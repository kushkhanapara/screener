import { store3m, store15m, storeIndex3m } from "../live/candleStore.js";
import * as volumeHistory from "../live/volumeHistory.js";
import { getNearMonthContracts, getUnderlyings } from "../data/instruments.js";
import { getQuotes, getIntradayCandles } from "../data/upstox.js";
import { buildContext, atrPct } from "../strategies/context.js";
import * as engine from "../paper/engine.js";
import * as store from "../paper/store.js";
import { calibrateContract } from "../paper/charges.js";
import { istMinutes, istDateString, barTimeMs } from "../core/session.js";
import { HAS_TOKEN, isMarketOpen } from "../config.js";
import * as live from "./liveService.js";
import * as daily from "./dailyService.js";
import { SINGLE_SLOT as CFG, SHADOW_RUN_ID, engineStrategy } from "../shadow/config.js";
import { loadBanList } from "../shadow/banList.js";
import { estimateBeta } from "../shadow/beta.js";
import { timeOfDayNorm } from "../shadow/volumeNorm.js";
import { tier1, preGates, finalize, BAR_MS, REJECT_ORDER } from "../shadow/signal.js";
import { outcome } from "../shadow/summary.js";
import { log } from "../logger.js";

const logger = log("shadow");

const DAY_MS = 24 * 60 * 60 * 1000;
const BAN_RETRY_MS = 15 * 60 * 1000;
const TRADING_DAYS_PER_MONTH = 21;

/**
 * Shadow logging for the single-slot strategy (plan phase B).
 *
 * Runs the full funnel on every closed 3-minute bar and records what it would
 * have done: every rejection with a reason code, every candidate that cleared
 * relative strength, and — for each rank-1 selection — a virtual trade managed
 * by the same exit engine as paper trading. Virtual trades live under their own
 * run id, use no paper capital, and never appear in paper results.
 */

const state = {
  started: false,
  timer: null,
  sessionDate: null,
  lastBar: 0,
  ban: { status: "unavailable", tradeDate: null, symbols: new Set(), fetchError: null },
  banCheckedAt: 0,
  betas: new Map(), // cashKey -> {beta, n, fallback}
  oiBaseline: new Map(), // futKey -> {oi, ltp, at}
  oiBaselineAt: null,
  streaks: new Map(), // underlying -> {barTime, side, streak}
  futPrices: new Map(),
  positions: new Map(),
  last: null,
  error: null,
};

let busy = false;

