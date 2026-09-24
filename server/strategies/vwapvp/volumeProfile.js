/**
 * Fixed-range volume profile: how much volume traded at each price over a
 * chosen span of bars.
 *
 * Candles do not say where inside its range a bar's volume traded, so each
 * bar's volume is spread across [low, high] in proportion to how much of that
 * range each price bin covers — the standard approximation when there is no
 * tick data. A bar with no range puts all its volume in one bin.
 */

/**
 * @param {Array<{high:number,low:number,close:number,volume:number}>} bars the fixed range
 * @param {object} [opt]
 * @param {number} [opt.binPct]  bin width as a fraction of the range's mid price (0.0015 = 0.15%)
 * @param {number} [opt.bins]    a fixed number of bins instead (overrides binPct)
 * @param {number} [opt.maxBins] ceiling on bins, so a wide range can't allocate unboundedly
 * @param {number} [opt.nodePct] a secondary peak counts as a node at this fraction of POC volume
 * @returns {null | {
 *   low:number, high:number, binSize:number, volumes:number[], totalVolume:number,
 *   poc:{price:number, low:number, high:number, volume:number},
 *   nodes:Array<{price:number, low:number, high:number, volume:number}>
 * }}
 */
export function volumeProfile(bars, { binPct = 0.0015, bins = null, maxBins = 400, nodePct = 0.7 } = {}) {
  const valid = (bars ?? []).filter(
    (b) => Number.isFinite(b.high) && Number.isFinite(b.low) && b.high >= b.low && (Number(b.volume) || 0) > 0
  );
  if (!valid.length) return null;

  const low = Math.min(...valid.map((b) => b.low));
  const high = Math.max(...valid.map((b) => b.high));
  const span = high - low;

  let n;
  if (span <= 0) n = 1;
  else if (bins > 0) n = Math.floor(bins);
  else n = Math.ceil(span / (binPct * ((low + high) / 2)));
  n = Math.max(1, Math.min(maxBins, n));
  const binSize = span > 0 ? span / n : 0;

  const binOf = (price) => (binSize > 0 ? Math.min(n - 1, Math.max(0, Math.floor((price - low) / binSize))) : 0);
  const volumes = new Array(n).fill(0);

  for (const b of valid) {
    const vol = Number(b.volume);
    const range = b.high - b.low;
    if (range <= 0 || binSize <= 0) {
      volumes[binOf(b.close ?? b.low)] += vol;
      continue;
    }
    for (let k = binOf(b.low); k <= binOf(b.high); k++) {
      const overlap = Math.min(b.high, low + (k + 1) * binSize) - Math.max(b.low, low + k * binSize);
      if (overlap > 0) volumes[k] += (vol * overlap) / range;
    }
  }

  const binInfo = (k) => ({
    price: low + (k + 0.5) * binSize,
    low: low + k * binSize,
    high: low + (k + 1) * binSize,
    volume: volumes[k],
  });

  // POC: the heaviest bin; ties go to the lowest price so the result is stable.
  let pocK = 0;
  for (let k = 1; k < n; k++) if (volumes[k] > volumes[pocK]) pocK = k;
  const pocVol = volumes[pocK];

  // Nodes: other local peaks at least nodePct of the POC's volume. Requiring a
  // peak stops the POC's own shoulders from counting as separate clusters.
  const nodes = [];
  for (let k = 0; k < n; k++) {
    if (k === pocK) continue;
    const left = k > 0 ? volumes[k - 1] : -Infinity;
    const right = k < n - 1 ? volumes[k + 1] : -Infinity;
    if (volumes[k] >= left && volumes[k] > right && volumes[k] >= nodePct * pocVol) nodes.push(binInfo(k));
  }

  return {
    low,
    high,
    binSize,
    volumes,
    totalVolume: volumes.reduce((a, v) => a + v, 0),
    poc: binInfo(pocK),
    nodes,
  };
}

/**
 * Two profiles agree when their POCs are within `tolerance` (a price
 * distance, e.g. 0.25 × ATR). The midpoint is then a confluence level: volume
 * accepted there on two different scales.
 * @returns {{price:number, gap:number}|null}
 */
export function dualPoc(a, b, tolerance) {
  if (!a?.poc || !b?.poc || !(tolerance >= 0)) return null;
  const gap = Math.abs(a.poc.price - b.poc.price);
  return gap <= tolerance ? { price: (a.poc.price + b.poc.price) / 2, gap } : null;
}

/**
 * The consolidation box: of the `size`-bar windows no wider than `maxRange`,
 * the one where the most volume traded.
 *
 * Volume, not tightness, picks the box. The narrowest window is often just a
 * quiet lull near the top of a move; the box that matters is where the market
 * built a position before moving on, and that shows up as volume. Ties go to
 * the most recent window. Null when no window is narrow enough — the span
 * never paused.
 * @returns {{start:number, end:number, range:number, volume:number}|null} indices into `bars`, inclusive
 */
export function consolidationBox(bars, size, maxRange = Infinity) {
  if (!Array.isArray(bars) || size < 1 || bars.length < size) return null;
  let best = null;
  for (let s = 0; s + size <= bars.length; s++) {
    let hi = -Infinity;
    let lo = Infinity;
    let volume = 0;
    for (let i = s; i < s + size; i++) {
      hi = Math.max(hi, bars[i].high);
      lo = Math.min(lo, bars[i].low);
      volume += Number(bars[i].volume) || 0;
    }
    const range = hi - lo;
    if (!(range <= maxRange)) continue;
    if (best == null || volume >= best.volume) best = { start: s, end: s + size - 1, range, volume };
  }
  return best;
}
