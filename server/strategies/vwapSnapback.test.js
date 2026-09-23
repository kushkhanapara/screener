import { test } from "node:test";
import assert from "node:assert/strict";
import snapback, { vwapSnapback } from "./vwapSnapback.js";

const at = (h, m) => Date.UTC(2026, 8, 17, h - 5, m - 30);

/** A context where price sits `stretch` ATRs below VWAP (negative = above). */
function ctx({ stretch = 3, rsi = 25, close = 100, prevHigh = 99.5, prevLow = 99, rs = 0.2, now = at(11, 0), volume = 500_000 } = {}) {
  const atr = 0.3; // 0.3% of price
  return {
    now,
    atr: { "3m": atr },
    vwap: close + stretch * atr,
    relStrength: rs,
    sessionVolume: volume,
    rows: { "3m": { latest: { close, rsi14: rsi }, prev: { close: close - 0.2, rsi14: rsi } } },
    bars: { "3m": [{ high: prevHigh, low: prevLow, close: prevHigh - 0.1 }, { high: close + 0.1, low: close - 0.2, close }] },
  };
}

test("buys a stretched, oversold stock that has turned back up", () => {
  const s = snapback.evaluate(ctx());
  assert.equal(s.side, "long");
  assert.ok(s.score >= 2.5);
});

test("no buy until the fall has stalled", () => {
  assert.equal(snapback.evaluate(ctx({ prevHigh: 100.5 })).side, null, "still below the previous bar's high");
});

test("no buy when not stretched far enough or not oversold", () => {
  assert.equal(snapback.evaluate(ctx({ stretch: 1.5 })).side, null);
  assert.equal(snapback.evaluate(ctx({ rsi: 45 })).side, null);
});

test("stays away from stocks on their own big move", () => {
  assert.equal(snapback.evaluate(ctx({ rs: -2.4 })).side, null);
});

test("nothing before 10:00 AM", () => {
  assert.equal(snapback.evaluate(ctx({ now: at(9, 51) })).side, null);
});

test("sells the mirror case: stretched above VWAP, overbought, turned down", () => {
  const s = snapback.evaluate(ctx({ stretch: -3, rsi: 78, prevLow: 100.5, prevHigh: 101 }));
  assert.equal(s.side, "short");
});

test("flat days only, one try per stock after a loss, no time stop", () => {
  assert.deepEqual(snapback.dayTypes, ["flat"]);
  assert.equal(snapback.noRetryAfterLoss, true);
  assert.ok(snapback.exits.timeStopBars >= 1000);
  assert.equal(snapback.exits.proveItBars, undefined);
});

test("variants carry their own settings", () => {
  const v = vwapSnapback({ id: "x", stretchAtr: 2, targetR: 1 });
  assert.equal(v.id, "x");
  assert.equal(v.exits.targetR, 1);
  assert.equal(v.evaluate(ctx({ stretch: 2.1 })).side, "long");
  assert.equal(snapback.evaluate(ctx({ stretch: 2.1 })).side, null, "default needs 2.5");
});
