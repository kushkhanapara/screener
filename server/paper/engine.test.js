import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openPosition,
  checkExit,
  onBarClose,
  closePosition,
  applyBar,
  unrealisedR,
} from "./engine.js";
import { tradeCosts, applySlippage, DEFAULT_COSTS } from "./costs.js";

/** Slippage off, so price arithmetic in the assertions stays exact. */
const NO_COST = { ...DEFAULT_COSTS, slippagePct: 0 };

const strategy = {
  id: "test",
  timeframes: { trend: "15m", trigger: "3m" },
  exits: {
    stopAtr: 2, // 1R = 2 x ATR
    trailAtr: 2,
    breakevenAtR: 1,
    targetR: 3,
    timeStopBars: 5,
    squareOffMin: 15 * 60 + 15,
  },
};

/** 11:00 IST on Fri 2026-09-11 — comfortably mid-session. */
const MIDDAY = Date.UTC(2026, 8, 11, 11 - 5, 0 - 30);
const ATR = 5; // => riskPerUnit = 10, so 1R = 10 price points

const open = (side = "long", over = {}) =>
  openPosition({
    runId: "test",
    strategy,
    signal: { side, reasons: ["r1"] },
    underlying: "TEST",
    fillPrice: 100,
    atr: ATR,
    lotSize: 50,
    now: MIDDAY,
    costConfig: NO_COST,
    ...over,
  });

// ── Opening ────────────────────────────────────────────────────────────

test("a long opens with the stop 1R below entry", () => {
  const p = open("long");
  assert.equal(p.entryPrice, 100);
  assert.equal(p.riskPerUnit, 10); // stopAtr(2) x atr(5)
  assert.equal(p.initialStop, 90);
  assert.equal(p.currentStop, 90);
  assert.equal(p.qty, 50);
  assert.equal(p.side, "long");
  assert.equal(p.breakevenMoved, false);
});

test("a short opens with the stop 1R above entry", () => {
  const p = open("short");
  assert.equal(p.initialStop, 110);
});

test("slippage always fills against the trader", () => {
  const cfg = { ...DEFAULT_COSTS, slippagePct: 0.01 };
  assert.ok(Math.abs(applySlippage(100, "long", true, cfg) - 101) < 1e-9, "buy to open: worse = higher");
  assert.ok(Math.abs(applySlippage(100, "long", false, cfg) - 99) < 1e-9, "sell to close: worse = lower");
  assert.ok(Math.abs(applySlippage(100, "short", true, cfg) - 99) < 1e-9, "sell to open: worse = lower");
  assert.ok(Math.abs(applySlippage(100, "short", false, cfg) - 101) < 1e-9, "buy to close: worse = higher");
});

test("opening rejects inputs that would make a nonsense stop", () => {
  assert.throws(() => open("long", { atr: 0 }), /atr/);
  assert.throws(() => open("long", { atr: NaN }), /atr/);
  assert.throws(() => open("long", { fillPrice: 0 }), /fillPrice/);
  assert.throws(() => open("long", { lotSize: 0 }), /lotSize/);
  assert.throws(
    () => openPosition({ runId: "t", strategy, signal: { side: "sideways" }, underlying: "X", fillPrice: 100, atr: 5, lotSize: 1, now: MIDDAY }),
    /side/
  );
});

test("unrealisedR measures profit in R for both directions", () => {
  assert.equal(unrealisedR(open("long"), 110), 1);
  assert.equal(unrealisedR(open("long"), 90), -1);
  assert.equal(unrealisedR(open("short"), 90), 1);
  assert.equal(unrealisedR(open("short"), 110), -1);
});

// ── Stop ───────────────────────────────────────────────────────────────

test("a long stops out at the initial stop", () => {
  const { exit } = checkExit(open("long"), strategy, 89, MIDDAY);
  assert.equal(exit.reason, "stop");
  assert.equal(exit.price, 90, "records the stop level, not the traded-through price");
});

test("a short stops out at the initial stop", () => {
  const { exit } = checkExit(open("short"), strategy, 111, MIDDAY);
  assert.equal(exit.reason, "stop");
  assert.equal(exit.price, 110);
});

