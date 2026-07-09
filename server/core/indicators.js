/**
 * Technical indicators — thin wrappers around the `technicalindicators`
 * package (we don't hand-roll the math). Each wrapper returns an array of ONLY
 * the valid values (warm-up dropped, no leading NaN), so the arrays come back
 * at DIFFERENT lengths. Use rightAlign() to trim them to the shortest common
 * length so index -1 (latest) / -2 (prev) refer to the same underlying bar.
 */
import { RSI, MACD, SMA, EMA } from "technicalindicators";

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
 * MACD(fast, slow, signal). Returns { macd, signal, hist } as equal-length,
 * bar-aligned arrays (only entries where the signal line exists are kept).
 */
export function macd(closes, fast = 12, slow = 26, signal = 9) {
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
