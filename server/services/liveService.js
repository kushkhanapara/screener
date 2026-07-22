import { loadFuturesUniverse, getUniverse, getUnderlyings } from "../data/instruments.js";
import { store3m, store15m } from "../live/candleStore.js";
import { seedAll } from "../live/seed.js";
import { UpstoxFeed } from "../live/upstoxFeed.js";
import { getLtp } from "../data/upstox.js";
import { buildRows } from "../core/rows.js";
import { evaluate, hasHistory } from "../core/strategy.js";
import { isMarketOpen, HAS_TOKEN } from "../config.js";
import { log } from "../logger.js";

const logger = log("live");

/**
 * Live intraday orchestrator (equity-chart, two-sided).
 *
 * Runs ONLY during market hours. Subscribes the CASH keys only (the strategy is
 * evaluated on the equity chart), aggregates ticks into 3-minute AND 15-minute
 * candles, and every minute recomputes Long+Short for both timeframes across all
 * underlyings. Futures LTPs (all active expiries) are fetched via a single batched
 * market-quote call for the MATCHED underlyings only, then broadcast.
 */

const state = {
  underlyings: [], // [{ underlying, cashKey }]
  futByUnderlying: new Map(), // underlying -> [{ key, label, month, expiry, expiryMs }]
  feed: null,
  starting: false,
  started: false,
  connected: false,
  lastTickTs: null,
  lastError: null,
  matchLong: new Set(), // underlyings currently matching Long (either timeframe)
  matchShort: new Set(),
  lastPayload: emptyPayload(),
  minuteTimer: null,
  minuteTimeout: null,
};

let broadcaster = () => {};
export function setBroadcaster(fn) {
  broadcaster = fn || (() => {});
}

function emptyPayload() {
  return {
    type: "update",
    ts: null,
    scrips: [],
    counts: { long: 0, short: 0 },
    entered: { long: [], short: [] },
    exited: { long: [], short: [] },
  };
}

function monthLabel(ms) {
  return new Date(ms).toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
}

/** Begin the supervisor loop that starts/stops the feed around market hours. */
export function init() {
  supervise();
  setInterval(supervise, 30 * 1000);
}

function supervise() {
  const open = isMarketOpen();
  if (open && HAS_TOKEN && !state.started && !state.starting) {
    start().catch((e) => {
      state.lastError = String(e.message || e);
      logger.error(state.lastError);
    });
  } else if (!open && state.started) {
    stop();
  }
}

async function start() {
  state.starting = true;
  state.lastError = null;
  try {
    if (!getUniverse()) await loadFuturesUniverse();
    state.underlyings = getUnderlyings() || [];

    // Group active futures contracts by underlying (for LTP display).
    state.futByUnderlying = new Map();
    for (const c of getUniverse() || []) {
      if (!state.futByUnderlying.has(c.underlying)) state.futByUnderlying.set(c.underlying, []);
      state.futByUnderlying.get(c.underlying).push({
        key: c.key,
        label: c.label,
        month: monthLabel(c.expiryMs),
        expiry: c.expiry,
        expiryMs: c.expiryMs,
      });
    }
    for (const list of state.futByUnderlying.values()) list.sort((a, b) => a.expiryMs - b.expiryMs);

    const cashKeys = state.underlyings.map((u) => u.cashKey).filter(Boolean);

    logger.info(`seeding ${state.underlyings.length} underlyings (3m + 15m cash)…`);
    const seeded = await seedAll(state.underlyings);
    logger.info(`seeded ${seeded} underlyings; opening cash feed (${cashKeys.length} keys)`);

    state.feed = new UpstoxFeed({
      onTick: (key, ltp, tsMs, qty) => {
        store3m.addTick(key, ltp, tsMs, qty);
        store15m.addTick(key, ltp, tsMs, qty);
        state.lastTickTs = tsMs;
      },
      onState: ({ connected, error }) => {
        state.connected = connected;
        if (error) state.lastError = error;
      },
    });
    state.feed.connect(cashKeys);

    state.started = true;
    await recompute(); // initial set from seeded data
    scheduleMinute();
  } finally {
    state.starting = false;
  }
}

function stop() {
  logger.info("market closed — stopping feed");
  if (state.feed) state.feed.disconnect();
  state.feed = null;
  state.started = false;
  state.connected = false;
  clearTimeout(state.minuteTimeout);
  clearInterval(state.minuteTimer);
  state.minuteTimer = null;
}

