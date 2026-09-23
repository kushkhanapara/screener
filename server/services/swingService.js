/**
 * Multi-day paper book — Trend Momentum on daily candles, held for days.
 *
 * Kept apart from the intraday engine on purpose: its own run id ("swing"), its
 * own ₹10 lakh, its own totals. The intraday square-off never sees these
 * positions because paperService only manages its own run.
 *
 * Same rules the daily replay tested (npm run replay:swing -- --strategies):
 *   signal   yesterday's daily candle: SMA34 > SMA200, close > SMA34,
 *            EMA5 > SMA34, RSI(14) ≥ 60 — first day it appears — and Nifty
 *            above its 50-day average
 *   entry    today, at the first futures price after 9:15
 *   stop     2 × daily ATR below entry; checked on every futures tick
 *   trail    each morning: best daily close since entry − 3 × ATR (only rises)
 *   exit     stop / trail, or at 3:25 PM on the 20th trading day held
 *   expiry   at 3:25 PM on expiry day the position rolls to the next month
 *            (closed and reopened; both legs are recorded)
 *
 * Daily jobs:
 *   from 9:00  "morning sync": download daily candles, update every open
 *              position's trail and days held, list today's buys
 *   9:16–15:00 open today's buys as futures prices arrive
 *   15:25      20-day limit and expiry rolls
 */
import * as store from "../paper/store.js";
import * as engine from "../paper/engine.js";
import { compute } from "../paper/metrics.js";
import { canAfford, deployedCapital, capitalState } from "../paper/capital.js";
import { calibrateContract } from "../paper/charges.js";
import { getUniverse, getUnderlyings, loadFuturesUniverse } from "../data/instruments.js";
import { getDailyCandles, getLtp } from "../data/upstox.js";
import { indicators, dailySignal } from "../swing/dailyStrategies.js";
import { atrAt, dateOf } from "../swing/dipRecovery.js";
import { istMinutes, istDateString, istDay } from "../core/session.js";
import { HAS_TOKEN } from "../config.js";
import * as live from "./liveService.js";
import { log } from "../logger.js";

const logger = log("swing");

export const RUN_ID = "swing";
const NIFTY_KEY = "NSE_INDEX|Nifty 50";
const HISTORY_DAYS = 420; // calendar days: enough for the 200-day average

export const SWING_BOOK = Object.freeze({
  id: "trend-momentum-daily",
  name: "Trend Momentum (multi-day)",
  capital: 1_000_000,
  maxOpen: 10,
  stopAtr: 2,
  trailAtr: 3,
  maxDays: 20,
  plain: {
    summary:
      "Buys stocks in a steady uptrend when momentum picks up, only while Nifty is also rising, and holds for up to 20 trading days.",
    buy: [
      "34-day average above the 200-day average (long-term uptrend)",
      "Price above the 34-day average, and the 5-day EMA above it too",
      "Daily RSI 60 or higher, on the first day this all lines up",
      "Nifty above its 50-day average",
      "Bought at the next morning's open (1 lot of the near-month future)",
    ],
    exits: [
      "Stop loss 2 × daily ATR below the entry, watched live all day",
      "Each morning the stop rises to 3 × ATR below the best close so far (never falls)",
      "Otherwise closed at 3:25 PM on the 20th trading day",
      "On expiry day it rolls to next month's future (shown as two trades)",
    ],
  },
});

// Only what openPosition and closePosition read.
const ENGINE_STRATEGY = { id: SWING_BOOK.id, exits: { stopAtr: SWING_BOOK.stopAtr }, timeframes: { trigger: "1d" } };

const state = {
  positions: new Map(),
  futPrices: new Map(), // futures key -> ltp
  cashPrices: new Map(), // cash key -> ltp
  plan: null, // { date, builtAt, signalDate, candidates: [...] }
  building: false,
  lastEodDate: null,
  error: null,
  timer: null,
};

let broadcaster = () => {};
export function setBroadcaster(fn) {
  broadcaster = fn || (() => {});
}

export function init() {
  store.init();
  const run = store.getRun(RUN_ID);
  try {
    state.lastEodDate = JSON.parse(run?.params ?? "null")?.lastEodDate ?? null;
  } catch {
    state.lastEodDate = null;
  }
  store.createRun({ id: RUN_ID, kind: "swing", params: { lastEodDate: state.lastEodDate } });
  for (const p of store.openPositions(RUN_ID)) state.positions.set(p.id, p);
  live.onTick(handleTick);
  state.timer = setInterval(() => tick(Date.now()).catch((e) => fail(e)), 20_000);
  state.timer.unref?.();
  setTimeout(() => tick(Date.now()).catch((e) => fail(e)), 5_000).unref?.();
  logger.info(`multi-day book ready — ${state.positions.size} open positions`);
}

