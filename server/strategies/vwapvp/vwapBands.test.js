import { test } from "node:test";
import assert from "node:assert/strict";
import {
  vwapSeries,
  vwapBandsAt,
  sessionAnchor,
  weekStartMs,
  weekAnchor,
  yearStartMs,
  fractalSwings,
  gapAnchors,
  eventAnchors,
} from "./vwapBands.js";

const ist = (y, mo, d, h, m) => Date.UTC(y, mo - 1, d, h - 5, m - 30);
const flat = (time, price, volume = 1) => ({ time, open: price, high: price, low: price, close: price, volume });
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test("VWAP and σ match the volume-weighted definitions", () => {
  const s = vwapSeries([flat(0, 10, 1), flat(1, 20, 3)]);
  near(s.vwap[1], 17.5);
  // σ² = (1·(10 − 17.5)² + 3·(20 − 17.5)²) / 4 = 18.75
  near(s.sigma[1], Math.sqrt(18.75));
  near(s.upper[1], 17.5 + Math.sqrt(18.75));
  near(s.lower[1], 17.5 - Math.sqrt(18.75));
});

test("typical price is (H + L + C) / 3", () => {
  const b = vwapBandsAt([{ time: 0, open: 9, high: 12, low: 9, close: 9, volume: 5 }]);
  near(b.vwap, 10);
  near(b.sigma, 0);
});

test("bars without volume are null until the first traded bar, then carry the value", () => {
  const s = vwapSeries([flat(0, 5, 0), flat(1, 10, 2), flat(2, 99, 0)]);
  assert.equal(s.vwap[0], null);
  near(s.vwap[1], 10);
  near(s.vwap[2], 10);
});

test("the daily anchor resets at 09:15 IST: yesterday's bars do not leak in", () => {
  const bars = [flat(ist(2026, 9, 22, 15, 27), 500, 1_000_000), flat(ist(2026, 9, 23, 9, 15), 100, 1), flat(ist(2026, 9, 23, 9, 18), 102, 1)];
  const now = ist(2026, 9, 23, 9, 21);
  const a = sessionAnchor(bars, now);
  assert.equal(a.index, 1);
  near(vwapBandsAt(bars, a.index).vwap, 101);
});

test("the week starts at Monday 09:15 IST, and an anchor is incomplete when the window starts after it", () => {
  assert.equal(weekStartMs(ist(2026, 9, 23, 11, 0)), ist(2026, 9, 21, 9, 15)); // Wed → Mon
  assert.equal(weekStartMs(ist(2026, 9, 21, 9, 0)), ist(2026, 9, 14, 9, 15)); // before Monday's open → last week
  const fromFri = [flat(ist(2026, 9, 18, 15, 27), 1), flat(ist(2026, 9, 21, 9, 15), 1), flat(ist(2026, 9, 23, 10, 0), 1)];
  assert.deepEqual(weekAnchor(fromFri, ist(2026, 9, 23, 11, 0)), { index: 1, complete: true });
  const fromTue = fromFri.slice(1).map((b, i) => (i === 0 ? { ...b, time: ist(2026, 9, 22, 9, 15) } : b));
  assert.equal(weekAnchor(fromTue, ist(2026, 9, 23, 11, 0)).complete, false);
});

test("the year starts on 1 January", () => {
  assert.equal(yearStartMs(ist(2026, 9, 23, 11, 0)), ist(2026, 1, 1, 9, 15));
});

test("fractal swings are only reported once N bars have closed on the right", () => {
  const lows = [5, 4, 3, 2, 1, 2, 3, 4, 5];
  const bars = lows.map((l, i) => ({ time: i, open: l, high: l + 1, low: l, close: l, volume: 1 }));
  // With bars 0–6 the low at 4 has only two bars after it: not yet a swing.
  assert.deepEqual(fractalSwings(bars.slice(0, 7), 3).filter((s) => s.type === "low"), []);
  const found = fractalSwings(bars.slice(0, 8), 3).filter((s) => s.type === "low");
  assert.deepEqual(found, [{ index: 4, price: 1, type: "low", confirmedAt: 7 }]);
});

test("of two equal highs, only the first is a swing", () => {
  const highs = [1, 2, 5, 5, 2, 1, 1];
  const bars = highs.map((h, i) => ({ time: i, open: h, high: h, low: h - 1, close: h, volume: 1 }));
  assert.deepEqual(fractalSwings(bars, 2).filter((s) => s.type === "high").map((s) => s.index), [2]);
});

test("gap anchors fire on a ≥ 0.8% opening gap only", () => {
  const bars = [
    flat(ist(2026, 9, 21, 15, 27), 100),
    { ...flat(ist(2026, 9, 22, 9, 15), 101), open: 101 }, // +1.0%
    flat(ist(2026, 9, 22, 15, 27), 101),
    { ...flat(ist(2026, 9, 23, 9, 15), 101.5), open: 101.5 }, // +0.5%
  ];
  assert.deepEqual(gapAnchors(bars), [1]);
});

test("event anchors map timestamps to the first bar at or after them", () => {
  const bars = [0, 3, 6, 9].map((m) => flat(ist(2026, 9, 23, 10, m), 1));
  assert.deepEqual(eventAnchors(bars, [ist(2026, 9, 23, 10, 4), ist(2026, 9, 23, 9, 0), ist(2026, 9, 23, 11, 0)]), [2]);
});
