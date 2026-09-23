import { test } from "node:test";
import assert from "node:assert/strict";
import orFade from "./openingRangeFade.js";

const ist = (h, m) => Date.UTC(2026, 8, 17, h - 5, m - 30);
const bar = (h, m, high, low, close) => ({ time: ist(h, m), open: close, high, low, close, volume: 10_000 });

/** Range 9:15–9:45 is 100–103 (ATR 0.5 → 6 ATRs wide). Then `after` bars. */
function ctx(after, { rs = 0.1, now } = {}) {
  const range = [];
  for (let i = 0; i < 10; i++) range.push(bar(9, 15 + 3 * i, i === 3 ? 103 : 102, i === 6 ? 100 : 101, 101.5));
  const bars = [...range, ...after];
  const last = bars[bars.length - 1];
  return {
    now: now ?? new Date(last.time).getTime() + 180_000,
    atr: { "3m": 0.5 },
    relStrength: rs,
    sessionVolume: 400_000,
    rows: { "3m": { latest: { close: last.close }, prev: { close: bars[bars.length - 2].close } } },
    bars: { "3m": bars },
  };
}

test("sells a failed break above the opening range", () => {
  const s = orFade.evaluate(ctx([bar(9, 45, 103.3, 102.5, 103.1), bar(9, 48, 103.2, 102.2, 102.4)]));
  assert.equal(s.side, "short");
  assert.ok(s.score >= 0.25);
});

test("buys a failed break below the opening range", () => {
  const s = orFade.evaluate(ctx([bar(9, 45, 100.5, 99.7, 99.9), bar(9, 48, 101, 99.9, 100.8)]));
  assert.equal(s.side, "long");
});

test("no trade while price is still outside the range", () => {
  assert.equal(orFade.evaluate(ctx([bar(9, 45, 103.5, 102.9, 103.4)])).side, null);
});

test("no trade on a poke too small to count", () => {
  assert.equal(orFade.evaluate(ctx([bar(9, 45, 103.05, 102.5, 102.6)])).side, null);
});

test("no trade before the range is complete, or on a stock moving on its own", () => {
  assert.equal(orFade.evaluate(ctx([bar(9, 45, 103.3, 102.2, 102.4)], { now: ist(9, 40) })).side, null);
  assert.equal(orFade.evaluate(ctx([bar(9, 45, 103.3, 102.5, 103.1), bar(9, 48, 103.2, 102.2, 102.4)], { rs: 1.8 })).side, null);
});

test("flat days only, no retry after a loss, no time stop", () => {
  assert.deepEqual(orFade.dayTypes, ["flat"]);
  assert.equal(orFade.noRetryAfterLoss, true);
  assert.ok(orFade.exits.timeStopBars >= 1000);
});
