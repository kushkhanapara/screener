import { getIntradayMinuteCandles, getHistoricalMinuteCandles } from "../data/upstox.js";
import { candleStore } from "./candleStore.js";
import { FETCH_CONCURRENCY } from "../config.js";

/**
 * Seed each contract's 1-minute window so indicators are available from the
 * market open. Pulls recent historical minute candles (prior trading days) plus
 * today's intraday candles, merges them, and loads them into the candle store.
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
 * Seed the store for all contracts. Returns the number successfully seeded.
 * @param {Array<{key:string}>} contracts
 */
export async function seedAll(contracts) {
  const to = istDate(0);
  const from = istDate(7); // ~5 trading days of 1-min history
  let seeded = 0;

  await pool(contracts, FETCH_CONCURRENCY, async (contract) => {
    try {
      // One call per contract to respect the API's 30-min request cap: prior
      // days of 1-min history (enough to warm indicators). Fall back to today's
      // intraday only if that came back empty. Live ticks fill in the rest.
      let bars = await getHistoricalMinuteCandles(contract.key, from, to).catch(() => []);
      if (!bars.length) {
        bars = await getIntradayMinuteCandles(contract.key).catch(() => []);
      }
      if (!bars.length) return;
      candleStore.seed(contract.key, bars);
      seeded++;
    } catch {
      // skip this contract's seed; live ticks will still build candles
    }
  });

  return seeded;
}