function fail(e) {
  state.error = String(e?.message || e);
  logger.error(`multi-day book: ${state.error}`);
}

const today = (now) => istDateString(now);
const isWeekday = (now) => istDay(now) >= 1 && istDay(now) <= 5;

async function tick(now) {
  if (!HAS_TOKEN || !isWeekday(now)) return;
  const min = istMinutes(now);
  if (min >= 9 * 60 && state.plan?.date !== today(now) && !state.building) await morningSync(now);
  if (state.plan?.date === today(now) && min >= 9 * 60 + 16 && min <= 15 * 60) await openEntries(now);
  if (state.plan?.date === today(now) && min > 15 * 60) expireWaiting();
  if (min >= 15 * 60 + 25 && min <= 15 * 60 + 29 && state.lastEodDate !== today(now)) await endOfDay(now);
}

// ── Morning sync ────────────────────────────────────────────────────────

async function dailyCandles(key, now) {
  const to = istDateString(now - 86_400_000);
  const from = istDateString(now - HISTORY_DAYS * 86_400_000);
  const candles = await getDailyCandles(key, from, to).catch(() => []);
  return candles.filter((c) => dateOf(c) < today(now)); // completed days only
}

async function morningSync(now) {
  state.building = true;
  state.error = null;
  try {
    if (!getUnderlyings()) await loadFuturesUniverse();
    const underlyings = getUnderlyings() || [];
    const nifty = await dailyCandles(NIFTY_KEY, now);
    if (nifty.length < 60) throw new Error("no Nifty daily history");
    const signalDate = dateOf(nifty.at(-1));
    const avg50 = nifty.slice(-51, -1).reduce((a, c) => a + c.close, 0) / 50;
    const niftyUp = nifty.at(-1).close > avg50;

    const byUnderlying = new Map();
    const queue = [...underlyings];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let u = queue.shift(); u; u = queue.shift()) byUnderlying.set(u.underlying, { u, candles: await dailyCandles(u.cashKey, now) });
      })
    );

    // 1. Update open positions: days held and the trailing stop.
    for (const p of [...state.positions.values()]) {
      const candles = byUnderlying.get(p.underlying)?.candles ?? [];
      // Counted from the signal day, so a position rolled at expiry keeps its age.
      const signalDate = istDateString(p.signalBarTime ?? p.entryTime - 86_400_000);
      const held = candles.filter((c) => dateOf(c) > signalDate);
      const atr = atrAt(candles, candles.length - 1);
      const next = { ...p, barsHeld: held.length };
      if (held.length && atr > 0 && p.cashPriceAtSignal > 0) {
        const bestClose = Math.max(...held.map((c) => c.close));
        const ratio = p.entryPrice / p.cashPriceAtSignal; // futures vs cash at entry
        const trail = (bestClose - SWING_BOOK.trailAtr * atr) * ratio;
        if (trail > next.currentStop) next.currentStop = trail;
      }
      state.positions.set(p.id, next);
      store.updatePosition(next);
    }

    // 2. Today's buys from yesterday's candle.
    const candidates = [];
    for (const { u, candles } of byUnderlying.values()) {
      if (!candles.length || dateOf(candles.at(-1)) !== signalDate) continue;
      const ind = indicators(candles);
      const i = candles.length - 1;
      const sig = dailySignal("trend-momentum", candles, ind, i, () => null);
      if (sig?.side !== "long") continue;
      const atr = atrAt(candles, i);
      if (!(atr > 0)) continue;
      candidates.push({
        underlying: u.underlying,
        cashKey: u.cashKey,
        signalDate,
        score: sig.score,
        cashClose: candles[i].close,
        atr,
        rsi: ind.rsi[i],
        status: niftyUp ? "waiting" : "skipped",
        skipReason: niftyUp ? null : "Nifty below its 50-day average — no new buys",
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    state.plan = { date: today(now), builtAt: now, signalDate, niftyUp, niftyClose: nifty.at(-1).close, niftyAvg50: avg50, candidates };
    for (const c of candidates) if (c.status === "skipped") recordSignal(c, false, c.skipReason);
    logger.info(`multi-day morning sync: ${candidates.length} setups from ${signalDate}, Nifty ${niftyUp ? "above" : "below"} its 50-day average`);
    broadcast();
  } finally {
    state.building = false;
  }
}

// ── Entries ─────────────────────────────────────────────────────────────

const signalId = (c) => `${RUN_ID}:${c.signalDate}:${c.underlying}`;

function recordSignal(c, taken, skipReason = null) {
  store.recordSignal({
    id: signalId(c),
    runId: RUN_ID,
    strategyId: SWING_BOOK.id,
    underlying: c.underlying,
    side: "long",
    barTime: Date.parse(`${c.signalDate}T15:30:00+05:30`),
    taken,
    skipReason,
    score: c.score,
  });
}

function nearestContract(underlying, afterMs = 0) {
  let best = null;
  for (const c of getUniverse() || []) {
    if (c.underlying !== underlying || c.expiryMs <= afterMs) continue;
    if (!best || c.expiryMs < best.expiryMs) best = c;
  }
  return best;
}

async function openEntries(now) {
  const decided = new Set(store.signals({ runId: RUN_ID, strategyId: SWING_BOOK.id, limit: 1000 }).map((s) => s.id));
  for (const c of state.plan.candidates) {
    if (c.status !== "waiting") continue;
    if (decided.has(signalId(c))) {
      c.status = "done"; // decided before a restart
      continue;
    }
    const skip = (reason) => {
      c.status = "skipped";
      c.skipReason = reason;
      recordSignal(c, false, reason);
    };
    if ([...state.positions.values()].some((p) => p.underlying === c.underlying)) {
      skip("Already holding this stock");
      continue;
    }
    if (state.positions.size >= SWING_BOOK.maxOpen) {
      skip(`${SWING_BOOK.maxOpen} positions already open`);
      continue;
    }
    const contract = nearestContract(c.underlying, now);
    if (!contract) {
      skip("No futures contract");
      continue;
    }
    const ltp = state.futPrices.get(contract.key);
    if (!(ltp > 0)) {
      if (istMinutes(now) >= 15 * 60) skip("No futures price today");
      continue; // wait for the first tick
    }
    const deployed = deployedCapital([...state.positions.values()]);
    const afford = canAfford({ price: ltp, qty: contract.lotSize, deployed, capital: SWING_BOOK.capital });
    if (!afford.ok) {
      skip(afford.reason);
      continue;
    }
    c.status = "opening";
    const chargeRates = await calibrateContract({ instrumentKey: contract.key, qty: contract.lotSize, price: ltp, product: "D" }).catch(() => null);
    const cashNow = state.cashPrices.get(c.cashKey) ?? c.cashClose;
    const position = engine.openPosition({
      runId: RUN_ID,
      strategy: ENGINE_STRATEGY,
      signal: { side: "long", reasons: [`Daily setup on ${c.signalDate} (RSI ${c.rsi?.toFixed(0)})`] },
      underlying: c.underlying,
      futKey: contract.key,
      futLabel: contract.label,
      fillPrice: ltp,
      atr: c.atr * (ltp / cashNow), // daily ATR, on the futures price
      lotSize: contract.lotSize,
      now,
      signalBarTime: Date.parse(`${c.signalDate}T15:30:00+05:30`),
      cashPriceAtSignal: cashNow, // cash price at entry: converts cash-chart trails to futures
      chargeRates,
    });
    store.insertPosition(position);
    state.positions.set(position.id, position);
    recordSignal(c, true);
    c.status = "taken";
    logger.info(`multi-day buy ${c.underlying} @ ${position.entryPrice.toFixed(2)} stop ${position.currentStop.toFixed(2)} (${contract.label})`);
    broadcast();
  }
}

/** Buys still waiting after 3 PM (no futures price all day, e.g. a holiday). */
function expireWaiting() {
  for (const c of state.plan.candidates) {
    if (c.status !== "waiting") continue;
    c.status = "skipped";
    c.skipReason = "Not bought before 3 PM";
    recordSignal(c, false, c.skipReason);
  }
}

// ── Exits ───────────────────────────────────────────────────────────────

function handleTick(key, ltp) {
  if (!Number.isFinite(ltp)) return;
  if (typeof key === "string" && key.startsWith("NSE_EQ|")) {
    state.cashPrices.set(key, ltp);
    return;
  }
  if (typeof key !== "string" || !key.startsWith("NSE_FO|")) return;
  state.futPrices.set(key, ltp);
  const now = Date.now();
  for (const p of [...state.positions.values()]) {
    if (p.futKey !== key) continue;
    if (ltp <= p.currentStop) {
      finalise(p, ltp, p.currentStop > p.entryPrice ? "trail" : "stop", now);
      continue;
    }
    if (ltp > p.highWater || ltp < p.lowWater) {
      const next = { ...p, highWater: Math.max(p.highWater, ltp), lowWater: Math.min(p.lowWater, ltp) };
      state.positions.set(p.id, next);
      store.updatePosition(next);
    }
  }
}

function finalise(position, exitPrice, reason, now) {
  const trade = engine.closePosition(position, exitPrice, reason, now);
  store.commitClose(position.id, trade);
  state.positions.delete(position.id);
  logger.info(`multi-day ${position.underlying} closed ${reason} R=${trade.rMultiple.toFixed(2)} net=₹${trade.netPnl.toFixed(0)}`);
  broadcast();
  return trade;
}

async function endOfDay(now) {
  state.lastEodDate = today(now);
  store.createRun({ id: RUN_ID, kind: "swing", params: { lastEodDate: state.lastEodDate } });
  for (const p of [...state.positions.values()]) {
    const ltp = state.futPrices.get(p.futKey);
    if (!(ltp > 0)) continue; // no trading today (holiday) — nothing to do
    if ((p.barsHeld ?? 0) + 1 >= SWING_BOOK.maxDays) {
      finalise(p, ltp, "days", now);
      continue;
    }
    const contract = (getUniverse() || []).find((c) => c.key === p.futKey);
    if (contract && istDateString(contract.expiryMs) === today(now)) await roll(p, contract, ltp, now);
  }
}

/** Close the expiring future and hold the same trade in next month's. */
async function roll(p, old, oldLtp, now) {
  const next = nearestContract(p.underlying, old.expiryMs);
  if (!next) return finalise(p, oldLtp, "roll", now);
  const newLtp = (await getLtp([next.key]).catch(() => new Map())).get(next.key);
  finalise(p, oldLtp, "roll", now);
  if (!(newLtp > 0)) return logger.warn(`multi-day roll ${p.underlying}: no price for ${next.label}, position closed`);
  const shift = newLtp - oldLtp; // keep the stop the same distance below price
  const cashKey = (getUnderlyings() || []).find((u) => u.underlying === p.underlying)?.cashKey;
  const cashNow = state.cashPrices.get(cashKey) ?? oldLtp / (p.entryPrice / p.cashPriceAtSignal);
  const opened = engine.openPosition({
    runId: RUN_ID,
    strategy: ENGINE_STRATEGY,
    signal: { side: "long", reasons: [...(p.reasons ?? []), `Rolled from ${old.label}`] },
    underlying: p.underlying,
    futKey: next.key,
    futLabel: next.label,
    fillPrice: newLtp,
    atr: p.riskPerUnit / SWING_BOOK.stopAtr,
    lotSize: next.lotSize,
    now,
    signalBarTime: p.signalBarTime,
    chargeRates: await calibrateContract({ instrumentKey: next.key, qty: next.lotSize, price: newLtp, product: "D" }).catch(() => null),
  });
  const rolled = {
    ...opened,
    initialStop: p.currentStop + shift,
    currentStop: p.currentStop + shift,
    riskPerUnit: p.riskPerUnit,
    barsHeld: p.barsHeld,
    // Keep entry / cash reference equal to next month's futures-to-cash ratio,
    // so the morning trail (worked out on the cash chart) lands right.
    cashPriceAtSignal: (opened.entryPrice * cashNow) / newLtp,
  };
  store.insertPosition(rolled);
  state.positions.set(rolled.id, rolled);
}

// ── Snapshot ────────────────────────────────────────────────────────────

function broadcast() {
  try {
    broadcaster({ type: "swing", ts: Date.now() });
  } catch {
    /* a UI hiccup must never break trading */
  }
}

export function getSnapshot() {
  const positions = [...state.positions.values()]
    .map((p) => {
      const ltp = state.futPrices.get(p.futKey) ?? null;
      const perUnit = ltp != null ? ltp - p.entryPrice : null;
      return {
        ...p,
        ltp,
        unrealisedR: perUnit != null ? perUnit / p.riskPerUnit : null,
        unrealisedPnl: perUnit != null ? perUnit * p.qty : null,
      };
    })
    .sort((a, b) => b.entryTime - a.entryTime);
  const trades = store.trades({ runId: RUN_ID, limit: 500 });
  return {
    book: SWING_BOOK,
    capital: capitalState([...state.positions.values()], SWING_BOOK.capital),
    positions,
    trades: trades.slice(0, 100),
    metrics: compute(store.tradesChronological({ runId: RUN_ID })),
    openPnl: positions.reduce((a, p) => a + (p.unrealisedPnl ?? 0), 0),
    plan: state.plan,
    signals: store.signals({ runId: RUN_ID, strategyId: SWING_BOOK.id, limit: 100 }),
    lastEodDate: state.lastEodDate,
    error: state.error,
  };
}

/** For the dry-run check only (scripts, tests) — not used by the server. */
export const _internals = { state, morningSync, openEntries, handleTick, endOfDay };
