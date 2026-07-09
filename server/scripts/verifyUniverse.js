/**
 * Fetches the Upstox instrument master and prints the derived stock-futures
 * universe. No token required (the master file is public).
 * Run with: npm run verify:universe
 */
import { loadFuturesUniverse } from "../data/instruments.js";
import { EXCLUDE_UNDERLYINGS, EXPIRY_POLICY } from "../config.js";

console.log("Loading Upstox instrument master…");
const contracts = await loadFuturesUniverse();

const underlyings = new Set(contracts.map((c) => c.underlying));
console.log(`\nExpiry policy: ${EXPIRY_POLICY}`);
console.log(`Excluded index underlyings: ${[...EXCLUDE_UNDERLYINGS].join(", ")}`);
console.log(`\nContracts: ${contracts.length}  |  Underlyings: ${underlyings.size}`);

// Confirm index futures are excluded.
const leaked = contracts.filter((c) =>
  EXCLUDE_UNDERLYINGS.has(c.underlying.toUpperCase())
);
console.log(`Index-future leaks (should be 0): ${leaked.length}`);

// Show a sample underlying that has multiple expiries.
const counts = new Map();
for (const c of contracts) counts.set(c.underlying, (counts.get(c.underlying) || 0) + 1);
const multi = [...counts.entries()].find(([, n]) => n > 1);
if (multi) {
  console.log(`\nSample multi-expiry underlying: ${multi[0]} (${multi[1]} contracts)`);
  for (const c of contracts.filter((c) => c.underlying === multi[0])) {
    console.log(`   ${c.key.padEnd(14)}  ${c.label.padEnd(22)}  exp ${c.expiry}`);
  }
}

console.log("\nFirst 8 contracts:");
for (const c of contracts.slice(0, 8)) {
  console.log(`   ${c.key.padEnd(14)}  ${c.label.padEnd(22)}  exp ${c.expiry}`);
}
