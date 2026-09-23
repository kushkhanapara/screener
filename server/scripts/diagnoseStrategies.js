/**
 * Why is a strategy (not) firing?
 *
 * Replays recent cached candles and reports the DISTRIBUTION of the values the
 * strategies gate on, plus how many names clear each threshold. A strategy with
 * zero signals is either admirably selective or quietly broken, and the only way
 * to tell them apart is to see which specific threshold rejects everything.
 *
 *   node server/scripts/diagnoseStrategies.js [nameCount]
 */
import { loadFuturesUniverse, getUnderlyings } from "../data/instruments.js";
import { seedWindow } from "../live/seed.js";
import { buildContext, atrPct } from "../strategies/context.js";
import { list as listStrategies } from "../strategies/index.js";
import * as daily from "../services/dailyService.js";
import { HAS_TOKEN } from "../config.js";

if (!HAS_TOKEN) {
  console.error("UPSTOX_ANALYTICS_TOKEN not set.");
  process.exit(1);
}

const istDate = (back = 0) =>
  new Date(Date.now() + 19800000 - back * 86400000).toISOString().slice(0, 10);

const LIMIT = Number(process.argv[2]) || 50;

await loadFuturesUniverse();
const underlyings = (getUnderlyings() || []).slice(0, LIMIT);
console.log(`Evaluating ${underlyings.length} underlyings from cached candles…`);

await daily.refresh();

const indexBars = await seedWindow("NSE_INDEX|Nifty 50", 3, 8).catch(() => []);

const strategies = listStrategies();
const signals = new Map(strategies.map((s) => [s.id, { long: 0, short: 0 }]));
const rows = [];

for (const u of underlyings) {
  const bars3 = await seedWindow(u.cashKey, 3, 8).catch(() => []);
  const bars15 = await seedWindow(u.cashKey, 15, 21).catch(() => []);
  if (bars3.length < 60) continue;

  const ctx = buildContext({
    underlying: u.underlying,
    cashKey: u.cashKey,
    bars3m: bars3,
    bars15m: bars15,
    indexBars3m: indexBars,
    daily: daily.getDailyStats(u.underlying),
    now: Date.now(),
  });

  rows.push({
    name: u.underlying,
    pctOpen: ctx.pctFromOpen,
    gap: ctx.gapPct,
    rsi15: ctx.intradayRsi?.["15m"],
    hist15: ctx.emaMacd?.["15m"]?.hist,
    vol: ctx.sessionVolume,
    rs: ctx.relStrength,
    atrPct: atrPct(ctx.atr?.["3m"], ctx.rows?.["3m"]?.latest?.close),
    hasDaily: Boolean(ctx.daily),
  });

  for (const s of strategies) {
    const res = s.evaluate(ctx);
    if (res.side) signals.get(s.id)[res.side]++;
  }
}

const n = rows.length;
const count = (fn) => rows.filter(fn).length;
const pad = (v, w = 5) => String(v).padStart(w);
const pct = (c) => `${pad(c, 3)}/${n}`;

console.log(`\n=== Context values across ${n} names ===`);
console.log(`  intraday move > +1.2% from open   ${pct(count((r) => r.pctOpen > 1.2))}`);
console.log(`  intraday move < -1.2% from open   ${pct(count((r) => r.pctOpen < -1.2))}`);
console.log(`  15m RSI available                 ${pct(count((r) => r.rsi15 != null))}`);
console.log(`  15m RSI < 68                      ${pct(count((r) => r.rsi15 != null && r.rsi15 < 68))}`);
console.log(`  15m MACD hist available           ${pct(count((r) => r.hist15 != null))}`);
console.log(`  15m MACD hist > 0                 ${pct(count((r) => r.hist15 > 0))}`);
console.log(`  session volume >= 250k            ${pct(count((r) => r.vol >= 250_000))}`);
console.log(`  daily stats present (gap guard)   ${pct(count((r) => r.hasDaily))}`);
console.log(`  relative strength available       ${pct(count((r) => r.rs != null))}`);
console.log(`  3m ATR >= 0.12% of price          ${pct(count((r) => r.atrPct >= 0.12))}`);

const moves = rows.map((r) => r.pctOpen).filter(Number.isFinite).sort((a, b) => a - b);
if (moves.length) {
  const q = (p) => moves[Math.floor(p * (moves.length - 1))].toFixed(2);
  console.log(
    `\n  move-from-open distribution: min ${q(0)}%  p25 ${q(0.25)}%  median ${q(0.5)}%  p75 ${q(0.75)}%  max ${q(1)}%`
  );
}
const vols = rows.map((r) => r.vol).filter(Number.isFinite).sort((a, b) => a - b);
if (vols.length) {
  const q = (p) => Math.round(vols[Math.floor(p * (vols.length - 1))]).toLocaleString("en-IN");
  console.log(`  session volume distribution: min ${q(0)}  median ${q(0.5)}  max ${q(1)}`);
}

console.log(`\n=== Signals ===`);
for (const s of strategies) {
  const g = signals.get(s.id);
  console.log(`  ${s.name.padEnd(26)} long ${pad(g.long, 3)}   short ${pad(g.short, 3)}`);
}

const top = rows
  .filter((r) => Number.isFinite(r.pctOpen))
  .sort((a, b) => Math.abs(b.pctOpen) - Math.abs(a.pctOpen))
  .slice(0, 8);
console.log(`\n=== Biggest movers today ===`);
console.log(`  name           move%    gap%   15mRSI  15mHist      volume`);
for (const r of top) {
  console.log(
    `  ${r.name.padEnd(14)}${pad(r.pctOpen?.toFixed(2), 6)}  ${pad(r.gap?.toFixed(2) ?? "—", 6)}  ` +
      `${pad(r.rsi15?.toFixed(1) ?? "—", 6)}  ${pad(r.hist15?.toFixed(3) ?? "—", 7)}  ` +
      `${pad(Math.round(r.vol).toLocaleString("en-IN"), 11)}`
  );
}
