import { test } from "node:test";
import assert from "node:assert/strict";
import { dayTrend, trendDayVeto } from "./dayType.js";

const ist = (h, m) => Date.UTC(2026, 8, 16, h - 5, m - 30);
const bar = (h, m, open, close) => ({ time: ist(h, m), open, high: Math.max(open, close), low: Math.min(open, close), close });
const CFG = { minBars: 10, minMovePct: 0.4, minEfficiency: 0.3 };

function series(closes) {
  let prev = 100;
  return closes.map((c, i) => {
    const b = bar(9, 15 + 3 * i, prev, c);
    prev = c;
    return b;
  });
}

test("a steady climb is a trending day with high efficiency", () => {
  const bars = series(Array.from({ length: 12 }, (_, i) => 100 + 0.05 * (i + 1)));
  const t = dayTrend(bars, ist(9, 55));
  assert.equal(t.direction, "up");
  assert.ok(t.movePct > 0.5);
  assert.ok(t.efficiency > 0.95);
  assert.equal(trendDayVeto(t, "long", CFG), null);
  assert.match(trendDayVeto(t, "short", CFG), /against Nifty/);
});

test("back-and-forth chop is vetoed even when it ends up a little", () => {
  const bars = series([100.3, 99.8, 100.4, 99.9, 100.5, 99.9, 100.4, 100.0, 100.5, 100.1, 100.6, 100.45]);
  const t = dayTrend(bars, ist(9, 55));
  assert.ok(t.efficiency < 0.3, `efficiency ${t.efficiency}`);
  assert.match(trendDayVeto(t, "long", CFG), /choppy/);
});

test("a flat day is vetoed", () => {
  const bars = series(Array.from({ length: 12 }, () => 100.05));
  assert.match(trendDayVeto(dayTrend(bars, ist(9, 55)), "long", CFG), /flat/);
});

test("nothing is judged before enough bars exist", () => {
  const bars = series([100.5, 101, 101.5]);
  assert.equal(trendDayVeto(dayTrend(bars, ist(9, 25)), "long", CFG), "too early to judge the day");
});

test("only today's bars count, never yesterday's", () => {
  const yesterday = { time: ist(9, 15) - 86_400_000, open: 90, high: 90, low: 90, close: 90 };
  const t = dayTrend([yesterday, ...series([100.1])], ist(9, 20));
  assert.equal(t.bars, 1);
});

// ── Day-type switch ────────────────────────────────────────────────────

import { classifyDay, dayTypeVeto, DAY_TYPE } from "./dayType.js";

const T = (bars, movePct, efficiency) => ({ bars, movePct, efficiency, direction: movePct > 0 ? "up" : movePct < 0 ? "down" : null });

test("days are classified from move and steadiness", () => {
  assert.equal(classifyDay(T(5, 1, 0.9)), "early");
  assert.equal(classifyDay(T(20, 0.5, 0.5)), "trend-up");
  assert.equal(classifyDay(T(20, -0.45, 0.4)), "trend-down");
  assert.equal(classifyDay(T(20, 0.12, 0.6)), "flat", "barely moved");
  assert.equal(classifyDay(T(20, 0.8, 0.2)), "flat", "moved but choppy");
  assert.equal(classifyDay(T(20, 0.35, 0.35)), "unclear");
  assert.equal(DAY_TYPE.trend.minMovePct, 0.4);
});

test("trend strategies trade only on trend days, in the trend's direction", () => {
  const s = { dayTypes: ["trend"] };
  assert.equal(dayTypeVeto(s, T(20, 0.6, 0.5), "long"), null);
  assert.match(dayTypeVeto(s, T(20, 0.6, 0.5), "short"), /Against today's trend/);
  assert.match(dayTypeVeto(s, T(20, 0.1, 0.5), "long"), /Not a trend day — flat/);
  assert.match(dayTypeVeto(s, T(20, 0.35, 0.35), "long"), /unclear/);
  assert.equal(dayTypeVeto(s, T(3, 1, 1), "long"), "Too early to judge the day");
});

test("flat-day strategies trade only on flat days, either direction", () => {
  const s = { dayTypes: ["flat"] };
  assert.equal(dayTypeVeto(s, T(20, 0.1, 0.5), "long"), null);
  assert.equal(dayTypeVeto(s, T(20, -0.1, 0.5), "short"), null);
  assert.match(dayTypeVeto(s, T(20, 0.6, 0.6), "short"), /Not a flat day — trending up/);
});

test("strategies without day types are never vetoed", () => {
  assert.equal(dayTypeVeto({}, T(3, 0, 0), "long"), null);
});
