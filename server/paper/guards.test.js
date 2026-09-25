import { test } from "node:test";
import assert from "node:assert/strict";
import { openPosition, onBarClose, entriesAllowed, checkExit, closePosition, manageBarClose } from "./engine.js";
import { DEFAULT_COSTS } from "./costs.js";
import { marketRegime, regimeAllows } from "../strategies/context.js";

const NO_SLIP = { ...DEFAULT_COSTS, slippagePct: 0 };
const ist = (h, m) => Date.UTC(2026, 8, 11, h - 5, m - 30);
const MIDDAY = ist(11, 0);

const strategy = {
  id: "t",
  timeframes: { trend: "15m", trigger: "3m" },
  exits: {
    stopAtr: 2,
    trailAtr: 2,
    breakevenAtR: 1,
    targetR: 3,
    timeStopBars: 20,
    squareOffMin: 15 * 60 + 15,
    noEntryAfterMin: 14 * 60 + 45,
    proveItBars: 3,
    proveItR: 0.25,
  },
};

const open = (side = "long") =>
  openPosition({
    runId: "t",
    strategy,
    signal: { side, reasons: [] },
    underlying: "TEST",
    fillPrice: 100,
    atr: 5, // 1R = 10 points
    lotSize: 50,
    now: MIDDAY,
    costConfig: NO_SLIP,
  });

// ── Entry cutoff ───────────────────────────────────────────────────────

test("entries are allowed well before the cutoff", () => {
  assert.equal(entriesAllowed(strategy, ist(11, 0)), true);
  assert.equal(entriesAllowed(strategy, ist(14, 44)), true);
});

test("entries stop at the cutoff, ahead of the square-off", () => {
  // 152 recorded trades were opened inside this window and lost 53.5R between
  // them: a 2.5R target cannot be reached in the minutes that remain.
  assert.equal(entriesAllowed(strategy, ist(14, 45)), false);
  assert.equal(entriesAllowed(strategy, ist(15, 5)), false);
});

test("a strategy without a cutoff is unrestricted", () => {
  const s = { exits: { ...strategy.exits, noEntryAfterMin: undefined } };
  assert.equal(entriesAllowed(s, ist(15, 10)), true);
});

// ── Prove-it stop ──────────────────────────────────────────────────────

test("a trade going nowhere is cut at the prove-it bar", () => {
  let p = open("long");
  let exit = null;
  // Three bars hovering at entry: never reaches +0.25R (= 102.5).
  for (let i = 0; i < 3; i++) ({ exit, position: p } = onBarClose(p, strategy, 100.5, MIDDAY));
  assert.equal(exit.reason, "proveit");
  assert.equal(p.barsHeld, 3);
});

test("a trade that showed follow-through is spared", () => {
  let p = open("long");
  // Push the high-water mark past the threshold first.
  ({ position: p } = checkExit(p, strategy, 104, MIDDAY)); // +0.4R
  let exit = null;
  for (let i = 0; i < 3; i++) ({ exit, position: p } = onBarClose(p, strategy, 100.5, MIDDAY));
  assert.equal(exit, null, "it proved itself, even though it gave the move back");
});

test("the prove-it stop does not fire early", () => {
  let p = open("long");
  let exit = null;
  for (let i = 0; i < 2; i++) ({ exit, position: p } = onBarClose(p, strategy, 100.2, MIDDAY));
  assert.equal(exit, null);
});

test("a trade currently above the threshold is spared", () => {
  let p = open("long");
  let exit = null;
  for (let i = 0; i < 3; i++) ({ exit, position: p } = onBarClose(p, strategy, 103, MIDDAY));
  assert.equal(exit, null);
});

test("the prove-it stop works for shorts", () => {
  let p = open("short");
  let exit = null;
  for (let i = 0; i < 3; i++) ({ exit, position: p } = onBarClose(p, strategy, 99.6, MIDDAY));
  assert.equal(exit.reason, "proveit");
});

test("prove-it exits cost a fraction of a full stop", () => {
  let p = open("long");
  let exit = null;
  for (let i = 0; i < 3; i++) ({ exit, position: p } = onBarClose(p, strategy, 99.5, MIDDAY));
  assert.equal(exit.reason, "proveit");
  // Cut at 99.5 is -0.05R before costs, versus -1R at the stop. This is the
  // whole point: 61% of losers never went green, so paying the full stop for
  // them is paying maximum price for information already available.
  assert.ok(exit.price > p.initialStop);
});

