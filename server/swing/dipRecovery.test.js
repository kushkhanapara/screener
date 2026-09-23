import { test } from "node:test";
import assert from "node:assert/strict";
import { signalAt, simulate } from "./dipRecovery.js";

const day = (n) => new Date(Date.UTC(2025, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
const flat = (n) => Array.from({ length: n }, (_, i) => ({ time: day(i), open: 100, high: 101, low: 99, close: 100, volume: 100_000 }));

test("dip and recovery: below yesterday's close, then closes 1% above the open", () => {
  const c = flat(70);
  c.push({ time: day(70), open: 99.8, high: 101.6, low: 99.5, close: 101.5, volume: 100_000 });
  assert.equal(signalAt(c, 70, "pattern").side, "long");
  c[70].low = 100.2; // never dipped below yesterday's 100 close
  assert.equal(signalAt(c, 70, "pattern"), null);
  assert.equal(signalAt(c, 70, "baseline").side, "long", "baseline ignores the dip");
});

test("short mirror and minimum body", () => {
  const c = flat(70);
  c.push({ time: day(70), open: 100.2, high: 100.5, low: 98.8, close: 98.9, volume: 100_000 });
  assert.equal(signalAt(c, 70, "pattern").side, "short");
  c[70].close = 99.5; // only −0.7%
  assert.equal(signalAt(c, 70, "pattern"), null);
});

test("stop below the signal day's low; gap through fills at the open", () => {
  const c = flat(70);
  c.push({ time: day(70), open: 99.8, high: 101.6, low: 99.5, close: 101.5, volume: 100_000 });
  c.push({ time: day(71), open: 101.5, high: 102, low: 101, close: 101.8, volume: 100_000 });
  c.push({ time: day(72), open: 99, high: 99.5, low: 98, close: 98.5, volume: 100_000 });
  const t = simulate(c, 70, "long", { stop: "signal", exit: 5 });
  assert.equal(t.entry, 101.5);
  assert.equal(t.exit, 99);
  assert.equal(t.reason, "gap through stop");
  assert.ok(t.r < -1, "gap loses more than 1R");
});

test("hold N days exits at the close of the Nth day", () => {
  const c = flat(70);
  c.push({ time: day(70), open: 99.8, high: 101.6, low: 99.5, close: 101.5, volume: 100_000 });
  for (let i = 71; i < 76; i++) c.push({ time: day(i), open: 101 + (i - 71), high: 102 + (i - 71), low: 100.5 + (i - 71), close: 101.5 + (i - 71), volume: 100_000 });
  const t = simulate(c, 70, "long", { stop: "signal", exit: 3 });
  assert.equal(t.exitDate, day(73));
  assert.equal(t.reason, "time");
  assert.ok(t.r > 0);
});
