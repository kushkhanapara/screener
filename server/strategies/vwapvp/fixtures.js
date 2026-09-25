/**
 * Synthetic 3-minute sessions for the VWAP + Volume Profile tests.
 * 23 Sept 2026 (a Wednesday), bars from 09:15 IST.
 */
const BAR = 3 * 60 * 1000;
export const OPEN = Date.UTC(2026, 8, 23, 9 - 5, 15 - 30);
export const at = (h, m) => Date.UTC(2026, 8, 23, h - 5, m - 30);

const mk = (i, open, high, low, close, volume) => ({ time: OPEN + i * BAR, open, high, low, close, volume });
const level = (i, p, volume = 1000, half = 0.05) => mk(i, p, p + half, p - half, p, volume);

/** Context the strategy reads: closed bars, ATR, the clock after the last bar, session volume. */
export function ctxOf(bars, atr) {
  return {
    now: bars[bars.length - 1].time + BAR,
    atr: { "3m": atr },
    bars: { "3m": bars },
    sessionVolume: bars.reduce((a, b) => a + b.volume, 0),
  };
}

/**
 * Rotation: price alternates between 98 and 102 in 10-bar blocks, so VWAP sits
 * near 100 with σ ≈ 2 and swing lows at 98. Then a few more bars at 98 and a
 * `signal` bar.
 */
export function rotationSession(signal) {
  const bars = [];
  for (let blk = 0; blk < 9; blk++) for (let j = 0; j < 10; j++) bars.push(level(bars.length, blk % 2 ? 98 : 102));
  for (let j = 0; j < 3; j++) bars.push(level(bars.length, 98));
  const [open, high, low, close] = signal;
  bars.push(mk(bars.length, open, high, low, close, 1000));
  return bars;
}

/**
 * Uptrend: a short push to 101, a heavy consolidation there (the volume
 * node), a rally to 104, a pause, a pullback, then the `signal` bar.
 */
export function trendSession(signal, { heavy = 10_000 } = {}) {
  const bars = [];
  for (let j = 0; j < 5; j++) bars.push(level(bars.length, 100 + j * 0.2));
  for (let j = 0; j < 20; j++) bars.push(level(bars.length, 101, heavy));
  for (let j = 0; j < 15; j++) bars.push(level(bars.length, 101.2 + j * 0.2));
  for (let j = 0; j < 10; j++) bars.push(level(bars.length, 104));
  for (let j = 0; j < 5; j++) bars.push(level(bars.length, 103.5 - j * 0.45));
  const [open, high, low, close] = signal;
  bars.push(mk(bars.length, open, high, low, close, 1000));
  return bars;
}
