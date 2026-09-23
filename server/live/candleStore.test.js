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