test("price inside the stop does not exit", () => {
  assert.equal(checkExit(open("long"), strategy, 95, MIDDAY).exit, null);
});

// ── Break-even and trail ───────────────────────────────────────────────

test("the stop moves to break-even once +1R is reached", () => {
  const { exit, position } = checkExit(open("long"), strategy, 110, MIDDAY);
  assert.equal(exit, null);
  assert.equal(position.breakevenMoved, true);
  assert.equal(position.currentStop, 100, "stop is now at entry");
});

test("below +1R the stop has not moved", () => {
  const { position } = checkExit(open("long"), strategy, 109, MIDDAY);
  assert.equal(position.breakevenMoved, false);
  assert.equal(position.currentStop, 90);
});

test("after break-even the stop trails the high-water mark", () => {
  let p = open("long");
  ({ position: p } = checkExit(p, strategy, 110, MIDDAY)); // arm break-even
  ({ position: p } = checkExit(p, strategy, 125, MIDDAY)); // trail: 125 - 10 = 115
  assert.equal(p.highWater, 125);
  assert.equal(p.currentStop, 115);
});

test("the trail never loosens when price pulls back", () => {
  let p = open("long");
  ({ position: p } = checkExit(p, strategy, 110, MIDDAY));
  ({ position: p } = checkExit(p, strategy, 125, MIDDAY));
  assert.equal(p.currentStop, 115);
  ({ position: p } = checkExit(p, strategy, 118, MIDDAY)); // pullback
  assert.equal(p.currentStop, 115, "stop must not move back down");
});

test("a trailed stop exits with reason 'trail'", () => {
  let p = open("long");
  ({ position: p } = checkExit(p, strategy, 110, MIDDAY));
  ({ position: p } = checkExit(p, strategy, 125, MIDDAY));
  const { exit } = checkExit(p, strategy, 114, MIDDAY);
  assert.equal(exit.reason, "trail");
  assert.equal(exit.price, 115);
});

test("a stop sitting exactly at entry exits as 'breakeven'", () => {
  let p = open("long");
  ({ position: p } = checkExit(p, strategy, 110, MIDDAY)); // stop -> 100
  const { exit } = checkExit(p, strategy, 99, MIDDAY);
  assert.equal(exit.reason, "breakeven");
  assert.equal(exit.price, 100);
});

test("the trail works symmetrically for a short", () => {
  let p = open("short");
  ({ position: p } = checkExit(p, strategy, 90, MIDDAY)); // +1R -> break-even
  assert.equal(p.currentStop, 100);
  ({ position: p } = checkExit(p, strategy, 75, MIDDAY)); // trail: 75 + 10 = 85
  assert.equal(p.currentStop, 85);
  ({ position: p } = checkExit(p, strategy, 80, MIDDAY));
  assert.equal(p.currentStop, 85, "must not loosen");
});

// ── Target ─────────────────────────────────────────────────────────────

test("a long takes its target at +3R", () => {
  const { exit } = checkExit(open("long"), strategy, 131, MIDDAY);
  assert.equal(exit.reason, "target");
  assert.equal(exit.price, 130); // entry 100 + 3R(30)
});

test("a short takes its target at +3R", () => {
  const { exit } = checkExit(open("short"), strategy, 69, MIDDAY);
  assert.equal(exit.reason, "target");
  assert.equal(exit.price, 70);
});

// ── Square-off ─────────────────────────────────────────────────────────

test("square-off fires at 15:15 IST regardless of profit", () => {
  const at1515 = Date.UTC(2026, 8, 11, 15 - 5, 15 - 30);
  const { exit } = checkExit(open("long"), strategy, 105, at1515);
  assert.equal(exit.reason, "squareoff");
  assert.equal(exit.price, 105);
});

test("square-off beats a simultaneous target", () => {
  const at1520 = Date.UTC(2026, 8, 11, 15 - 5, 20 - 30);
  const { exit } = checkExit(open("long"), strategy, 200, at1520);
  assert.equal(exit.reason, "squareoff", "the clock wins — positions must be flat");
});

test("no square-off before the cutoff", () => {
  const at1514 = Date.UTC(2026, 8, 11, 15 - 5, 14 - 30);
  assert.equal(checkExit(open("long"), strategy, 105, at1514).exit, null);
});

