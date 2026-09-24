import { test } from "node:test";
import assert from "node:assert/strict";
import { volumeProfile, dualPoc, consolidationBox } from "./volumeProfile.js";

const bar = (low, high, volume) => ({ time: 0, open: low, high, low, close: high, volume });
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test("a bar's volume is spread across its range by overlap", () => {
  const p = volumeProfile([bar(100, 104, 400)], { bins: 4 });
  assert.equal(p.volumes.length, 4);
  p.volumes.forEach((v) => near(v, 100));
  near(p.totalVolume, 400);
});

test("a bar covering half the range fills only its half", () => {
  const p = volumeProfile([bar(100, 104, 0.0001), bar(100, 102, 200)], { bins: 4 });
  near(p.volumes[0], 100, 1e-3);
  near(p.volumes[1], 100, 1e-3);
  near(p.volumes[3], 0, 1e-3);
});

test("the POC is the heaviest bin, and a secondary peak ≥ 70% is a node", () => {
  const bars = [bar(100, 110, 100), bar(101, 102, 500), bar(107, 108, 400)];
  const p = volumeProfile(bars, { bins: 10 });
  near(p.poc.price, 101.5);
  assert.deepEqual(p.nodes.map((n) => n.price), [107.5]);
  assert.equal(volumeProfile(bars, { bins: 10, nodePct: 0.9 }).nodes.length, 0);
});

test("the POC's own shoulders are not separate nodes", () => {
  const p = volumeProfile([bar(100, 103, 300), bar(101, 102, 300)], { bins: 3 });
  near(p.poc.price, 101.5);
  assert.equal(p.nodes.length, 0);
});

test("bin width follows binPct of price", () => {
  const p = volumeProfile([bar(99, 101, 10)], { binPct: 0.002 }); // 0.2 of 100
  assert.equal(p.volumes.length, 10);
  near(p.binSize, 0.2);
});

test("a range with no width puts everything in one bin; no volume returns null", () => {
  const p = volumeProfile([bar(50, 50, 7)]);
  assert.equal(p.volumes.length, 1);
  near(p.poc.price, 50);
  assert.equal(volumeProfile([bar(1, 2, 0)]), null);
  assert.equal(volumeProfile([]), null);
});

test("two POCs agree only within the tolerance", () => {
  const a = { poc: { price: 100 } };
  const b = { poc: { price: 100.2 } };
  near(dualPoc(a, b, 0.25).price, 100.1);
  assert.equal(dualPoc(a, b, 0.1), null);
});

test("the consolidation box is the heaviest window narrow enough to count", () => {
  const bars = [bar(95, 96, 50), bar(95.2, 96, 50), bar(97, 98, 1), bar(97.5, 98, 1), bar(80, 99, 999)];
  // Windows 0–1 and 2–3 both qualify; the first carries the volume.
  assert.deepEqual(consolidationBox(bars, 2, 1.5), { start: 0, end: 1, range: 1, volume: 100 });
  // The heaviest window of all is too wide to be a consolidation.
  assert.equal(consolidationBox(bars, 2, 1.5).volume, 100);
  assert.equal(consolidationBox(bars, 2, 0.5), null);
});