/** Fire recompute a couple seconds after each minute boundary. */
function scheduleMinute() {
  const now = Date.now();
  const msToNext = 60000 - (now % 60000) + 2000;
  state.minuteTimeout = setTimeout(() => {
    recompute().catch((e) => {
      state.lastError = String(e.message || e);
      logger.error(state.lastError);
    });
    state.minuteTimer = setInterval(
      () => recompute().catch((e) => (state.lastError = String(e.message || e))),
      60 * 1000
    );
  }, msToNext);
}

/** Evaluate one timeframe for a cash key. */
function evalTimeframe(store, cashKey) {
  const rows = buildRows(store.bars(cashKey));
  if (!rows) return { dataLimited: true, long: false, short: false };
  const l = rows.latest;
  return {
    long: evaluate(l, "long").pass,
    short: evaluate(l, "short").pass,
    dataLimited: !hasHistory(l), // SMA200 unavailable -> can't confirm trend
    close: l.close,
    rsi14: l.rsi14,
    rsiSignal: l.rsiSignal,
    macd: l.macd,
    macdSignal: l.macdSignal,
    macdHist: l.macdHist,
    sma34: l.sma34,
    sma200: l.ma200,
  };
}

function trendOf(tf) {
  if (!tf || tf.dataLimited || tf.close == null) return "neutral";
  const up = tf.close > tf.sma34 && tf.macd > tf.macdSignal;
  const down = tf.close < tf.sma34 && tf.macd < tf.macdSignal;
  return up ? "bullish" : down ? "bearish" : "neutral";
}

/** Recompute Long/Short across both timeframes, price matched futures, broadcast. */
async function recompute() {
  const scrips = [];
  const matchLong = new Set();
  const matchShort = new Set();

  for (const u of state.underlyings) {
    const tf3 = evalTimeframe(store3m, u.cashKey);
    const tf15 = evalTimeframe(store15m, u.cashKey);

    const longMatch = Boolean(tf3.long || tf15.long);
    const shortMatch = Boolean(tf3.short || tf15.short);
    if (!longMatch && !shortMatch) continue;

    if (longMatch) matchLong.add(u.underlying);
    if (shortMatch) matchShort.add(u.underlying);

    const cashLtp = tf3.close ?? tf15.close ?? null;
    const trend = trendOf(tf15.dataLimited ? tf3 : tf15);

    scrips.push({
      underlying: u.underlying,
      cashKey: u.cashKey,
      cashLtp,
      trend,
      longMatch,
      shortMatch,
      conflict: longMatch && shortMatch, // opposite direction across timeframes
      tf: { "3m": tf3, "15m": tf15 },
      futures: [], // filled below for matched scrips
    });
  }

  // Price the futures of matched scrips only (single batched LTP call).
  const futKeys = [];
  for (const s of scrips) {
    for (const f of state.futByUnderlying.get(s.underlying) || []) futKeys.push(f.key);
  }
  let ltpMap = new Map();
  if (futKeys.length) ltpMap = await getLtp(futKeys).catch(() => new Map());
  for (const s of scrips) {
    s.futures = (state.futByUnderlying.get(s.underlying) || []).map((f) => ({
      label: f.label,
      month: f.month,
      expiry: f.expiry,
      ltp: ltpMap.get(f.key) ?? null,
    }));
  }

  scrips.sort((a, b) => a.underlying.localeCompare(b.underlying));

  const entered = { long: diffNew(matchLong, state.matchLong), short: diffNew(matchShort, state.matchShort) };
  const exited = { long: diffNew(state.matchLong, matchLong), short: diffNew(state.matchShort, matchShort) };
  state.matchLong = matchLong;
  state.matchShort = matchShort;

  state.lastPayload = {
    type: "update",
    ts: new Date().toISOString(),
    scrips,
    counts: { long: matchLong.size, short: matchShort.size },
    entered,
    exited,
  };
  broadcaster(state.lastPayload);
}

/** Members of `a` not in `b`. */
function diffNew(a, b) {
  const out = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  return out;
}

/** Current full snapshot, sent immediately to newly-connected WS clients. */
export function getSnapshot() {
  return { ...state.lastPayload, entered: { long: [], short: [] }, exited: { long: [], short: [] } };
}

export function getStatus() {
  return {
    connected: state.connected,
    marketOpen: isMarketOpen(),
    hasToken: HAS_TOKEN,
    lastTickTs: state.lastTickTs,
    subscribed: state.started ? state.underlyings.length : 0,
    counts: state.lastPayload.counts,
    error: state.lastError,
  };
}
