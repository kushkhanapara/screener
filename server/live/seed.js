import { getHistoricalCandles } from "../data/upstox.js";
import { store3m, store15m } from "./candleStore.js";
import { FETCH_CONCURRENCY } from "../config.js";

/**
 * Seed each underlying's CASH 3m and 15m windows so indicators (incl. SMA200)
 * are available from the market open. The strategy runs on the equity chart, so
 * we seed the cash key — not the futures contract.
 *
 * SMA200 needs 200 bars: ~600 min (~1.6 trading days) on 3m and ~3000 min
 * (~8 trading days) on 15m — hence the different lookback windows below.
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

/**
 * Seed the 3m + 15m cash stores for all underlyings. Returns the number of
 * underlyings seeded on at least one timeframe.
 * @param {Array<{cashKey:string}>} underlyings
 */
export async function seedAll(underlyings) {
  const to = istDate(0);
  const from3m = istDate(7); // ~5 trading days of 3m history
  const from15m = istDate(20); // ~14 trading days of 15m history
  let seeded = 0;

  await pool(underlyings, FETCH_CONCURRENCY, async (u) => {
    const key = u.cashKey;
    if (!key) return;
    let any = false;
    try {
      const bars3 = await getHistoricalCandles(key, "minutes", 3, from3m, to).catch(() => []);
      if (bars3.length) {
        store3m.seed(key, bars3);
        any = true;
      }
      const bars15 = await getHistoricalCandles(key, "minutes", 15, from15m, to).catch(() => []);
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
