import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as store from "./store.js";
import { openPosition, closePosition } from "./engine.js";
import { DEFAULT_COSTS } from "./costs.js";
import { compute, maxDrawdown, sharpeOf } from "./metrics.js";

const NO_SLIP = { ...DEFAULT_COSTS, slippagePct: 0 };
const MIDDAY = Date.UTC(2026, 8, 11, 11 - 5, 0 - 30);

const strategy = {
  id: "s1",
  timeframes: { trend: "15m", trigger: "3m" },
  exits: { stopAtr: 2, trailAtr: 2, breakevenAtR: 1, targetR: 3, timeStopBars: 5, squareOffMin: 915 },
};

const mkPosition = (over = {}) =>
  openPosition({
    runId: "live",
    strategy,
    signal: { side: "long", reasons: ["a", "b"] },
    underlying: "TEST",
    futKey: "NSE_FO|1",
    futLabel: "TEST 25 SEP FUT",
    fillPrice: 100,
    atr: 5,
    lotSize: 50,
    now: MIDDAY,
    costConfig: NO_SLIP,
    ...over,
  });

beforeEach(() => {
  store.initMemory();
});

after(() => store.close());

// ── Positions ──────────────────────────────────────────────────────────

test("a position round-trips through the database unchanged", () => {
  const p = mkPosition();
  store.insertPosition(p);

  const back = store.getPosition(p.id);
  assert.equal(back.underlying, "TEST");
  assert.equal(back.side, "long");
  assert.equal(back.entryPrice, p.entryPrice);
  assert.equal(back.initialStop, p.initialStop);
  assert.equal(back.qty, 50);
  assert.deepEqual(back.reasons, ["a", "b"], "JSON columns survive the round trip");
  assert.equal(back.breakevenMoved, false, "integer 0 comes back as a boolean");
});

test("updatePosition persists the fields the exit machine mutates", () => {
  const p = mkPosition();
  store.insertPosition(p);

  store.updatePosition({ ...p, currentStop: 100, highWater: 125, breakevenMoved: true, barsHeld: 3 });

  const back = store.getPosition(p.id);
  assert.equal(back.currentStop, 100);
  assert.equal(back.highWater, 125);
  assert.equal(back.breakevenMoved, true);
  assert.equal(back.barsHeld, 3);
});

test("openPositions filters by run and strategy", () => {
  store.insertPosition(mkPosition({ underlying: "AAA" }));
  store.insertPosition(mkPosition({ underlying: "BBB" }));
  store.insertPosition(mkPosition({ underlying: "CCC", runId: "backtest-1" }));

  assert.equal(store.openPositions("live").length, 2);
  assert.equal(store.openPositions("backtest-1").length, 1);
  assert.equal(store.openPositions("live", "s1").length, 2);
  assert.equal(store.openPositions("live", "other").length, 0);
});

test("hasOpenPosition prevents stacking a second entry in the same name", () => {
  store.insertPosition(mkPosition({ underlying: "AAA" }));
  assert.equal(store.hasOpenPosition("live", "s1", "AAA"), true);
  assert.equal(store.hasOpenPosition("live", "s1", "BBB"), false);
  assert.equal(store.hasOpenPosition("live", "other", "AAA"), false);
});

// ── Closing atomically ─────────────────────────────────────────────────

test("closing moves a position to trades in one step", () => {
  const p = mkPosition();
  store.insertPosition(p);

  const trade = closePosition(p, 130, "target", MIDDAY + 60000, NO_SLIP);
  store.commitClose(p.id, trade);

  assert.equal(store.getPosition(p.id), null, "the open row is gone");
  assert.equal(store.openPositions("live").length, 0);

  const [t] = store.trades({ runId: "live" });
  assert.equal(t.id, p.id);
  assert.equal(t.exitReason, "target");
  assert.equal(t.grossPnl, 1500);
  assert.deepEqual(t.reasons, ["a", "b"]);
});

test("a failed close leaves the position open rather than half-applied", () => {
  const p = mkPosition();
  store.insertPosition(p);

  const bad = closePosition(p, 130, "target", MIDDAY + 60000, NO_SLIP);
  bad.entryTime = null; // violates NOT NULL, so the insert must fail

  assert.throws(() => store.commitClose(p.id, bad));

  // The whole point of using a transactional store: no phantom state.
  assert.ok(store.getPosition(p.id), "position survived the rollback");
  assert.equal(store.countTrades({ runId: "live" }), 0, "no orphan trade was written");
});

