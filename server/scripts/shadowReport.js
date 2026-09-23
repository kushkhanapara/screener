/**
 * Shadow logging review for one session — shadow data only.
 *
 *   npm run report:shadow                  latest logged session
 *   npm run report:shadow -- 2026-09-15    a specific session
 *
 * Shadow is its own book (one slot, virtual fills, no paper capital); nothing
 * here reads or compares paper trades. For paper, use `npm run report`.
 */
import * as store from "../paper/store.js";
import { SINGLE_SLOT as CFG, SHADOW_RUN_ID } from "../shadow/config.js";
import { REJECT_ORDER } from "../shadow/signal.js";
import { outcome } from "../shadow/summary.js";
import { istDateString, istMinutes } from "../core/session.js";

const BAR_MS = 3 * 60 * 1000;
const EXPECTED_BARS = 110; // closes from 09:30 up to 15:00

store.init();

const all = store.shadowBars({ configId: CFG.id });
if (!all.length) {
  console.log("No shadow bars recorded yet.");
  process.exit(0);
}
const date = process.argv[2] || all[all.length - 1].sessionDate;
const bars = all.filter((b) => b.sessionDate === date);
if (!bars.length) {
  console.log(`No shadow bars for ${date}. Logged sessions: ${[...new Set(all.map((b) => b.sessionDate))].join(", ")}`);
  process.exit(0);
}

const evals = bars.flatMap((b) => store.shadowEvals({ configId: CFG.id, barTime: b.barTime }).map((e) => ({ ...e, barTime: b.barTime })));
const trades = store.tradesChronological({ runId: SHADOW_RUN_ID }).filter((t) => istDateString(t.entryTime) === date);
store.close();

const hhmm = (ms) => {
  const m = istMinutes(ms);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const rupees = (v) => `${v < 0 ? "−" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
const R = (v) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}R`);
const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const section = (t) => console.log(`\n${t}`);

const versions = [...new Set(bars.map((b) => b.configVersion))];
console.log(`\nSHADOW REVIEW — ${CFG.name} — ${date} — config v${versions.join(", v")}`);
console.log("─".repeat(78));

// ── Coverage ────────────────────────────────────────────────────────────
const gaps = [];
for (let i = 1; i < bars.length; i++) {
  if (bars[i].barTime - bars[i - 1].barTime !== BAR_MS) gaps.push(`${hhmm(bars[i - 1].barTime)}→${hhmm(bars[i].barTime)}`);
}
section("COVERAGE");
console.log(
  `  ${bars.length}/${EXPECTED_BARS} bars (${hhmm(bars[0].barTime)}–${hhmm(bars[bars.length - 1].barTime)})   ` +
    `${gaps.length ? `gaps: ${gaps.join(", ")}` : "no gaps"}`
);
const passes = sum(bars, (b) => b.passed);
console.log(
  `  ${bars.filter((b) => b.passed > 0).length} bars with a candidate · ${passes} passes · ` +
    `${new Set(evals.filter((e) => e.passed).map((e) => e.underlying)).size} distinct names`
);

// ── Funnel ──────────────────────────────────────────────────────────────
const totals = {};
for (const b of bars) for (const [k, v] of Object.entries(b.rejects)) totals[k] = (totals[k] || 0) + v;
section("FUNNEL (name-bars rejected, in gate order)");
for (const k of REJECT_ORDER) if (totals[k]) console.log(`  ${k.padEnd(24)} ${String(totals[k]).padStart(6)}`);
console.log(`  ${"passed".padEnd(24)} ${String(passes).padStart(6)}`);

section("BY HOUR (avg per bar)");
const hours = new Map();
for (const b of bars) {
  const h = Math.floor(istMinutes(b.barTime) / 60);
  if (!hours.has(h)) hours.set(h, []);
  hours.get(h).push(b);
}
for (const [h, hb] of hours) {
  const rej = {};
  for (const b of hb) for (const [k, v] of Object.entries(b.rejects)) rej[k] = (rej[k] || 0) + v;
  const top = Object.entries(rej).sort((a, b) => b[1] - a[1])[0];
  const avg = (f) => (sum(hb, f) / hb.length).toFixed(1);
  console.log(
    `  ${String(h).padStart(2, "0")}:00  eligible ${avg((b) => b.eligible)}   past RS ${avg((b) => b.meta?.preVolumeCandidates ?? 0)}   ` +
      `passes ${avg((b) => b.passed)}   top reject ${top ? `${top[0]} (${(top[1] / hb.length).toFixed(0)}/bar)` : "—"}`
  );
}

// ── Direction and selections ────────────────────────────────────────────
section("DIRECTION");
const passed = evals.filter((e) => e.passed);
console.log(
  `  passes: ${passed.filter((e) => e.side === "long").length} long · ${passed.filter((e) => e.side === "short").length} short   ` +
    `(evaluated past RS: ${evals.filter((e) => e.side === "long").length} long · ${evals.filter((e) => e.side === "short").length} short)`
);

