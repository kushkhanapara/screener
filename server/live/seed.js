import { getHistoricalCandles, getIntradayCandles } from "../data/upstox.js";
import { store3m, store15m } from "./candleStore.js";
import { FETCH_CONCURRENCY } from "../config.js";
import { istMinutes } from "../core/session.js";
import * as volumeHistory from "./volumeHistory.js";

// Before this minute there are no intraday bars to fetch, so a start right at
// the open skips 211×2 REST calls and lets live ticks build today's bars.
const INTRADAY_FROM_MIN = 9 * 60 + 16;

/**
 * Seed each underlying's CASH 3m and 15m windows so indicators are available
 * from the market open. The strategy runs on the equity chart, so we seed the
 * cash key — not the futures contract.
 *
 * TWO fetches per timeframe, and both are necessary:
 *
 *   historical — completed trading days only. A range ending "today" still
 *                stops at yesterday's close, so this alone leaves the current
 *                session empty: no session VWAP, no session volume, and a
 *                "move from the open" measured against a bar that isn't today's
 *                open. Strategies gated on those would simply never fire.
 *   intraday   — today's bars, from 09:15 to now.
 *
 * The historical range deliberately ends YESTERDAY, which makes it immutable and
 * therefore cacheable forever; only the small intraday call repeats on restart.
 *
 * SMA200 needs 200 bars: ~600 min (~1.6 trading days) on 3m and ~3000 min
 * (~8 trading days) on 15m. The 3m window is longer than SMA200 needs because
 * shadow's time-of-day volume norm reads ~10 prior sessions (volumeHistory.js).
 */

function istDate(daysBack = 0) {
  const now = Date.now() + (5 * 60 + 30) * 60 * 1000;
  return new Date(now - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function pool(items, concurrency, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) await worker(items[i++]);
  });
  await Promise.all(runners);
}

/** Completed-day history plus today, merged. CandleStore dedupes by bucket. */
async function windowFor(key, interval, fromDate, toDate) {
  const wantToday = istMinutes(Date.now()) >= INTRADAY_FROM_MIN;
  const [history, today] = await Promise.all([
    getHistoricalCandles(key, "minutes", interval, fromDate, toDate).catch(() => []),
    wantToday ? getIntradayCandles(key, "minutes", interval).catch(() => []) : [],
  ]);
  return { history, today };
}

/**
 * Date ranges for the seed windows. Shared by seeding and the pre-market
 * warm-up so both hit exactly the same cache entries.
 *
 * The 3m history is ~10 trading days: the rolling store only keeps 500 bars
 * (~4 sessions), but the time-of-day volume norm needs more sessions than that.
 */
export function seedRanges() {
  return {
    to: istDate(1), // yesterday — immutable, so the cache never expires
    from3m: istDate(15), // ~10 trading days of 3m history
    from15m: istDate(21), // ~14 trading days of 15m history
  };
}

/**
 * Fetch the history half of every seed window into the on-disk cache, without
 * touching the live stores. Run before the open, this moves ~420 rate-limited
 * requests out of market hours, so seeding at 09:15 reads from disk.
 * @returns {Promise<number>} underlyings warmed
 */
export async function prewarmHistory(underlyings) {
  const { to, from3m, from15m } = seedRanges();
  let warmed = 0;
  await pool(underlyings, FETCH_CONCURRENCY, async (u) => {
    if (!u.cashKey) return;
    await Promise.all([
      getHistoricalCandles(u.cashKey, "minutes", 3, from3m, to).catch(() => []),
      getHistoricalCandles(u.cashKey, "minutes", 15, from15m, to).catch(() => []),
    ]);
    warmed++;
  });
  return warmed;
}

/**
 * Seed the 3m + 15m cash stores for all underlyings. Returns the number of
 * underlyings seeded on at least one timeframe.
 * @param {Array<{cashKey:string}>} underlyings
 */
export async function seedAll(underlyings) {
  const { to, from3m, from15m } = seedRanges();
  let seeded = 0;

  await pool(underlyings, FETCH_CONCURRENCY, async (u) => {
    const key = u.cashKey;
    if (!key) return;
    let any = false;
    try {
      const w3 = await windowFor(key, 3, from3m, to);
      // Completed sessions only, kept in full before the store trims to 500 bars.
      volumeHistory.set(key, w3.history);
      const bars3 = [...w3.history, ...w3.today];
      if (bars3.length) {
        store3m.seed(key, bars3);
        any = true;
      }
      const w15 = await windowFor(key, 15, from15m, to);
      const bars15 = [...w15.history, ...w15.today];
      if (bars15.length) {
        store15m.seed(key, bars15);
        any = true;
      }
    } catch {
      // skip this underlying's seed; live ticks will still build candles
    }
    if (any) seeded++;
  });

  return seeded;
}

/** Same two-part window, for callers that manage their own store (e.g. the index). */
export async function seedWindow(key, interval, daysBack) {
  const { history, today } = await windowFor(key, interval, istDate(daysBack), istDate(1));
  return [...history, ...today];
}