test("trades are separated by run, so a backtest cannot pollute live results", () => {
  const live = mkPosition({ underlying: "AAA" });
  const bt = mkPosition({ underlying: "BBB", runId: "backtest-1" });
  store.insertPosition(live);
  store.insertPosition(bt);
  store.commitClose(live.id, closePosition(live, 130, "target", MIDDAY + 1000, NO_SLIP));
  store.commitClose(bt.id, closePosition(bt, 130, "target", MIDDAY + 1000, NO_SLIP));

  assert.equal(store.countTrades({ runId: "live" }), 1);
  assert.equal(store.countTrades({ runId: "backtest-1" }), 1);
  assert.equal(store.trades({ runId: "live" })[0].underlying, "AAA");
});

test("tradesChronological is oldest-first for equity curves", () => {
  for (const [i, name] of ["A", "B", "C"].entries()) {
    const p = mkPosition({ underlying: name });
    store.insertPosition(p);
    store.commitClose(p.id, closePosition(p, 110, "target", MIDDAY + i * 60000, NO_SLIP));
  }
  const asc = store.tradesChronological({ runId: "live" });
  assert.deepEqual(asc.map((t) => t.underlying), ["A", "B", "C"]);
  // The paginated view is newest-first, which is what a UI table wants.
  assert.deepEqual(store.trades({ runId: "live" }).map((t) => t.underlying), ["C", "B", "A"]);
});

test("trades paginate", () => {
  for (let i = 0; i < 5; i++) {
    const p = mkPosition({ underlying: `S${i}` });
    store.insertPosition(p);
    store.commitClose(p.id, closePosition(p, 110, "target", MIDDAY + i * 60000, NO_SLIP));
  }
  assert.equal(store.trades({ runId: "live", limit: 2 }).length, 2);
  assert.equal(store.trades({ runId: "live", limit: 2, offset: 4 }).length, 1);
  assert.equal(store.countTrades({ runId: "live" }), 5);
});

// ── Runs and signals ───────────────────────────────────────────────────

test("runs record their parameters", () => {
  store.createRun({ id: "bt-1", kind: "backtest", strategyId: "s1", params: { days: 30 } });
  const r = store.getRun("bt-1");
  assert.equal(r.kind, "backtest");
  assert.deepEqual(JSON.parse(r.params), { days: 30 });
  assert.equal(r.finished_at, null);

  store.finishRun("bt-1");
  assert.ok(store.getRun("bt-1").finished_at > 0);
  assert.equal(store.listRuns("backtest").length, 1);
  assert.equal(store.listRuns("live").length, 0);
});

test("re-registering a run keeps its original start time", async () => {
  store.createRun({ id: "live-x", kind: "live", params: { boot: 1 } });
  const first = store.getRun("live-x").started_at;
  await new Promise((r) => setTimeout(r, 5));
  store.createRun({ id: "live-x", kind: "live", params: { boot: 2 } });
  const again = store.getRun("live-x");
  assert.equal(again.started_at, first, "a restart must not look like a new run");
  assert.deepEqual(JSON.parse(again.params), { boot: 2 }, "metadata still refreshes");
});

test("skipCountsSince counts only matching skip reasons after the cutoff", () => {
  const t = Date.UTC(2026, 8, 16, 5, 0);
  const sig = (id, strategyId, barTime, skipReason, taken = false) =>
    store.recordSignal({ id, runId: "live", strategyId, underlying: "A", side: "long", barTime, taken, skipReason });
  sig("q1", "a-selective", t, "weak vs Nifty (+0.4%, needs +1.0%)");
  sig("q2", "a-selective", t, "already lost on A today");
  sig("q3", "a-selective", t, "insufficient capital — needs ₹1");
  sig("q4", "a-selective", t - 86_400_000, "weak vs Nifty (+0.2%, needs +1.0%)");
  sig("q5", "b-selective", t, null, true);
  const counts = store.skipCountsSince({ runId: "live", since: t - 1000, prefixes: ["weak vs Nifty", "already lost on"] });
  assert.deepEqual(counts, [{ strategyId: "a-selective", n: 2 }]);
});