section("SELECTIONS");
const sel = bars.map((b) => b.meta?.selection).filter(Boolean);
console.log(
  `  ${sel.filter((s) => s.positionId).length} virtual trades opened · ${sel.filter((s) => s.skipped === "already tracked").length} bars where rank 1 was already tracked`
);

// ── Outcomes ────────────────────────────────────────────────────────────
section("OUTCOMES (shadow virtual trades only)");
const row = (label, ts) => {
  const o = outcome(ts);
  const risk = sum(ts, (t) => t.rupeeRisk || 0);
  const grossW = sum(ts.filter((t) => t.grossPnl > 0), (t) => t.grossPnl);
  const grossL = -sum(ts.filter((t) => t.grossPnl < 0), (t) => t.grossPnl);
  console.log(
    `  ${label.padEnd(8)} ${String(o.trades).padStart(3)} trades   win ${pct(o.winRate).padStart(4)}   ${R(o.expectancyR).padStart(7)} avg   ` +
      `${R(sum(ts, (t) => t.rMultiple)).padStart(8)} total   net ${rupees(o.netPnl).padStart(9)}   ` +
      `PF ${grossL ? (grossW / grossL).toFixed(2) : "—"}   charges/risk ${risk ? ((sum(ts, (t) => t.costs) / risk) * 100).toFixed(0) : "—"}%`
  );
};
row("all", trades);
row("slot", trades.filter((t) => t.slotTaken === true));
row("missed", trades.filter((t) => t.slotTaken === false));
for (const t of trades.filter((t) => t.slotTaken === true)) {
  console.log(`    slot: ${hhmm(t.entryTime)} ${t.side} ${t.underlying} → ${t.exitReason} ${R(t.rMultiple)} ${rupees(t.netPnl)}`);
}

section("SCORE FLOORS (this session)");
for (const floor of [0, 0.5, 0.6, 0.7, 0.8]) {
  const ts = trades.filter((t) => (t.features?.score ?? 0) >= floor);
  const o = outcome(ts);
  console.log(
    `  ≥ ${floor.toFixed(2)}   bars ${String(bars.filter((b) => (b.topScore ?? -1) >= floor).length).padStart(3)}   trades ${String(o.trades).padStart(3)}   ` +
      `win ${pct(o.winRate).padStart(4)}   ${R(o.expectancyR).padStart(7)} avg   net ${rupees(o.netPnl)}`
  );
}

// ── Data quality ────────────────────────────────────────────────────────
section("DATA QUALITY");
const metaVals = (k) => [...new Set(bars.map((b) => JSON.stringify(b.meta?.[k] ?? null)))];
console.log(`  ban list: ${metaVals("banStatus").join(", ")} · ${bars[0].meta?.bannedCount ?? 0} names`);
const baseline = bars.find((b) => b.meta?.oiBaselineAt)?.meta.oiBaselineAt;
console.log(`  OI baseline: ${baseline ? hhmm(baseline) : "never captured"}`);
const betaFallback = new Set(evals.filter((e) => e.inputs?.betaFallback).map((e) => e.underlying));
console.log(`  beta fallbacks: ${betaFallback.size ? [...betaFallback].join(", ") : "none"}`);
const norms = {};
for (const e of evals) if (e.inputs?.normSessions != null) norms[e.inputs.normSessions] = (norms[e.inputs.normSessions] || 0) + 1;
console.log(`  volume-norm sessions: ${Object.entries(norms).map(([k, v]) => `${k}×${v}`).join(" ") || "—"}`);
console.log(`  volume check cap hit on ${bars.filter((b) => b.meta?.volumeCapHit).length} bars`);
const spreads = evals.map((e) => e.inputs?.spreadPct).filter(Number.isFinite);
if (spreads.length) {
  console.log(`  spread: avg ${(sum(spreads, (x) => x) / spreads.length).toFixed(3)}% · max ${Math.max(...spreads).toFixed(3)}%`);
}
const basis = trades
  .filter((t) => t.cashPriceAtSignal > 0)
  .map((t) => ({ t, pct: ((t.entryPrice - t.cashPriceAtSignal) / t.cashPriceAtSignal) * 100 }))
  .filter((x) => Math.abs(x.pct) > 0.4);
console.log(
  `  futures vs cash > 0.4% at entry: ${basis.length ? basis.map((x) => `${x.t.underlying} ${x.pct.toFixed(2)}%`).join(", ") : "none"}`
);
const missing = (k) => [...new Set(bars.flatMap((b) => b.meta?.[k] ?? []))];
console.log(`  no daily data: ${missing("noDailyData").join(", ") || "none recorded"}`);
console.log(`  no bar data:   ${missing("noData").join(", ") || "none recorded"}`);
console.log();
