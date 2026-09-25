import { ensureFreshUniverse, getUniverse, getUnderlyings } from "../data/instruments.js";
import { store3m, store15m, storeIndex3m } from "../live/candleStore.js";
import { seedAll, prewarmHistory } from "../live/seed.js";
import { UpstoxFeed } from "../live/upstoxFeed.js";
import { getLtp, getIntradayCandles } from "../data/upstox.js";
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
  feedOpenedAt: null, // when this session's feed was opened
  seededAt: null, // when seeding finished; bars starting after it are purely tick-built
  allKeys: [], // everything the single feed connection subscribes
  lastTickAt: null, // WALL-CLOCK time of the last trade message (lastTickTs is the exchange stamp)
  stale: false, // true while the feed is open but has stopped delivering
  staleSince: null,
  reconnects: 0,
  repairing: false,
  repairsPending: 0, // blocking repairs scheduled or running: no new entries meanwhile
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
const quoteListeners = []; // (key, bid, ask, tsMs) => void — futures best bid/ask
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
// Futures best bid/ask. Quotes move between trades, so they are what keeps an
// open position's price live when its contract has not traded for a while.
const latestQuotes = new Map(); // instrument key -> [bid, ask]
const dirtyQuotes = new Set();
let priceTimer = null;
// Broker-terminal feel: push changed prices four times a second. Only keys that
// moved go in each frame, so this stays small even with 400+ instruments.
const PRICE_PUSH_MS = 250;

/** Receive `{type:"prices", ts, ltp:{key:price}, quote?:{key:[bid,ask]}}` frames with changed keys only. */
export function onPrices(fn) {
  priceListeners.push(fn);
}

/** Every known price, for a client that has just connected. */
export function getPricesSnapshot() {
  return {
    type: "prices",
    ts: Date.now(),
    full: true,
    ltp: Object.fromEntries(latestPrices),
    quote: Object.fromEntries(latestQuotes),
  };
}

