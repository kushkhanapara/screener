import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRows } from "./rows.js";
import { sma } from "./indicators.js";
import { MIN_BARS } from "../config.js";

/** A gently oscillating close series — enough variation to keep RSI finite. */
const wave = (n, amp = 10, period = 8) =>
  Array.from({ length: n }, (_, i) => ({ close: 100 + Math.sin(i / period) * amp }));

test("returns null below MIN_BARS", () => {
  assert.equal(buildRows(wave(MIN_BARS - 1)), null);
});

test("returns null for a non-array or empty input", () => {
  assert.equal(buildRows(null), null);
  assert.equal(buildRows([]), null);
});

test("returns null when any close is non-finite", () => {
  const candles = wave(120);
  candles[42].close = NaN;
  assert.equal(buildRows(candles), null);
});

test("ma200 is null below 200 bars while core fields stay finite", () => {
  const rows = buildRows(wave(120));
  assert.ok(rows, "expected rows");
  assert.equal(rows.latest.ma200, null);

  for (const k of ["close", "rsi14", "rsiSignal", "macd", "macdSignal", "sma34", "ma20", "ma50", "ema5"]) {
    assert.ok(Number.isFinite(rows.latest[k]), `latest.${k} should be finite`);
    assert.ok(Number.isFinite(rows.prev[k]), `prev.${k} should be finite`);
  }
});

test("ma200 is finite once there are enough bars", () => {
  const rows = buildRows(wave(260));
  assert.ok(Number.isFinite(rows.latest.ma200));
});

test("latest and prev are adjacent bars of the same aligned series", () => {
  const candles = wave(260);
  const closes = candles.map((c) => c.close);
  const ma50 = sma(closes, 50);

  const rows = buildRows(candles);
  assert.ok(Math.abs(rows.latest.ma50 - ma50[ma50.length - 1]) < 1e-9);
  assert.ok(Math.abs(rows.prev.ma50 - ma50[ma50.length - 2]) < 1e-9);
});

test("latest.close is the final candle's close", () => {
  const candles = wave(120);
  const rows = buildRows(candles);
  assert.ok(Math.abs(rows.latest.close - candles[candles.length - 1].close) < 1e-9);
  assert.ok(Math.abs(rows.prev.close - candles[candles.length - 2].close) < 1e-9);
});

test("macdHist equals macd - macdSignal on both rows", () => {
  const rows = buildRows(wave(260));
  for (const r of [rows.latest, rows.prev]) {
    assert.ok(Math.abs(r.macdHist - (r.macd - r.macdSignal)) < 1e-9);
  }
});

test("every declared row field is present", () => {
  const rows = buildRows(wave(260));
  const expected = [
    "close", "rsi14", "rsiSignal", "macd", "macdSignal", "macdHist",
    "sma34", "ma20", "ma50", "ma200", "ema5", "ema9", "ema21",
  ];
  assert.deepEqual(Object.keys(rows.latest).sort(), [...expected].sort());
});

test("a rising series yields a high RSI and price above its moving averages", () => {
  const rising = Array.from({ length: 260 }, (_, i) => ({ close: 100 + i * 0.5 }));
  const { latest } = buildRows(rising);
  assert.ok(latest.rsi14 > 70, `expected strong RSI, got ${latest.rsi14}`);
  assert.ok(latest.close > latest.sma34);
  assert.ok(latest.sma34 > latest.ma200);
});

test("a falling series yields a low RSI and price below its moving averages", () => {
  const falling = Array.from({ length: 260 }, (_, i) => ({ close: 300 - i * 0.5 }));
  const { latest } = buildRows(falling);
  assert.ok(latest.rsi14 < 30, `expected weak RSI, got ${latest.rsi14}`);
  assert.ok(latest.close < latest.sma34);
  assert.ok(latest.sma34 < latest.ma200);
});
