import { test } from "node:test";
import assert from "node:assert/strict";
import { orbHold, rsLeaders, gapGo, relativeVolume, RESEARCH_BOOKS } from "./research.js";

const at = (h, m) => Date.UTC(2026, 8, 18, h - 5, m - 30);
const bar = (h, m, o, hi, lo, c) => ({ time: at(h, m), open: o, high: hi, low: lo, close: c, volume: 100_000 });

function ctx({ now, bars, close, rs = 1, pct = 1.2, index = 0.4, gap = 0, prevClose = 100, vwap = 100, volume = 2_000_000, turnover = 200_000_000 }) {
  return {
    now,
    bars: { "3m": bars },
    rows: { "3m": { latest: { close }, prev: { close } } },
    atr: { "3m": 0.5 },
    relStrength: rs,
    pctFromOpen: pct,
    index: { pctFromOpen: index },
    gapPct: gap,
    vwap,
    sessionVolume: volume,
    daily: { avgTurnover20: turnover, prevClose },
  };
}

test("relative volume compares today's pace with a normal day", () => {
  const c = ctx({ now: at(10, 30), bars: [], close: 100, volume: 1_000_000, turnover: 375_000_000 });
  // 75 of 375 minutes gone, ₹10 crore traded vs ₹7.5 crore expected → 1.33×
  assert.ok(Math.abs(relativeVolume(c) - 1.333) < 0.01);
});

test("breakout-hold buys a fresh 15-minute close above the opening range", () => {
  const bars = [bar(9, 15, 100, 101, 99.5, 100.8), bar(9, 30, 100.8, 101.2, 100.4, 101), bar(9, 45, 101, 101.1, 100.6, 101), bar(10, 0, 101, 101.8, 100.9, 101.6)];
  assert.equal(orbHold().evaluate(ctx({ now: at(10, 15), bars, close: 101.6 })).side, "long");
  assert.equal(orbHold().evaluate(ctx({ now: at(10, 15), bars, close: 101.6, index: -0.2 })).side, null, "not against Nifty");
});

test("10:15 leaders only decide at 10:15", () => {
  const bars = [bar(9, 15, 100, 102, 99.8, 101.8), bar(10, 0, 101.8, 102.5, 101.5, 102.2)];
  assert.equal(rsLeaders().evaluate(ctx({ now: at(10, 15), bars, close: 102.2, rs: 1.8, pct: 2.2, vwap: 101.5, volume: 5_000_000 })).side, "long");
  assert.equal(rsLeaders().evaluate(ctx({ now: at(11, 0), bars, close: 102.2, rs: 1.8, pct: 2.2, vwap: 101.5, volume: 5_000_000 })).side, null);
});

test("gap continuation needs the gap to hold", () => {
  const held = [bar(9, 15, 102, 102.8, 101.6, 102.5), bar(9, 30, 102.5, 103, 102.2, 102.8)];
  const faded = [bar(9, 15, 102, 102.2, 100.4, 100.8), bar(9, 30, 100.8, 101.4, 100.6, 101.2)];
  assert.equal(gapGo().evaluate(ctx({ now: at(9, 45), bars: held, close: 102.8, gap: 2 })).side, "long");
  assert.equal(gapGo().evaluate(ctx({ now: at(9, 45), bars: faded, close: 101.2, gap: 2 })).side, null);
});

test("research strategies are 15-minute, hold-to-close, and not live", () => {
  for (const s of RESEARCH_BOOKS) {
    assert.equal(s.tf15, true);
    assert.ok(s.exits.targetR >= 10, `${s.id}: no quick target`);
    assert.equal(s.exits.squareOffMin, 15 * 60 + 15);
  }
});
