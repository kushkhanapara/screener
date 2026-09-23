import { barTimeMs } from "../core/session.js";

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/**
 * Stock beta to the index from aligned 3-minute log returns.
 *
 * Only returns between adjacent buckets of the same session are used, so the
 * overnight gap is never read as a single enormous bar. Falls back to beta 1
 * when there isn't enough history to trust an estimate.
 */
export function estimateBeta(
  stockBars,
  indexBars,
  { lookback = 300, minReturns = 100, bucketMs = 3 * 60 * 1000, min = -1, max = 3 } = {}
) {
  const index = new Map();
  for (const b of indexBars ?? []) index.set(barTimeMs(b.time), b.close);

  const rs = [];
  const ri = [];
  const bars = stockBars ?? [];
  for (let i = 1; i < bars.length; i++) {
    const t0 = barTimeMs(bars[i - 1].time);
    const t1 = barTimeMs(bars[i].time);
    if (t1 - t0 !== bucketMs) continue;
    const i0 = index.get(t0);
    const i1 = index.get(t1);
    const s0 = bars[i - 1].close;
    const s1 = bars[i].close;
    if (!(i0 > 0 && i1 > 0 && s0 > 0 && s1 > 0)) continue;
    rs.push(Math.log(s1 / s0));
    ri.push(Math.log(i1 / i0));
  }

  const n = Math.min(rs.length, lookback);
  if (n < minReturns) return { beta: 1, n: rs.length, fallback: true };

  const a = rs.slice(-n);
  const b = ri.slice(-n);
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let variance = 0;
  for (let k = 0; k < n; k++) {
    cov += (a[k] - ma) * (b[k] - mb);
    variance += (b[k] - mb) ** 2;
  }
  if (variance === 0) return { beta: 1, n, fallback: true };

  return { beta: Math.max(min, Math.min(max, cov / variance)), n, fallback: false };
}