// ── Time stop ──────────────────────────────────────────────────────────

test("the time stop cuts a trade going nowhere", () => {
  let p = open("long");
  let exit = null;
  for (let i = 0; i < 5; i++) ({ exit, position: p } = onBarClose(p, strategy, 101, MIDDAY));
  assert.equal(exit.reason, "time");
  assert.equal(p.barsHeld, 5);
});

test("the time stop spares a trade already past +1R", () => {
  let p = open("long");
  let exit = null;
  for (let i = 0; i < 6; i++) ({ exit, position: p } = onBarClose(p, strategy, 115, MIDDAY));
  assert.equal(exit, null, "winners are not cut by the time stop");
});

test("the time stop does not fire early", () => {
  let p = open("long");
  let exit = null;
  for (let i = 0; i < 4; i++) ({ exit, position: p } = onBarClose(p, strategy, 101, MIDDAY));
  assert.equal(exit, null);
  assert.equal(p.barsHeld, 4);
});

// ── Closing and P&L ────────────────────────────────────────────────────

test("a long winner produces the hand-computed gross P&L and R", () => {
  const p = open("long"); // entry 100, 1R = 10 points, qty 50
  const t = closePosition(p, 130, "target", MIDDAY + 60000, NO_COST);

  assert.equal(t.grossPnl, 1500); // (130-100) * 50
  assert.equal(t.rupeeRisk, 500); // 10 * 50
  assert.ok(t.costs > 0, "costs are always deducted");
  assert.ok(Math.abs(t.rMultiple - (t.netPnl / 500)) < 1e-9);
  assert.ok(t.rMultiple < 3, "net R is below gross 3R because costs are real");
  assert.ok(t.rMultiple > 2.8);
});

test("a short winner is computed in the right direction", () => {
  const p = open("short");
  const t = closePosition(p, 70, "target", MIDDAY + 60000, NO_COST);
  assert.equal(t.grossPnl, 1500); // (100-70) * 50
  assert.ok(t.netPnl > 0);
});

test("a loser lands near -1R", () => {
  const p = open("long");
  const t = closePosition(p, 90, "stop", MIDDAY + 60000, NO_COST);
  assert.equal(t.grossPnl, -500);
  assert.ok(t.rMultiple < -1, "slightly worse than -1R once costs are paid");
  assert.ok(t.rMultiple > -1.2);
});

test("R is computed on net P&L, so costs cannot be hidden", () => {
  const p = open("long");
  const t = closePosition(p, 130, "target", MIDDAY + 60000, NO_COST);
  assert.ok(Math.abs(t.rMultiple - (t.grossPnl - t.costs) / t.rupeeRisk) < 1e-9);
});

test("MFE and MAE record the excursion, not just the exit", () => {
  let p = open("long");
  ({ position: p } = checkExit(p, strategy, 110, MIDDAY)); // +1R, break-even armed
  ({ position: p } = checkExit(p, strategy, 130, MIDDAY)); // ran to +3R
  ({ position: p } = checkExit(p, strategy, 121, MIDDAY)); // pulled back

  const t = closePosition(p, 120, "trail", MIDDAY + 60000, NO_COST);
  assert.ok(Math.abs(t.mfe - 3) < 1e-9, "ran to +3R at best");
  assert.equal(t.mae, 0, "never traded below entry");
});

test("MAE captures heat taken before a winner", () => {
  let p = open("long");
  ({ position: p } = checkExit(p, strategy, 95, MIDDAY)); // -0.5R first
  ({ position: p } = checkExit(p, strategy, 120, MIDDAY));
  const t = closePosition(p, 120, "target", MIDDAY + 60000, NO_COST);
  assert.ok(Math.abs(t.mae - 0.5) < 1e-9);
});

test("the closed trade carries its signal provenance", () => {
  const p = open("long", { signalBarTime: 12345, cashPriceAtSignal: 99 });
  const t = closePosition(p, 110, "target", MIDDAY + 60000, NO_COST);
  assert.equal(t.signalBarTime, 12345);
  assert.equal(t.signalTf, "3m");
  assert.deepEqual(t.reasons, ["r1"]);
  assert.equal(t.basisAtEntry, 1, "futures traded 1 point above cash");
});

