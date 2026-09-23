import { test } from "node:test";
import assert from "node:assert/strict";
import { list, get, ids, describeAll, validate, familyOf, selectiveVariants } from "./index.js";
import trendMomentum from "./trendMomentum.js";
import vwapRs from "./vwapRelativeStrength.js";
import { buildContext, atrPct, runChecks } from "./context.js";

// ── Registry ───────────────────────────────────────────────────────────

test("registry exposes every strategy with unique ids", () => {
  assert.equal(list().length, 3);
  assert.equal(new Set(ids()).size, 3);
  assert.equal(get("trend-momentum"), trendMomentum);
  assert.equal(get("vwap-relative-strength"), vwapRs);
  assert.equal(get("momentum-surge")?.id, "momentum-surge");
  assert.equal(get("nope"), undefined);
});

test("every registered strategy passes shape validation", () => {
  assert.deepEqual(validate(), []);
});

test("describeAll returns UI metadata without leaking check functions", () => {
  for (const s of describeAll()) {
    assert.ok(s.id && s.name);
    assert.ok(Array.isArray(s.description.long) && s.description.long.length);
    assert.ok(Array.isArray(s.description.short) && s.description.short.length);
    assert.ok(Number.isFinite(s.exits.stopAtr));
    assert.equal(JSON.stringify(s).includes("function"), false);
  }
});

test("the strategies use different exit parameters", () => {
  assert.notDeepEqual(trendMomentum.exits, vwapRs.exits);
  const originals = list().filter((s) => !s.selection);
  const seen = originals.map((s) => JSON.stringify(s.exits));
  assert.equal(new Set(seen).size, seen.length, "each strategy tunes its own exits");
});

test("live trading runs the originals only, on the 15 Sept exit rules", () => {
  for (const s of list()) {
    assert.equal(s.selection, undefined, `${s.id} must not be a Selective variant`);
    assert.equal(s.exits.proveItBars, undefined, `${s.id}: no early "no follow-through" exit`);
    assert.ok(s.exits.timeStopBars >= 1000, `${s.id}: no time stop`);
    assert.deepEqual(s.dayTypes, ["trend"], `${s.id}: trades on trend days only`);
  }
});

test("Selective variants stay available to the replay with the same signal and exits", () => {
  const originals = list();
  for (const o of originals) {
    const twin = selectiveVariants().find((s) => s.id === `${o.id}-selective`);
    assert.ok(twin, `${o.id} has a Selective version`);
    assert.equal(twin.evaluate, o.evaluate, "same signal");
    assert.deepEqual(twin.exits, o.exits, "stops and exits are untouched");
    assert.equal(familyOf(twin), o.id);
    assert.equal(familyOf(o), o.id);
    assert.ok(twin.selection);
  }
});

// ── Shared helpers ─────────────────────────────────────────────────────

test("atrPct converts ATR into a percentage of price", () => {
  assert.ok(Math.abs(atrPct(2, 100) - 2) < 1e-9);
  assert.equal(atrPct(null, 100), null);
  assert.equal(atrPct(2, 0), null);
});

test("runChecks treats a throwing check as failed rather than crashing", () => {
  const checks = [
    { label: "ok", test: () => true },
    { label: "explodes", test: () => { throw new Error("boom"); } },
  ];
  const res = runChecks(checks, {}, {});
  assert.equal(res.pass, false);
  assert.deepEqual(res.reasons, ["ok"]);
});

// ── Strategy A: Trend Momentum ─────────────────────────────────────────

/** Rows that satisfy every long condition on both timeframes. */
const aLong = (over = {}) => ({
  rows: {
    "15m": {
      latest: { close: 110, sma34: 100, ma200: 90, ...over.l15 },
      prev: { close: 110, sma34: 100, ma200: 90, ...over.p15 },
    },
    "3m": {
      latest: { close: 110, sma34: 100, ema5: 105, rsi14: 65, ...over.l3 },
      // Default prior bar FAILS, so the setup is a fresh transition.
      prev: { close: 110, sma34: 100, ema5: 95, rsi14: 50, ...over.p3 },
    },
  },
});

