import { test } from "node:test";
import assert from "node:assert/strict";
import { CandleStore } from "./candleStore.js";

const MIN = 60000;
const BUCKET = 3 * MIN;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % BUCKET); // aligned bucket start

const mk = () => new CandleStore(BUCKET);

test("addTick opens a bar and updates OHLC within the same bucket", () => {
  const s = mk();
  s.addTick("K", 100, T0 + 10, 5);
  s.addTick("K", 105, T0 + 20, 5);
  s.addTick("K", 95, T0 + 30, 5);
  s.addTick("K", 102, T0 + 40, 5);

  const [b] = s.bars("K");
  assert.equal(b.time, T0);
  assert.equal(b.open, 100);
  assert.equal(b.high, 105);
  assert.equal(b.low, 95);
  assert.equal(b.close, 102);
  assert.equal(b.volume, 20);
});

test("addTick rolls into a new bar when the bucket advances", () => {
  const s = mk();
  s.addTick("K", 100, T0 + 10);
  s.addTick("K", 110, T0 + BUCKET + 10);
  const bars = s.bars("K");
  assert.equal(bars.length, 2);
  assert.equal(bars[1].time, T0 + BUCKET);
  assert.equal(bars[1].open, 110);
});

test("addTick ignores stale ticks from an earlier bucket", () => {
  const s = mk();
  s.addTick("K", 100, T0 + BUCKET + 10);
  s.addTick("K", 999, T0 + 10); // late arrival for a bucket already closed
  const bars = s.bars("K");
  assert.equal(bars.length, 1);
  assert.equal(bars[0].close, 100);
});

test("addTick ignores a non-finite price", () => {
  const s = mk();
  s.addTick("K", NaN, T0 + 10);
  assert.equal(s.bars("K").length, 0);
});

// ── Closed-bar semantics (the repaint fix) ─────────────────────────────

test("closedBars excludes the still-forming bar", () => {
  const s = mk();
  s.addTick("K", 100, T0 + 10);
  const midBar = T0 + MIN; // one minute into a three-minute bucket

  assert.equal(s.bars("K").length, 1, "the forming bar is visible to bars()");
  assert.equal(s.closedBars("K", midBar).length, 0, "but not to closedBars()");
});

test("closedBars includes a bar once its bucket has elapsed", () => {
  const s = mk();
  s.addTick("K", 100, T0 + 10);
  const afterClose = T0 + BUCKET;

  const closed = s.closedBars("K", afterClose);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].time, T0);
});

test("closedBars keeps older bars and drops only the newest forming one", () => {
  const s = mk();
  s.addTick("K", 100, T0 + 10);
  s.addTick("K", 110, T0 + BUCKET + 10);
  s.addTick("K", 120, T0 + 2 * BUCKET + 10);

  const now = T0 + 2 * BUCKET + MIN; // third bar still forming
  const closed = s.closedBars("K", now);
  assert.equal(closed.length, 2);
  assert.deepEqual(
    closed.map((b) => b.time),
    [T0, T0 + BUCKET]
  );
});

test("closedBars is empty for an unknown key", () => {
  assert.deepEqual(mk().closedBars("NOPE", T0), []);
});

test("a bar closes on elapsed time even when ticks stop (illiquid name)", () => {
  const s = mk();
  s.addTick("K", 100, T0 + 10);
  // No further ticks ever arrive; the bar must still close on the clock.
  const muchLater = T0 + 50 * BUCKET;
  assert.equal(s.closedBars("K", muchLater).length, 1);
});

test("lastClosedBucket reports the newest closed bar, or -1 when none", () => {
  const s = mk();
  assert.equal(s.lastClosedBucket("K", T0), -1);
  s.addTick("K", 100, T0 + 10);
  assert.equal(s.lastClosedBucket("K", T0 + MIN), -1, "forming bar does not count");
  assert.equal(s.lastClosedBucket("K", T0 + BUCKET), T0);
});

