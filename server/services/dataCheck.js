import { store3m, store15m, storeIndex3m } from "../live/candleStore.js";
import { getUnderlyings, getUniverse } from "../data/instruments.js";
import { getIntradayCandles, getLtp } from "../data/upstox.js";
import { sessionStartMs } from "../core/session.js";
import * as live from "./liveService.js";

/**
 * Data check: do the bars and prices the strategies trade on match Upstox?
 *
 * For a sample of underlyings, fetch Upstox's own 3m and 15m candles for today
 * and compare them bar by bar with the in-memory stores, split by where each
 * bar came from:
 *
 *   seeded     loaded from the REST API at startup — should match exactly
 *   tick-built built from live ticks after the feed opened — the part that can
 *              drift (missed ticks change the range; the ltpc feed reports
 *              last-trade quantity, so volume can under-count)
 *
 * Plus a point-in-time LTP check of the live feed against the quote API.
 * Read-only: it changes nothing in the stores.
 */

const PRICE_TOL = 0.0005; // 0.05% — about one tick on most F&O names
const REST_SETTLE_MS = 90_000;

function relDiff(a, b) {
  return Math.abs(a - b) / Math.max(Math.abs(b), 1e-9);
}

function compareBars(ours, theirs, feedOpenedAt, seededAt, bucketMs) {
  const byTime = new Map(ours.map((b) => [b.time, b]));
  const out = { seeded: blank(), tickBuilt: blank(), mixed: 0, missing: 0, worst: [] };
  for (const t of theirs) {
    const time = new Date(t.time).getTime();
    const o = byTime.get(time);
    // Only SETTLED bars are comparable: the forming one is still changing, and
    // Upstox's REST candle for a bar that closed moments ago is still incomplete
    // (25 Sept 2026: at +20s, 4 of 60 REST bars were short; minutes later all 4
    // matched the live-built bar exactly).
    if (time + bucketMs + REST_SETTLE_MS > Date.now()) continue;
    if (!o) {
      out.missing++;
      continue;
    }
    // Closed before the feed opened: from the REST seed alone. Started after
    // seeding finished: from ticks alone. In between it is a merge of both, so
    // it is counted but not judged.
    let bucket;
    if (!feedOpenedAt || time + bucketMs <= feedOpenedAt) bucket = out.seeded;
    else if (seededAt && time >= seededAt) bucket = out.tickBuilt;
    else {
      out.mixed++;
      continue;
    }
    bucket.bars++;
    const d = {
      open: relDiff(o.open, t.open),
      high: relDiff(o.high, t.high),
      low: relDiff(o.low, t.low),
      close: relDiff(o.close, t.close),
    };
    const priceBad = Object.values(d).some((x) => x > PRICE_TOL);
    if (priceBad) bucket.priceMismatch++;
    for (const k of Object.keys(d)) bucket.maxDiffPct[k] = Math.max(bucket.maxDiffPct[k], d[k] * 100);
    if (t.volume > 0) {
      bucket.volOurs += o.volume || 0;
      bucket.volTheirs += t.volume;
    }
    if (priceBad && out.worst.length < 5) {
      out.worst.push({ time: new Date(time).toISOString(), source: bucket === out.seeded ? "seeded" : "tick-built", ours: pick(o), upstox: pick(t) });
    }
  }
  for (const b of [out.seeded, out.tickBuilt]) {
    b.volumeRatio = b.volTheirs ? +(b.volOurs / b.volTheirs).toFixed(3) : null;
    for (const k of Object.keys(b.maxDiffPct)) b.maxDiffPct[k] = +b.maxDiffPct[k].toFixed(3);
  }
  return out;
}

const blank = () => ({
  bars: 0,
  priceMismatch: 0,
  maxDiffPct: { open: 0, high: 0, low: 0, close: 0 },
  volOurs: 0,
  volTheirs: 0,
});
const pick = (b) => ({ open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });

function sampleOf(list, n, symbols) {
  if (symbols?.length) return list.filter((u) => symbols.includes(u.underlying));
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/** Sum two per-name results into a total. */
function add(total, r) {
  for (const src of ["seeded", "tickBuilt"]) {
    const a = total[src];
    const b = r[src];
    a.bars += b.bars;
    a.priceMismatch += b.priceMismatch;
    a.volOurs += b.volOurs;
    a.volTheirs += b.volTheirs;
    for (const k of Object.keys(a.maxDiffPct)) a.maxDiffPct[k] = Math.max(a.maxDiffPct[k], b.maxDiffPct[k]);
  }
  total.missing += r.missing;
  total.mixed += r.mixed;
}

export async function runDataCheck({ n = 10, symbols = null } = {}) {
  const status = live.getStatus();
  const feedOpenedAt = status.feedOpenedAt;
  const seededAt = status.seededAt;
  const start = sessionStartMs(Date.now());
  const names = sampleOf(getUnderlyings() || [], n, symbols);

  const perName = [];
  const totals = {
    "3m": { seeded: blank(), tickBuilt: blank(), mixed: 0, missing: 0 },
    "15m": { seeded: blank(), tickBuilt: blank(), mixed: 0, missing: 0 },
  };

  for (const u of names) {
    const row = { underlying: u.underlying };
    for (const [tf, store, interval] of [
      ["3m", store3m, 3],
      ["15m", store15m, 15],
    ]) {
      const theirs = await getIntradayCandles(u.cashKey, "minutes", interval).catch((e) => ({ error: e.message }));
      if (!Array.isArray(theirs)) {
        row[tf] = theirs;
        continue;
      }
      const ours = store.bars(u.cashKey).filter((b) => b.time >= start);
      const r = compareBars(ours, theirs, feedOpenedAt, seededAt, store.bucketMs);
      add(totals[tf], r);
      row[tf] = r;
    }
    perName.push(row);
  }
  for (const t of Object.values(totals)) {
    for (const b of [t.seeded, t.tickBuilt]) {
      b.volumeRatio = b.volTheirs ? +(b.volOurs / b.volTheirs).toFixed(3) : null;
      for (const k of Object.keys(b.maxDiffPct)) b.maxDiffPct[k] = +b.maxDiffPct[k].toFixed(3);
    }
  }

  // Live prices: feed vs the quote API, for the sampled names' cash and futures.
  const futByU = new Map();
  for (const c of getUniverse() || []) {
    const cur = futByU.get(c.underlying);
    if (!cur || c.expiryMs < cur.expiryMs) futByU.set(c.underlying, c);
  }
  const keys = names.flatMap((u) => [u.cashKey, futByU.get(u.underlying)?.key].filter(Boolean));
  const rest = await getLtp(keys).catch(() => new Map());
  const prices = keys.map((k) => {
    const feed = live.latestPrice(k);
    const quote = rest.get(k);
    return {
      key: k,
      feed: feed ?? null,
      quoteApi: quote ?? null,
      diffPct: feed != null && quote != null ? +(relDiff(feed, quote) * 100).toFixed(3) : null,
    };
  });

  // Nifty's 3m bars: relative strength and the day type are read from them.
  const NIFTY = "NSE_INDEX|Nifty 50";
  const idxRest = await getIntradayCandles(NIFTY, "minutes", 3).catch(() => []);
  const index = compareBars(
    storeIndex3m.bars(NIFTY).filter((b) => b.time >= start),
    idxRest,
    feedOpenedAt,
    seededAt,
    storeIndex3m.bucketMs
  );
  delete index.seeded.volOurs; // the index has no volume
  delete index.tickBuilt.volOurs;

  return {
    checkedAt: new Date().toISOString(),
    index,
    feedOpenedAt: feedOpenedAt ? new Date(feedOpenedAt).toISOString() : null,
    seededAt: seededAt ? new Date(seededAt).toISOString() : null,
    priceTolerancePct: PRICE_TOL * 100,
    totals,
    prices,
    perName,
  };
}
