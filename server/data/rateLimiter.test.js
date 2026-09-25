import { test } from "node:test";
import assert from "node:assert/strict";
import { SlidingLimiter } from "./rateLimiter.js";
import * as cache from "./candleCache.js";

const elapsed = async (fn) => {
  const t0 = Date.now();
  await fn();
  return Date.now() - t0;
};

test("requests within the window pass straight through", async () => {
  const l = new SlidingLimiter([{ limit: 5, windowMs: 1000 }]);
  const ms = await elapsed(async () => {
    for (let i = 0; i < 5; i++) await l.acquire();
  });
  assert.ok(ms < 100, `expected no throttling, waited ${ms}ms`);
});

test("exceeding the window throttles the next request", async () => {
  const l = new SlidingLimiter([{ limit: 2, windowMs: 300 }]);
  await l.acquire();
  await l.acquire();
  const ms = await elapsed(() => l.acquire());
  assert.ok(ms >= 250, `expected a wait of ~300ms, got ${ms}ms`);
});

test("every window is enforced, not just the tightest", async () => {
  // 10/sec would allow these instantly, but 2 per 400ms must not.
  const l = new SlidingLimiter([
    { limit: 10, windowMs: 1000 },
    { limit: 2, windowMs: 400 },
  ]);
  await l.acquire();
  await l.acquire();
  const ms = await elapsed(() => l.acquire());
  assert.ok(ms >= 300, `the narrower window should have applied, waited ${ms}ms`);
});

// ── Circuit breaker ────────────────────────────────────────────────────

test("penalise pauses every caller, not just the one that tripped it", async () => {
  const l = new SlidingLimiter([{ limit: 100, windowMs: 1000 }]);
  l.penalise(300);

  assert.ok(l.pausedFor() > 200, "reports remaining pause time");

  // Two independent callers both wait out the global pause. This is the point:
  // Cloudflare's 1015 is a sustained-rate ban, so per-request backoff alone
  // keeps the pressure on and extends it.
  const ms = await elapsed(() => Promise.all([l.acquire(), l.acquire()]));
  assert.ok(ms >= 250, `expected a global pause, waited only ${ms}ms`);
  assert.equal(l.pausedFor(), 0, "the pause lapses on its own");
});

test("a longer penalty extends the pause, a shorter one does not shorten it", () => {
  const l = new SlidingLimiter([{ limit: 10, windowMs: 1000 }]);
  l.penalise(5000);
  const long = l.pausedFor();
  l.penalise(100);
  assert.ok(l.pausedFor() >= long - 50, "a later small penalty must not cut the pause short");
  assert.equal(l.stats().penalties, 2);
});

test("stats report the configured rate and penalty count", () => {
  const l = new SlidingLimiter([{ limit: 3, windowMs: 1000 }]);
  const s = l.stats();
  assert.ok(Number.isFinite(s.rps));
  assert.equal(s.penalties, 0);
  assert.equal(s.pausedForMs, 0);
});

// ── Candle cache ───────────────────────────────────────────────────────

const KEY = ["TEST_EQ|CACHE", "minutes", "3", "2020-01-01", "2020-01-07"];
const BARS = [{ time: "2020-01-01T09:15:00+05:30", open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];

test("a cached response round-trips", () => {
  cache.setEnabled(true);
  cache.write(KEY, BARS);
  assert.deepEqual(cache.read(KEY, "2020-01-07"), BARS);
});

test("a miss returns null rather than throwing", () => {
  assert.equal(cache.read(["TEST_EQ|ABSENT", "minutes", "3", "x", "y"], "2020-01-07"), null);
});

test("instrument keys containing pipes and spaces produce usable filenames", () => {
  const odd = ["NSE_INDEX|Nifty 50", "minutes", "3", "2020-01-01", "2020-01-07"];
  cache.write(odd, BARS);
  assert.deepEqual(cache.read(odd, "2020-01-07"), BARS);
});

test("two different ranges do not collide", () => {
  const a = ["TEST_EQ|X", "minutes", "3", "2020-01-01", "2020-01-07"];
  const b = ["TEST_EQ|X", "minutes", "3", "2020-02-01", "2020-02-07"];
  cache.write(a, [{ close: 1 }]);
  cache.write(b, [{ close: 2 }]);
  assert.equal(cache.read(a, "2020-01-07")[0].close, 1);
  assert.equal(cache.read(b, "2020-02-07")[0].close, 2);
});

test("disabling the cache bypasses reads", () => {
  cache.setEnabled(true);
  cache.write(KEY, BARS);
  cache.setEnabled(false);
  assert.equal(cache.read(KEY, "2020-01-07"), null);
  cache.setEnabled(true);
});

test("stats report the cache location", () => {
  const s = cache.stats();
  assert.ok(s.dir.includes("candles"));
  assert.ok(typeof s.entries === "number");
});
