import { getDailyCandles } from "../data/upstox.js";
import { loadFuturesUniverse, getUnderlyings } from "../data/instruments.js";
import { buildRows } from "../core/rows.js";
import { evaluate } from "../core/strategy.js";
import { FETCH_CONCURRENCY, DAILY_LOOKBACK_DAYS, HAS_TOKEN } from "../config.js";

/**
 * Daily (EOD) snapshot service.
 *
 * Runs on the UNDERLYING CASH equity of each stock (long, continuous history),
 * not the short-lived futures contract — so RSI/MACD/MA50/MA200 are meaningful.
 * The live intraday path stays on the futures contracts; only this daily view
 * uses cash.
 *
 * On refresh: fetch daily candles per underlying from Upstox Historical, build
 * indicator rows once, and cache them with a timestamp. scan() then runs the
 * fixed strategy over the cached rows (instant, strategy-independent cache so
 * editing strategy.js + restart is reflected).
 */

const state = {
  fetching: false,
  updatedAt: null,
  total: 0,
  loaded: 0, // contracts with usable rows
  skipped: 0, // contracts skipped (insufficient history / NaN / fetch error)
  rows: new Map(), // key -> { contract, latest, prev }
  error: null,
};

/** IST calendar date (YYYY-MM-DD) offset by `daysBack`. */
function istDate(daysBack = 0) {
  const now = Date.now() + (5 * 60 + 30) * 60 * 1000; // shift to IST
  const d = new Date(now - daysBack * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Run `worker` over `items` with a fixed concurrency pool. */
async function pool(items, concurrency, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

/** Background refresh of the daily cache. Safe to call repeatedly. */
export async function refresh() {
  if (state.fetching) return;
  if (!HAS_TOKEN) {
    state.error = "UPSTOX_ANALYTICS_TOKEN not set — daily data unavailable.";
    return;
  }
  state.fetching = true;
  state.error = null;

  try {
    if (!getUnderlyings()) await loadFuturesUniverse();
    const underlyings = getUnderlyings();
    state.total = underlyings.length;

    const to = istDate(0);
    const from = istDate(DAILY_LOOKBACK_DAYS);
    const nextRows = new Map();
    let skipped = 0;

    await pool(underlyings, FETCH_CONCURRENCY, async (u) => {
      try {
        const candles = await getDailyCandles(u.cashKey, from, to);
        const built = buildRows(candles);
        if (!built) {
          skipped++;
          return;
        }
        const asOf = candles.length ? String(candles[candles.length - 1].time).slice(0, 10) : "";
        nextRows.set(u.underlying, { underlying: u.underlying, asOf, ...built });
      } catch {
        skipped++; // network / API failure -> skip this stock
      }
    });

    state.rows = nextRows;
    state.loaded = nextRows.size;
    state.skipped = skipped;
    state.updatedAt = new Date().toISOString();
  } catch (err) {
    state.error = String(err.message || err);
  } finally {
    state.fetching = false;
  }
}

/** Run the fixed strategy over the cached rows. */
export function scan() {
  const results = [];
  for (const { underlying, asOf, latest, prev } of state.rows.values()) {
    const { pass, reasons } = evaluate(latest, prev);
    if (!pass) continue;
    results.push({
      contract: underlying, // daily view is the cash stock, shown by symbol
      underlying,
      expiry: asOf, // "as of" data date (no expiry for cash)
      close: latest.close,
      rsi14: latest.rsi14,
      macdHist: latest.macdHist,
      reasons,
    });
  }
  results.sort((a, b) => a.underlying.localeCompare(b.underlying));
  return {
    updatedAt: state.updatedAt,
    total: state.total,
    loaded: state.loaded,
    skipped: state.skipped,
    count: results.length,
    results,
  };
}

export function status() {
  return {
    updatedAt: state.updatedAt,
    loaded: state.loaded,
    total: state.total,
    skipped: state.skipped,
    fetching: state.fetching,
    error: state.error,
  };
}
