import { loadFuturesUniverse, getUniverse } from "../data/instruments.js";
import { candleStore } from "../live/candleStore.js";
import { seedAll } from "../live/seed.js";
import { UpstoxFeed } from "../live/upstoxFeed.js";
import { buildRows } from "../core/rows.js";
import { evaluate } from "../core/strategy.js";
import { isMarketOpen, HAS_TOKEN } from "../config.js";

/**
 * Live intraday orchestrator.
 *
 * Runs ONLY during market hours: seeds candles, opens one Upstox ltpc feed,
 * aggregates ticks into 1-min candles, and every minute recomputes indicators +
 * the fixed strategy for every contract, diffs the matching set, and broadcasts.
 */

const state = {
  contracts: [],
  keyToContract: new Map(),
  feed: null,
  starting: false,
  started: false,
  connected: false,
  lastTickTs: null,
  lastError: null,
  matchingKeys: new Set(),
  lastPayload: emptyPayload(),
  minuteTimer: null,
  minuteTimeout: null,
};

let broadcaster = () => {};
export function setBroadcaster(fn) {
  broadcaster = fn || (() => {});
}

function emptyPayload() {
  return { type: "update", count: 0, matching: [], entered: [], exited: [], ts: null };
}

/** Begin the supervisor loop that starts/stops the feed around market hours. */
export function init() {
  supervise();
  setInterval(supervise, 30 * 1000);
}

function supervise() {
  const open = isMarketOpen();
  if (open && HAS_TOKEN && !state.started && !state.starting) {
    start().catch((e) => (state.lastError = String(e.message || e)));
  } else if (!open && state.started) {
    stop();
  }
}

async function start() {
  state.starting = true;
  state.lastError = null;
  try {
    state.contracts = getUniverse() || (await loadFuturesUniverse());
    state.keyToContract = new Map(state.contracts.map((c) => [c.key, c]));

    console.log(`[live] seeding ${state.contracts.length} contracts…`);
    const seeded = await seedAll(state.contracts);
    console.log(`[live] seeded ${seeded} contracts; opening feed`);

    state.feed = new UpstoxFeed({
      onTick: (key, ltp, tsMs, qty) => {
        candleStore.addTick(key, ltp, tsMs, qty);
        state.lastTickTs = tsMs;
      },
      onState: ({ connected, error }) => {
        state.connected = connected;
        if (error) state.lastError = error;
      },
    });
    state.feed.connect(state.contracts.map((c) => c.key));

    state.started = true;
    recompute(); // initial set from seeded data
    scheduleMinute();
  } finally {
    state.starting = false;
  }
}

function stop() {
  console.log("[live] market closed — stopping feed");
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
    recompute();
    state.minuteTimer = setInterval(recompute, 60 * 1000);
  }, msToNext);
}

/** Recompute the matching set across all contracts and broadcast the diff. */
function recompute() {
  const nextKeys = new Set();
  const matching = [];

  for (const contract of state.contracts) {
    const bars = candleStore.bars(contract.key);
    const rows = buildRows(bars);
    if (!rows) continue;
    const { pass, reasons } = evaluate(rows.latest, rows.prev);
    if (!pass) continue;
    nextKeys.add(contract.key);
    matching.push({
      contract: contract.label,
      underlying: contract.underlying,
      expiry: contract.expiry,
      close: rows.latest.close,
      rsi14: rows.latest.rsi14,
      macdHist: rows.latest.macdHist,
      reasons,
    });
  }

  const entered = [];
  const exited = [];
  for (const key of nextKeys) {
    if (!state.matchingKeys.has(key)) entered.push(label(key));
  }
  for (const key of state.matchingKeys) {
    if (!nextKeys.has(key)) exited.push(label(key));
  }

  matching.sort((a, b) => a.underlying.localeCompare(b.underlying));
  state.matchingKeys = nextKeys;
  state.lastPayload = {
    type: "update",
    count: matching.length,
    matching,
    entered,
    exited,
    ts: new Date().toISOString(),
  };
  broadcaster(state.lastPayload);
}

function label(key) {
  return state.keyToContract.get(key)?.label ?? key;
}

/** Current full snapshot, sent immediately to newly-connected WS clients. */
export function getSnapshot() {
  return { ...state.lastPayload, entered: [], exited: [] };
}

export function getStatus() {
  return {
    connected: state.connected,
    marketOpen: isMarketOpen(),
    hasToken: HAS_TOKEN,
    lastTickTs: state.lastTickTs,
    subscribed: state.started ? state.contracts.length : 0,
    count: state.lastPayload.count,
    error: state.lastError,
  };
}
