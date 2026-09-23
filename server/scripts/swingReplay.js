/**
 * Daily swing test of the "dip and recovery" pattern (see swing/dipRecovery.js).
 *
 *   npm run replay:swing                 all futures stocks, ~2 years of daily candles
 *   npm run replay:swing -- --limit=20   first 20 stocks only (quick check)
 *   npm run replay:swing -- --strategies the three live strategies on daily candles
 *                                        (swing/dailyStrategies.js), held for days
 *   add --older                          also judge the same picks on Jan 2021 – Sept 2024,
 *                                        years no setting was ever chosen on
 *
 * Settings are chosen on the older year (entries before 17 Sept 2025) and
 * judged unchanged on the newer year. Positions are limited by money (at most
 * MAX_OPEN open at once per book, one per stock), not by a daily trade count.
 */
import { loadFuturesUniverse, getUnderlyings, getNearMonthContracts } from "../data/instruments.js";
import { getDailyCandles } from "../data/upstox.js";
import { SWING, VARIANTS, signalAt, simulate, dateOf } from "../swing/dipRecovery.js";
import { DAILY_BOOKS, indicators, dailySignal } from "../swing/dailyStrategies.js";

const NIFTY = "NSE_INDEX|Nifty 50";
const olderMode = process.argv.includes("--older");
const OLDER_FROM = "2021-01-01"; // --older: untouched years, until TUNE_FROM
const FETCH_FROM = olderMode ? "2020-03-01" : "2023-06-01"; // SMA200 needs ~10 months before the first signal
const TUNE_FROM = "2024-09-17"; // older year: entries from here until TEST_FROM
const TEST_FROM = "2025-09-17";
const MAX_OPEN = 10;
const GATE = { minTrades: 100, minAvgR: 0.1, worstMonthR: -10 };
const strategiesMode = process.argv.includes("--strategies");
const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.slice(8)) || null;

