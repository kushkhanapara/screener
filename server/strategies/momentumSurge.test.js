import { test } from "node:test";
import assert from "node:assert/strict";
import surge, { shortTermScore } from "./momentumSurge.js";

/** A context satisfying every LONG condition; override to break one. */
const ctxLong = (over = {}) => ({
  rows: { "3m": { latest: { close: 105 }, prev: { close: 104 } } },
  pctFromOpen: 2.0,
  pctFromPrevClose: 2.2,
  gapPct: 0.2, // small gap -> the move is genuinely intraday
  intradayRsi: { "15m": 60, "3m": 62 },
  emaMacd: { "15m": { hist: 0.4 }, "3m": { hist: 0.3 } },
  sessionVolume: 900_000,
  ...over,
});

const ctxShort = (over = {}) => ({
  rows: { "3m": { latest: { close: 95 }, prev: { close: 96 } } },
  pctFromOpen: -2.0,
  pctFromPrevClose: -2.2,
  gapPct: -0.2,
  intradayRsi: { "15m": 40 },
  emaMacd: { "15m": { hist: -0.4 } },
  sessionVolume: 900_000,
  ...over,
});

test("fires long on a clean intraday surge", () => {
  const res = surge.evaluate(ctxLong());
  assert.equal(res.side, "long");
  assert.equal(res.reasons.length, 5);
  assert.ok(Number.isFinite(res.score));
});

test("fires short on the mirrored setup", () => {
  assert.equal(surge.evaluate(ctxShort()).side, "short");
});

test("needs the full surge threshold", () => {
  assert.equal(surge.evaluate(ctxLong({ pctFromOpen: 1.1 })).side, null);
  assert.equal(surge.evaluate(ctxLong({ pctFromOpen: null })).side, null);
  assert.equal(surge.evaluate(ctxShort({ pctFromOpen: -1.1 })).side, null);
});

test("refuses to chase into overbought (the RSI ceiling)", () => {
  // This is the rule that separates the traded 'Strong' tier from the 'Bias'
  // tier in the original, which had no RSI guard at all.
  assert.equal(surge.evaluate(ctxLong({ intradayRsi: { "15m": 68 } })).side, null);
  assert.equal(surge.evaluate(ctxLong({ intradayRsi: { "15m": 80 } })).side, null);
  assert.equal(surge.evaluate(ctxLong({ intradayRsi: { "15m": 67.9 } })).side, "long");
});

test("refuses to chase into oversold on the short side", () => {
  assert.equal(surge.evaluate(ctxShort({ intradayRsi: { "15m": 32 } })).side, null);
  assert.equal(surge.evaluate(ctxShort({ intradayRsi: { "15m": 32.1 } })).side, "short");
});

test("requires MACD to agree with the direction", () => {
  assert.equal(surge.evaluate(ctxLong({ emaMacd: { "15m": { hist: -0.1 } } })).side, null);
  assert.equal(surge.evaluate(ctxLong({ emaMacd: { "15m": { hist: 0 } } })).side, null);
  assert.equal(surge.evaluate(ctxShort({ emaMacd: { "15m": { hist: 0.1 } } })).side, null);
});

test("uses the 15m timeframe, not 3m, for confirmation", () => {
  // 3m disagreeing must not matter; 15m disagreeing must.
  assert.equal(surge.evaluate(ctxLong({ emaMacd: { "15m": { hist: 0.4 }, "3m": { hist: -9 } } })).side, "long");
  assert.equal(surge.evaluate(ctxLong({ emaMacd: { "15m": { hist: -0.4 }, "3m": { hist: 9 } } })).side, null);
});

test("rejects a move that is mostly an overnight gap", () => {
  // Gapped +2.0 and only moved +0.1 since — the original would have called this
  // a surge because it measured from the previous close.
  assert.equal(
    surge.evaluate(ctxLong({ pctFromOpen: 1.5, pctFromPrevClose: 2.1, gapPct: 2.0 })).side,
    null
  );
});

test("accepts a move that continued well past its gap", () => {
  assert.equal(
    surge.evaluate(ctxLong({ pctFromOpen: 2.0, pctFromPrevClose: 2.5, gapPct: 0.5 })).side,
    "long"
  );
});

test("missing gap data does not block a signal", () => {
  // Absence of information is not evidence of a gap.
  assert.equal(surge.evaluate(ctxLong({ gapPct: null, pctFromPrevClose: null })).side, "long");
});

test("enforces the liquidity floor", () => {
  assert.equal(surge.evaluate(ctxLong({ sessionVolume: 1000 })).side, null);
});

test("prefers futures volume when it is available", () => {
  assert.equal(surge.evaluate(ctxLong({ sessionVolume: 10, futVolume: 900_000 })).side, "long");
  assert.equal(surge.evaluate(ctxLong({ sessionVolume: 900_000, futVolume: 10 })).side, null);
});

test("stays silent without intraday rows or indicators", () => {
  assert.equal(surge.evaluate({ rows: {} }).side, null);
  assert.equal(surge.evaluate(ctxLong({ intradayRsi: {} })).side, null);
  assert.equal(surge.evaluate(ctxLong({ emaMacd: {} })).side, null);
});

test("long and short cannot both fire on one context", () => {
  for (const c of [ctxLong(), ctxShort()]) {
    const r = surge.evaluate(c);
    assert.ok(r.side === "long" || r.side === "short");
  }
});

// ── ST_Score (ranking only) ────────────────────────────────────────────

test("shortTermScore reproduces the original formula", () => {
  // 2% on 5m shares: 2*2.5 + 5*2 + (2*50)/80 = 5 + 10 + 1.25 = 16.25 -> 16.3
  assert.equal(shortTermScore(2, 5_000_000), 16.3);
});

test("shortTermScore applies the move and volume bonuses", () => {
  const base = shortTermScore(2.4, 1_000_000);
  const withMoveBonus = shortTermScore(2.5, 1_000_000); // +4
  assert.ok(withMoveBonus - base > 3.9);

  const under = shortTermScore(1, 9_999_999);
  const over = shortTermScore(1, 10_000_000); // +2
  assert.ok(over - under >= 2);
});

test("shortTermScore is dominated by volume, not by the size of the move", () => {
  // Documents a real weakness: a smaller mover in a liquid name outranks a much
  // bigger mover in a thinner one, so this ranks liquidity more than opportunity.
  const liquidSmallMove = shortTermScore(1.5, 15_000_000);
  const thinBigMove = shortTermScore(3.0, 300_000);
  assert.ok(
    liquidSmallMove > thinBigMove * 2,
    `expected volume to dominate: ${liquidSmallMove} vs ${thinBigMove}`
  );
});

test("shortTermScore handles bad input", () => {
  assert.equal(shortTermScore(null, 100), null);
  assert.equal(shortTermScore(1, null), null);
});

test("is symmetric in score for equal moves in either direction", () => {
  assert.equal(shortTermScore(2, 5_000_000), shortTermScore(-2, 5_000_000));
});
