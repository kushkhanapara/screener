import { test } from "node:test";
import assert from "node:assert/strict";
import vp, { vwapVolumeProfile, isReactionBar } from "./strategy.js";
import { rotationSession, trendSession, ctxOf, at } from "./fixtures.js";

// Lower-band bounce with a rejecting wick: open 98.05, high 98.2, low 97.9, close 98.15.
const BOUNCE = [98.05, 98.2, 97.9, 98.15];
// Pullback into VWAP (≈101.25) with a rejecting wick.
const PULLBACK = [101.35, 101.5, 101.2, 101.4];
// A session VWAP carrying heavy volume barely moves, so the trend test needs a finer ε.
const trendCfg = { regimeEpsAtr: 0.005 };

test("rotation: buys a lower-band bounce with VWAP as the target", () => {
  const s = vp.evaluate(ctxOf(rotationSession(BOUNCE), 0.8));
  assert.equal(s.side, "long");
  assert.equal(s.setup, "rotation");
  assert.ok(s.target > 100 && s.target < 100.3, `target ${s.target} should be VWAP`);
  assert.ok(s.stop < 98.15, "the stop sits below the entry, not below VWAP");
  assert.ok((s.target - 98.15) / (98.15 - s.stop) >= 1.5, "at least 1.5R to VWAP");
  assert.ok(s.reasons.some((r) => r.startsWith("A:")) && s.reasons.some((r) => r.startsWith("C:")));
});

test("rotation: sells the mirror case at the upper band", () => {
  const mirror = rotationSession(BOUNCE).map((b) => ({ ...b, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close }));
  const s = vp.evaluate(ctxOf(mirror, 0.8));
  assert.equal(s.side, "short");
  assert.ok(s.stop > mirror[mirror.length - 1].close && s.target < s.stop);
});

test("rotation: no trade when VWAP is too close to pay 1.5R", () => {
  // A wide ATR puts the stop so far away that VWAP is under 1.5R.
  assert.equal(vp.evaluate(ctxOf(rotationSession(BOUNCE), 2.5)).side, null);
});

test("an isolated touch is not enough: confluence below the minimum is skipped", () => {
  const strict = vwapVolumeProfile({ minConfluence: 3 });
  assert.equal(strict.evaluate(ctxOf(rotationSession(BOUNCE), 0.8)).side, null);
});

test("no signal without a reaction bar", () => {
  const noWick = [98.2, 98.25, 98.1, 98.15]; // closed down, no rejecting wick
  assert.equal(vp.evaluate(ctxOf(rotationSession(noWick), 0.8)).side, null);
});

test("no signal during the 09:15–09:30 opening buffer", () => {
  const bars = rotationSession(BOUNCE);
  const ctx = { ...ctxOf(bars, 0.8), now: at(9, 27) };
  assert.equal(vp.evaluate(ctx).side, null);
});

test("trend: buys a pullback into VWAP where the box and leg POCs agree", () => {
  const s = vwapVolumeProfile(trendCfg).evaluate(ctxOf(trendSession(PULLBACK), 1.0));
  assert.equal(s.side, "long");
  assert.equal(s.setup, "trend");
  assert.equal(s.target, null, "trend trades run on the trail");
  assert.ok(Math.abs(s.breakevenAt - 104.05) < 1e-9, "break-even at the prior swing high");
  assert.ok(s.reasons.some((r) => r.startsWith("B:")));
  assert.ok(s.invalidateAt < 101.25 && s.stop < s.invalidateAt, "zone below VWAP, stop 1 ATR below that");
});

test("trend: needs the dual POC — without the volume node there is no trade", () => {
  // Without the heavy consolidation, the box and leg POCs no longer agree.
  const s = vwapVolumeProfile(trendCfg).evaluate(ctxOf(trendSession(PULLBACK, { heavy: 1000 }), 1.0));
  assert.notEqual(s.setup, "trend");
});

test("modes switch the setups off independently", () => {
  assert.equal(vwapVolumeProfile({ modes: ["trend"] }).evaluate(ctxOf(rotationSession(BOUNCE), 0.8)).side, null);
  assert.equal(vwapVolumeProfile({ ...trendCfg, modes: ["rotation"] }).evaluate(ctxOf(trendSession(PULLBACK), 1.0)).setup, undefined);
});

test("reaction bars", () => {
  const bar = (open, high, low, close) => ({ open, high, low, close });
  assert.equal(isReactionBar(bar(10.5, 11, 10, 10.8), "long", 0.4), true);
  assert.equal(isReactionBar(bar(10.5, 11, 10, 10.4), "long", 0.4), false, "closed down");
  assert.equal(isReactionBar(bar(10.2, 11, 10, 10.8), "long", 0.4), false, "wick too short");
  assert.equal(isReactionBar(bar(10.5, 11, 10, 10.2), "short", 0.4), true);
});

test("has the exits and trigger timeframe the engine and registry require", () => {
  assert.equal(vp.timeframes.trigger, "3m");
  for (const k of ["stopAtr", "trailAtr", "breakevenAtR", "targetR", "timeStopBars", "squareOffMin"]) {
    assert.ok(Number.isFinite(vp.exits[k]), k);
  }
});


// ── Kept apart from the other strategies ────────────────────────────────

test("trades live on paper; its trend-only and rotation-only books stay in the replay", async () => {
  const registry = await import("../index.js");
  assert.equal(registry.get(vp.id), vp);
  assert.ok(!registry.ids().some((id) => id.startsWith("vwap-vp")));
  assert.deepEqual(registry.validate(), [], "every live strategy is still valid");
});

test("brings its own exit engine, so the shared one is not changed", async () => {
  const own = await import("./engine.js");
  assert.equal(vp.engine.applyBar, own.applyBar);
  assert.equal(vp.engine.openPosition, own.openPosition);
});