const istToday = () => new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
const yesterday = () => new Date(Date.parse(`${istToday()}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const rupees = (x) => `${x < 0 ? "−" : ""}₹${Math.round(Math.abs(x)).toLocaleString("en-IN")}`;
const fmtR = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}R`;

/** Nifty above (long) / below (short) its 50-day average on each date. */
function niftyTrend(nifty) {
  const out = new Map();
  for (let i = 50; i < nifty.length; i++) {
    const avg = nifty.slice(i - 50, i).reduce((a, c) => a + c.close, 0) / 50;
    out.set(dateOf(nifty[i]), nifty[i].close > avg ? "up" : "down");
  }
  return out;
}

/** Money limit: at most MAX_OPEN positions open, one per stock; best scores first. */
function portfolio(trades) {
  const byDay = new Map();
  for (const t of trades) (byDay.get(t.entryDate) ?? byDay.set(t.entryDate, []).get(t.entryDate)).push(t);
  const taken = [];
  let open = [];
  for (const day of [...byDay.keys()].sort()) {
    open = open.filter((t) => t.exitDate >= day);
    for (const t of byDay.get(day).sort((a, b) => b.score - a.score)) {
      if (open.length >= MAX_OPEN || open.some((o) => o.stock === t.stock)) continue;
      open.push(t);
      taken.push(t);
    }
  }
  return taken;
}

function stats(ts) {
  const n = ts.length;
  const total = ts.reduce((a, t) => a + t.r, 0);
  const months = new Map();
  for (const t of ts) months.set(t.exitDate.slice(0, 7), (months.get(t.exitDate.slice(0, 7)) ?? 0) + t.r);
  return {
    n,
    total,
    avg: n ? total / n : 0,
    win: n ? ts.filter((t) => t.r > 0).length / n : 0,
    rupees: ts.reduce((a, t) => a + t.rupees, 0),
    worstMonth: months.size ? Math.min(...months.values()) : 0,
    costR: n ? ts.reduce((a, t) => a + t.costR, 0) / n : 0,
    hold: n ? ts.reduce((a, t) => a + (t.exitIdx - t.entryIdx + 1), 0) / n : 0,
  };
}

async function main() {
  const to = yesterday();
  console.log("loading futures universe…");
  await loadFuturesUniverse();
  let underlyings = getUnderlyings() || [];
  if (limit) underlyings = underlyings.slice(0, limit);
  const lots = getNearMonthContracts();

  console.log(`downloading daily candles ${FETCH_FROM} → ${to} for ${underlyings.length} stocks + Nifty (cached after the first run)…`);
  const t0 = Date.now();
  const nifty = await getDailyCandles(NIFTY, FETCH_FROM, to);
  const trend = niftyTrend(nifty);
  const series = [];
  for (const [n, u] of underlyings.entries()) {
    const candles = await getDailyCandles(u.cashKey, FETCH_FROM, to).catch(() => []);
    if (candles.length > 100) series.push({ stock: u.underlying, candles, lot: lots.get(u.underlying)?.lotSize ?? null });
    if ((n + 1) % 50 === 0) console.log(`  ${n + 1}/${underlyings.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  console.log(`data ready: ${series.length} stocks, Nifty ${nifty.length} days (${Math.round((Date.now() - t0) / 1000)}s)\n`);

  const niftyPct = new Map(nifty.slice(1).map((c, i) => [dateOf(c), ((c.close - nifty[i].close) / nifty[i].close) * 100]));
  for (const s of series) s.ind = strategiesMode ? indicators(s.candles) : null;

  // Each group: a signal on candle i of a stock, and the exit settings to try.
  const defs = strategiesMode
    ? DAILY_BOOKS.flatMap((b) =>
        ["long", "short"].map((side) => ({
          name: `${b.name} — ${side.toUpperCase()}`,
          kind: b.id,
          side,
          signal: (s, i) => dailySignal(b.id, s.candles, s.ind, i, (k) => niftyPct.get(dateOf(s.candles[k] ?? {})) ?? null),
          variants: [
            { stop: "atr", stopAtr: b.exits.stopAtr, exit: "original", ...b.exits, tag: `same exits as live (stop ${b.exits.stopAtr}×ATR, target ${b.exits.targetR}R, ≤20d)` },
            ...VARIANTS.filter((v) => v.stop === "atr2"),
          ],
        }))
      )
    : ["pattern", "baseline"].flatMap((kind) =>
        ["long", "short"].map((side) => ({
          name: `${kind === "pattern" ? "DIP & RECOVERY" : "BASELINE (strong candle, no dip)"} — ${side.toUpperCase()}`,
          kind,
          side,
          signal: (s, i) => signalAt(s.candles, i, kind),
          variants: VARIANTS,
        }))
      );

  const groups = [];
  for (const def of defs) {
    const { side } = def;
    const books = [];
    for (const v of def.variants) {
      for (const market of ["any", "with Nifty"]) {
        const trades = [];
        for (const s of series) {
          for (let i = 1; i < s.candles.length - 1; i++) {
            const sig = def.signal(s, i);
            if (!sig || sig.side !== side) continue;
            if (market === "with Nifty" && trend.get(dateOf(s.candles[i])) !== (side === "long" ? "up" : "down")) continue;
            const t = simulate(s.candles, i, side, v);
            if (!t || t.entryDate < (olderMode ? OLDER_FROM : TUNE_FROM)) continue;
            const dir = side === "long" ? 1 : -1;
            const lot = s.lot ?? 0;
            trades.push({ ...t, stock: s.stock, score: sig.score, rupees: lot * (dir * (t.exit - t.entry) - t.entry * SWING.costPct), notional: lot * t.entry });
          }
        }
        // Separate books for the untouched years and for tune + test, so the older
        // run can't change the tune/test numbers through positions carried across.
        const taken = portfolio(trades.filter((t) => t.entryDate >= TUNE_FROM));
        const olderTaken = portfolio(trades.filter((t) => t.entryDate < TUNE_FROM));
        books.push({
          older: stats(olderTaken),
          olderTrades: olderTaken,
          tag: `${v.tag}, market ${market}`,
          signals: trades.length,
          tune: stats(taken.filter((t) => t.entryDate < TEST_FROM)),
          test: stats(taken.filter((t) => t.entryDate >= TEST_FROM)),
          testTrades: taken.filter((t) => t.entryDate >= TEST_FROM),
        });
      }
    }
    groups.push({ ...def, books });
  }

  const row = (s) => `${String(s.n).padStart(4)} trades ${fmtR(s.avg).padStart(7)}/trade ${fmtR(s.total).padStart(9)} win ${(s.win * 100).toFixed(0).padStart(2)}%`;
  console.log(`Older year (entries ${TUNE_FROM} → ${TEST_FROM}) picks the settings; newer year judges them. At most ${MAX_OPEN} positions open per book.`);
  const chosen = [];
  for (const g of groups) {
    console.log(`\n${g.name}`);
    console.log(`  ${"settings".padEnd(58)} | older year (tuning)                     | newer year (test)${olderMode ? "                       | 2021 – Sept 2024 (untouched)" : ""}`);
    const eligible = g.books.filter((b) => b.tune.n >= 50);
    const best = (eligible.length ? eligible : g.books).reduce((a, b) => (b.tune.avg > a.tune.avg ? b : a));
    for (const b of g.books) console.log(`${b === best ? "→" : " "} ${b.tag.padEnd(58)} | ${row(b.tune)} | ${row(b.test)}${olderMode ? ` | ${row(b.older)}` : ""}`);
    chosen.push({ g, b: best });
  }

  const judged = olderMode ? "older" : "test";
  const judgedTrades = olderMode ? "olderTrades" : "testTrades";
  console.log(
    olderMode
      ? `\nVERDICT — untouched years (${OLDER_FROM} → ${TUNE_FROM}), same settings picked on the older year`
      : `\nVERDICT — newer year (${TEST_FROM} → ${to}), settings picked on the older year`
  );
  if (olderMode) {
    const inYear = (y) => nifty.filter((c) => dateOf(c).startsWith(String(y)));
    const moves = [2021, 2022, 2023, 2024, 2025, 2026].map((y) => {
      const c = inYear(y);
      return c.length ? `${y} ${(((c.at(-1).close - c[0].open) / c[0].open) * 100).toFixed(0)}%` : null;
    });
    console.log(`  Nifty by year: ${moves.filter(Boolean).join(" · ")}`);
  }
  console.log(`  gate: profit after charges, ≥ ${GATE.minAvgR}R per trade, ≥ ${GATE.minTrades} trades, worst month ≥ ${GATE.worstMonthR}R`);
  for (const { g, b } of chosen) {
    const s = b[judged];
    const checks = [
      ["profit", s.total > 0],
      [`avg ≥ ${GATE.minAvgR}R`, s.avg >= GATE.minAvgR],
      [`≥ ${GATE.minTrades} trades`, s.n >= GATE.minTrades],
      [`worst month ≥ ${GATE.worstMonthR}R`, s.worstMonth >= GATE.worstMonthR],
    ];
    const pass = checks.every(([, ok]) => ok);
    const exits = {};
    const ts = b[judgedTrades];
    for (const t of ts) exits[t.reason] = (exits[t.reason] ?? 0) + 1;
    const notional = ts.length ? ts.reduce((a, t) => a + t.notional, 0) / ts.length : 0;
    console.log(`\n  ${pass ? "PASS" : "FAIL"}  ${g.name}`);
    console.log(`        settings: ${b.tag}`);
    console.log(`        ${row(s)} · worst month ${fmtR(s.worstMonth)} · charges ${s.costR.toFixed(2)}R/trade · avg hold ${s.hold.toFixed(1)} days`);
    console.log(`        1 lot per trade: ${rupees(s.rupees)} net · avg position ${rupees(notional)} (margin roughly a fifth of that)`);
    console.log(`        exits: ${Object.entries(exits).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
    console.log(`        ${checks.map(([k, ok]) => `${ok ? "✓" : "✗"} ${k}`).join("  ")}`);
    if (olderMode) {
      const years = new Map();
      const months = new Map();
      for (const t of ts) {
        const y = t.entryDate.slice(0, 4);
        if (!years.has(y)) years.set(y, []);
        years.get(y).push(t);
        months.set(t.exitDate.slice(0, 7), (months.get(t.exitDate.slice(0, 7)) ?? 0) + t.r);
      }
      const perYear = [...years].sort().map(([y, list]) => {
        const x = stats(list);
        return `${y} ${x.n} trades ${fmtR(x.avg)}/trade ${fmtR(x.total)}`;
      });
      console.log(`        by year: ${perYear.join(" · ")}`);
      console.log(`        losing months: ${[...months.values()].filter((x) => x < 0).length} of ${months.size}`);
    }
  }
  const pl = chosen.find((c) => c.g.kind === "pattern" && c.g.side === "long")?.b.test;
  const bl = chosen.find((c) => c.g.kind === "baseline" && c.g.side === "long")?.b.test;
  if (pl && bl && !strategiesMode) console.log(`\nDoes the dip matter (longs, newer year)? with dip ${fmtR(pl.avg)}/trade vs without ${fmtR(bl.avg)}/trade`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
