/**
 * Trend vs rotation, from the slope of a VWAP-family line.
 *
 * The slope is a least-squares fit over the last M values (price per bar),
 * compared against a volatility-scaled threshold ε = epsAtr × ATR, so the same
 * setting reads a ₹200 stock and a ₹4000 one alike.
 *
 * Which line is fitted matters. A session VWAP's σ starts at zero and widens as
 * the day goes on, so the Upper Band climbs even in a market going nowhere;
 * fitting the Upper Band alone therefore calls "uptrend" far too often. The
 * default fits the VWAP line itself; the band variants are kept for comparison.
 */

/** Least-squares slope of `values` against 0..n−1. Null with fewer than two points. */
export function linregSlope(values) {
  const ys = (values ?? []).filter(Number.isFinite);
  const n = ys.length;
  if (n < 2) return null;
  const xMean = (n - 1) / 2;
  const yMean = ys.reduce((a, y) => a + y, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (ys[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return num / den;
}

/**
 * @param {{vwap:number[], upper:number[], lower:number[]}} series aligned band series (e.g. from vwapSeries)
 * @param {number} atr
 * @param {object} [opt]
 * @param {number} [opt.bars]   M, how many trailing values to fit
 * @param {number} [opt.epsAtr] ε as a multiple of ATR
 * @param {"vwap"|"upper"|"bands"} [opt.source]
 *   vwap  — fit the VWAP line (default)
 *   upper — fit the Upper Band only, as originally specified
 *   bands — both bands must slope the same way beyond ε
 * @returns {{regime:"up"|"down"|"rotation", slope:number, eps:number}|null}
 *   null when there are fewer than M values or no ATR
 */
export function classifyRegime(series, atr, { bars = 10, epsAtr = 0.05, source = "vwap" } = {}) {
  if (!(atr > 0) || !series) return null;
  const tail = (arr) => {
    const t = (arr ?? []).slice(-bars);
    return t.length === bars && t.every(Number.isFinite) ? t : null;
  };
  const eps = epsAtr * atr;
  const label = (s) => (s > eps ? "up" : s < -eps ? "down" : "rotation");

  if (source === "bands") {
    const u = tail(series.upper);
    const l = tail(series.lower);
    if (!u || !l) return null;
    const su = linregSlope(u);
    const sl = linregSlope(l);
    const a = label(su);
    const b = label(sl);
    return { regime: a === b ? a : "rotation", slope: (su + sl) / 2, eps };
  }

  const values = tail(source === "upper" ? series.upper : series.vwap);
  if (!values) return null;
  const slope = linregSlope(values);
  return { regime: label(slope), slope, eps };
}