test("a strategy without a prove-it setting keeps the old behaviour", () => {
  const s = { exits: { ...strategy.exits, proveItBars: undefined } };
  let p = open("long");
  let exit = null;
  for (let i = 0; i < 5; i++) ({ exit, position: p } = onBarClose(p, s, 100.5, MIDDAY));
  assert.equal(exit, null);
});

// ── Bar close, as the live paths drive it ──────────────────────────────

test("manageBarClose applies prove-it after three quiet bars", () => {
  // Live paper once managed positions on ticks alone, so prove-it and the time
  // stop never fired and every trade recorded zero bars held.
  let p = open("long");
  let exit = null;
  for (let i = 0; i < 3; i++) ({ exit, position: p } = manageBarClose(p, strategy, 100.5, MIDDAY));
  assert.equal(exit.reason, "proveit");
  assert.equal(p.barsHeld, 3);
});

test("manageBarClose advances the bar count on a quiet bar", () => {
  const { exit, position } = manageBarClose(open("long"), strategy, 101, MIDDAY);
  assert.equal(exit, null);
  assert.equal(position.barsHeld, 1);
});

test("a stop reached at the bar close exits as a stop, not a bar rule", () => {
  const { exit } = manageBarClose(open("long"), strategy, 89, MIDDAY);
  assert.equal(exit.reason, "stop");
});

test("a target reached at the bar close exits as a target", () => {
  const { exit } = manageBarClose(open("short"), strategy, 69, MIDDAY);
  assert.equal(exit.reason, "target");
});

// ── Market regime ──────────────────────────────────────────────────────

test("regime reads bullish when the index rises and holds its VWAP", () => {
  assert.equal(marketRegime(0.5, 100, 99), "bullish");
});

test("regime reads bearish when the index falls and sits under its VWAP", () => {
  assert.equal(marketRegime(-0.5, 99, 100), "bearish");
});

test("a small index move is neutral", () => {
  assert.equal(marketRegime(0.05, 100, 99), "neutral");
  assert.equal(marketRegime(-0.1, 99, 100), "neutral");
});

test("index move and VWAP disagreeing is chop, not a direction", () => {
  // Up on the day but trading below VWAP — faded from the highs.
  assert.equal(marketRegime(0.5, 99, 100), "neutral");
  assert.equal(marketRegime(-0.5, 100, 99), "neutral");
});

test("no index data yields null, which is unknown rather than neutral", () => {
  assert.equal(marketRegime(null, null, null), null);
});

test("the regime blocks only the side that fights it", () => {
  assert.equal(regimeAllows("bullish", "long"), true);
  assert.equal(regimeAllows("bullish", "short"), false);
  assert.equal(regimeAllows("bearish", "short"), true);
  assert.equal(regimeAllows("bearish", "long"), false);
});

test("neutral and unknown regimes permit both sides", () => {
  for (const side of ["long", "short"]) {
    assert.equal(regimeAllows("neutral", side), true);
    assert.equal(regimeAllows(null, side), true, "unknown must not veto");
  }
});

// ── Clock skew ─────────────────────────────────────────────────────────

test("a trade can never be recorded as ending before it began", () => {
  // Exchange tick timestamps lag the wall clock, so an exit stamped from a tick
  // could precede an entry stamped from Date.now(). That produced trades with
  // negative holding periods, which corrupts every duration metric.
  const p = open("long");
  const beforeEntry = p.entryTime - 90_000;
  const t = closePosition(p, 105, "squareoff", beforeEntry, NO_SLIP);

  assert.equal(t.exitTime, p.entryTime, "clamped to the entry instant");
  assert.ok(t.exitTime - t.entryTime >= 0);
});

test("a normal exit keeps its real timestamp", () => {
  const p = open("long");
  const later = p.entryTime + 600_000;
  assert.equal(closePosition(p, 105, "target", later, NO_SLIP).exitTime, later);
});

// ── Live strategy cutoff ───────────────────────────────────────────────

test("every registered strategy stops taking new trades at 15:00 IST", async () => {
  const { list } = await import("../strategies/index.js");
  for (const s of list()) {
    // A strategy may stop earlier on its own (VWAP + Volume Profile: 14:30).
    const last = Math.min(s.exits.noEntryAfterMin ?? 15 * 60, 15 * 60) - 1;
    assert.equal(entriesAllowed(s, ist(Math.floor(last / 60), last % 60)), true, `${s.id} should still trade a minute before its cutoff`);
    assert.equal(entriesAllowed(s, ist(15, 0)), false, `${s.id} must not open at 15:00`);
    assert.equal(entriesAllowed(s, ist(15, 10)), false, `${s.id} must not open after 15:00`);
  }
});
