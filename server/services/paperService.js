import { randomUUID } from "node:crypto";
import { store3m, store15m, storeIndex3m } from "../live/candleStore.js";
import { seedWindow } from "../live/seed.js";
import { getDailyCandles, getIntradayCandles, getHistoricalCandles } from "../data/upstox.js";
import { getUniverse, getUnderlyings } from "../data/instruments.js";
import { list as listStrategies, get as getStrategy, familyOf } from "../strategies/index.js";
import { buildContext, regimeAllows } from "../strategies/context.js";
import * as engine from "../paper/engine.js";
import { levelsToFutures } from "../strategies/vwapvp/engine.js";
import * as store from "../paper/store.js";
import { compute } from "../paper/metrics.js";
import { canAfford, deployedCapital, capitalState } from "../paper/capital.js";
import { calibrateContract } from "../paper/charges.js";
import { extractFeatures } from "../paper/features.js";
import { dayTrend, classifyDay, dayTypeVeto } from "../paper/dayType.js";
import {
  SELECTION,
  alignedRsOf,
  stopPctOf,
  qualityOf,
  selectionVeto,
  createDayState,
  buildDayStates,
  noteClose,
  createConfluence,
  SELECTION_SKIP_PREFIXES,
} from "../paper/selection.js";
import { buildReport } from "../paper/report.js";
import { CAPITAL_PER_STRATEGY } from "../config.js";
import { istMinutes, istDateString, sessionBars, sessionStartMs } from "../core/session.js";
import { HAS_TOKEN, isMarketOpen } from "../config.js";
import * as live from "./liveService.js";
import * as daily from "./dailyService.js";
import { log } from "../logger.js";

const logger = log("paper");

export const NIFTY_KEY = "NSE_INDEX|Nifty 50";
const RUN_ID = store.LIVE_RUN_ID;
const BAR_MS = 3 * 60 * 1000; // every strategy triggers on 3m (enforced by validate())

/**
 * Auto paper-trading orchestrator.
 *
 * The split that makes this trustworthy:
 *   ENTRIES are decided on CLOSED cash bars. Evaluating a forming bar is what
 *   made the old screener repaint — a 15m bar re-read every minute gives 15
 *   different answers, so a "signal" could vanish before you could act on it.
 *
 *   EXITS are managed on LIVE FUTURES ticks. Checking stops only at bar close
 *   records a mid-bar stop breach at the bar's closing price, which flatters
 *   results, sometimes enormously.
 *
 * Signals come from the cash chart but fills are priced on the near-month
 * future, because that is the instrument actually traded — basis and futures
 * liquidity are part of the result, not an inconvenience to be abstracted away.
 */

const state = {
  started: false,
  futByUnderlying: new Map(), // underlying -> near-month contract
  futPrices: new Map(), // futures key -> { ltp, ts }
  futQuotes: new Map(), // futures key -> { bid, ask, ts } — best bid/ask, between trades
  indexStore: storeIndex3m,
  positions: new Map(), // position id -> position
  lastBarSeen: new Map(), // `${strategyId}:${underlying}:${tf}` -> bucket ms
  squaredOffToday: null, // session start ms of the last square-off sweep
  lastBarClose: 0, // 3m boundary whose bar-close rules have already been applied
  dayStates: new Map(), // strategyId -> {lostNames, taken, skippedForQuality}, this session
  confluence: createConfluence(SELECTION),
  lastEvalTs: null,
  // Nifty as the screen shows it: live price, today's open, yesterday's close.
  // Two different moves matter — from the open (what the strategies can trade)
  // and from yesterday's close (the number the news quotes).
  nifty: { ltp: null, open: null, prevClose: null, prevCloseDate: null },
  counts: { signals: 0, trades: 0 },
  error: null,
  // Bumped whenever a position opens or closes. Everything derived from the
  // trade history is expensive to recompute and only changes when this does, so
  // it is cached against this number rather than rebuilt on every push.
  revision: 0,
};

/** Cache of the heavy, history-derived parts of the snapshot. */
let derivedCache = { revision: -1, value: null };

function bumpRevision() {
  state.revision++;
  derivedCache = { revision: -1, value: null };
}

let broadcaster = () => {};
export function setBroadcaster(fn) {
  broadcaster = fn || (() => {});
}

/** Wire into the shared feed. Must run before liveService connects. */
export function init() {
  store.init();
  store.createRun({ id: RUN_ID, kind: "live", params: { startedAt: Date.now() } });
  restoreOpenPositions();
  // A restart mid-bar must not apply this bar's close a second time.
  state.lastBarClose = currentBoundary(Date.now());
  rebuildDayStates(Date.now());

  live.registerKeys(() => subscriptionKeys());
  live.onTick(handleTick);
  live.onQuote((key, bid, ask, ts) => state.futQuotes.set(key, { bid, ask, ts }));
  live.onStarted(onSessionStart);
  live.onStopped(onSessionEnd);

  logger.info(
    `paper engine ready — ${listStrategies().length} strategies, ${state.positions.size} open positions restored`
  );

  // Positions the engine was not watching (restart, sleep, dead feed) are
  // brought up to date from the contract's real bars — see catchUpPositions.
  setTimeout(() => catchUpPositions("restart").catch((e) => logger.error(`catch-up failed: ${e.message}`)), 5_000);
  setInterval(() => {
    if (state.started && live.isFeedHealthy()) return; // the live engine is managing them
    catchUpPositions("engine not running").catch((e) => logger.error(`catch-up failed: ${e.message}`));
  }, CATCHUP_EVERY_MS).unref?.();
}

