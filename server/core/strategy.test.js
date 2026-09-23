import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, hasHistory, describe, longChecks, shortChecks } from "./strategy.js";

/** A row satisfying every LONG check; override fields to break one at a time. */
const longRow = (over = {}) => ({
  close: 110,
  sma34: 100,
  ema5: 105,
  ma200: 90,
  rsi14: 65,
  macd: 0.5,
  macdSignal: 0.2,
  macdHist: 0.3,
  ...over,
});

/** Mirror of the above for the SHORT side. */
const shortRow = (over = {}) => ({
  close: 90,
  sma34: 100,
  ema5: 95,
  ma200: 110,
  rsi14: 35,
  macd: -0.5,
  macdSignal: -0.2,
  macdHist: -0.3,
  ...over,
});

test("a fully qualifying long row passes with every reason listed", () => {
  const res = evaluate(longRow(), "long");
  assert.equal(res.pass, true);
  assert.equal(res.reasons.length, longChecks.length);
});

test("a fully qualifying short row passes", () => {
  const res = evaluate(shortRow(), "short");
  assert.equal(res.pass, true);
  assert.equal(res.reasons.length, shortChecks.length);
});

test("evaluate defaults to the long side", () => {
  assert.equal(evaluate(longRow()).pass, true);
  assert.deepEqual(evaluate(longRow()), evaluate(longRow(), "long"));
});

test("an unknown side falls back to long rather than throwing", () => {
  assert.equal(evaluate(longRow(), "sideways").pass, true);
});

// Each check must be individually load-bearing — if breaking one still passes,
// that check is dead weight.
for (const [name, over] of [
  ["close below sma34", { close: 99 }],
  ["ema5 below sma34", { ema5: 95 }],
  ["sma34 below ma200", { ma200: 120 }],
  ["rsi under the threshold", { rsi14: 59.9 }],
  ["macd below signal", { macd: 0.1 }],
]) {
  test(`long fails when ${name}`, () => {
    const res = evaluate(longRow(over), "long");
    assert.equal(res.pass, false);
    assert.ok(res.reasons.length < longChecks.length);
  });
}

for (const [name, over] of [
  ["close above sma34", { close: 101 }],
  ["ema5 above sma34", { ema5: 105 }],
  ["sma34 above ma200", { ma200: 90 }],
  ["rsi over the threshold", { rsi14: 40.1 }],
  ["macd above signal", { macd: -0.1 }],
]) {
  test(`short fails when ${name}`, () => {
    assert.equal(evaluate(shortRow(over), "short").pass, false);
  });
}

test("rsi thresholds are inclusive at the boundary", () => {
  assert.equal(evaluate(longRow({ rsi14: 60 }), "long").pass, true);
  assert.equal(evaluate(shortRow({ rsi14: 40 }), "short").pass, true);
});

test("a null ma200 fails the trend check instead of throwing", () => {
  const res = evaluate(longRow({ ma200: null }), "long");
  assert.equal(res.pass, false);
  assert.equal(evaluate(shortRow({ ma200: null }), "short").pass, false);
});

test("hasHistory distinguishes data-limited rows from non-matching ones", () => {
  assert.equal(hasHistory(longRow()), true);
  assert.equal(hasHistory(longRow({ ma200: null })), false);
  assert.equal(hasHistory(undefined), false);
});

test("describe returns one label per check for each side", () => {
  assert.equal(describe("long").length, longChecks.length);
  assert.equal(describe("short").length, shortChecks.length);
  assert.ok(describe("long").every((s) => typeof s === "string" && s.length));
});

test("the long and short descriptions are not identical", () => {
  assert.notDeepEqual(describe("long"), describe("short"));
});

test("long and short cannot both pass on the same row", () => {
  // The sides are strict mirrors, so a row qualifying for both would mean a
  // contradictory check set.
  for (const row of [longRow(), shortRow()]) {
    const both = evaluate(row, "long").pass && evaluate(row, "short").pass;
    assert.equal(both, false);
  }
});
