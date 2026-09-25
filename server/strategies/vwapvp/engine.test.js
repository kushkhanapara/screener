import { test } from "node:test";
import assert from "node:assert/strict";
import * as vpEngine from "./engine.js";
import * as shared from "../../paper/engine.js";
import { at } from "./fixtures.js";

const strategy = {
  id: "t",
  exits: { stopAtr: 1, trailAtr: 1.5, breakevenAtR: 1, targetR: 20, timeStopBars: 10_000, squareOffMin: 915 },
};
const args = (signal, fillPrice = 100) => ({
  runId: "r",
  strategy,
  signal: { side: "long", reasons: [], ...signal },
  underlying: "X",
  fillPrice,
  atr: 1,
  lotSize: 1,
  now: at(10, 0),
  costConfig: { slippagePct: 0 },
});
const open = (signal, fillPrice) => vpEngine.openPosition(args(signal, fillPrice));
const bar = (open, high, low, close) => ({ time: at(10, 0), open, high, low, close });

test("a signal's own stop sets the risk; a stop on the wrong side of the fill falls back to ATR", () => {
  const p = open({ stop: 98 });
  assert.equal(p.initialStop, 98);
  assert.equal(p.currentStop, 98);
  assert.equal(p.riskPerUnit, 2);
  const gapped = open({ stop: 101 }); // the fill opened below the planned stop
  assert.equal(gapped.riskPerUnit, 1);
  assert.equal(gapped.initialStop, 99);
});

test("a price target exits there", () => {
  const p = open({ stop: 99, target: 101.5 });
  const { exit } = vpEngine.applyBar(p, strategy, bar(100, 101.7, 99.8, 101.6), at(10, 3));
  assert.equal(exit.reason, "target");
  assert.ok(Math.abs(exit.price - 101.5) < 1e-9);
});

test("break-even arms at the strategy's level instead of +1R", () => {
  const p = open({ stop: 98, breakevenAt: 100.5 });
  const { position } = vpEngine.checkExit(p, strategy, 100.6, at(10, 3));
  assert.equal(position.breakevenMoved, true, "armed at 100.5, only +0.3R");
  assert.equal(position.currentStop, 100);
  const plain = vpEngine.checkExit(open({ stop: 98 }), strategy, 100.6, at(10, 3)).position;
  assert.equal(plain.breakevenMoved, false);
});

test("a bar closing beyond the zone ends the trade before the stop; a wick through it does not", () => {
  const p = open({ stop: 98, invalidateAt: 99.2 });
  assert.deepEqual(vpEngine.applyBar(p, strategy, bar(99.8, 99.9, 99.0, 99.1), at(10, 3)).exit, { reason: "invalidated", price: 99.1 });
  assert.equal(vpEngine.applyBar(p, strategy, bar(99.8, 99.9, 99.0, 99.3), at(10, 3)).exit, null);
  assert.equal(vpEngine.manageBarClose(p, strategy, 99.1, at(10, 3)).exit.reason, "invalidated");
  assert.equal(vpEngine.checkExit(p, strategy, 99.1, at(10, 1)).exit, null, "ticks never invalidate, only closes");
});

test("the stop still wins over the zone rule when the bar reaches it", () => {
  const p = open({ stop: 98, invalidateAt: 99.2 });
  assert.equal(vpEngine.applyBar(p, strategy, bar(99.5, 99.6, 97.5, 98.2), at(10, 3)).exit.reason, "stop");
});

test("without levels it behaves exactly like the shared engine, bar for bar", () => {
  const path = [
    bar(100, 100.4, 99.6, 100.2),
    bar(100.2, 101.3, 100.1, 101.2), // +1R: break-even
    bar(101.2, 102.9, 101.0, 102.8), // trail advances
    bar(102.8, 103.0, 101.0, 101.1), // trail hit
  ];
  let a = shared.openPosition(args({}));
  let b = open({});
  for (let i = 0; i < path.length; i++) {
    const t = at(10, 3 * (i + 1));
    const ra = shared.applyBar(a, strategy, path[i], t);
    const rb = vpEngine.applyBar(b, strategy, path[i], t);
    assert.deepEqual(rb.exit, ra.exit, `bar ${i}`);
    const { levels, id: _b, ...restB } = rb.position;
    const { id: _a, ...restA } = ra.position;
    assert.deepEqual(restB, restA, `bar ${i}`);
    a = ra.position;
    b = rb.position;
    if (ra.exit) break;
  }
});

test("the shared engine's own settings are never changed", () => {
  const exits = { ...strategy.exits };
  const p = open({ stop: 98, target: 104, breakevenAt: 101 });
  vpEngine.applyBar(p, strategy, bar(100, 101.5, 99.5, 101.2), at(10, 3));
  assert.deepEqual(strategy.exits, exits);
});

test("cash-chart levels move onto the futures contract with the basis", () => {
  const sig = { side: "long", reasons: ["r"], stop: 98, target: 102, breakevenAt: 101, invalidateAt: 99 };
  const fut = vpEngine.levelsToFutures(sig, 100, 100.5); // future at a 0.5% premium
  assert.ok(Math.abs(fut.stop - 98.49) < 1e-9);
  assert.ok(Math.abs(fut.target - 102.51) < 1e-9);
  assert.equal(sig.stop, 98, "the original signal is not modified");
  assert.equal(vpEngine.levelsToFutures(sig, null, 100.5), sig);
});