/*
 * Catch-up for positions nobody was watching.
 *
 * Bar-close exits and the square-off run inside the evaluation loop, which only
 * runs while the feed is live and seeded. When it is not — the machine slept
 * (25 Sept 2026: 13:14 → 20:33, with a position open), the process restarted,
 * the feed died — a position simply sat there: no stop, no square-off, then
 * restored the next time as if still live.
 *
 * So the gap is replayed from the contract's own settled 3-minute futures bars
 * through the strategy's exit engine (applyBar — the replay's rules: a bar
 * whose range holds the stop takes the stop). position.barsHeld counts the bar
 * closes already applied, so exactly the missing ones are replayed, and the
 * exit lands at the price and time it would have. A position past its
 * square-off with no bars to close on is left open and reported, never closed
 * at an invented price.
 */
const CATCHUP_EVERY_MS = 60_000;
const CATCHUP_SETTLE_MS = 90_000; // REST bars are incomplete just after the close
let catchingUp = false;

async function futuresBars3m(futKey, sessionStart) {
  const day = istDateString(sessionStart);
  const candles =
    day === istDateString(Date.now())
      ? await getIntradayCandles(futKey, "minutes", 3)
      : await getHistoricalCandles(futKey, "minutes", 3, day, day);
  return new Map(
    candles.map((c) => {
      const time = new Date(c.time).getTime();
      return [time, { time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }];
    })
  );
}

async function catchUpPositions(reason) {
  if (catchingUp || !HAS_TOKEN || !state.positions.size) return;
  catchingUp = true;
  try {
    for (const position of [...state.positions.values()]) {
      const strategy = getStrategy(position.strategyId);
      if (!strategy || !position.futKey) continue;
      const session = sessionStartMs(position.entryTime);
      const squareOffAt = session + (strategy.exits.squareOffMin - (9 * 60 + 15)) * 60_000;
      const firstClose = Math.floor(position.entryTime / BAR_MS) * BAR_MS + BAR_MS;
      const now = Date.now();
      // Nothing missed yet: the next unapplied bar has not settled.
      if (firstClose + position.barsHeld * BAR_MS + CATCHUP_SETTLE_MS > now) continue;

      let bars;
      try {
        bars = await futuresBars3m(position.futKey, session);
      } catch (e) {
        logger.error(`catch-up: no futures bars for ${position.underlying} (${e.message})`);
        continue;
      }
      if (!state.positions.has(position.id)) continue; // closed live meanwhile

      const eng = engineOf(strategy);
      let p = position;
      let exit = null;
      let exitAt = null;
      let applied = 0;
      for (let close = firstClose + position.barsHeld * BAR_MS; close <= squareOffAt; close += BAR_MS) {
        if (close + CATCHUP_SETTLE_MS > now) break;
        const bar = bars.get(close - BAR_MS);
        if (!bar) continue; // no trades in that bar
        const r = eng.applyBar(p, strategy, bar, close);
        applied++;
        p = r.position;
        if (r.exit) {
          exit = r.exit;
          exitAt = close;
          break;
        }
      }

      if (exit) {
        logger.warn(
          `catch-up (${reason}): ${p.strategyId} ${p.side} ${p.underlying} closed at ${exit.price} ` +
            `(${exit.reason}) as of ${new Date(exitAt).toISOString()}, replaying ${applied} unwatched bars`
        );
        finalise(p, exit.price, exit.reason, exitAt);
      } else if (applied) {
        state.positions.set(p.id, p);
        store.updatePosition(p);
        logger.info(`catch-up (${reason}): ${p.underlying} brought up to date over ${applied} unwatched bars`);
      } else if (now > squareOffAt + BAR_MS + CATCHUP_SETTLE_MS) {
        logger.error(
          `catch-up: ${p.underlying} is past its ${new Date(squareOffAt).toISOString()} square-off but Upstox ` +
            "returned no futures bars to close it on — left open rather than closed at an invented price"
        );
      }
    }
  } finally {
    catchingUp = false;
  }
}

/**
 * Reload positions left open by a previous process.
 *
 * Without this a restart mid-session would strand real (paper) exposure: the
 * position would sit in the database with nothing watching its stop.
 */
function restoreOpenPositions() {
  for (const p of store.openPositions(RUN_ID)) {
    state.positions.set(p.id, p);
  }
  if (state.positions.size) {
    logger.warn(`restored ${state.positions.size} open positions from a previous run`);
  }
}