const round = (v, dp = 3) => {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

const dayStart = (isoDate) => Date.parse(`${isoDate}T00:00:00+05:30`);

export function init() {
  store.init();
  store.createRun({
    id: SHADOW_RUN_ID,
    kind: "shadow",
    strategyId: CFG.id,
    params: { configVersion: CFG.version },
  });
  for (const p of store.openPositions(SHADOW_RUN_ID)) state.positions.set(p.id, p);

  live.onTick(handleTick);
  live.onStarted(onSessionStart);
  live.onStopped(onSessionEnd);
  logger.info(`shadow logging ready — ${CFG.name} v${CFG.version}`);
}

function handleTick(key, ltp) {
  if (typeof key !== "string" || !key.startsWith("NSE_FO|")) return;
  state.futPrices.set(key, ltp);
  const now = Date.now();
  for (const p of [...state.positions.values()]) {
    if (p.futKey !== key) continue;
    const { exit, position } = engine.checkExit(p, engineStrategy, ltp, now);
    if (exit) closeVirtual(position, exit.price, exit.reason, now);
    else if (position !== p) {
      state.positions.set(position.id, position);
      store.updatePosition(position);
    }
  }
}

function closeVirtual(position, price, reason, now) {
  const trade = engine.closePosition(position, price, reason, now);
  try {
    store.commitClose(position.id, trade);
  } catch (e) {
    state.error = `failed to record virtual trade: ${e.message}`;
    logger.error(state.error);
    return;
  }
  state.positions.delete(position.id);
}

async function refreshBanList(now, force) {
  if (!force) {
    if (state.ban.status === "current" && state.ban.tradeDate === istDateString(now)) return;
    if (now - state.banCheckedAt < BAN_RETRY_MS) return;
  }
  state.banCheckedAt = now;
  try {
    state.ban = await loadBanList({ now });
  } catch (e) {
    state.ban = { ...state.ban, fetchError: String(e?.message || e) };
  }
}

function computeBetas(now) {
  const indexBars = storeIndex3m.closedBars(CFG.indexKey, now);
  state.betas.clear();
  for (const u of getUnderlyings() || []) {
    state.betas.set(u.cashKey, estimateBeta(store3m.bars(u.cashKey), indexBars, CFG.beta));
  }
}

async function onSessionStart() {
  const now = Date.now();
  state.started = true;
  state.error = null;
  state.sessionDate = istDateString(now);
  state.lastBar = 0;
  state.streaks.clear();
  state.oiBaseline.clear();
  state.oiBaselineAt = null;
  state.last = null;

  // A server left running across days would otherwise screen on stale ATR percentiles.
  const ds = daily.status();
  if (!ds.fetching && (!ds.updatedAt || istDateString(Date.parse(ds.updatedAt)) !== state.sessionDate)) {
    Promise.resolve(daily.refresh()).catch(() => {});
  }

  await refreshBanList(now, true);
  computeBetas(now);

  clearInterval(state.timer);
  state.timer = setInterval(() => {
    tick().catch((e) => {
      state.error = String(e?.message || e);
      logger.error(state.error);
    });
  }, 20_000);

  const fallback = [...state.betas.values()].filter((b) => b.fallback).length;
  logger.info(
    `shadow session ${state.sessionDate}: ban list ${state.ban.status} (${state.ban.symbols.size} names), ` +
      `betas for ${state.betas.size} names (${fallback} on fallback)`
  );
}

function onSessionEnd() {
  const now = Date.now();
  for (const p of [...state.positions.values()]) {
    closeVirtual(p, state.futPrices.get(p.futKey) ?? p.entryPrice, "squareoff", now);
  }
  state.started = false;
  clearInterval(state.timer);
  state.timer = null;
}

function enforceSquareOff(now) {
  if (istMinutes(now) < CFG.exits.squareOffMin) return;
  for (const p of [...state.positions.values()]) {
    closeVirtual(p, state.futPrices.get(p.futKey) ?? p.entryPrice, "squareoff", now);
  }
}

/** OI change is measured from the first snapshot of the session, so take it as early as possible. */
async function captureBaseline(now) {
  const contracts = getNearMonthContracts();
  const keys = (getUnderlyings() || []).map((u) => contracts.get(u.underlying)?.key).filter(Boolean);
  if (!keys.length) return;
  const quotes = await getQuotes(keys);
  for (const [k, q] of quotes) {
    if (!state.oiBaseline.has(k) && q.oi > 0 && q.ltp > 0) state.oiBaseline.set(k, { oi: q.oi, ltp: q.ltp, at: now });
  }
  if (state.oiBaseline.size) state.oiBaselineAt = now;
}

async function tick(now = Date.now()) {
  if (!HAS_TOKEN || !state.started || busy) return;
  busy = true;
  try {
    enforceSquareOff(now);

    if (!state.oiBaselineAt && istMinutes(now) >= CFG.openingRange.startMin) {
      await captureBaseline(now).catch((e) => {
        state.error = `OI baseline: ${e.message}`;
      });
    }

    const barTime = Math.floor(now / BAR_MS) * BAR_MS - BAR_MS;
    const closeMin = istMinutes(barTime + BAR_MS);
    if (barTime <= state.lastBar) return;
    if (closeMin < CFG.entryStartMin || closeMin >= CFG.exits.noEntryAfterMin) return;

    await refreshBanList(now, false);
    if (await evaluateBar(barTime, now)) state.lastBar = barTime;
  } finally {
    busy = false;
  }
}

function openingRange(indexBars, now) {
  const day = istDateString(now);
  const bars = indexBars.filter((b) => {
    const t = barTimeMs(b.time);
    const m = istMinutes(t);
    return istDateString(t) === day && m >= CFG.openingRange.startMin && m < CFG.openingRange.endMin;
  });
  const expected = (CFG.openingRange.endMin - CFG.openingRange.startMin) / 3;
  if (bars.length < expected) return null;
  return { high: Math.max(...bars.map((b) => b.high)), low: Math.min(...bars.map((b) => b.low)) };
}

async function volumeFor(cashKey, barTime) {
  // Seeded history, not the rolling store: the store keeps only ~4 sessions.
  const norm = timeOfDayNorm(volumeHistory.bars(cashKey), istMinutes(barTime), state.sessionDate, {
    minSessions: CFG.minNormSessions,
  });
  let volume = null;
  try {
    const candles = await getIntradayCandles(cashKey, "minutes", 3);
    const bar = candles.find((k) => barTimeMs(k.time) === barTime);
    if (bar && Number.isFinite(Number(bar.volume))) volume = Number(bar.volume);
  } catch {
    /* recorded as volume_missing */
  }
  const volumeRatio = norm.avg && volume != null ? volume / norm.avg : null;
  return { volumeChecked: true, volume, volumeRatio, normSessions: norm.sessions };
}

function rankBy(items, valueOf, field) {
  [...items].sort((a, b) => valueOf(b) - valueOf(a)).forEach((it, i) => (it[field] = i + 1));
}

function manageOnBarClose(quotes, now) {
  for (const p of [...state.positions.values()]) {
    const price = state.futPrices.get(p.futKey) ?? quotes.get(p.futKey)?.ltp;
    if (!Number.isFinite(price)) continue;
    const { exit, position } = engine.manageBarClose(p, engineStrategy, price, now);
    if (exit) closeVirtual(position, exit.price, exit.reason, now);
    else {
      state.positions.set(position.id, position);
      store.updatePosition(position);
    }
  }
}

async function evaluateBar(barTime, now) {
  const contracts = getNearMonthContracts();
  const underlyings = getUnderlyings() || [];
  if (!underlyings.length) return false;

  let quotes;
  try {
    quotes = await getQuotes(underlyings.map((u) => contracts.get(u.underlying)?.key).filter(Boolean));
  } catch (e) {
    state.error = `quotes failed: ${e.message}`;
    logger.warn(state.error);
    return false;
  }

  for (const [k, q] of quotes) {
    if (!state.oiBaseline.has(k) && q.oi > 0 && q.ltp > 0) state.oiBaseline.set(k, { oi: q.oi, ltp: q.ltp, at: now });
  }
  if (!state.oiBaselineAt && state.oiBaseline.size) state.oiBaselineAt = now;

  manageOnBarClose(quotes, now);

  const indexBars = storeIndex3m.closedBars(CFG.indexKey, now);
  const or = openingRange(indexBars, now);
  const indexClose = indexBars.length ? indexBars[indexBars.length - 1].close : null;

  const rejects = {};
  const bump = (code) => (rejects[code] = (rejects[code] || 0) + 1);
  const missingDaily = [];
  const missingBars = [];

  const eligible = [];
  for (const u of underlyings) {
    const c = contracts.get(u.underlying);
    const q = c ? quotes.get(c.key) : null;
    const t = tier1(c, q, CFG);
    if (!t.eligible) {
      bump(t.rejectCode);
      state.streaks.delete(u.underlying);
      continue;
    }
    eligible.push({ u, c, q, margin: t.margin, notional: t.notional });
  }

  // Liquidity is recorded, not gated, so the Tier 1 cutoff can be chosen from evidence.
  rankBy(eligible, (e) => (e.q.volume || 0) * e.q.ltp, "futTurnoverRank");
  rankBy(eligible, (e) => daily.getDailyStats(e.u.underlying)?.avgTurnover20 ?? 0, "cashTurnoverRank");

  const detail = [];
  const pre = [];

  for (const e of eligible) {
    const { u, c, q } = e;
    const bars3 = store3m.closedBars(u.cashKey, now);
    if (bars3.length < 60 || store3m.stalenessBuckets(u.cashKey, now) > 3) {
      bump("no_data");
      missingBars.push(u.underlying);
      state.streaks.delete(u.underlying);
      continue;
    }

    const dailyStats = daily.getDailyStats(u.underlying);
    const ctx = buildContext({
      underlying: u.underlying,
      cashKey: u.cashKey,
      bars3m: bars3,
      bars15m: store15m.closedBars(u.cashKey, now),
      indexBars3m: indexBars,
      daily: dailyStats,
      now,
    });
    const close = bars3[bars3.length - 1].close;
    const beta = state.betas.get(u.cashKey) ?? { beta: 1, n: 0, fallback: true };
    const indexPct = ctx.index?.pctFromOpen ?? null;
    const residualPct =
      ctx.pctFromOpen != null && indexPct != null ? ctx.pctFromOpen - beta.beta * indexPct : null;
    const base = state.oiBaseline.get(c.key);
    const mid = q.bid && q.ask ? (q.bid + q.ask) / 2 : null;

    const inp = {
      banned: state.ban.status === "unavailable" ? null : state.ban.symbols.has(u.underlying),
      atrPercentile: dailyStats?.atrPctPercentile ?? null,
      atrPct3m: atrPct(ctx.atr?.["3m"], close),
      residualPct,
      indexClose,
      orHigh: or?.high ?? null,
      orLow: or?.low ?? null,
      hasOiBaseline: Boolean(base),
      oiChangePct: base && q.oi > 0 ? ((q.oi - base.oi) / base.oi) * 100 : null,
      futPriceChangePct: base && base.ltp > 0 ? ((q.ltp - base.ltp) / base.ltp) * 100 : null,
    };

    const inputs = {
      ltp: q.ltp,
      lotSize: c.lotSize,
      notional: round(e.notional, 0),
      margin: round(e.margin, 0),
      residualPct: round(residualPct),
      pctFromOpen: round(ctx.pctFromOpen),
      indexPctFromOpen: round(indexPct),
      beta: round(beta.beta),
      betaReturns: beta.n,
      betaFallback: beta.fallback,
      atrPct3m: round(inp.atrPct3m),
      atrPercentile: round(inp.atrPercentile, 1),
      oiChangePct: round(inp.oiChangePct),
      futPriceChangePct: round(inp.futPriceChangePct),
      spreadPct: mid ? round(((q.ask - q.bid) / mid) * 100, 4) : null,
      futTurnoverRank: e.futTurnoverRank,
      cashTurnoverRank: e.cashTurnoverRank,
      universeSize: eligible.length,
    };

    const p = preGates(inp, CFG);
    if (!p.pass) {
      bump(p.rejectCode);
      if (p.rejectCode === "no_daily_data") missingDaily.push(u.underlying);
      state.streaks.delete(u.underlying);
      if (p.passedRs) {
        detail.push({ underlying: u.underlying, side: p.side, passed: false, rejectCode: p.rejectCode, gates: p.gates, inputs });
      }
      continue;
    }
    pre.push({ ...e, ctx, close, p, inputs });
  }

  // Volume is the one per-name API call: last in the funnel, strongest candidates first.
  pre.sort((a, b) => b.p.partial - a.p.partial);
  const passing = [];
  let checked = 0;
  for (const item of pre) {
    let vol = { volumeChecked: false };
    if (checked < CFG.volumeCheckCap) {
      checked++;
      vol = await volumeFor(item.u.cashKey, barTime);
    }
    const f = finalize(item.p, vol, state.streaks.get(item.u.underlying), barTime, CFG);
    if (f.nextState) state.streaks.set(item.u.underlying, f.nextState);
    else state.streaks.delete(item.u.underlying);

    item.f = f;
    item.inputs.volume = vol.volume ?? null;
    item.inputs.volumeRatio = round(vol.volumeRatio);
    item.inputs.normSessions = vol.normSessions ?? null;
    item.inputs.streak = f.streak || null;

    if (f.pass) passing.push(item);
    else bump(f.rejectCode);
  }

  passing.sort((a, b) => b.f.score - a.f.score);
  passing.forEach((it, i) => (it.rank = i + 1));

  for (const it of pre) {
    detail.push({
      underlying: it.u.underlying,
      side: it.f.side,
      passed: it.f.pass,
      rejectCode: it.f.rejectCode,
      rank: it.rank ?? null,
      score: it.f.score,
      gates: it.f.gates,
      components: it.f.components ?? {},
      inputs: it.inputs,
    });
  }

  const top = passing[0] ?? null;
  const selection = top && engine.entriesAllowed(engineStrategy, now) ? await openVirtual(top, barTime, now) : null;

  const stats = {
    configId: CFG.id,
    configVersion: CFG.version,
    sessionDate: state.sessionDate,
    barTime,
    eligible: eligible.length,
    passed: passing.length,
    topScore: top ? round(top.f.score, 4) : null,
    topUnderlying: top?.u.underlying ?? null,
    rejects,
    meta: {
      banStatus: state.ban.status,
      banTradeDate: state.ban.tradeDate,
      bannedCount: state.ban.symbols.size,
      oiBaselineAt: state.oiBaselineAt,
      preVolumeCandidates: pre.length,
      volumeChecked: checked,
      volumeCapHit: pre.length > CFG.volumeCheckCap,
      openingRange: or,
      selection,
      // Names, not just counts, so a data gap can be chased down afterwards.
      ...(missingDaily.length ? { noDailyData: missingDaily } : {}),
      ...(missingBars.length ? { noData: missingBars.slice(0, 50) } : {}),
    },
  };

  store.recordShadowBar(stats, detail);
  state.last = { stats, evals: sortEvals(detail) };
  return true;
}

function sortEvals(rows) {
  return [...rows].sort(
    (a, b) =>
      Number(b.passed) - Number(a.passed) ||
      (a.rank ?? 1e9) - (b.rank ?? 1e9) ||
      (b.score ?? -1) - (a.score ?? -1)
  );
}

async function openVirtual(item, barTime, now) {
  const { u, c, q, ctx, close, f, inputs, rank } = item;
  for (const p of state.positions.values()) {
    if (p.underlying === u.underlying) return { underlying: u.underlying, skipped: "already tracked" };
  }

  const fill = state.futPrices.get(c.key) ?? q.ltp;
  const atr3 = ctx.atr?.["3m"];
  if (!(fill > 0) || !(atr3 > 0) || !(close > 0)) return { underlying: u.underlying, skipped: "no price" };

  const chargeRates = await calibrateContract({ instrumentKey: c.key, qty: c.lotSize, price: fill }).catch(
    () => null
  );

  let position;
  try {
    position = engine.openPosition({
      runId: SHADOW_RUN_ID,
      strategy: engineStrategy,
      signal: {
        side: f.side,
        reasons: ["residual strength", "OI building", "volume above norm", "persistent"],
        score: f.score,
      },
      underlying: u.underlying,
      futKey: c.key,
      futLabel: c.label,
      fillPrice: fill,
      atr: atr3 * (fill / close),
      lotSize: c.lotSize,
      now,
      signalBarTime: barTime,
      cashPriceAtSignal: close,
      chargeRates,
      features: {
        configId: CFG.id,
        configVersion: CFG.version,
        rank,
        score: round(f.score, 4),
        components: f.components,
        ...inputs,
      },
    });
    position = store.insertPositionClaimingSlot(position);
  } catch (e) {
    return { underlying: u.underlying, skipped: String(e?.message || e) };
  }

  state.positions.set(position.id, position);
  logger.info(
    `${position.slotTaken ? "SLOT" : "missed"} ${f.side} ${u.underlying} @ ${position.entryPrice.toFixed(2)} ` +
      `score ${f.score.toFixed(3)}`
  );
  return { underlying: u.underlying, side: f.side, positionId: position.id, slotTaken: position.slotTaken };
}

// ── Read models ────────────────────────────────────────────────────────

/**
 * The config version whose data the views show: the current one once it has
 * logged anything, otherwise the most recent version that did. Right after a
 * version bump that keeps the last session reviewable, clearly labelled, rather
 * than showing an empty tab until the next session.
 */
function displayVersion() {
  if (store.latestShadowBar(CFG.id, CFG.version)) return CFG.version;
  return store.latestShadowBar(CFG.id)?.configVersion ?? CFG.version;
}

/** Live state plus the most recent recorded bar (from the database after a restart). */
export function getSnapshot() {
  const version = displayVersion();
  const latest = store.latestShadowBar(CFG.id, version);
  let last = state.last;
  if (!last && latest) {
    last = { stats: latest, evals: store.shadowEvals({ configId: CFG.id, barTime: latest.barTime }) };
  }

  const sessionDate = latest?.sessionDate ?? state.sessionDate;
  const sessionBars = sessionDate
    ? store.shadowBars({ configId: CFG.id, version, from: dayStart(sessionDate) })
    : [];
  const sessionRejects = {};
  for (const b of sessionBars) {
    for (const [k, v] of Object.entries(b.rejects)) sessionRejects[k] = (sessionRejects[k] || 0) + v;
  }

  const open = [...state.positions.values()].map(({ chargeRates, ...p }) => {
    const ltp = state.futPrices.get(p.futKey) ?? null;
    return { ...p, ltp, unrealisedR: ltp != null ? engine.unrealisedR(p, ltp) : null };
  });

  return {
    config: {
      id: CFG.id,
      version: CFG.version,
      dataVersion: version,
      name: CFG.name,
      weights: CFG.weights,
      persistenceBars: CFG.persistenceBars,
      volumeCheckCap: CFG.volumeCheckCap,
      // Every number the rules card on the Shadow tab explains.
      capital: CFG.capital,
      minPrice: CFG.minPrice,
      atrPercentile: CFG.atrPercentile,
      minStopPct: CFG.minStopPct,
      minResidualPct: CFG.minResidualPct,
      minVolumeRatio: CFG.minVolumeRatio,
      minNormSessions: CFG.minNormSessions,
      entryStartMin: CFG.entryStartMin,
      exits: CFG.exits,
    },
    running: state.started,
    marketOpen: isMarketOpen(),
    hasToken: HAS_TOKEN,
    ban: {
      status: state.ban.status,
      tradeDate: state.ban.tradeDate,
      symbols: [...state.ban.symbols].sort(),
      fetchError: state.ban.fetchError ?? null,
    },
    oiBaselineAt: state.oiBaselineAt,
    last,
    session: {
      date: sessionDate,
      bars: sessionBars.length,
      barsWithCandidate: sessionBars.filter((b) => b.passed > 0).length,
      rejects: sessionRejects,
    },
    open,
    recentTrades: store
      .trades({ runId: SHADOW_RUN_ID, limit: 200 })
      .filter((t) => t.features?.configVersion === version)
      .slice(0, 50),
    rejectOrder: REJECT_ORDER,
    error: state.error,
  };
}

/** Multi-day review: how often a candidate clears each score floor, and what those picks did. */
export function getSummary({ days = 30 } = {}) {
  const now = Date.now();
  const from = days ? dayStart(istDateString(now)) - (days - 1) * DAY_MS : null;
  const version = displayVersion();
  const bars = store.shadowBars({ configId: CFG.id, version, from });

  const byDay = new Map();
  const rejectTotals = {};
  for (const b of bars) {
    const d = byDay.get(b.sessionDate) ?? { day: b.sessionDate, bars: 0, barsWithCandidate: 0, maxScore: null };
    d.bars++;
    if (b.passed > 0) d.barsWithCandidate++;
    if (b.topScore != null && (d.maxScore == null || b.topScore > d.maxScore)) d.maxScore = b.topScore;
    byDay.set(b.sessionDate, d);
    for (const [k, v] of Object.entries(b.rejects)) rejectTotals[k] = (rejectTotals[k] || 0) + v;
  }
  const sessions = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  const trades = store
    .tradesChronological({ runId: SHADOW_RUN_ID })
    .filter((t) => t.features?.configVersion === version)
    .filter((t) => from == null || t.exitTime >= from);

  const floors = [0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map((floor) => {
    const qualifying = sessions.filter((s) => s.maxScore != null && s.maxScore >= floor).length;
    return {
      floor,
      daysWithCandidate: qualifying,
      perMonth: sessions.length ? (qualifying / sessions.length) * TRADING_DAYS_PER_MONTH : 0,
      ...outcome(trades.filter((t) => (t.features?.score ?? 0) >= floor)),
    };
  });

  return {
    window: { days: days ?? null, from, label: days ? `Last ${days} days` : "All history" },
    version,
    sessions: sessions.length,
    bars: bars.length,
    daily: sessions,
    floors,
    rejectTotals,
    rejectOrder: REJECT_ORDER,
    outcomes: {
      all: outcome(trades),
      slot: outcome(trades.filter((t) => t.slotTaken === true)),
      missed: outcome(trades.filter((t) => t.slotTaken === false)),
    },
    targetNetPct: 0.25,
  };
}

export function getStatus() {
  return {
    running: state.started,
    marketOpen: isMarketOpen(),
    banStatus: state.ban.status,
    oiBaselineAt: state.oiBaselineAt,
    lastBarTime: state.last?.stats.barTime ?? null,
    openVirtual: state.positions.size,
    error: state.error,
  };
}