function flushPrices() {
  if (!dirtyPrices.size && !dirtyQuotes.size) return;
  const ltp = {};
  for (const k of dirtyPrices) ltp[k] = latestPrices.get(k);
  dirtyPrices.clear();
  const frame = { type: "prices", ts: Date.now(), ltp };
  if (dirtyQuotes.size) {
    frame.quote = {};
    for (const k of dirtyQuotes) frame.quote[k] = latestQuotes.get(k);
    dirtyQuotes.clear();
  }
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

/** Last traded price the feed has seen for a key, or undefined. */
export function latestPrice(key) {
  return latestPrices.get(key);
}

/** Receive every best bid/ask change for the futures (full-mode) keys. */
export function onQuote(fn) {
  quoteListeners.push(fn);
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
    await ensureFreshUniverse();
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
    await ensureFreshUniverse();
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
    // Feed FIRST, history second. Seeding 211 names takes minutes; with the
    // feed waiting on it, a restart left prices frozen and open positions
    // unwatched for that whole time. Ticks that arrive meanwhile build bars the
    // seed merges into (CandleStore.seed), and paper stops run on every futures
    // tick from the moment the feed opens.
    logger.info(
      `opening feed (${cashKeys.length} cash + ${extraKeys.length} extra = ${allKeys.length} keys), then seeding`
    );

    state.allKeys = allKeys;
    openFeed();
    state.feedOpenedAt = Date.now();
    clearInterval(priceTimer);
    priceTimer = setInterval(flushPrices, PRICE_PUSH_MS);

    // Screening and new entries wait for history: they need it to be right.
    logger.info(`seeding ${state.underlyings.length} underlyings (3m + 15m cash)…`);
    const seeded = await seedAll(state.underlyings);
    logger.info(`seeded ${seeded} underlyings`);
    state.seededAt = Date.now();
    // Bars that were forming while the feed opened and seeding ran are part
    // REST, part ticks. Replace them with the exchange's own once those have
    // settled. New entries wait for the 3m pass; the 15m pass runs in the
    // background when the 15m bar that was forming has closed and settled.
    const closeOf = (ms, bar) => Math.floor(ms / bar) * bar + bar;
    scheduleRepair("startup (3m)", closeOf(state.seededAt, BAR_3M_MS) + REST_SETTLE_MS + 5_000, true);
    scheduleRepair("startup (15m)", closeOf(state.seededAt, BAR_15M_MS) + REST_SETTLE_MS + 5_000, false);

    state.started = true;
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

/*
 * One feed connection, and a watchdog on it.
 *
 * Upstox allows one market-data connection per token. A second one (another
 * copy of this app, a script) does not close the first: the first stays "open"
 * and simply stops receiving data. On 25 Sept 2026 two copies ran for hours
 * that way, each showing "connected" on frozen prices while strategies traded
 * on bars that had stopped updating.
 *
 * So silence is treated as failure. During market hours ~420 instruments trade
 * every few seconds; nothing for STALL_MS means the feed is dead whatever the
 * socket says. The watchdog marks it stale (new entries stop), reconnects, and
 * once data flows again replaces the bars built during the gap with the
 * exchange's own candles.
 */
const BAR_3M_MS = 3 * 60 * 1000;
const BAR_15M_MS = 15 * 60 * 1000;
// Upstox's REST candle for a bar is incomplete for a while after the bar
// closes (seen 25 Sept 2026 at +20s; complete a few minutes later).
const REST_SETTLE_MS = 90_000;
const STALL_MS = 30_000;
const WATCHDOG_MS = 5_000;
const NIFTY_KEY = "NSE_INDEX|Nifty 50";
let watchdogTimer = null;

function openFeed() {
  // Upstox allows one connection: close any previous one before opening.
  if (state.feed) state.feed.disconnect();
  state.feed = new UpstoxFeed({
    onTick: (key, ltp, tsMs, qty, minute) => {
      state.lastTickAt = Date.now();
      if (state.stale) onFeedRecovered();
      // Only cash keys feed the screener's candle stores; futures and index
      // ticks are handled by their own consumers, so they do not bloat these.
      if (cashKeySet.has(key)) {
        store3m.addTick(key, ltp, tsMs, qty);
        store15m.addTick(key, ltp, tsMs, qty);
        // The exchange candle for the last completed minute: exact, and it
        // replaces the snapshot-built version of that minute in both stores.
        if (minute) {
          store3m.applyMinute(key, minute.ts, minute);
          store15m.applyMinute(key, minute.ts, minute);
        }
      }
      state.lastTickTs = tsMs;
      if (Number.isFinite(ltp) && latestPrices.get(key) !== ltp) {
        latestPrices.set(key, ltp);
        dirtyPrices.add(key);
      }
      for (const fn of tickListeners) {
        try {
          fn(key, ltp, tsMs, qty, minute);
        } catch {
          /* one bad listener must not stall the feed */
        }
      }
    },
    onQuote: (key, bid, ask, tsMs) => {
      const prev = latestQuotes.get(key);
      if (!prev || prev[0] !== bid || prev[1] !== ask) {
        latestQuotes.set(key, [bid, ask]);
        dirtyQuotes.add(key);
      }
      for (const fn of quoteListeners) {
        try {
          fn(key, bid, ask, tsMs);
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
  // Cash and futures in full mode: futures for their bid/ask, both for the
  // cumulative day volume and the exchange's minute candles that make bars exact.
  // The index too, for its minute candles (it has no volume or depth).
  state.feed.connect(state.allKeys, {
    fullKeys: state.allKeys.filter((k) => /^NSE_(FO|EQ|INDEX)\|/.test(k)),
  });
  state.lastTickAt = Date.now(); // the silence clock starts at the connect
  clearInterval(watchdogTimer);
  watchdogTimer = setInterval(watchdog, WATCHDOG_MS);
}

function watchdog() {
  if (!state.feed || !isMarketOpen()) return;
  const silentFor = Date.now() - (state.lastTickAt ?? 0);
  if (silentFor < STALL_MS) return;
  if (!state.stale) {
    state.stale = true;
    state.staleSince = state.lastTickAt;
    logger.error(
      `live feed stalled: no data for ${Math.round(silentFor / 1000)}s although the socket reports ` +
        `${state.connected ? "open" : "closed"} — another connection on the same Upstox token ` +
        "(a second copy of this app?) is the usual cause. Reconnecting."
    );
  }
  state.lastError = `feed stalled — no data since ${new Date(state.staleSince).toISOString()}; reconnecting`;
  state.reconnects++;
  openFeed();
}

/** Data is flowing again after a stall: rebuild the gap from the exchange's candles. */
function onFeedRecovered() {
  const since = state.staleSince;
  state.stale = false;
  state.staleSince = null;
  state.lastError = null;
  logger.warn(`live feed recovered after ${Math.round((Date.now() - since) / 1000)}s — repairing bars from REST`);
  // Now for the gap bars that have already settled, and again once the last
  // gap bar (the one forming when data returned) has closed and settled.
  scheduleRepair("feed gap", Date.now(), true);
  const lastGapBarClose = Math.floor(Date.now() / BAR_3M_MS) * BAR_3M_MS + BAR_3M_MS;
  scheduleRepair("feed gap, settled", lastGapBarClose + REST_SETTLE_MS + 5_000, true);
}

/**
 * Run a bar repair at `atMs`. A blocking repair holds new entries from now
 * until it has run: bars that are about to be replaced are not traded on.
 */
function scheduleRepair(reason, atMs, blocking) {
  if (blocking) state.repairsPending++;
  const t = setTimeout(() => {
    repairBars(reason)
      .catch((e) => logger.error(`bar repair failed: ${e.message}`))
      .finally(() => {
        if (blocking) state.repairsPending = Math.max(0, state.repairsPending - 1);
      });
  }, Math.max(0, atMs - Date.now()));
  t.unref?.();
}

/**
 * Replace today's SETTLED bars with Upstox's own candles, for every name and
 * the index. Bars built while the feed was silent are missing or frozen
 * mid-bar; settled REST candles matched the exchange exactly in testing.
 * Bars younger than REST_SETTLE_MS are left alone — their REST candle is not
 * final yet, and the live-built bar is the better one.
 */
async function repairBars(reason) {
  // One pass at a time; a second request waits for the running one.
  while (state.repairing) await new Promise((r) => setTimeout(r, 1000));
  state.repairing = true;
  const t0 = Date.now();
  let fixed = 0;
  try {
    for (const u of state.underlyings) {
      if (!u.cashKey) continue;
      const [b3, b15] = await Promise.all([
        getIntradayCandles(u.cashKey, "minutes", 3).catch(() => []),
        getIntradayCandles(u.cashKey, "minutes", 15).catch(() => []),
      ]);
      store3m.reconcile(u.cashKey, b3, Date.now(), REST_SETTLE_MS);
      store15m.reconcile(u.cashKey, b15, Date.now(), REST_SETTLE_MS);
      fixed++;
    }
    const idx = await getIntradayCandles(NIFTY_KEY, "minutes", 3).catch(() => []);
    storeIndex3m.reconcile(NIFTY_KEY, idx, Date.now(), REST_SETTLE_MS);
    logger.info(`bar repair (${reason}): ${fixed} names + index rebuilt from REST in ${Math.round((Date.now() - t0) / 1000)}s`);
  } finally {
    state.repairing = false;
  }
}

/** Diagnostics: recent raw full-feed OHLC blocks for one key. */
export function debugFeed(key) {
  return state.feed?.rawOhlc?.get(key) ?? [];
}

/** True while the feed is delivering. New positions must not open on a dead feed. */
export function isFeedHealthy() {
  return Boolean(state.feed) && !state.stale && !state.repairsPending;
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
  clearInterval(watchdogTimer);
  watchdogTimer = null;
  if (state.feed) state.feed.disconnect();
  state.feed = null;
  state.stale = false;
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
    // A socket that is open but silent is not connected in any useful sense.
    connected: state.connected && !state.stale,
    stale: state.stale,
    repairing: state.repairing || state.repairsPending > 0,
    reconnects: state.reconnects,
    lastDataAt: state.lastTickAt,
    marketOpen: isMarketOpen(),
    hasToken: HAS_TOKEN,
    lastTickTs: state.lastTickTs,
    feedOpenedAt: state.feedOpenedAt,
    seededAt: state.seededAt,
    subscribed: state.started ? state.underlyings.length : 0,
    counts: state.lastPayload.counts,
    error: state.lastError,
    // Set when the feed cannot recover on its own (e.g. a rejected token), so
    // the UI can say so instead of showing a permanent "connecting…".
    fatal: state.fatal ?? null,
  };
}