test("stalenessBuckets grows as data goes stale, and is Infinity when absent", () => {
  const s = mk();
  assert.equal(s.stalenessBuckets("K", T0), Infinity);

  s.addTick("K", 100, T0 + 10);
  assert.equal(s.stalenessBuckets("K", T0 + BUCKET), 0, "just closed");
  assert.equal(s.stalenessBuckets("K", T0 + 4 * BUCKET), 3);
});

test("bucketMs is exposed for bar-boundary arithmetic", () => {
  assert.equal(mk().bucketMs, BUCKET);
});

// ── Seeding ────────────────────────────────────────────────────────────

test("seed dedupes by bucket, sorts ascending, and drops non-finite closes", () => {
  const s = mk();
  s.seed("K", [
    { time: new Date(T0 + BUCKET).toISOString(), open: 2, high: 2, low: 2, close: 2, volume: 1 },
    { time: new Date(T0).toISOString(), open: 1, high: 1, low: 1, close: 1, volume: 1 },
    // same bucket as the first -> later entry wins
    { time: new Date(T0 + BUCKET + 60).toISOString(), open: 3, high: 3, low: 3, close: 3, volume: 1 },
    { time: new Date(T0 + 2 * BUCKET).toISOString(), open: 9, high: 9, low: 9, close: NaN, volume: 1 },
  ]);

  const bars = s.bars("K");
  assert.deepEqual(
    bars.map((b) => b.time),
    [T0, T0 + BUCKET]
  );
  assert.equal(bars[1].close, 3, "last write wins within a bucket");
});

test("seeded bars then accept live ticks on the following bucket", () => {
  const s = mk();
  s.seed("K", [
    { time: new Date(T0).toISOString(), open: 1, high: 1, low: 1, close: 1, volume: 1 },
  ]);
  s.addTick("K", 50, T0 + BUCKET + 10);
  assert.equal(s.bars("K").length, 2);
  assert.equal(s.closedBars("K", T0 + 2 * BUCKET).length, 2);
});

test("seed keeps bars the live feed built before seeding finished", () => {
  const s = mk();
  const t0 = 1_000 * BUCKET;
  // The feed opened first: ticks in the bar that was forming, and in the next.
  s.addTick("K", 101, t0 + 10, 5);
  s.addTick("K", 104, t0 + 20, 5);
  s.addTick("K", 103, t0 + BUCKET + 1, 7);
  // Seed returns history up to and including the forming bar (partial).
  s.seed("K", [
    { time: new Date(t0 - BUCKET).toISOString(), open: 98, high: 99, low: 97, close: 98.5, volume: 50 },
    { time: new Date(t0).toISOString(), open: 100, high: 102, low: 99, close: 101, volume: 40 },
  ]);
  const bars = s.bars("K");
  assert.equal(bars.length, 3, "history, the shared bar and the newer live bar");
  assert.deepEqual(bars[0], { time: t0 - BUCKET, open: 98, high: 99, low: 97, close: 98.5, volume: 50 });
  assert.deepEqual(bars[1], { time: t0, open: 100, high: 104, low: 99, close: 104, volume: 40 });
  assert.equal(bars[2].time, t0 + BUCKET);
  assert.equal(bars[2].close, 103);
  // And ticks keep extending the newest bar afterwards.
  s.addTick("K", 105, t0 + BUCKET + 2, 1);
  assert.equal(s.bars("K").at(-1).close, 105);
});

test("seed with nothing live behaves exactly as before", () => {
  const s = mk();
  s.seed("K", [{ time: new Date(0).toISOString(), open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }]);
  assert.deepEqual(s.bars("K"), [{ time: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }]);
});