/** Near-month futures for every underlying, plus the index. */
function subscriptionKeys() {
  const universe = getUniverse() || [];
  const nearest = new Map();
  for (const c of universe) {
    const cur = nearest.get(c.underlying);
    if (!cur || c.expiryMs < cur.expiryMs) nearest.set(c.underlying, c);
  }
  state.futByUnderlying = nearest;
  return [...[...nearest.values()].map((c) => c.key), NIFTY_KEY];
}

/** Every tick: record futures prices, build index bars, manage open positions. */
function handleTick(key, ltp, tsMs, qty, minute = null) {
  if (key === NIFTY_KEY) {
    state.indexStore.addTick(key, ltp, tsMs, qty);
    // The exchange's candle for the last completed minute: exact index bars.
    if (minute) state.indexStore.applyMinute(key, minute.ts, minute);
    state.nifty.ltp = ltp; // every tick, so the header moves with the market
    return;
  }
  const tracked = state.futPrices.has(key) || isFuturesKey(key);
  if (!tracked) return;
  state.futPrices.set(key, { ltp, ts: tsMs });

  /*
   * Manage on the WALL CLOCK, not the tick's own timestamp.
   *
   * Upstox stamps each tick with its exchange last-traded time, which lags
   * real time by seconds. Entries were recorded with Date.now() while exits
   * took the tick's stamp, so a position could be closed at an instant EARLIER
   * than it opened — trades appeared in the books with negative hold times, and
   * the 15:15 square-off fired against a clock running behind the real one.
   *
   * The tick's price is what matters; its timestamp is only useful for
   * staleness checks.
   */
  manageOpenPositionsFor(key, ltp, Date.now());
}

function isFuturesKey(key) {
  return typeof key === "string" && key.startsWith("NSE_FO|");
}

/** The exit engine a strategy trades with: its own when it has one, else the shared one. */
function engineOf(strategy) {
  return strategy?.engine ?? engine;
}

/** Run the exit machine for every open position on this futures contract. */
function manageOpenPositionsFor(futKey, price, now) {
  for (const position of state.positions.values()) {
    if (position.futKey !== futKey) continue;
    const strategy = getStrategy(position.strategyId);
    if (!strategy) continue;

    const { exit, position: next } = engineOf(strategy).checkExit(position, strategy, price, now);
    if (exit) {
      finalise(next, exit.price, exit.reason, now);
    } else if (next !== position) {
      state.positions.set(next.id, next);
      store.updatePosition(next);
    }
  }
}

/** Close a position, persist the trade, and broadcast. */
function finalise(position, exitPrice, exitReason, now) {
  const trade = engine.closePosition(position, exitPrice, exitReason, now);
  try {
    store.commitClose(position.id, trade);
  } catch (e) {
    state.error = `failed to persist trade: ${e.message}`;
    logger.error(state.error);
    return;
  }
  state.positions.delete(position.id);
  noteClose(dayStateOf(trade.strategyId), trade);
  state.counts.trades++;
  bumpRevision();
  logger.info(
    `${trade.strategyId} ${trade.side} ${trade.underlying} closed ${exitReason} ` +
      `R=${trade.rMultiple.toFixed(2)} net=₹${trade.netPnl.toFixed(0)}`
  );
  broadcast();
}

/** Seed the index's 3m window so relative strength works from the first bar. */
async function onSessionStart() {
  state.started = true;
  state.error = null;
  state.lastBarClose = currentBoundary(Date.now());
  rebuildDayStates(Date.now());
  try {
    // Must include TODAY: relative strength compares the stock's move since the
    // open against the index's, and history alone leaves the index session empty.
    const bars = await seedWindow(NIFTY_KEY, 3, 8);
    if (bars.length) state.indexStore.seed(NIFTY_KEY, bars);
    const todays = state.indexStore.bars(NIFTY_KEY).length;
    logger.info(`index seeded with ${bars.length} 3m bars (${todays} in store)`);
  } catch (e) {
    logger.error(`index seed failed: ${e.message}`);
  }
  await loadNiftyPrevClose();
  scheduleEvaluation();
}

/**
 * Yesterday's Nifty close, once a session. Without it the page can only show
 * the move since the open, which on a gap day reads far smaller than the move
 * everyone else quotes (24 Sept 2026: −0.68% from the open, −1.64% from the
 * previous close, because it opened 0.96% lower).
 */
async function loadNiftyPrevClose() {
  const today = istDateString(Date.now());
  if (state.nifty.prevCloseDate && state.nifty.prevCloseDate < today && state.nifty.prevClose) return;
  try {
    const to = istDateString(Date.now() - 86_400_000);
    const from = istDateString(Date.now() - 14 * 86_400_000);
    const candles = await getDailyCandles(NIFTY_KEY, from, to);
    const last = candles.filter((c) => String(c.time).slice(0, 10) < today).at(-1);
    if (last) {
      state.nifty.prevClose = last.close;
      state.nifty.prevCloseDate = String(last.time).slice(0, 10);
      logger.info(`Nifty previous close ${last.close} (${state.nifty.prevCloseDate})`);
    }
  } catch (e) {
    logger.warn(`could not read Nifty's previous close: ${e.message}`);
  }
}

