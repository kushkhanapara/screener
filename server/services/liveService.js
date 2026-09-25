import { loadFuturesUniverse, getUniverse, getUnderlyings } from "../data/instruments.js";
import { store3m, store15m } from "../live/candleStore.js";
import { seedAll, prewarmHistory } from "../live/seed.js";
import { UpstoxFeed } from "../live/upstoxFeed.js";
import { getLtp } from "../data/upstox.js";
import { buildRows } from "../core/rows.js";
import { evaluate, hasHistory } from "../core/strategy.js";
import { isMarketOpen, HAS_TOKEN } from "../config.js";
import { istMinutes, istDay, istDateString, sessionBars } from "../core/session.js";
import { getDailyStats } from "./dailyService.js";
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
  prewarmedDate: null, // IST date the pre-market warm-up last completed (or started)
  prewarming: false,
};

// Pre-market warm-up window, IST minutes.
const PREWARM_FROM_MIN = 8 * 60 + 30;
const PREWARM_UNTIL_MIN = 9 * 60 + 15;

let broadcaster = () => {};
export function setBroadcaster(fn) {
  broadcaster = fn || (() => {});
}

/**
 * Feed sharing.
 *
 * Upstox's free tier 403s on a second parallel WebSocket, so there can only ever
 * be ONE connection. This service owns it, and other consumers (the paper
 * engine, which needs near-month futures and the NIFTY index) register their
 * keys and tick handlers here rather than opening their own.
 */
const extraKeyProviders = []; // () => string[]  — consulted at connect time
const priceListeners = []; // (frame) => void — throttled last-traded prices
const tickListeners = []; // (key, ltp, tsMs, qty) => void
const startedHooks = []; // () => void|Promise
const stoppedHooks = []; // () => void

/**
 * Live last-traded prices for the UI.
 *
 * Ticks arrive continuously, but the screener payload is rebuilt once a minute
 * and the paper/shadow views refresh on their own slower cadence, so prices on
 * screen lagged the market by up to a minute. Every tick now updates this map;
 * once a second the keys that changed go out as one small "prices" frame.
 */
const latestPrices = new Map(); // instrument key -> ltp
const dirtyPrices = new Set();
let priceTimer = null;
// Broker-terminal feel: push changed prices four times a second. Only keys that
// moved go in each frame, so this stays small even with 400+ instruments.
const PRICE_PUSH_MS = 250;

/** Receive `{type:"prices", ts, ltp:{key:price}}` frames with changed keys only. */
export function onPrices(fn) {
  priceListeners.push(fn);
}

/** Every known price, for a client that has just connected. */
export function getPricesSnapshot() {
  return { type: "prices", ts: Date.now(), full: true, ltp: Object.fromEntries(latestPrices) };
}

function flushPrices() {
  if (!dirtyPrices.size) return;
  const ltp = {};
  for (const k of dirtyPrices) ltp[k] = latestPrices.get(k);
  dirtyPrices.clear();
  const frame = { type: "prices", ts: Date.now(), ltp };
  for (const fn of priceListeners) {
    try {
      fn(frame);
    } catch {
      /* a bad listener must not stop the others */
    }
  }
}

/** Register instrument keys to include in the single subscription. */
export function registerKeys(fn) {
  extraKeyProviders.push(fn);
}

/** Receive every tick from the shared feed, for any subscribed key. */
export function onTick(fn) {
  tickListeners.push(fn);
}

/** Called once the feed is connected and seeded, each session. */
export function onStarted(fn) {
  startedHooks.push(fn);
}

/** Called when the market closes and the feed is torn down. */
export function onStopped(fn) {
  stoppedHooks.push(fn);
}

/** Cash keys this service aggregates into the 3m/15m stores. */
let cashKeySet = new Set();

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
  maybePrewarm();
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

/**
 * Fetch the immutable history half of the seed before the open.
 *
 * Seeding used to begin at 09:15 and took ~4.5 minutes of rate-limited REST
 * calls, so the session only went live around 09:20 — the OI baseline, the
 * first futures prices and the first-bar entries all ran late. With history on
 * disk, the 09:15 start only reads the cache.
 */
