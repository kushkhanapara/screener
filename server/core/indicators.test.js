import { test } from "node:test";
import assert from "node:assert/strict";
import { sma, ema, rsi, macd, atr, latestAtr, rightAlign } from "./indicators.js";

test("sma computes the trailing average at the right length", () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [2, 3, 4]);
});

test("ema seeds on the SMA of the first period", () => {
  const e = ema([1, 2, 3, 4, 5, 6], 3);
  assert.equal(e.length, 4);
  assert.ok(Math.abs(e[0] - 2) < 1e-9); // SMA of [1,2,3]
});

test("rsi saturates near 100 for a monotonically rising series", () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const r = rsi(closes, 14);
  assert.equal(r.length, closes.length - 14);
  assert.ok(r[r.length - 1] > 99.9);
});

test("macd returns macd/signal/hist bar-aligned, hist === macd - signal", () => {
  const closes = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 10);
  const m = macd(closes);
  assert.equal(m.macd.length, m.signal.length);
  assert.equal(m.hist.length, m.signal.length);
  for (let i = 0; i < m.hist.length; i++) {
    assert.ok(Math.abs(m.hist[i] - (m.macd[i] - m.signal[i])) < 1e-9);
  }
});

test("rightAlign trims to the shortest common length, preserving tails", () => {
  const [a, b, c] = rightAlign([1, 2, 3, 4, 5], [7, 8, 9], [10, 11, 12, 13]);
  assert.equal(a.length, 3);
  assert.equal(b.length, 3);
  assert.equal(c.length, 3);
  assert.deepEqual(a, [3, 4, 5]);
  assert.deepEqual(c, [11, 12, 13]);
});

// ── ATR ────────────────────────────────────────────────────────────────

/** Candles with a constant 4-point range, rising 1 point per bar. */
function steadyCandles(n) {
  return Array.from({ length: n }, (_, i) => {
    const base = 100 + i;
    return { high: base + 2, low: base - 2, close: base, open: base };
  });
}

test("atr on a constant-range series equals that range", () => {
  const a = atr(steadyCandles(40), 14);
  assert.equal(a.length, 40 - 14);
  assert.ok(Math.abs(a[a.length - 1] - 4) < 1e-9);
});

test("atr returns empty rather than NaN when there are too few bars", () => {
  assert.deepEqual(atr(steadyCandles(14), 14), []);
  assert.deepEqual(atr([], 14), []);
  assert.deepEqual(atr(null, 14), []);
});

test("atr rejects a series containing a non-finite price", () => {
  const bad = steadyCandles(40);
  bad[10].high = NaN;
  assert.deepEqual(atr(bad, 14), []);
});

test("atr grows when the range widens", () => {
  const narrow = latestAtr(steadyCandles(40), 14);
  const wide = steadyCandles(40).map((c) => ({ ...c, high: c.close + 10, low: c.close - 10 }));
  assert.ok(latestAtr(wide, 14) > narrow);
});

test("latestAtr returns null instead of undefined when unavailable", () => {
  assert.equal(latestAtr(steadyCandles(5), 14), null);
});