/** Nifty for the header: both moves, live off the latest tick. */
function niftySnapshot() {
  // TODAY's bars only: the store also holds days of seeded history, whose first
  // bar would otherwise be mistaken for this morning's open.
  const bars = sessionBars(state.indexStore.bars(NIFTY_KEY) ?? [], Date.now());
  const open = bars.length ? bars[0].open : state.nifty.open;
  state.nifty.open = open ?? null;
  const ltp = state.nifty.ltp ?? (bars.length ? bars.at(-1).close : null);
  const move = (from) => (from > 0 && ltp > 0 ? ((ltp - from) / from) * 100 : null);
  return {
    key: NIFTY_KEY,
    ltp,
    open: open ?? null,
    prevClose: state.nifty.prevClose,
    prevCloseDate: state.nifty.prevCloseDate,
    pctFromOpen: move(open),
    pctFromPrevClose: move(state.nifty.prevClose),
  };
}

function onSessionEnd() {
  // Flatten anything still open at the last price we saw, so the books close.
  const now = Date.now();
  for (const position of [...state.positions.values()]) {
    const price = state.futPrices.get(position.futKey)?.ltp ?? position.entryPrice;
    finalise(position, price, "squareoff", now);
  }
  state.started = false;
  clearTimeout(state.timer);
  state.timer = null;
}