function maybePrewarm(now = Date.now()) {
  if (!HAS_TOKEN || state.prewarming || state.started || state.starting) return;
  const day = istDay(now);
  if (day === 0 || day === 6) return;
  const min = istMinutes(now);
  if (min < PREWARM_FROM_MIN || min >= PREWARM_UNTIL_MIN) return;
  const today = istDateString(now);
  if (state.prewarmedDate === today) return;

  state.prewarming = true;
  state.prewarmedDate = today;
  const t0 = Date.now();
  (async () => {
    if (!getUniverse()) await loadFuturesUniverse();
    const underlyings = getUnderlyings() || [];
    logger.info(`pre-market warm-up: fetching seed history for ${underlyings.length} underlyings…`);
    const warmed = await prewarmHistory(underlyings);
    logger.info(`pre-market warm-up done: ${warmed} underlyings in ${Math.round((Date.now() - t0) / 1000)}s`);
  })()
    .catch((e) => logger.error(`pre-market warm-up failed: ${e.message}`))
    .finally(() => {
      state.prewarming = false;
    });
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
    cashKeySet = new Set(cashKeys);

    logger.info(`seeding ${state.underlyings.length} underlyings (3m + 15m cash)…`);
    const seeded = await seedAll(state.underlyings);

    // Keys other consumers need on the same connection (futures, index).
    const extraKeys = [];
    for (const provider of extraKeyProviders) {
      try {
        extraKeys.push(...(provider() || []));
      } catch (e) {
        logger.error(`key provider failed: ${e.message}`);
      }
    }
    const allKeys = [...new Set([...cashKeys, ...extraKeys])];
    logger.info(
      `seeded ${seeded} underlyings; opening feed (${cashKeys.length} cash + ${extraKeys.length} extra = ${allKeys.length} keys)`
    );

    state.feed = new UpstoxFeed({
      onTick: (key, ltp, tsMs, qty) => {
        // Only cash keys feed the screener's candle stores; futures and index
        // ticks are handled by their own consumers, so they do not bloat these.
        if (cashKeySet.has(key)) {
          store3m.addTick(key, ltp, tsMs, qty);
          store15m.addTick(key, ltp, tsMs, qty);
        }
        state.lastTickTs = tsMs;
        if (Number.isFinite(ltp) && latestPrices.get(key) !== ltp) {
          latestPrices.set(key, ltp);
          dirtyPrices.add(key);
        }
        for (const fn of tickListeners) {
          try {
            fn(key, ltp, tsMs, qty);
          } catch {
            /* one bad listener must not stall the feed */
          }
        }
      },
      onState: ({ connected, error, fatal }) => {
        state.connected = connected;
        if (error) state.lastError = error;
        if (fatal) {
          state.fatal = error;
          logger.error(error);
        }
      },
    });
    state.feed.connect(allKeys);

    state.started = true;
    clearInterval(priceTimer);
    priceTimer = setInterval(flushPrices, PRICE_PUSH_MS);
    await recompute(); // initial set from seeded data
    scheduleMinute();

    for (const fn of startedHooks) {
      try {
        await fn();
      } catch (e) {
        logger.error(`started hook failed: ${e.message}`);
      }
    }
  } finally {
    state.starting = false;
  }
}

function stop() {
  logger.info("market closed — stopping feed");
  // Consumers first, so the paper engine can flatten anything still open while
  // it can still see prices.
  for (const fn of stoppedHooks) {
    try {
      fn();
    } catch (e) {
      logger.error(`stopped hook failed: ${e.message}`);
    }
  }
  if (state.feed) state.feed.disconnect();
  state.feed = null;
  clearInterval(priceTimer);
  priceTimer = null;
  flushPrices();
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

    // Reference prices travel with the row so the browser can work out the
    // change on every tick, instead of waiting a minute for the next rebuild.
    const today = sessionBars(store3m.bars(u.cashKey) ?? [], Date.now());
    scrips.push({
      underlying: u.underlying,
      cashKey: u.cashKey,
      cashLtp,
      prevClose: getDailyStats(u.underlying)?.prevClose ?? null,
      dayOpen: today.length ? today[0].open : null,
      dayHigh: today.length ? Math.max(...today.map((b) => b.high)) : null,
      dayLow: today.length ? Math.min(...today.map((b) => b.low)) : null,
      trend,
      longMatch,
      shortMatch,
      conflict: longMatch && shortMatch, // opposite direction across timeframes
      tf: { "3m": tf3, "15m": tf15 },
      futures: [], // filled below for matched scrips
    });
  }

  // Price the futures of matched scrips. Contracts on the live feed (the near
  // month) use their latest tick; only the rest need the batched REST call,
  // which also keeps this minute loop out of the shared rate-limit queue.
  const futKeys = [];
  for (const s of scrips) {
    for (const f of state.futByUnderlying.get(s.underlying) || []) {
      if (!latestPrices.has(f.key)) futKeys.push(f.key);
    }
  }
  let ltpMap = new Map();
  if (futKeys.length) ltpMap = await getLtp(futKeys).catch(() => new Map());
  for (const s of scrips) {
    s.cashLtp = latestPrices.get(s.cashKey) ?? s.cashLtp;
    s.futures = (state.futByUnderlying.get(s.underlying) || []).map((f) => ({
      key: f.key,
      label: f.label,
      month: f.month,
      expiry: f.expiry,
      ltp: latestPrices.get(f.key) ?? ltpMap.get(f.key) ?? null,
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
    // Set when the feed cannot recover on its own (e.g. a rejected token), so
    // the UI can say so instead of showing a permanent "connecting…".
    fatal: state.fatal ?? null,
  };
}
