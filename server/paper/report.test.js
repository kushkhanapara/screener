import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { extractFeatures, FEATURE_VERSION } from "./features.js";
import { buildReport, MIN_SAMPLE } from "./report.js";
import * as store from "./store.js";
import { openPosition, closePosition } from "./engine.js";
import { DEFAULT_COSTS } from "./costs.js";

const ist = (y, mo, d, h, m) => Date.UTC(y, mo - 1, d, h - 5, m - 30);
const NOW = ist(2026, 9, 14, 16, 0); // Monday evening
const NO_SLIP = { ...DEFAULT_COSTS, slippagePct: 0 };

// ── Features ───────────────────────────────────────────────────────────

const ctx = {
  rows: { "3m": { latest: { close: 101, rsi14: 62.123 } }, "15m": { latest: { rsi14: 58 } } },
  intradayRsi: { "15m": 57.456 },
  emaMacd: { "15m": { hist: 0.12345 } },
  atr: { "3m": 0.505 },
  vwap: 100,
  pctFromOpen: 1.5,
  pctFromPrevClose: 2,
  gapPct: 0.5,
  relStrength: 0.8,
  index: { pctFromOpen: 0.3 },
  sessionVolume: 900_000,
  regime: "bullish",
};

test("features capture the entry conditions", () => {
  const f = extractFeatures(ctx, { side: "long", score: 3.14159 }, { now: ist(2026, 9, 14, 11, 20) });
  assert.equal(f.v, FEATURE_VERSION);
  assert.equal(f.side, "long");
  assert.equal(f.regime, "bullish");
  assert.equal(f.entryMinuteIst, 11 * 60 + 20);
  assert.equal(f.weekday, 1); // Monday
  assert.equal(f.rsi15m, 57.46, "prefers the 15m RSI and rounds it");
  assert.equal(f.rsi3m, 62.12);
  assert.equal(f.score, 3.142);
  assert.equal(f.atrPct, 0.5); // 0.505 / 101
  assert.equal(f.vwapDistPct, 1);
});

test("aligned features point in the trade's favour for both sides", () => {
  const long = extractFeatures(ctx, { side: "long" }, { now: NOW });
  const short = extractFeatures(ctx, { side: "short" }, { now: NOW });
  assert.equal(long.alignedMove, 1.5);
  assert.equal(short.alignedMove, -1.5, "a short entered after a rally is entered against the move");
  assert.equal(long.alignedRs, 0.8);
  assert.equal(short.alignedRs, -0.8);
});

test("missing context yields nulls, not NaN or a crash", () => {
  const f = extractFeatures({}, { side: "short" }, { now: NOW });
  for (const k of ["rsi15m", "atrPct", "vwapDistPct", "alignedMove", "regime", "relStrength"]) {
    assert.equal(f[k], null, `${k} should be null`);
  }
});

// ── Report ─────────────────────────────────────────────────────────────

let seq = 0;
/** A closed trade; defaults to a 20-minute long entered Monday 11:00 IST. */
function trade(over = {}) {
  const entryTime = over.entryTime ?? ist(2026, 9, 14, 11, 0);
  return {
    id: `t${seq++}`,
    strategyId: "s1",
    side: "long",
    entryTime,
    exitTime: entryTime + 20 * 60_000,
    exitReason: "target",
    rMultiple: 1,
    netPnl: 1000,
    grossPnl: 1150,
    costs: 150,
    mae: 0.2,
    mfe: 1.2,
    features: { v: 1, regime: "bullish", rsi15m: 55, atrPct: 0.3, alignedMove: 1.2, alignedRs: 0.6 },
    ...over,
  };
}

const loser = (over = {}) =>
  trade({ exitReason: "stop", rMultiple: -1.1, netPnl: -1100, grossPnl: -950, mae: 1.05, mfe: 0.05, ...over });

test("only trades inside the window are counted", () => {
  const r = buildReport(
    [trade(), trade({ entryTime: ist(2026, 8, 20, 11, 0) })], // one from weeks ago
    { days: 7, now: NOW }
  );
  assert.equal(r.counts.real, 1);
  assert.equal(buildReport([trade(), trade({ entryTime: ist(2026, 8, 20, 11, 0) })], { days: null, now: NOW }).counts.real, 2);
});

test("trades flattened within a minute are excluded as churn", () => {
  const junk = trade({ exitTime: ist(2026, 9, 14, 11, 0) + 20_000, rMultiple: -0.3, netPnl: -380, costs: 150 });
  const r = buildReport([trade(), junk], { now: NOW });
  assert.equal(r.counts.real, 1);
  assert.equal(r.counts.excludedJunk, 1);
  assert.equal(r.counts.junkCosts, 150);
  assert.equal(r.summary.trades, 1, "junk must not dilute the real numbers");
});

test("breakdowns group by entry condition in a stable order", () => {
  const r = buildReport([trade({ side: "short" }), trade(), trade()], { now: NOW });
  const side = r.breakdowns.find((b) => b.key === "side");
  assert.deepEqual(side.rows.map((x) => x.bucket), ["long", "short"]);
  assert.equal(side.rows[0].trades, 2);
});

test("feature breakdowns are skipped when no trade has the feature", () => {
  const r = buildReport([trade({ features: null }), trade({ features: null })], { now: NOW });
  assert.ok(r.breakdowns.some((b) => b.key === "side"), "outcome-based dimensions still work");
  assert.ok(!r.breakdowns.some((b) => b.key === "regime"), "no regime data, no regime table");
  assert.equal(r.counts.withFeatures, 0);
});

