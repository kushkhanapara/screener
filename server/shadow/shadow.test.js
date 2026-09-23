import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseBanList, loadBanList } from "./banList.js";
import { estimateBeta } from "./beta.js";
import { timeOfDayNorm } from "./volumeNorm.js";
import { tier1, preGates, finalize, scoreOf, BAR_MS } from "./signal.js";
import { SINGLE_SLOT as CFG, engineStrategy } from "./config.js";
import * as store from "../paper/store.js";
import { openPosition, closePosition } from "../paper/engine.js";
import { DEFAULT_COSTS } from "../paper/costs.js";

const ist = (y, mo, d, h, m) => Date.UTC(y, mo - 1, d, h - 5, m - 30);

// ── Config ─────────────────────────────────────────────────────────────

test("score weights sum to 1", () => {
  const total = Object.values(CFG.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

// ── Ban list ───────────────────────────────────────────────────────────

const SAMPLE = "Securities in Ban For Trade Date 15-SEP-2026:\n1,BANDHANBNK\n2,INOXWIND\n3,KAYNES\n4,MANAPPURAM\n5,SAIL\n";

test("parses NSE's ban list file", () => {
  const r = parseBanList(SAMPLE);
  assert.equal(r.tradeDate, "2026-09-15");
  assert.deepEqual(r.symbols, ["BANDHANBNK", "INOXWIND", "KAYNES", "MANAPPURAM", "SAIL"]);
});

test("an empty ban period parses to no symbols, and junk to no date", () => {
  assert.deepEqual(parseBanList("Securities in Ban For Trade Date 01-OCT-2026:\n").symbols, []);
  assert.equal(parseBanList("<html>blocked</html>").tradeDate, null);
});

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ban-"));
const okFetch = (text) => async () => ({ ok: true, text: async () => text });
const badFetch = async () => {
  throw new Error("network down");
};

test("today's list is current when the file is for today", async () => {
  const r = await loadBanList({ now: ist(2026, 9, 15, 9, 0), fetchImpl: okFetch(SAMPLE), dir: tmpDir() });
  assert.equal(r.status, "current");
  assert.ok(r.symbols.has("SAIL"));
});

test("a failed fetch falls back to the most recent earlier list", async () => {
  const dir = tmpDir();
  await loadBanList({ now: ist(2026, 9, 15, 9, 0), fetchImpl: okFetch(SAMPLE), dir });
  const r = await loadBanList({ now: ist(2026, 9, 16, 9, 0), fetchImpl: badFetch, dir });
  assert.equal(r.status, "stale");
  assert.equal(r.tradeDate, "2026-09-15");
  assert.ok(r.symbols.has("KAYNES"));
  assert.match(r.fetchError, /network down/);
});

test("the evening's file for tomorrow does not count as today's", async () => {
  // NSE publishes the next trade date's list the evening before.
  const r = await loadBanList({ now: ist(2026, 9, 14, 21, 0), fetchImpl: okFetch(SAMPLE), dir: tmpDir() });
  assert.notEqual(r.status, "current");
});

test("no cache and no network means unavailable", async () => {
  const r = await loadBanList({ now: ist(2026, 9, 15, 9, 0), fetchImpl: badFetch, dir: tmpDir() });
  assert.equal(r.status, "unavailable");
  assert.equal(r.symbols.size, 0);
});

// ── Beta ───────────────────────────────────────────────────────────────

/** Two bar series moving together: stock returns = k * index returns (+ optional noise). */
function linkedBars(n, k, { start = ist(2026, 9, 10, 9, 15), noise = 0 } = {}) {
  const idx = [];
  const stk = [];
  let ip = 20000;
  let sp = 1000;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < n; i++) {
    const t = start + i * BAR_MS;
    if (i > 0) {
      const ri = rnd() * 0.004;
      ip *= Math.exp(ri);
      sp *= Math.exp(k * ri + rnd() * noise);
    }
    idx.push({ time: t, close: ip });
    stk.push({ time: t, close: sp });
  }
  return { idx, stk };
}

test("beta recovers the true sensitivity to the index", () => {
  const { idx, stk } = linkedBars(400, 1.5);
  const b = estimateBeta(stk, idx);
  assert.equal(b.fallback, false);
  assert.ok(Math.abs(b.beta - 1.5) < 0.01, `got ${b.beta}`);
});

test("beta falls back to 1 without enough history", () => {
  const { idx, stk } = linkedBars(40, 2);
  const b = estimateBeta(stk, idx);
  assert.equal(b.fallback, true);
  assert.equal(b.beta, 1);
});

test("returns across a gap between sessions are ignored", () => {
  const { idx, stk } = linkedBars(200, 1);
  // Shift the second half a day later: the jump between halves must not count.
  const shift = (arr) => arr.map((b, i) => (i >= 100 ? { ...b, time: b.time + 24 * 60 * 60 * 1000 } : b));
  const b = estimateBeta(shift(stk), shift(idx), { minReturns: 10 });
  assert.equal(b.n, 198, "one return lost at the gap");
});

test("beta is clamped to a sane range", () => {
  const { idx, stk } = linkedBars(400, 9);
  assert.equal(estimateBeta(stk, idx).beta, 3);
});

// ── Time-of-day volume norm ────────────────────────────────────────────

test("the norm uses the same slot on previous sessions only", () => {
  const slot = 10 * 60; // 10:00
  const bars = [
    { time: ist(2026, 9, 10, 10, 0), volume: 1000 },
    { time: ist(2026, 9, 11, 10, 0), volume: 2000 },
    { time: ist(2026, 9, 14, 10, 0), volume: 3000 },
    { time: ist(2026, 9, 14, 10, 3), volume: 999999 }, // different slot
    { time: ist(2026, 9, 15, 10, 0), volume: 888888 }, // today — excluded
  ];
  const n = timeOfDayNorm(bars, slot, "2026-09-15");
  assert.equal(n.sessions, 3);
  assert.equal(n.avg, 2000);
});

test("too few prior sessions gives no norm", () => {
  const bars = [{ time: ist(2026, 9, 14, 10, 0), volume: 1000 }];
  assert.equal(timeOfDayNorm(bars, 600, "2026-09-15").avg, null);
});

test("the norm reads up to ten prior sessions from seeded volume history", async () => {
  const vh = await import("../live/volumeHistory.js");
  const slot = 10 * 60;
  const days = [1, 2, 3, 4, 7, 8, 9, 10, 11, 14]; // ten September sessions
  const candles = days.map((d, i) => ({ time: ist(2026, 9, d, 10, 0), volume: 1000 + i * 100, open: 1 }));
  vh.set("NSE_EQ|TEST", candles);
  const n = timeOfDayNorm(vh.bars("NSE_EQ|TEST"), slot, "2026-09-15");
  assert.equal(n.sessions, 10, "the rolling store's ~4 sessions no longer cap the norm");
  assert.equal(n.avg, 1450);
  vh.clear();
});

test("v2 needs five prior sessions before trusting a volume norm", () => {
  assert.equal(CFG.version, 2);
  assert.equal(CFG.minNormSessions, 5);
  const p = preGates(goodLong());
  const at = (sessions) => finalize(p, { volumeChecked: true, volume: 1000, volumeRatio: null, normSessions: sessions }, null, BAR);
  assert.equal(at(4).rejectCode, "no_volume_norm");
  assert.equal(at(5).rejectCode, "volume_missing");
});

// ── Tier 1 ─────────────────────────────────────────────────────────────

test("tier 1 rejects cheap stocks and lots too big for the account", () => {
  assert.equal(tier1(null, null).rejectCode, "no_quote");
  assert.equal(tier1({ lotSize: 1000 }, { ltp: 45 }).rejectCode, "price_below_min");
  assert.equal(tier1({ lotSize: 1000 }, { ltp: 1200 }).rejectCode, "margin_exceeds_capital"); // 12L x 20% = 2.4L
  const ok = tier1({ lotSize: 500 }, { ltp: 1420 }); // 7.1L x 20% = 1.42L
  assert.equal(ok.eligible, true);
  assert.equal(ok.margin, 142_000);
});

// ── Gates ──────────────────────────────────────────────────────────────

/** Inputs that clear every pre-volume gate as a long. */
const goodLong = (over = {}) => ({
  banned: false,
  atrPercentile: 55,
  atrPct3m: 0.4, // stop 1.5 x 0.4 = 0.6% >= 0.3%
  residualPct: 1.2,
  indexClose: 20050,
  orHigh: 20100,
  orLow: 19950,
  hasOiBaseline: true,
  oiChangePct: 3,
  futPriceChangePct: 1.1,
  ...over,
});

test("a clean long clears the pre-volume gates", () => {
  const p = preGates(goodLong());
  assert.equal(p.pass, true);
  assert.equal(p.side, "long");
  assert.equal(p.passedRs, true);
});

for (const [name, over, code] of [
  ["banned stock", { banned: true }, "banned"],
  ["missing daily history", { atrPercentile: null }, "no_daily_data"],
  ["volatility too low", { atrPercentile: 20 }, "atr_percentile"],
  ["volatility too high", { atrPercentile: 90 }, "atr_percentile"],
  ["stop too tight to clear costs", { atrPct3m: 0.1 }, "stop_too_tight"],
  ["weak residual strength", { residualPct: 0.2 }, "rs_weak"],
  ["long at Nifty's opening-range low", { indexClose: 19950 }, "market_context"],
  ["no OI baseline yet", { hasOiBaseline: false }, "no_oi_baseline"],
  ["OI falling (short covering)", { oiChangePct: -1 }, "oi_not_building"],
  ["OI up but price down", { futPriceChangePct: -0.4 }, "oi_price_mismatch"],
]) {
  test(`gate: ${name} -> ${code}`, () => {
    const p = preGates(goodLong(over));
    assert.equal(p.pass, false);
    assert.equal(p.rejectCode, code);
  });
}

test("gates fail in funnel order, reporting the first failure", () => {
  // Banned AND weak: the ban is checked first.
  assert.equal(preGates(goodLong({ banned: true, residualPct: 0.1 })).rejectCode, "banned");
});

test("an unknown ban list or opening range does not veto", () => {
  const p = preGates(goodLong({ banned: null, orHigh: null, orLow: null }));
  assert.equal(p.pass, true);
  assert.equal(p.gates.ban, null);
  assert.equal(p.gates.context, null);
});

test("the market gate is mirrored for shorts", () => {
  const short = goodLong({ residualPct: -1.2, futPriceChangePct: -1.1 });
  assert.equal(preGates(short).side, "short");
  assert.equal(preGates(short).pass, true);
  assert.equal(preGates({ ...short, indexClose: 20100 }).rejectCode, "market_context");
});

test("near misses past relative strength are marked for detailed logging", () => {
  assert.equal(preGates(goodLong({ residualPct: 0.1 })).passedRs, false);
  assert.equal(preGates(goodLong({ oiChangePct: -1 })).passedRs, true);
});

// ── Volume, persistence and score ──────────────────────────────────────

const BAR = ist(2026, 9, 15, 10, 30);
const vol = (ratio, over = {}) => ({ volumeChecked: true, volume: 1000, volumeRatio: ratio, normSessions: 5, ...over });

test("volume gate outcomes", () => {
  const p = preGates(goodLong());
  assert.equal(finalize(p, { volumeChecked: false }, null, BAR).rejectCode, "volume_unchecked");
  assert.equal(finalize(p, vol(null, { normSessions: 1 }), null, BAR).rejectCode, "no_volume_norm");
  assert.equal(finalize(p, vol(null, { normSessions: 6 }), null, BAR).rejectCode, "volume_missing");
  assert.equal(finalize(p, vol(0.8), null, BAR).rejectCode, "volume_low");
});

test("a single bar is not persistent; two consecutive same-side bars are", () => {
  const p = preGates(goodLong());
  const first = finalize(p, vol(1.5), null, BAR);
  assert.equal(first.pass, false);
  assert.equal(first.rejectCode, "not_persistent");
  assert.deepEqual(first.nextState, { barTime: BAR, side: "long", streak: 1 });

  const second = finalize(p, vol(1.5), first.nextState, BAR + BAR_MS);
  assert.equal(second.pass, true);
  assert.equal(second.streak, 2);
});

test("a gap of one bar or a side flip resets the streak", () => {
  const p = preGates(goodLong());
  const prev = { barTime: BAR, side: "long", streak: 3 };
  assert.equal(finalize(p, vol(1.5), prev, BAR + 2 * BAR_MS).streak, 1, "skipped bar");
  assert.equal(finalize(p, vol(1.5), { ...prev, side: "short" }, BAR + BAR_MS).streak, 1, "side flip");
});

test("a failed volume gate clears the streak state", () => {
  const p = preGates(goodLong());
  assert.equal(finalize(p, vol(0.5), { barTime: BAR, side: "long", streak: 4 }, BAR + BAR_MS).nextState, null);
});

test("every score component is bounded to 0..1, so no input dominates by scale", () => {
  const p = preGates(goodLong({ residualPct: 40, oiChangePct: 500 }));
  const f = finalize(p, vol(50), { barTime: BAR, side: "long", streak: 99 }, BAR + BAR_MS);
  for (const [k, v] of Object.entries(f.components)) assert.ok(v >= 0 && v <= 1, `${k}=${v}`);
  assert.ok(Math.abs(f.score - 1) < 1e-9, "all components saturated -> score 1");
});

test("score is the weighted sum of components", () => {
  const s = scoreOf({ rs: 1, oi: 0, volume: 0.5, persistence: 0 });
  assert.ok(Math.abs(s - (0.4 + 0.1)) < 1e-9);
});

// ── Single slot, enforced by the database ──────────────────────────────

beforeEach(() => store.initMemory());
after(() => store.close());

const NO_SLIP = { ...DEFAULT_COSTS, slippagePct: 0 };
const virtual = (underlying) =>
  openPosition({
    runId: "shadow",
    strategy: engineStrategy,
    signal: { side: "long", reasons: [], score: 0.7 },
    underlying,
    fillPrice: 1000,
    atr: 2,
    lotSize: 100,
    now: BAR,
    costConfig: NO_SLIP,
  });

test("only one position can hold the slot", () => {
  const a = store.insertPositionClaimingSlot(virtual("AAA"));
  const b = store.insertPositionClaimingSlot(virtual("BBB"));
  assert.equal(a.slotTaken, true);
  assert.equal(b.slotTaken, false, "second candidate is recorded as missed, not rejected");
  assert.equal(store.openPositions("shadow").length, 2);
});

test("closing the slot holder frees the slot in the same transaction", () => {
  const a = store.insertPositionClaimingSlot(virtual("AAA"));
  store.commitClose(a.id, closePosition(a, 1010, "target", BAR + 600_000, NO_SLIP));
  const c = store.insertPositionClaimingSlot(virtual("CCC"));
  assert.equal(c.slotTaken, true);

  const [t] = store.trades({ runId: "shadow" });
  assert.equal(t.slotTaken, true, "the closed trade remembers it held the slot");
});

test("paper positions are never constrained by the slot", () => {
  const live = (u) => ({ ...virtual(u), runId: "live" });
  store.insertPosition(live("AAA"));
  store.insertPosition(live("BBB"));
  assert.equal(store.openPositions("live").length, 2);
});

test("a re-recorded bar replaces its detail rather than duplicating it", () => {
  const stats = { configId: "single-slot", configVersion: 1, sessionDate: "2026-09-15", barTime: BAR, eligible: 180, passed: 1, topScore: 0.6, topUnderlying: "AAA", rejects: { rs_weak: 150 }, meta: {} };
  const rows = [{ underlying: "AAA", side: "long", passed: true, rank: 1, score: 0.6, gates: {}, components: {}, inputs: { residualPct: 1 } }];
  store.recordShadowBar(stats, rows);
  store.recordShadowBar(stats, rows);
  assert.equal(store.shadowEvals({ configId: "single-slot", barTime: BAR }).length, 1);
  assert.equal(store.shadowBars({ configId: "single-slot" }).length, 1);
  assert.deepEqual(store.latestShadowBar("single-slot").rejects, { rs_weak: 150 });
});