// ── Backtest bar replay ────────────────────────────────────────────────

test("applyBar takes the stop when a bar's range contains both stop and target", () => {
  // The pessimistic assumption: without ticks the sequence is unknowable, so
  // never assume the profitable ordering.
  const { exit } = applyBar(
    open("long"),
    strategy,
    { open: 100, high: 135, low: 85, close: 130 },
    MIDDAY
  );
  assert.equal(exit.reason, "stop");
  assert.equal(exit.price, 90);
});

test("applyBar takes the target when the stop was never touched", () => {
  const { exit } = applyBar(
    open("long"),
    strategy,
    { open: 100, high: 135, low: 99, close: 133 },
    MIDDAY
  );
  assert.equal(exit.reason, "target");
  assert.equal(exit.price, 130);
});

test("applyBar leaves a quiet bar open and advances the bar count", () => {
  const { exit, position } = applyBar(
    open("long"),
    strategy,
    { open: 100, high: 104, low: 98, close: 102 },
    MIDDAY
  );
  assert.equal(exit, null);
  assert.equal(position.barsHeld, 1);
});

test("applyBar squares off after the cutoff", () => {
  const at1520 = Date.UTC(2026, 8, 11, 15 - 5, 20 - 30);
  const { exit } = applyBar(open("long"), strategy, { open: 100, high: 101, low: 99, close: 100 }, at1520);
  assert.equal(exit.reason, "squareoff");
});

test("applyBar is symmetric for shorts", () => {
  const { exit } = applyBar(
    open("short"),
    strategy,
    { open: 100, high: 115, low: 65, close: 70 },
    MIDDAY
  );
  assert.equal(exit.reason, "stop", "the short's stop is above, and the bar hit it");
  assert.equal(exit.price, 110);
});

// ── Costs ──────────────────────────────────────────────────────────────

test("STT falls on the sell leg and stamp duty on the buy leg", () => {
  // Identical prices, opposite directions. The long sells at the higher price
  // (its exit); the short sells at the lower price (its entry).
  const long = tradeCosts({ entryPrice: 100, exitPrice: 110, qty: 100, side: "long" });
  const short = tradeCosts({ entryPrice: 100, exitPrice: 110, qty: 100, side: "short" });

  assert.ok(long.stt > short.stt, "long sells higher, so pays more STT");
  assert.ok(short.stamp > long.stamp, "short buys higher, so pays more stamp duty");

  // Turnover-based charges ignore direction entirely.
  assert.ok(Math.abs(long.exchange - short.exchange) < 1e-9);
  assert.ok(Math.abs(long.sebi - short.sebi) < 1e-9);
});

test("mirrored trades incur identical STT and stamp duty", () => {
  // Long 100->200 and short 200->100 both buy at 100 and sell at 200.
  const long = tradeCosts({ entryPrice: 100, exitPrice: 200, qty: 100, side: "long" });
  const short = tradeCosts({ entryPrice: 200, exitPrice: 100, qty: 100, side: "short" });
  assert.ok(Math.abs(long.stt - short.stt) < 1e-9);
  assert.ok(Math.abs(long.stamp - short.stamp) < 1e-9);
});

test("brokerage is capped at the flat fee on large turnover", () => {
  const c = tradeCosts({ entryPrice: 5000, exitPrice: 5000, qty: 100, side: "long" });
  assert.ok(Math.abs(c.brokerage - 40) < 1e-9, "₹20 per leg, two legs");
});

test("brokerage uses the percentage when it is cheaper", () => {
  const c = tradeCosts({ entryPrice: 100, exitPrice: 100, qty: 10, side: "long" });
  assert.ok(c.brokerage < 40);
  assert.ok(Math.abs(c.brokerage - 0.6) < 1e-9); // 0.03% of 1000, twice
});

test("the cost total equals the sum of its parts", () => {
  const c = tradeCosts({ entryPrice: 1000, exitPrice: 1010, qty: 250, side: "long" });
  const parts = c.brokerage + c.stt + c.exchange + c.sebi + c.stamp + c.gst;
  assert.ok(Math.abs(c.total - parts) < 1e-9);
  assert.ok(c.total > 0);
});