test("reconcile replaces closed bars with authoritative candles and fills gaps", () => {
  const s = mk();
  const t0 = 1_000 * BUCKET;
  // Feed froze mid-bar at t0, then missed t0+BUCKET entirely; t0+2B is forming.
  s.addTick("K", 100, t0 + 1, 10);
  s.addTick("K", 100.5, t0 + 2, 10);
  s.addTick("K", 102, t0 + 2 * BUCKET + 1, 5);
  const now = t0 + 2 * BUCKET + 30_000;
  const n = s.reconcile(
    "K",
    [
      { time: new Date(t0).toISOString(), open: 100, high: 101.5, low: 99.8, close: 101.2, volume: 900 },
      { time: new Date(t0 + BUCKET).toISOString(), open: 101.2, high: 102, low: 101, close: 101.9, volume: 700 },
      // The forming bar from REST is partial: it must not replace the live one.
      { time: new Date(t0 + 2 * BUCKET).toISOString(), open: 101.9, high: 101.95, low: 101.9, close: 101.95, volume: 1 },
    ],
    now
  );
  assert.equal(n, 2);
  const bars = s.bars("K");
  assert.equal(bars.length, 3);
  assert.deepEqual(bars[0], { time: t0, open: 100, high: 101.5, low: 99.8, close: 101.2, volume: 900 });
  assert.equal(bars[1].close, 101.9);
  assert.equal(bars[2].close, 102, "forming bar stays live");
  s.addTick("K", 102.5, t0 + 2 * BUCKET + 5, 1);
  assert.equal(s.bars("K").at(-1).close, 102.5);
});

test("exchange minute candles replace snapshot-built minutes, fixing boundary slide", () => {
  const s = mk();
  const t0 = 1_000 * BUCKET; // bar A = [t0, t0+3m), bar B = [t0+3m, t0+6m)
  // Last minute of A: the snapshots saw 100.
  s.addTick("K", 100, t0 + 2 * MIN + 10_000, 50);
  // A snapshot just after the boundary carries trades from before it: it lands
  // in B with their volume (400).
  s.addTick("K", 103, t0 + BUCKET + 500, 400);
  let [a, b] = s.bars("K");
  assert.equal(a.close, 100);
  assert.equal(b.volume, 400);
  // The exchange candles for A's last minute and B's first minute arrive.
  s.applyMinute("K", t0 + 2 * MIN, { open: 100, high: 102.5, low: 99.9, close: 102.4, volume: 380 });
  s.applyMinute("K", t0 + BUCKET, { open: 102.6, high: 103, low: 102.5, close: 103, volume: 70 });
  [a, b] = s.bars("K");
  assert.equal(a.close, 102.4, "A closes where the exchange says");
  assert.equal(a.high, 102.5);
  assert.equal(a.volume, 380);
  assert.equal(b.open, 102.6, "B opens on its own first trade");
  assert.equal(b.volume, 70, "volume no longer slides into B");
  // A late snapshot inside a minute the exchange has closed changes nothing.
  s.addTick("K", 150, t0 + BUCKET + 30_000, 999);
  assert.equal(s.bars("K").at(-1).high, 103);
});

test("a bar is the aggregate of its minutes", () => {
  const s = mk();
  const t0 = 1_000 * BUCKET;
  s.applyMinute("K", t0, { open: 10, high: 11, low: 9.5, close: 10.5, volume: 100 });
  s.applyMinute("K", t0 + MIN, { open: 10.5, high: 12, low: 10.4, close: 11.8, volume: 200 });
  s.addTick("K", 11.6, t0 + 2 * MIN + 1_000, 30); // forming third minute
  assert.deepEqual(s.bars("K"), [{ time: t0, open: 10, high: 12, low: 9.5, close: 11.6, volume: 330 }]);
});

test("reconciled bars are locked against later minute updates", () => {
  const s = mk();
  const t0 = 1_000 * BUCKET;
  s.addTick("K", 10, t0 + 1_000, 5);
  s.addTick("K", 10.2, t0 + BUCKET + 1_000, 5); // A has closed
  s.reconcile(
    "K",
    [{ time: new Date(t0).toISOString(), open: 10, high: 10.4, low: 9.9, close: 10.1, volume: 999 }],
    t0 + BUCKET + 2_000
  );
  s.applyMinute("K", t0 + 2 * MIN, { open: 1, high: 1, low: 1, close: 1, volume: 1 });
  assert.deepEqual(s.bars("K")[0], { time: t0, open: 10, high: 10.4, low: 9.9, close: 10.1, volume: 999 });
});