test("a clearly losing group is flagged once it has enough trades", () => {
  const trades = [
    ...Array.from({ length: 8 }, () => trade()),
    ...Array.from({ length: MIN_SAMPLE }, () => loser({ side: "short" })),
  ];
  const r = buildReport(trades, { now: NOW });
  const f = r.findings.find((x) => x.dimension === "side" && x.bucket === "short");
  assert.ok(f, "shorts should be flagged");
  assert.equal(f.severity, "warn");
  assert.equal(f.n, MIN_SAMPLE);
});

test("a losing group below the minimum sample is NOT flagged", () => {
  const trades = [
    ...Array.from({ length: 8 }, () => trade()),
    ...Array.from({ length: MIN_SAMPLE - 1 }, () => loser({ side: "short" })),
  ];
  const r = buildReport(trades, { now: NOW });
  assert.equal(
    r.findings.some((x) => x.dimension === "side" && x.bucket === "short"),
    false,
    "4 losing shorts is not enough evidence to flag"
  );
});

test("a losing group that dominates the sample is still flagged", () => {
  // Found on real data: 152 shorts at −0.64R were never flagged, because they
  // made up most of the overall average they were being compared against.
  const trades = [
    ...Array.from({ length: 6 }, () => trade()),
    ...Array.from({ length: 20 }, () => loser({ side: "short" })),
  ];
  const r = buildReport(trades, { now: NOW });
  const f = r.findings.find((x) => x.dimension === "side" && x.bucket === "short");
  assert.ok(f, "the majority losing group must still surface");
  assert.equal(f.severity, "warn");
});

test("a dimension with a single bucket produces no findings", () => {
  // Every trade on one weekday says nothing about weekdays.
  const trades = Array.from({ length: 10 }, () => loser());
  const r = buildReport(trades, { now: NOW });
  assert.equal(r.findings.some((x) => x.dimension === "weekday"), false);
});

test("a stop wider than winners need is flagged", () => {
  const winners = Array.from({ length: 6 }, () => trade({ mae: 0.3 }));
  const r = buildReport(winners, { now: NOW });
  assert.ok(r.findings.some((x) => x.title.startsWith("Stop may be wider")));
});

test("losers that never went green are flagged as an entry problem", () => {
  const r = buildReport(Array.from({ length: 6 }, () => loser({ mfe: 0.1 })), { now: NOW });
  assert.ok(r.findings.some((x) => x.title === "Losers were wrong from the start"));
});

test("heavy square-off exits are flagged", () => {
  const r = buildReport(
    Array.from({ length: 6 }, () => trade({ exitReason: "squareoff", rMultiple: 0.1, netPnl: 100 })),
    { now: NOW }
  );
  assert.ok(r.findings.some((x) => x.title === "Trades are being ended by the clock"));
});

test("a small sample carries an explicit warning, listed last", () => {
  const r = buildReport([trade(), trade()], { now: NOW });
  const info = r.findings.find((x) => x.title === "Sample too small to act on");
  assert.ok(info);
  assert.equal(r.findings[r.findings.length - 1].severity, "info");
});

test("an empty window produces an empty report, not an error", () => {
  const r = buildReport([], { now: NOW });
  assert.equal(r.counts.total, 0);
  assert.equal(r.summary.trades, 0);
  assert.ok(Array.isArray(r.breakdowns));
});

test("the report can be restricted to one strategy", () => {
  const r = buildReport([trade(), trade({ strategyId: "s2" })], { now: NOW, strategyId: "s2" });
  assert.equal(r.counts.real, 1);
  assert.equal(r.strategies[0].strategyId, "s2");
});

// ── Persistence ────────────────────────────────────────────────────────

beforeEach(() => store.initMemory());
after(() => store.close());

test("features survive open -> close -> reload from the database", () => {
  const strategy = {
    id: "s1",
    timeframes: { trigger: "3m" },
    exits: { stopAtr: 2, trailAtr: 2, breakevenAtR: 1, targetR: 3, timeStopBars: 5, squareOffMin: 915 },
  };
  const features = extractFeatures(ctx, { side: "long", score: 2 }, { now: NOW });
  const p = openPosition({
    runId: "live",
    strategy,
    signal: { side: "long", reasons: [] },
    underlying: "TEST",
    fillPrice: 100,
    atr: 5,
    lotSize: 50,
    now: ist(2026, 9, 14, 11, 0),
    costConfig: NO_SLIP,
    features,
  });
  store.insertPosition(p);
  assert.deepEqual(store.getPosition(p.id).features, features, "open position keeps its features");

  store.commitClose(p.id, closePosition(p, 110, "target", ist(2026, 9, 14, 11, 30), NO_SLIP));
  const [t] = store.trades({ runId: "live" });
  assert.deepEqual(t.features, features, "closed trade keeps its features");
});

test("trades recorded before features existed read back as null", () => {
  const strategy = {
    id: "s1",
    timeframes: { trigger: "3m" },
    exits: { stopAtr: 2, trailAtr: 2, breakevenAtR: 1, targetR: 3, timeStopBars: 5, squareOffMin: 915 },
  };
  const p = openPosition({
    runId: "live", strategy, signal: { side: "long" }, underlying: "OLD",
    fillPrice: 100, atr: 5, lotSize: 50, now: ist(2026, 9, 14, 11, 0), costConfig: NO_SLIP,
  });
  store.insertPosition(p);
  store.commitClose(p.id, closePosition(p, 105, "squareoff", ist(2026, 9, 14, 11, 30), NO_SLIP));
  assert.equal(store.trades({ runId: "live" })[0].features, null);
});
