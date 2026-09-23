import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SELECTION,
  alignedRsOf,
  stopPctOf,
  qualityOf,
  selectionVeto,
  isSelectionSkip,
  createDayState,
  buildDayStates,
  noteClose,
  createConfluence,
} from "./selection.js";

const BAR = 3 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 16, 5, 0);

// ── Strength vs Nifty ──────────────────────────────────────────────────

test("relative strength is signed toward the trade", () => {
  assert.equal(alignedRsOf(1.5, "long"), 1.5);
  assert.equal(alignedRsOf(-1.5, "short"), 1.5, "a stock falling harder than Nifty favours a short");
  assert.equal(alignedRsOf(1.5, "short"), -1.5);
  assert.equal(alignedRsOf(null, "long"), null);
});

test("a stock barely beating Nifty is vetoed, for longs and shorts alike", () => {
  const day = createDayState();
  assert.match(selectionVeto({ underlying: "X", alignedRs: 0.4 }, day), /^weak vs Nifty/);
  assert.match(selectionVeto({ underlying: "X", alignedRs: alignedRsOf(-0.4, "short") }, day), /^weak vs Nifty/);
  assert.equal(selectionVeto({ underlying: "X", alignedRs: alignedRsOf(-1.8, "short") }, day), null);
  assert.match(selectionVeto({ underlying: "X", alignedRs: 1.2 }, day), /^weak vs Nifty/, "+1.2% is below the v2 bar");
  assert.equal(selectionVeto({ underlying: "X", alignedRs: SELECTION.minAlignedRsPct }, day), null, "the bar itself passes");
});

test("an unknown strength reading is not taken", () => {
  assert.ok(selectionVeto({ underlying: "X", alignedRs: null }, createDayState()));
});

test("the veto message says how far short the stock was", () => {
  const msg = selectionVeto({ underlying: "X", alignedRs: 0.42 }, createDayState());
  assert.equal(msg, "weak vs Nifty (+0.4%, needs +1.5%)");
  assert.ok(isSelectionSkip(msg));
  assert.equal(isSelectionSkip("insufficient capital — needs ₹1"), false);
});

// ── No retry after a loss ──────────────────────────────────────────────

test("a stock that lost today is not retried; a winner can be", () => {
  const day = createDayState();
  noteClose(day, { underlying: "PFC", netPnl: -1500 });
  noteClose(day, { underlying: "COFORGE", netPnl: 8500 });
  assert.equal(selectionVeto({ underlying: "PFC", alignedRs: 2 }, day), "already lost on PFC today");
  assert.equal(selectionVeto({ underlying: "COFORGE", alignedRs: 2 }, day), null);
});

test("there is no daily trade cap", () => {
  const day = createDayState();
  day.taken = 40;
  assert.equal(selectionVeto({ underlying: "ANY", alignedRs: 2 }, day), null);
});

test("day state rebuilds from the store after a restart", () => {
  const states = buildDayStates({
    trades: [
      { strategyId: "a-selective", underlying: "PFC", netPnl: -900 },
      { strategyId: "a-selective", underlying: "LT", netPnl: 700 },
      { strategyId: "b", underlying: "VEDL", netPnl: -100 },
    ],
    openPositions: [{ strategyId: "a-selective", underlying: "INFY" }],
    skips: [{ strategyId: "a-selective", n: 31 }],
  });
  const a = states.get("a-selective");
  assert.equal(a.taken, 3);
  assert.equal(a.skippedForQuality, 31);
  assert.ok(a.lostNames.has("PFC"));
  assert.equal(a.lostNames.has("LT"), false);
  assert.equal(states.get("b").lostNames.has("PFC"), false, "losses are per strategy");
});

// ── Quality score ──────────────────────────────────────────────────────

test("quality is bounded to 0..1 whatever the inputs", () => {
  for (const inp of [
    { alignedRs: 50, stopPct: 9, confluence: 4 },
    { alignedRs: -5, stopPct: -1, confluence: 0 },
    { alignedRs: null, stopPct: null },
  ]) {
    const q = qualityOf(inp);
    assert.ok(q.score >= 0 && q.score <= 1, JSON.stringify(inp));
  }
  assert.equal(qualityOf({ alignedRs: 5, stopPct: 1, confluence: 1 }).score, 1);
});

test("stronger, roomier, confirmed setups rank higher", () => {
  const weak = qualityOf({ alignedRs: 1.0, stopPct: 0.2, confluence: 0 });
  const strong = qualityOf({ alignedRs: 2.0, stopPct: 0.2, confluence: 0 });
  const roomy = qualityOf({ alignedRs: 1.0, stopPct: 0.45, confluence: 0 });
  const confirmed = qualityOf({ alignedRs: 1.0, stopPct: 0.2, confluence: 1 });
  assert.ok(strong.score > weak.score);
  assert.ok(roomy.score > weak.score);
  assert.ok(confirmed.score > weak.score);
});

test("stop distance is measured, never changed", () => {
  const strategy = { exits: { stopAtr: 1.5 } };
  assert.equal(stopPctOf(strategy, 2, 1000), 0.3);
  assert.equal(stopPctOf(strategy, 0, 1000), null);
});

// ── Confluence ─────────────────────────────────────────────────────────

test("another family signalling the same stock and side confirms", () => {
  const c = createConfluence();
  c.note("trend-momentum", "COFORGE", "short", T0);
  c.note("vwap-relative-strength", "COFORGE", "short", T0 + BAR);
  assert.equal(c.count("trend-momentum", "COFORGE", "short", T0), 1);
});

test("an original and its Selective twin never confirm each other", () => {
  const c = createConfluence();
  c.note("trend-momentum", "PFC", "short", T0); // the original
  c.note("trend-momentum", "PFC", "short", T0); // its Selective twin, same family
  assert.equal(c.count("trend-momentum", "PFC", "short", T0), 0);
});

test("confluence ignores the other side and stale signals", () => {
  const c = createConfluence();
  c.note("a", "X", "long", T0);
  c.note("b", "X", "short", T0);
  assert.equal(c.count("a", "X", "long", T0), 0, "opposite side is not confirmation");
  c.note("c", "X", "long", T0 - 10 * BAR);
  assert.equal(c.count("a", "X", "long", T0), 0, "ten bars ago is not now");
  c.prune(T0);
  assert.equal(c.count("a", "X", "long", T0 - 10 * BAR), 0, "pruned");
});
