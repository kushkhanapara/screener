/**
 * Technical indicators — thin wrappers around the `technicalindicators`
 * package (we don't hand-roll the math). Each wrapper returns an array of ONLY
 * the valid values (warm-up dropped, no leading NaN), so the arrays come back
 * at DIFFERENT lengths. Use rightAlign() to trim them to the shortest common
 * length so index -1 (latest) / -2 (prev) refer to the same underlying bar.
 */
import { RSI, MACD, SMA, EMA, ATR } from "technicalindicators";

/** Simple moving average. Output length = values.length - period + 1. */
export function sma(values, period) {
  return SMA.calculate({ period, values });
}

/** Exponential moving average (seeded on the SMA of the first `period`). */
export function ema(values, period) {
  return EMA.calculate({ period, values });
}

/** RSI with Wilder (SMMA) smoothing. Output length = closes.length - period. */
export function rsi(closes, period = 14) {
  return RSI.calculate({ period, values: closes });
}

/**
 * MACD(fast, slow, signal) — SMA VARIANT. The oscillator and signal are both
 * computed with SIMPLE moving averages (not EMAs), per the strategy spec:
 * 12/26/9 SMA on close. This is intentionally smoother/laggier than the classic
 * EMA MACD — cleaner trend, slower entries.
 * Returns { macd, signal, hist } as equal-length, bar-aligned arrays (only
 * entries where the signal line exists are kept).
 */
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const raw = MACD.calculate({
    values: closes,
    fastPeriod: fast,
    slowPeriod: slow,
    signalPeriod: signal,
    SimpleMAOscillator: true,
    SimpleMASignal: true,
  });
  const valid = raw.filter((x) => x.signal !== undefined && x.MACD !== undefined);
  return {
    macd: valid.map((x) => x.MACD),
    signal: valid.map((x) => x.signal),
    hist: valid.map((x) => x.histogram),
  };
}

/**
 * MACD(12,26,9) — the STANDARD exponential variant.
 *
 * Distinct from macd() above, which uses the simple-moving-average variant. The
 * two disagree meaningfully: the SMA version lags noticeably more, so a strategy
 * written against one cannot be evaluated with the other.
 */
export function macdEma(closes, fast = 12, slow = 26, signal = 9) {
  const raw = MACD.calculate({
    values: closes,
    fastPeriod: fast,
    slowPeriod: slow,
    signalPeriod: signal,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const valid = raw.filter((x) => x.signal !== undefined && x.MACD !== undefined);
  return {
    macd: valid.map((x) => x.MACD),
    signal: valid.map((x) => x.signal),
    hist: valid.map((x) => x.histogram),
  };
}

/**
 * Average True Range (Wilder). Needs high/low/close, so it takes candles rather
 * than a close series. Drives stop distance and the volatility floor: sizing a
 * stop in ATR units is what makes an R-multiple comparable across a ₹200 stock
 * and a ₹4000 one.
 *
 * @param {Array<{high:number,low:number,close:number}>} candles oldest -> newest
 * @returns {number[]} valid values only (warm-up dropped), oldest -> newest
 */
export function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return [];
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  if ([...high, ...low, ...close].some((v) => !Number.isFinite(v))) return [];
  return ATR.calculate({ period, high, low, close }).filter((v) => Number.isFinite(v));
}

/** Latest ATR value, or null when there aren't enough bars. */
export function latestAtr(candles, period = 14) {
  const a = atr(candles, period);
  return a.length ? a[a.length - 1] : null;
}

/**
 * Trim every passed array from the LEFT to the shortest common length, so the
 * tails line up bar-for-bar. Returns a new array of trimmed arrays in order.
 */
export function rightAlign(...series) {
  const min = series.reduce(
    (m, s) => Math.min(m, s.length),
    Number.POSITIVE_INFINITY
  );
  if (!Number.isFinite(min)) return series.map(() => []);
  return series.map((s) => s.slice(s.length - min));
}