function istDate(daysBack = 0) {
  const now = Date.now() + (5 * 60 + 30) * 60 * 1000;
  return new Date(now - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Upstox stamps ticks with the exchange trade time and delivers them a moment
// late, and the exchange minute candle that finalises a bar arrives with the
// first snapshot after its boundary. Reading the
// bar this long after it closes catches them.
const BAR_CLOSE_GRACE_MS = 5000;

/**
 * Evaluate right as each 3-minute bar closes (plus the grace above), rather
 * than on a free-running 20-second timer that noticed a closed bar anywhere
 * from 0 to 20 seconds late — and entered, or ran the bar-close exits, at
 * whatever the price had become by then. 3-minute boundaries fall on 09:15 IST
 * and every 3 minutes after, which are whole multiples of 3 minutes since the
 * epoch.
 */
function scheduleEvaluation() {
  clearTimeout(state.timer);
  const now = Date.now();
  const next = Math.floor(now / BAR_MS) * BAR_MS + BAR_MS + BAR_CLOSE_GRACE_MS;
  const wait = next - BAR_MS - now > 0 ? next - BAR_MS - now : next - now;
  state.timer = setTimeout(() => {
    evaluate()
      .catch((e) => {
        state.error = String(e.message || e);
        logger.error(state.error);
      })
      .finally(() => {
        if (state.timer) scheduleEvaluation();
      });
  }, wait);
}

/** One evaluation pass across every strategy and underlying. */
export async function evaluate(now = Date.now()) {
  if (!HAS_TOKEN) return;

  enforceSquareOff(now);
  // A silent feed means frozen bars and frozen prices: judging a bar close or
  // opening a trade on them is acting on data that is not the market. Stops
  // still run on every tick the moment data returns; bar-based decisions wait
  // until the bars have been rebuilt.
  if (!live.isFeedHealthy()) {
    state.error = "live feed not delivering — no bar-close exits or new entries until it recovers";
    return;
  }
  if (state.error?.startsWith("live feed not delivering")) state.error = null;
  // Before entries, so a trade cut by prove-it frees its margin for this bar.
  manageBarCloses(now);

  const underlyings = getUnderlyings() || [];
  if (!underlyings.length) return;

  const indexBars = state.indexStore.closedBars(NIFTY_KEY, now);
  // What kind of day it is so far — decides which strategies may enter.
  const trend = dayTrend(indexBars, now);
  state.dayTrend = { ...trend, type: classifyDay(trend) };
  const strategies = listStrategies();
  const candidates = [];
  let opened = 0;

  for (const u of underlyings) {
    const bars3 = store3m.closedBars(u.cashKey, now);
    const bars15 = store15m.closedBars(u.cashKey, now);
    if (bars3.length < 60) continue;

    // Skip names whose data has gone stale rather than acting on a dead price.
    if (store3m.stalenessBuckets(u.cashKey, now) > 3) continue;

    const lastBar3 = bars3[bars3.length - 1].time;
    let ctx = null;

    for (const strategy of strategies) {
      // One evaluation per closed bar per strategy — the guard that stops a
      // single bar from being traded twice if an evaluation ever runs again on it.
      const seenKey = `${strategy.id}:${u.underlying}:3m`;
      if (state.lastBarSeen.get(seenKey) === lastBar3) continue;
      state.lastBarSeen.set(seenKey, lastBar3);

      if (store.hasOpenPosition(RUN_ID, strategy.id, u.underlying)) continue;

      ctx ??= buildContext({
        underlying: u.underlying,
        cashKey: u.cashKey,
        bars3m: bars3,
        bars15m: bars15,
        indexBars3m: indexBars,
        // Previous-day close, for separating the overnight gap from the move
        // the session actually produced.
        daily: daily.getDailyStats(u.underlying),
        now,
      });

      let signal;
      try {
        signal = strategy.evaluate(ctx);
      } catch (e) {
        logger.error(`${strategy.id} threw on ${u.underlying}: ${e.message}`);
        continue;
      }
      if (!signal?.side) continue;

      state.counts.signals++;
      candidates.push({ strategy, signal, ctx, underlying: u, barTime: lastBar3 });
    }
  }

  /*
   * Capital is the binding constraint, so WHICH signal gets taken matters more
   * than whether any does. Taking them in whatever order the universe happens
   * to be sorted means alphabetical position decides the portfolio — so rank by
   * the strategy's own score first, and let the best-scoring candidate claim
   * the free margin.
   */
  // Confirmation across strategy families, then a quality score for every
  // candidate. Selective strategies rank by quality; the originals keep their
  // own score order. Capital is per strategy, so the two orders never compete.
  state.confluence.prune(now);
  for (const c of candidates) {
    state.confluence.note(familyOf(c.strategy), c.underlying.underlying, c.signal.side, c.barTime);
  }
  for (const c of candidates) {
    const atr = c.ctx.atr?.["3m"];
    const close = c.ctx.rows?.["3m"]?.latest?.close;
    c.quality = qualityOf(
      {
        alignedRs: alignedRsOf(c.ctx.relStrength, c.signal.side),
        stopPct: stopPctOf(c.strategy, atr, close),
        confluence: state.confluence.count(
          familyOf(c.strategy),
          c.underlying.underlying,
          c.signal.side,
          c.barTime
        ),
      },
      SELECTION
    );
  }
  const rankOf = (c) => (c.strategy.selection ? c.quality.score : c.signal.score) ?? 0;
  candidates.sort((a, b) => rankOf(b) - rankOf(a));

  for (const c of candidates) {
    const taken = await tryOpen(c.strategy, c.signal, c.ctx, c.underlying, c.barTime, now, c.quality, trend);
    if (taken) opened++;
  }

  state.lastEvalTs = now;
  if (opened) broadcast();
}

/**
 * Attempt to open a position for a signal.
 *
 * Every signal is recorded even when it cannot be taken, because "how selective
 * is this strategy?" is answered by the signal count, not the trade count.
 * There is deliberately no cap on concurrent positions — the strategy is
 * supposed to be the filter — so a strategy firing dozens of signals a day is
 * telling you it is not selective enough, and that is a strategy problem.
 */
async function tryOpen(strategy, signal, ctx, underlying, barTime, now, quality = null, trend = null) {
  const signalId = randomUUID();
  const record = (taken, skipReason = null) =>
    store.recordSignal({
      id: signalId,
      runId: RUN_ID,
      strategyId: strategy.id,
      underlying: underlying.underlying,
      side: signal.side,
      barTime,
      taken,
      skipReason,
      score: Number.isFinite(signal.score) ? signal.score : null,
    });

  // Structural: a setup needing multiple R cannot travel that far in the few
  // minutes before the forced square-off.
  if (!engineOf(strategy).entriesAllowed(strategy, now)) {
    record(false, "too close to square-off");
    return false;
  }

  // Portfolio-level: don't fight the index. Shorts ran at −120R against longs
  // at −5R because the strategies shorted almost everything on any index dip.
  if (strategy.regimeFilter && !regimeAllows(ctx.regime, signal.side)) {
    record(false, `market regime is ${ctx.regime}`);
    return false;
  }

  // Day-type switch: trend strategies on trend days, flat-day strategies on flat days.
  const dayVeto = dayTypeVeto(strategy, trend, signal.side);
  if (dayVeto) {
    record(false, dayVeto);
    return false;
  }
  if (strategy.noRetryAfterLoss && dayStateOf(strategy.id).lostNames.has(underlying.underlying)) {
    record(false, `already lost on ${underlying.underlying} today`);
    return false;
  }

  // Selective variants: only setups clearly stronger than Nifty, and never a
  // second attempt on a stock that already lost today. No daily cap.
  if (strategy.selection) {
    const day = dayStateOf(strategy.id);
    const veto = selectionVeto(
      { underlying: underlying.underlying, alignedRs: quality?.alignedRs ?? null },
      day,
      strategy.selection
    );
    if (veto) {
      day.skippedForQuality++;
      record(false, veto);
      return false;
    }
  }

  const contract = state.futByUnderlying.get(underlying.underlying);
  if (!contract) return record(false, "no near-month futures contract"), false;

  const quote = state.futPrices.get(contract.key);
  if (!quote) return record(false, "no futures price yet"), false;

  const atr = ctx.atr?.["3m"];
  if (!Number.isFinite(atr) || atr <= 0) return record(false, "no ATR"), false;

  // Real money check. A position blocks margin until it closes, so this is what
  // stops the engine from "holding" a portfolio no account could fund.
  const qty = contract.lotSize;
  const deployed = deployedCapital(openPositionsOf(strategy.id));
  const afford = canAfford({ price: quote.ltp, qty, deployed });
  if (!afford.ok) {
    record(false, afford.reason);
    return false;
  }

  // Resolve real Upstox charges for this contract before opening, so the close
  // path can stay synchronous inside the tick handler.
  const chargeRates = await calibrateContract({
    instrumentKey: contract.key,
    qty,
    price: quote.ltp,
  }).catch(() => null);

  try {
    // A strategy that places its own levels reads them off the cash chart; the
    // position is filled and watched on the future, so move them across.
    const position = engineOf(strategy).openPosition({
      runId: RUN_ID,
      strategy,
      signal: strategy.engine ? levelsToFutures(signal, ctx.rows["3m"].latest.close, quote.ltp) : signal,
      underlying: underlying.underlying,
      futKey: contract.key,
      futLabel: contract.label,
      fillPrice: quote.ltp,
      atr: scaleAtrToFutures(atr, ctx.rows["3m"].latest.close, quote.ltp),
      lotSize: contract.lotSize,
      now,
      signalBarTime: barTime,
      cashPriceAtSignal: ctx.rows["3m"].latest.close,
      chargeRates,
      features: { ...extractFeatures(ctx, signal, { now }), quality },
    });

    store.insertPosition(position);
    state.positions.set(position.id, position);
    dayStateOf(strategy.id).taken++;
    record(true);
    bumpRevision();
    logger.info(
      `${strategy.id} ${signal.side} ${underlying.underlying} @ ${position.entryPrice.toFixed(2)} ` +
        `stop ${position.currentStop.toFixed(2)} (${contract.label})`
    );
    return true;
  } catch (e) {
    record(false, e.message);
    return false;
  }
}

/**
 * ATR is measured on the cash chart but the stop sits on the futures price.
 * Futures track cash closely, so the volatility is near-identical in percentage
 * terms — rescaling by the price ratio keeps the stop the same *fraction* of
 * price rather than importing an absolute rupee distance from a different
 * instrument.
 */
function scaleAtrToFutures(atrCash, cashPrice, futPrice) {
  if (!Number.isFinite(cashPrice) || cashPrice <= 0) return atrCash;
  return atrCash * (futPrice / cashPrice);
}

function dayStateOf(strategyId) {
  if (!state.dayStates.has(strategyId)) state.dayStates.set(strategyId, createDayState());
  return state.dayStates.get(strategyId);
}

/** Rebuild this session's selection state from the store, so restarts keep it. */
function rebuildDayStates(now) {
  try {
    const since = sessionStartMs(now);
    state.dayStates = buildDayStates({
      trades: store.tradesChronological({ runId: RUN_ID }).filter((t) => t.entryTime >= since),
      openPositions: [...state.positions.values()].filter((p) => p.entryTime >= since),
      skips: store.skipCountsSince({ runId: RUN_ID, since, prefixes: SELECTION_SKIP_PREFIXES }),
    });
  } catch (e) {
    logger.error(`selection state rebuild failed: ${e.message}`);
    state.dayStates = new Map();
  }
}

function currentBoundary(now) {
  return Math.floor(now / BAR_MS) * BAR_MS;
}

/**
 * Apply the bar-close rules (prove-it, time stop) once per 3-minute boundary.
 *
 * Ticks alone only ever check price levels; without this the bar-counted exits
 * never ran live and every trade recorded zero bars held. A position counts a
 * bar only if it was open when that bar closed.
 */
function manageBarCloses(now) {
  const boundary = currentBoundary(now);
  if (boundary <= state.lastBarClose) return;
  state.lastBarClose = boundary;

  for (const position of [...state.positions.values()]) {
    if (position.entryTime >= boundary) continue;
    const strategy = getStrategy(position.strategyId);
    if (!strategy) continue;
    const price = state.futPrices.get(position.futKey)?.ltp;
    if (!Number.isFinite(price)) continue;

    const { exit, position: next } = engineOf(strategy).manageBarClose(position, strategy, price, now);
    if (exit) {
      finalise(next, exit.price, exit.reason, now);
    } else {
      state.positions.set(next.id, next);
      store.updatePosition(next);
    }
  }
}

/** Force every position flat once the square-off time passes. */
function enforceSquareOff(now) {
  const session = sessionStartMs(now);
  if (state.squaredOffToday === session) return;

  for (const position of [...state.positions.values()]) {
    const strategy = getStrategy(position.strategyId);
    if (!strategy) continue;
    if (istMinutes(now) < strategy.exits.squareOffMin) continue;
    const price = state.futPrices.get(position.futKey)?.ltp ?? position.entryPrice;
    finalise(position, price, "squareoff", now);
  }

  if (istMinutes(now) >= 15 * 60 + 20) state.squaredOffToday = session;
}

// ── Read models for the API / WS ───────────────────────────────────────

/** Raw open positions for one strategy, for capital accounting. */
function openPositionsOf(strategyId) {
  const out = [];
  for (const p of state.positions.values()) {
    if (p.strategyId === strategyId) out.push(p);
  }
  return out;
}

/** Capital deployed vs available for one strategy. */
export function getCapital(strategyId) {
  return capitalState(openPositionsOf(strategyId), CAPITAL_PER_STRATEGY);
}

/**
 * The price an open position could exit at right now: the best bid for a long,
 * the best ask for a short. A futures contract can go many seconds without a
 * trade while its quotes keep moving, so this keeps open profit live. Falls
 * back to the last trade when there is no quote on that side. Display only —
 * stops and targets still fire on real trades (handleTick).
 */
function markOf(p) {
  const last = state.futPrices.get(p.futKey)?.ltp ?? null;
  const q = state.futQuotes.get(p.futKey);
  const quoted = p.side === "long" ? q?.bid : q?.ask;
  if (Number.isFinite(quoted) && quoted > 0) return { price: quoted, source: p.side === "long" ? "bid" : "ask", last };
  return { price: last, source: last != null ? "last" : null, last };
}

/** Open positions, marked to the price they could exit at (see markOf). */
export function getOpenPositions(strategyId = null) {
  const out = [];
  for (const p of state.positions.values()) {
    if (strategyId && p.strategyId !== strategyId) continue;
    const mark = markOf(p);
    const price = mark.price;
    out.push({
      ...p,
      ltp: mark.last,
      markPrice: price,
      markSource: mark.source,
      unrealisedR: price != null ? engine.unrealisedR(p, price) : null,
      unrealisedPnl:
        price != null
          ? (p.side === "long" ? price - p.entryPrice : p.entryPrice - price) * p.qty
          : null,
    });
  }
  return out.sort((a, b) => b.entryTime - a.entryTime);
}

/** Metrics for one strategy over the live run. */
export function getMetrics(strategyId) {
  return compute(store.tradesChronological({ runId: RUN_ID, strategyId }), {
    signalDays: store.signalsPerDay({ runId: RUN_ID, strategyId }),
  });
}

/** Trade review over a window of IST days (null = all history). */
export function getReport({ days = 7, strategyId = null } = {}) {
  return buildReport(store.tradesChronological({ runId: RUN_ID }), { days, strategyId });
}

/** Stocks a strategy selected recently, taken or skipped. */
export function getSignals(strategyId = null, limit = 200) {
  return store.signals({ runId: RUN_ID, strategyId, limit });
}

/** Realised P&L per trading day. */
export function getDailyPnl(strategyId = null) {
  return store.dailyPnl({ runId: RUN_ID, strategyId });
}

/**
 * A merged, newest-first stream of what the engine has been doing: entries from
 * still-open positions, plus entry AND exit events from closed trades. This is
 * what makes the screen feel live — metrics move slowly, but events are legible
 * the moment they happen.
 */
/** Exit events, from the trade history. Cached per revision. */
function closedActivity(limit = 60) {
  return store.trades({ runId: RUN_ID, limit }).map((t) => ({
    // A stable id keeps React from re-mounting rows as the list shifts, which
    // is what makes a live-updating feed flicker.
    id: `close:${t.id}`,
    kind: "close",
    ts: t.exitTime,
    strategyId: t.strategyId,
    underlying: t.underlying,
    side: t.side,
    price: t.exitPrice,
    exitReason: t.exitReason,
    rMultiple: t.rMultiple,
    netPnl: t.netPnl,
    detail: t.exitReason,
  }));
}

/** Entry events, from the positions still open. */
function openActivity() {
  return [...state.positions.values()].map((p) => ({
    id: `open:${p.id}`,
    kind: "open",
    ts: p.entryTime,
    strategyId: p.strategyId,
    underlying: p.underlying,
    side: p.side,
    price: p.entryPrice,
    detail: `stop ${p.currentStop.toFixed(2)}`,
  }));
}

function mergeActivity(closedEvents, limit = 40) {
  return [...openActivity(), ...closedEvents].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export function getActivity(limit = 40) {
  return mergeActivity(closedActivity(Math.max(limit, 60)), limit);
}

/** Realised side of the totals — history-derived, so cached per revision. */
const istDay = (ms) => new Date(ms + 19800000).toISOString().slice(0, 10);

/** Trades closed today (IST), summed — what the cards show under "Today". */
function todayStats(trades) {
  const today = istDay(Date.now());
  const ts = trades.filter((t) => istDay(t.exitTime) === today);
  return {
    trades: ts.length,
    wins: ts.filter((t) => t.netPnl > 0).length,
    netPnl: ts.reduce((a, t) => a + t.netPnl, 0),
    totalR: ts.reduce((a, t) => a + t.rMultiple, 0),
    costs: ts.reduce((a, t) => a + (t.costs ?? 0), 0),
  };
}

function closedTotals() {
  const trades = store.tradesChronological({ runId: RUN_ID });
  const all = compute(trades, { signalDays: store.signalsPerDay({ runId: RUN_ID }) });
  const today = todayStats(trades);

  return {
    closedTrades: all.trades,
    netPnl: all.netPnl,
    totalR: all.totalR,
    winRate: all.winRate,
    totalCosts: all.totalCosts,
    todayNetPnl: today.netPnl,
    todayTrades: today.trades,
    todayWins: today.wins,
    todayR: today.totalR,
    todayCosts: today.costs,
  };
}

/**
 * Aggregate across every strategy, for the summary strip. The unrealised half
 * is recomputed every push (it moves with the market); the realised half comes
 * from the per-revision cache.
 */
export function getTotals(d = derived()) {
  let openPositions = 0;
  let openR = 0;
  let openPnl = 0;
  for (const p of getOpenPositions()) {
    openPositions++;
    if (Number.isFinite(p.unrealisedR)) openR += p.unrealisedR;
    if (Number.isFinite(p.unrealisedPnl)) openPnl += p.unrealisedPnl;
  }
  return { openPositions, openR, openPnl, ...d.closedTotals };
}

/**
 * History-derived data: metrics, daily P&L, recent picks, and the closed half of
 * the activity stream. All of it is a function of the trade history, so it is
 * computed once per revision instead of on every heartbeat — four full metric
 * passes and ten queries every three seconds was wasteful, and handing the
 * client brand-new objects each time forced it to re-render tables that had not
 * actually changed.
 */
function derived() {
  if (derivedCache.revision === state.revision && derivedCache.value) {
    return derivedCache.value;
  }
  const value = {
    closedEvents: closedActivity(60),
    byStrategy: new Map(
      listStrategies().map((s) => [
        s.id,
        {
          metrics: getMetrics(s.id),
          dailyPnl: getDailyPnl(s.id),
          recentSignals: getSignals(s.id, 60),
          today: todayStats(store.tradesChronological({ runId: RUN_ID, strategyId: s.id })),
        },
      ])
    ),
    closedTotals: closedTotals(),
  };
  derivedCache = { revision: state.revision, value };
  return value;
}

/** Everything the UI needs, for every strategy. */
export function getSnapshot() {
  const d = derived();

  return {
    type: "paper",
    ts: new Date().toISOString(),
    // The client uses this to skip re-rendering panels that cannot have
    // changed — it only moves when a position opens or closes.
    revision: state.revision,
    capitalPerStrategy: CAPITAL_PER_STRATEGY,
    // Today's day type so far (trend-up / trend-down / flat / unclear / early).
    // Decided on CLOSED 3m bars, so it never flickers; the live Nifty numbers
    // below are separate and move with every tick.
    dayType: state.dayTrend ?? null,
    nifty: niftySnapshot(),
    running: state.started,
    marketOpen: isMarketOpen(),
    hasToken: HAS_TOKEN,
    lastEvalTs: state.lastEvalTs,
    error: state.error,
    totals: getTotals(d),
    activity: mergeActivity(d.closedEvents, 40),
    strategies: listStrategies().map((s) => {
      const dd = d.byStrategy.get(s.id);
      return {
        id: s.id,
        name: s.name,
        tagline: s.tagline,
        family: familyOf(s),
        // Rules in plain words plus the exit settings, so the page can explain
        // exactly how this strategy enters and leaves a trade.
        plain: s.plain ?? null,
        dayTypes: s.dayTypes ?? null,
        exits: s.exits,
        regimeFilter: Boolean(s.regimeFilter),
        today: dd.today,
        open: getOpenPositions(s.id),
        capital: getCapital(s.id),
        metrics: dd.metrics,
        dailyPnl: dd.dailyPnl,
        recentSignals: dd.recentSignals,
        selection: s.selection
          ? {
              version: s.selection.version,
              minAlignedRsPct: s.selection.minAlignedRsPct,
              taken: dayStateOf(s.id).taken,
              skippedForQuality: dayStateOf(s.id).skippedForQuality,
            }
          : null,
      };
    }),
  };
}

export function getTrades({ strategyId = null, limit = 100, offset = 0 } = {}) {
  return store.trades({ runId: RUN_ID, strategyId, limit, offset });
}

function broadcast() {
  try {
    broadcaster(getSnapshot());
  } catch (e) {
    logger.error(`broadcast failed: ${e.message}`);
  }
}

export function getStatus() {
  return {
    running: state.started,
    marketOpen: isMarketOpen(),
    hasToken: HAS_TOKEN,
    openPositions: state.positions.size,
    futuresTracked: state.futPrices.size,
    signals: state.counts.signals,
    tradesClosed: state.counts.trades,
    lastEvalTs: state.lastEvalTs,
    error: state.error,
  };
}