test("signalsPerDay groups by IST day and counts what was taken", () => {
  const day1 = Date.UTC(2026, 8, 11, 10 - 5, 0 - 30); // 10:00 IST
  const day2 = Date.UTC(2026, 8, 14, 10 - 5, 0 - 30);

  store.recordSignal({ id: "x1", runId: "live", strategyId: "s1", underlying: "A", side: "long", barTime: day1, taken: true });
  store.recordSignal({ id: "x2", runId: "live", strategyId: "s1", underlying: "B", side: "long", barTime: day1, taken: false, skipReason: "already in position" });
  store.recordSignal({ id: "x3", runId: "live", strategyId: "s1", underlying: "C", side: "short", barTime: day2, taken: true });

  const rows = store.signalsPerDay({ runId: "live", strategyId: "s1" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].day, "2026-09-11");
  assert.equal(rows[0].signals, 2);
  assert.equal(rows[0].taken, 1);
  assert.equal(rows[1].day, "2026-09-14");
});

test("a late-evening signal still lands on the IST calendar day", () => {
  // 23:00 IST is the previous day in UTC; the grouping must not drift.
  const late = Date.UTC(2026, 8, 11, 23 - 5, 0 - 30);
  store.recordSignal({ id: "y", runId: "live", strategyId: "s1", underlying: "A", side: "long", barTime: late, taken: true });
  assert.equal(store.signalsPerDay({ runId: "live" })[0].day, "2026-09-11");
});

// ── Metrics over stored trades ─────────────────────────────────────────

test("metrics over an empty set are zeroed, not NaN", () => {
  const m = compute([]);
  assert.equal(m.trades, 0);
  assert.equal(m.winRate, 0);
  assert.equal(m.expectancyR, 0);
  assert.ok(Number.isFinite(m.expectancyR));
});

test("metrics compute expectancy, win rate and drawdown from real trades", () => {
  const t = (r, netPnl) => ({
    rMultiple: r, netPnl, grossPnl: netPnl, costs: 0, side: "long",
    entryTime: MIDDAY, exitTime: MIDDAY + 600000, barsHeld: 4, mae: 0.3, mfe: 1.2,
    exitReason: r > 0 ? "target" : "stop",
  });
  // +2R, -1R, +1R, -1R  -> total +1R over 4 trades
  const m = compute([t(2, 1000), t(-1, -500), t(1, 500), t(-1, -500)]);

  assert.equal(m.trades, 4);
  assert.equal(m.wins, 2);
  assert.equal(m.winRate, 0.5);
  assert.ok(Math.abs(m.totalR - 1) < 1e-9);
  assert.ok(Math.abs(m.expectancyR - 0.25) < 1e-9);
  assert.ok(Math.abs(m.profitFactor - 1.5) < 1e-9); // 1500 won / 1000 lost
  assert.deepEqual(m.byExitReason, { target: 2, stop: 2 });
  assert.equal(m.bySide.long.trades, 4);
  assert.equal(m.bySide.short.trades, 0);
});

test("profitFactor is Infinity with no losses, not a fabricated number", () => {
  const win = { rMultiple: 1, netPnl: 100, grossPnl: 100, costs: 0, side: "long", entryTime: MIDDAY, exitTime: MIDDAY, exitReason: "target" };
  assert.equal(compute([win]).profitFactor, Infinity);
});

test("maxDrawdown finds the worst peak-to-trough decline", () => {
  assert.equal(maxDrawdown([1, 2, 3]), 0, "a rising curve has no drawdown");
  assert.equal(maxDrawdown([1, 3, 1, 4]), 2);
  assert.equal(maxDrawdown([]), 0);
});

test("sharpeOf needs at least two trades and handles zero variance", () => {
  assert.equal(sharpeOf([1]), 0);
  assert.equal(sharpeOf([1, 1, 1]), 0, "no dispersion -> undefined ratio, reported as 0");
  assert.ok(sharpeOf([1, -1, 2, 0]) !== 0);
});

test("metrics flow end to end from the database", () => {
  for (const [i, exit] of [130, 90, 130].entries()) {
    const p = mkPosition({ underlying: `S${i}` });
    store.insertPosition(p);
    store.commitClose(p.id, closePosition(p, exit, exit > 100 ? "target" : "stop", MIDDAY + i * 60000, NO_SLIP));
  }

  const m = compute(store.tradesChronological({ runId: "live" }), {
    signalDays: store.signalsPerDay({ runId: "live" }),
  });

  assert.equal(m.trades, 3);
  assert.equal(m.wins, 2);
  assert.ok(m.expectancyR > 0, "two 3R winners against one 1R loser");
  assert.ok(m.totalCosts > 0, "costs are carried through to the metrics");
  assert.equal(m.equityCurveR.length, 3);
});