test("A fires long when the trend gate and trigger both complete", () => {
  const res = trendMomentum.evaluate(aLong());
  assert.equal(res.side, "long");
  assert.equal(res.reasons.length, 4);
  assert.ok(Math.abs(res.score - 5) < 1e-9); // rsi 65 - threshold 60
});

test("A does NOT re-fire while the same setup persists", () => {
  // Prior bar already satisfied everything -> standing state, not an event.
  const res = trendMomentum.evaluate(
    aLong({ p3: { close: 110, sma34: 100, ema5: 105, rsi14: 65 } })
  );
  assert.equal(res.side, null);
});

test("A refuses long when the 15m trend gate is against it", () => {
  assert.equal(trendMomentum.evaluate(aLong({ l15: { ma200: 120 } })).side, null);
  assert.equal(trendMomentum.evaluate(aLong({ l15: { close: 99 } })).side, null);
});

test("A refuses long when the 3m trigger is incomplete", () => {
  assert.equal(trendMomentum.evaluate(aLong({ l3: { rsi14: 59 } })).side, null);
  assert.equal(trendMomentum.evaluate(aLong({ l3: { ema5: 95 } })).side, null);
});

test("A treats a null ma200 as no trend rather than throwing", () => {
  assert.equal(trendMomentum.evaluate(aLong({ l15: { ma200: null } })).side, null);
});

test("A fires short on the mirrored setup", () => {
  const res = trendMomentum.evaluate({
    rows: {
      "15m": { latest: { close: 90, sma34: 100, ma200: 110 }, prev: { close: 90, sma34: 100, ma200: 110 } },
      "3m": {
        latest: { close: 90, sma34: 100, ema5: 95, rsi14: 35 },
        prev: { close: 90, sma34: 100, ema5: 105, rsi14: 50 },
      },
    },
  });
  assert.equal(res.side, "short");
});

test("A returns no signal when a timeframe has no rows", () => {
  assert.equal(trendMomentum.evaluate({ rows: { "15m": null, "3m": null } }).side, null);
  assert.equal(trendMomentum.evaluate({}).side, null);
});

// ── Strategy B: VWAP Relative Strength ─────────────────────────────────

/** A context satisfying every long condition. */
const bLong = (over = {}) => ({
  vwap: 100,
  relStrength: 1.0,
  sessionVolume: 200_000,
  atr: { "3m": 1.0 },
  rows: {
    "3m": {
      latest: { close: 105, ema9: 104, ...over.latest },
      prev: { close: 99, ema9: 100, ...over.prev }, // was below EMA9
    },
  },
  ...over.ctx,
});

test("B fires long on a reclaim by an outperforming name", () => {
  const res = vwapRs.evaluate(bLong());
  assert.equal(res.side, "long");
  assert.equal(res.reasons.length, 5);
  assert.equal(res.score, 1.0);
});

test("B requires genuine outperformance, not just an up move", () => {
  // Rising with the market is exactly what this strategy exists to exclude.
  assert.equal(vwapRs.evaluate(bLong({ ctx: { relStrength: 0.1 } })).side, null);
  assert.equal(vwapRs.evaluate(bLong({ ctx: { relStrength: null } })).side, null);
});

test("B requires a pullback — it will not chase a bar already above EMA9", () => {
  assert.equal(vwapRs.evaluate(bLong({ prev: { close: 105, ema9: 100 } })).side, null);
});

test("B rejects names below the volatility floor", () => {
  // ATR 0.01 on a 105 price is ~0.01% — far under the 0.12% floor.
  assert.equal(vwapRs.evaluate(bLong({ ctx: { atr: { "3m": 0.01 } } })).side, null);
  assert.equal(vwapRs.evaluate(bLong({ ctx: { atr: {} } })).side, null);
});

