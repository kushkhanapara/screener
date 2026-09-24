import { test } from "node:test";
import assert from "node:assert/strict";
import { linregSlope, classifyRegime } from "./regime.js";
import { vwapSeries } from "./vwapBands.js";

test("linear regression slope of a straight line is its slope", () => {
  assert.equal(linregSlope([1, 3, 5, 7]), 2);
  assert.equal(linregSlope([4]), null);
});

test("classifies up, down and rotation against ε = epsAtr × ATR", () => {
  const line = (step) => ({ vwap: Array.from({ length: 10 }, (_, i) => 100 + i * step) });
  assert.equal(classifyRegime(line(0.1), 1).regime, "up");
  assert.equal(classifyRegime(line(-0.1), 1).regime, "down");
  assert.equal(classifyRegime(line(0.04), 1).regime, "rotation");
  assert.equal(classifyRegime(line(0.04), 0.5).regime, "up", "a quieter stock has a smaller ε");
  assert.equal(classifyRegime({ vwap: [1, 2] }, 1), null, "too few values");
});

test("the Upper Band alone reads a flat, widening session as an uptrend; the VWAP line does not", () => {
  // Price swings ever wider around 100: VWAP stays put while σ grows.
  const bars = Array.from({ length: 30 }, (_, i) => {
    const p = 100 + (i % 2 ? 1 : -1) * (0.2 + i * 0.2);
    return { time: i, open: p, high: p, low: p, close: p, volume: 1 };
  });
  const s = vwapSeries(bars);
  assert.equal(classifyRegime(s, 1, { source: "upper" }).regime, "up");
  assert.equal(classifyRegime(s, 1, { source: "vwap" }).regime, "rotation");
  assert.equal(classifyRegime(s, 1, { source: "bands" }).regime, "rotation");
});
