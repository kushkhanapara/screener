/**
 * Print the trade review to the terminal.
 *
 *   npm run report                 last 7 days, all strategies
 *   npm run report -- 30           last 30 days
 *   npm run report -- all momentum-surge
 */
import * as store from "../paper/store.js";
import { buildReport } from "../paper/report.js";

const [daysArg, strategyId] = process.argv.slice(2);
const days = daysArg === "all" ? null : Number(daysArg) || 7;

store.init();
const r = buildReport(store.tradesChronological({ runId: store.LIVE_RUN_ID }), {
  days,
  strategyId: strategyId || null,
});
store.close();

const rupees = (v) => `${v < 0 ? "−" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
const R = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}R`;
const pct = (v) => `${Math.round(v * 100)}%`;

console.log(`\nTRADE REVIEW — ${r.window.label}${r.strategyId ? ` — ${r.strategyId}` : ""}`);
console.log("─".repeat(72));
console.log(
  `${r.counts.real} real trades   win ${pct(r.summary.winRate)}   expectancy ${R(r.summary.expectancyR)}   ` +
    `total ${R(r.summary.totalR)}   net ${rupees(r.summary.netPnl)}`
);
console.log(
  `charges ${rupees(r.summary.totalCosts)}   ${r.counts.excludedJunk} churn trades excluded (${rupees(r.counts.junkCosts)} in charges)   ` +
    `${r.counts.withFeatures} with entry data`
);

if (!r.strategyId && r.families.some((f) => f.selective.trades > 0)) {
  console.log("\nSELECTIVE VS ORIGINAL (same signal and exits; the gap is the quality bar)");
  for (const f of r.families) {
    for (const [tag, s] of [["original ", f.original], ["selective", f.selective]]) {
      console.log(
        `  ${f.family.padEnd(24)} ${tag}  ${String(s.trades).padStart(3)} trades (${s.tradesPerDay.toFixed(1)}/day)   ` +
          `win ${pct(s.winRate).padStart(4)}   ${R(s.expectancyR).padStart(7)} avg   net ${rupees(s.netPnl).padStart(9)}   ` +
          `charges ${rupees(s.costs)}`
      );
    }
  }
}

console.log("\nFINDINGS");
if (!r.findings.length) console.log("  nothing stands out");
for (const f of r.findings) {
  const tag = { warn: "[!]", good: "[+]", info: "[i]" }[f.severity];
  console.log(`  ${tag} ${f.title}`);
  console.log(`      ${f.detail}`);
}

for (const b of r.breakdowns) {
  console.log(`\n${b.label.toUpperCase()}`);
  for (const row of b.rows) {
    const thin = row.trades < r.minSample ? "  (too few)" : "";
    console.log(
      `  ${String(row.bucket).padEnd(16)} ${String(row.trades).padStart(3)} trades   win ${pct(row.winRate).padStart(4)}   ` +
        `${R(row.expectancyR).padStart(7)} avg   ${R(row.totalR).padStart(7)} total   ${rupees(row.netPnl).padStart(10)}${thin}`
    );
  }
}
console.log();