test("B rejects names below the liquidity floor", () => {
  assert.equal(vwapRs.evaluate(bLong({ ctx: { sessionVolume: 100 } })).side, null);
});

test("B requires price on the right side of VWAP", () => {
  assert.equal(vwapRs.evaluate(bLong({ ctx: { vwap: 110 } })).side, null);
  assert.equal(vwapRs.evaluate(bLong({ ctx: { vwap: null } })).side, null);
});

test("B fires short on the mirrored setup", () => {
  const res = vwapRs.evaluate({
    vwap: 100,
    relStrength: -1.0,
    sessionVolume: 200_000,
    atr: { "3m": 1.0 },
    rows: { "3m": { latest: { close: 95, ema9: 96 }, prev: { close: 101, ema9: 100 } } },
  });
  assert.equal(res.side, "short");
  assert.equal(res.score, 1.0, "score is magnitude, so sides rank comparably");
});

test("B returns no signal without 3m rows", () => {
  assert.equal(vwapRs.evaluate({ rows: {} }).side, null);
});

// ── Context builder ────────────────────────────────────────────────────

const MIN = 60000;
const BASE = Date.UTC(2026, 8, 11, 9 - 5, 15 - 30); // 09:15 IST, Fri 2026-09-11

const series = (n, startPrice, step, startMs, stepMs) =>
  Array.from({ length: n }, (_, i) => {
    const c = startPrice + i * step;
    return { time: startMs + i * stepMs, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 };
  });

test("buildContext assembles rows, atr, vwap and relative strength", () => {
  const now = BASE + 200 * 3 * MIN;
  const ctx = buildContext({
    underlying: "TEST",
    cashKey: "NSE_EQ|TEST",
    bars3m: series(220, 100, 0.5, BASE, 3 * MIN),
    bars15m: series(220, 100, 0.5, BASE, 15 * MIN),
    indexBars3m: series(220, 20000, 10, BASE, 3 * MIN),
    now,
  });

  assert.equal(ctx.underlying, "TEST");
  assert.ok(ctx.rows["3m"] && ctx.rows["15m"]);
  assert.ok(Number.isFinite(ctx.atr["3m"]));
  assert.ok(Number.isFinite(ctx.vwap));
  assert.ok(Number.isFinite(ctx.pctFromOpen));
  assert.ok(Number.isFinite(ctx.relStrength));
  assert.ok(ctx.sessionVolume > 0);
});

test("buildContext leaves relStrength null when the index is missing", () => {
  const ctx = buildContext({
    underlying: "TEST",
    cashKey: "K",
    bars3m: series(220, 100, 0.5, BASE, 3 * MIN),
    bars15m: series(220, 100, 0.5, BASE, 15 * MIN),
    now: BASE + 200 * 3 * MIN,
  });
  assert.equal(ctx.relStrength, null, "null means unknown, distinct from 0 = in line");
});

test("buildContext tolerates too-few bars without throwing", () => {
  const ctx = buildContext({
    underlying: "TEST",
    cashKey: "K",
    bars3m: series(5, 100, 1, BASE, 3 * MIN),
    bars15m: [],
    now: BASE + 5 * 3 * MIN,
  });
  assert.equal(ctx.rows["3m"], null);
  assert.equal(ctx.rows["15m"], null);
  assert.equal(ctx.atr["3m"], null);
});

test("a context built from too-few bars yields no signal from either strategy", () => {
  const ctx = buildContext({
    underlying: "TEST",
    cashKey: "K",
    bars3m: series(5, 100, 1, BASE, 3 * MIN),
    bars15m: [],
    now: BASE + 5 * 3 * MIN,
  });
  for (const s of list()) {
    assert.equal(s.evaluate(ctx).side, null, `${s.id} should stay silent`);
  }
});
