/**
 * Deterministic checks for the shared core (indicators + rows + strategy).
 * Run with: npm run verify:core
 * No network, no token — pure math.
 */
import assert from "node:assert/strict";
import { sma, ema, rsi, macd, rightAlign } from "../core/indicators.js";
import { buildRows } from "../core/rows.js";
import { evaluate, checks } from "../core/strategy.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("Core verification\n");

test("sma computes trailing average, correct length", () => {
  const v = [1, 2, 3, 4, 5];
  const s = sma(v, 3);
  assert.equal(s.length, 3);
  assert.deepEqual(s, [2, 3, 4]);
});

test("ema length = n - period + 1 and seeds on SMA", () => {
  const v = [1, 2, 3, 4, 5, 6];
  const e = ema(v, 3);
  assert.equal(e.length, 4);
  assert.ok(Math.abs(e[0] - 2) < 1e-9); // SMA of [1,2,3]
});

test("rsi is 100 for a monotonically rising series", () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const r = rsi(closes, 14);
  assert.equal(r.length, closes.length - 14);
  assert.ok(r[r.length - 1] > 99.9);
});

test("rightAlign trims all arrays to shortest common length, tails preserved", () => {
  const [a, b, c] = rightAlign([1, 2, 3, 4, 5], [7, 8, 9], [10, 11, 12, 13]);
  assert.equal(a.length, 3);
  assert.equal(b.length, 3);
  assert.equal(c.length, 3);
  assert.deepEqual(a, [3, 4, 5]); // last 3 of first array
  assert.deepEqual(c, [11, 12, 13]);
});

test("macd returns macd/signal/hist at equal, aligned lengths", () => {
  const closes = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 10);
  const m = macd(closes);
  assert.equal(m.macd.length, m.signal.length);
  assert.equal(m.hist.length, m.signal.length);
  // hist == macd - signal element-wise
  for (let i = 0; i < m.hist.length; i++) {
    assert.ok(Math.abs(m.hist[i] - (m.macd[i] - m.signal[i])) < 1e-9);
  }
});

test("buildRows returns null below MIN_BARS", () => {
  const short = Array.from({ length: 40 }, (_, i) => ({ close: 100 + i }));
  assert.equal(buildRows(short), null);
});

test("buildRows: ma200 is null when <200 bars but core fields finite", () => {
  const candles = Array.from({ length: 120 }, (_, i) => ({
    close: 100 + Math.sin(i / 6) * 8,
  }));
  const rows = buildRows(candles);
  assert.ok(rows, "expected rows");
  assert.equal(rows.latest.ma200, null);
  for (const k of ["close", "rsi14", "macd", "macdSignal", "ma20", "ma50"]) {
    assert.ok(Number.isFinite(rows.latest[k]), `${k} finite`);
    assert.ok(Number.isFinite(rows.prev[k]), `prev ${k} finite`);
  }
});

test("buildRows: ma200 finite with >=200 bars, latest/prev on same bars", () => {
  const candles = Array.from({ length: 260 }, (_, i) => ({
    close: 100 + Math.sin(i / 10) * 15,
  }));
  const rows = buildRows(candles);
  assert.ok(Number.isFinite(rows.latest.ma200));
  // latest.ma50 must equal a fresh SMA50 of the whole series' last value.
  const closes = candles.map((c) => c.close);
  const ma50 = sma(closes, 50);
  assert.ok(Math.abs(rows.latest.ma50 - ma50[ma50.length - 1]) < 1e-9);
  assert.ok(Math.abs(rows.prev.ma50 - ma50[ma50.length - 2]) < 1e-9);
});

test("strategy: evaluate passes only when ALL checks pass", () => {
  // Craft a row that satisfies the interim uptrend-momentum strategy.
  const latest = {
    close: 110, ma50: 100, ma200: 90, ema9: 105, ema21: 102,
    macd: 0.5, macdSignal: 0.2, macdHist: 0.3, rsi14: 60,
  };
  const res = evaluate(latest, latest);
  assert.equal(res.pass, true);
  assert.equal(res.reasons.length, checks.length);
});

test("strategy: fails if any single check fails", () => {
  // Same, but RSI is overbought (80) -> the RSI band check fails.
  const latest = {
    close: 110, ma50: 100, ma200: 90, ema9: 105, ema21: 102,
    macd: 0.5, macdSignal: 0.2, macdHist: 0.3, rsi14: 80,
  };
  const res = evaluate(latest, latest);
  assert.equal(res.pass, false);
});

test("end-to-end: RSI crossover detected across the same aligned bar", () => {
  // Long steady decline (RSI low) then two up bars: prev bar keeps RSI < 30,
  // latest bar lifts it >= 30. Confirms latest/prev index the same bars.
  const closes = [];
  let p = 200;
  for (let i = 0; i < 80; i++) {
    p -= 0.5; // gentle steady decline drives RSI toward oversold
    closes.push(p);
  }
  closes.push(p + 0.2); // small up tick (prev-of-latest), RSI stays < 30
  closes.push(p + 6); // strong up tick (latest) -> RSI pops above 30
  const candles = closes.map((c) => ({ close: c }));
  const rows = buildRows(candles);
  assert.ok(rows, "expected rows");
  assert.ok(rows.prev.rsi14 < 30, `prev RSI ${rows.prev.rsi14} should be <30`);
  assert.ok(rows.latest.rsi14 >= 30, `latest RSI ${rows.latest.rsi14} should be >=30`);
});

console.log(`\n${passed} checks passed.\n`);
