/**
 * Replay the PAPER strategies over cached history — originals beside their
 * Selective versions — to check the quality bar on days other than the one it
 * was read from. Shadow logging is not replayed; it is a separate book.
 *
 *   npm run replay                  every cached session after the warm-up days
 *   npm run replay -- --today       also fetch today's intraday bars (≈420 API calls)
 *   npm run replay -- --days=2026-09-15,2026-09-11   only these sessions
 *   npm run replay -- --from=2026-08-14   fetch history from this date (≈1,300 API calls, cached)
 *   npm run replay -- --selective   also replay the Selective variants
 *   npm run replay -- --daytype     day-type switch: 15 Sept rules vs momentum on
 *                                   trend days only vs VWAP Snap-back on flat days,
 *                                   tuned on the first half, tested on the second
 *   npm run replay -- --year        12 months (17 Sept 2025 – yesterday), a month at a
 *                                   time; judged on the untouched months 17 Sept 2025 –
 *                                   31 Jan 2026. Add --stop-at=08:00 to stop by then,
 *                                   or --download-only to fetch the history and exit.
 *   npm run replay -- --year --research    the research strategies (strategies/research.js)
 *                                   over the same 12 months, judged the same way
 *   npm run replay -- --daytype --tf15     momentum strategies on 15-minute bars vs
 *                                   3-minute bars (both trend days only)
 *   npm run replay -- --daytype --orfade   same split test for Opening Range Fade
 *                                   (flat-day candidate) instead of VWAP Snap-back
 *
 * By default it replays the originals beside "trend-day" versions (dayType.js)
 * that only trade when Nifty is clearly moving one way.
 *
 * Same code as live wherever it matters: buildContext → strategy.evaluate →
 * entriesAllowed / regimeAllows / canAfford / selectionVeto → engine exits via
 * applyBar (which runs the bar-close rules). Differences, stated plainly:
 *   - fills are the next CASH bar's open (no futures history is cached), so
 *     basis is ignored;
 *   - charges are a flat 0.065% of notional — what real Upstox-calibrated
 *     charges came to on 15 Sept; the built-in estimate understates STT;
 *   - stops and targets are checked on bar ranges (pessimistically), not ticks.
 * So compare originals with Selective here; don't read the rupees as live.
 *
 * Writes only to PAPER_DB_PATH (default data/replay.db) — never screener.db.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "../paper/store.js";
import * as candleCache from "../data/candleCache.js";
import { loadFuturesUniverse, getUnderlyings, getNearMonthContracts } from "../data/instruments.js";
import { getIntradayCandles, getHistoricalCandles, getDailyCandles } from "../data/upstox.js";
import { dayTrend, trendDayVeto, dayTypeVeto, classifyDay, DAY_TYPE } from "../paper/dayType.js";
import { vwapSnapback } from "../strategies/vwapSnapback.js";
import { openingRangeFade } from "../strategies/openingRangeFade.js";
import { RESEARCH_BOOKS } from "../strategies/research.js";
import { dailyStatsFrom } from "../services/dailyService.js";
import { list as listStrategies, familyOf, selectiveVariants } from "../strategies/index.js";
import { buildContext, regimeAllows } from "../strategies/context.js";
import * as engine from "../paper/engine.js";
import { canAfford, deployedCapital } from "../paper/capital.js";
import { extractFeatures } from "../paper/features.js";
import {
  SELECTION,
  alignedRsOf,
  stopPctOf,
  qualityOf,
  selectionVeto,
  createDayState,
  noteClose,
  createConfluence,
} from "../paper/selection.js";
import { istDateString, istMinutes } from "../core/session.js";
import { CAPITAL_PER_STRATEGY } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NIFTY = "NSE_INDEX|Nifty 50";
const BAR3 = 3 * 60 * 1000;
const BAR15 = 15 * 60 * 1000;
const MAX_BARS = 500; // same window the live store keeps
const WARMUP_SESSIONS = 2;
const FLAT_COST_PCT = 0.00065;

// Cached seed ranges on disk (ranges ending before today never expire).
const RANGES_3M = [["2026-09-03", "2026-09-10"], ["2026-09-04", "2026-09-11"], ["2026-09-07", "2026-09-14"]];
const RANGES_15M = [["2026-08-21", "2026-09-10"], ["2026-08-22", "2026-09-11"], ["2026-08-25", "2026-09-14"]];
const RANGE_DAILY = ["2025-08-10", "2026-09-14"];

const withToday = process.argv.includes("--today");
const onlyDays = process.argv.find((a) => a.startsWith("--days="))?.slice(7).split(",").filter(Boolean) ?? null;
const historyFrom = process.argv.find((a) => a.startsWith("--from="))?.slice(7) ?? null;
const withSelective = process.argv.includes("--selective");
const dayTypeMode = process.argv.includes("--daytype");

// Split test for --daytype: settings are chosen on the tuning half only, then
// judged unchanged on the test half.
const TUNE_LAST_DAY = "2026-09-02";
const SNAPBACK_GRID = [2.0, 2.5, 3.0].flatMap((stretchAtr) =>
  [1.0, 1.5, 2.0].map((targetR) => vwapSnapback({ id: `vwap-snapback@stretch${stretchAtr}-target${targetR}`, stretchAtr, targetR }))
);
const orFadeMode = process.argv.includes("--orfade");
const tf15Mode = process.argv.includes("--tf15");
const yearMode = process.argv.includes("--year");
const researchMode = process.argv.includes("--research");
const YEAR_FROM = "2025-09-17";
const UNTOUCHED_LAST_DAY = "2026-01-31"; // no rule was ever tuned on these months
const STOP_AT = process.argv.find((a) => a.startsWith("--stop-at="))?.slice(10) ?? null; // "HH:MM" IST
const YEAR_GATE = { minTrades: 100, minAvgR: 0.1, worstDayR: -5 };
const trendVariantOf = (base, tag, minMovePct, minEfficiency) => ({
  ...base,
  id: `${base.id}@${tag}`,
  family: base.id,
  dayTypes: ["trend"],
  dayTypeCfg: { ...DAY_TYPE, trend: { minMovePct, minEfficiency } },
  variantOf: base.id,
});
// Same rules on 15-minute bars: checked only when a 15-minute bar closes, with
// the stop and trail sized on the 15-minute ATR. Exits are still watched on
// every 3-minute bar, as live watches every tick.
const tf15Of = (base) => ({
  ...base,
  id: `${base.id}@15m-trend-only`,
  family: `${base.id}@15m`,
  dayTypes: ["trend"],
  tf15: true,
  variantOf: base.id,
});
const ORFADE_GRID = [1.0, 1.5].flatMap((stopAtr) =>
  [1.0, 1.5, 2.0].map((targetR) => openingRangeFade({ id: `opening-range-fade@stop${stopAtr}-target${targetR}`, stopAtr, targetR }))
);
const FLAT_GRID = orFadeMode ? ORFADE_GRID : SNAPBACK_GRID;
const FLAT_NAME = orFadeMode ? "OPENING RANGE FADE" : "VWAP SNAP-BACK";
const trendOnlyOf = (base) => ({ ...base, id: `${base.id}@trend-only`, family: base.id, dayTypes: ["trend"], variantOf: base.id });
const GATE = { minTrades: 30, minAvgR: 0.1, worstDayR: -5 };

const istDateOffset = (isoDate, days) =>
  new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const YESTERDAY = istDateOffset(new Date(Date.now() + 19_800_000).toISOString().slice(0, 10), -1);

// Trend-day settings to test beside the unfiltered originals.
const DAY_FILTERS = [
  { tag: "trend: move≥0.3%", cfg: { minBars: 10, minMovePct: 0.3, minEfficiency: 0 } },
  { tag: "trend: move≥0.5%", cfg: { minBars: 10, minMovePct: 0.5, minEfficiency: 0 } },
  { tag: "trend: move≥0.3% eff≥0.3", cfg: { minBars: 10, minMovePct: 0.3, minEfficiency: 0.3 } },
  { tag: "trend: move≥0.4% eff≥0.4", cfg: { minBars: 10, minMovePct: 0.4, minEfficiency: 0.4 } },
];
const dayFilterVariantsOf = (base) =>
  DAY_FILTERS.map((f) => ({ ...base, id: `${base.id}@${f.tag}`, dayFilter: f.cfg, variantOf: base.id }));

// Extra Selective settings to replay alongside v1, to see where the bar belongs.
const RS_GRID = [0.5, 1.0, 2.0];
const variantsOf = (base) => [
  ...RS_GRID.map((rs) => ({ tag: `rs≥${rs}`, cfg: { ...SELECTION, minAlignedRsPct: rs } })),
  { tag: `rs≥${SELECTION.minAlignedRsPct} retry`, cfg: { ...SELECTION, noRetryAfterLoss: false } },
].map((v) => ({ ...base, id: `${base.id}@${v.tag}`, selection: v.cfg, variantOf: base.id }));

// ── Data ────────────────────────────────────────────────────────────────

const toBar = (bucketMs) => (c) => {
  const t = new Date(c.time).getTime();
  return {
    time: Math.floor(t / bucketMs) * bucketMs,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume || 0,
  };
};

function mergeBars(lists, bucketMs) {
  const byTime = new Map();
  for (const list of lists) for (const c of list ?? []) {
    const b = toBar(bucketMs)(c);
    if (Number.isFinite(b.close)) byTime.set(b.time, b);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function cached(key, unit, interval, [from, to]) {
  return candleCache.read([key, unit, String(interval), from, to], to) ?? [];
}

async function loadSeries(key) {
  const today3 = withToday ? await getIntradayCandles(key, "minutes", 3).catch(() => []) : [];
  const today15 = withToday ? await getIntradayCandles(key, "minutes", 15).catch(() => []) : [];
  if (historyFrom) {
    // Upstox caps minute ranges at about a month per request, so 15m history
    // (needed for the 200-bar average) comes in two pieces.
    const early = istDateOffset(historyFrom, -30);
    const [h3, h15a, h15b, daily] = await Promise.all([
      getHistoricalCandles(key, "minutes", 3, historyFrom, YESTERDAY).catch(() => []),
      getHistoricalCandles(key, "minutes", 15, early, istDateOffset(historyFrom, -1)).catch(() => []),
      getHistoricalCandles(key, "minutes", 15, historyFrom, YESTERDAY).catch(() => []),
      getDailyCandles(key, istDateOffset(historyFrom, -400), YESTERDAY).catch(() => []),
    ]);
    return {
      b3: mergeBars([h3, today3], BAR3),
      b15: mergeBars([h15a, h15b, today15], BAR15),
      daily,
    };
  }
  return {
    b3: mergeBars([...RANGES_3M.map((r) => cached(key, "minutes", 3, r)), today3], BAR3),
    b15: mergeBars([...RANGES_15M.map((r) => cached(key, "minutes", 15, r)), today15], BAR15),
    daily: cached(key, "days", 1, RANGE_DAILY),
  };
}

/** Index of the last element with time <= t (bars sorted ascending). */
function lastIndexAtOrBefore(bars, t, hint = 0) {
  let i = Math.min(hint, bars.length - 1);
  while (i + 1 < bars.length && bars[i + 1].time <= t) i++;
  while (i >= 0 && bars[i].time > t) i--;
  return i;
}

// ── 12-month history, a month at a time ────────────────────────────────

const istTimeNow = () => new Date(Date.now() + 19_800_000).toISOString().slice(11, 16);

/** The next moment the IST clock reads HH:MM, as an absolute time (never "earlier today"). */
function nextIstTime(hhmm, now = Date.now()) {
  const today = new Date(now + 19_800_000).toISOString().slice(0, 10);
  let at = Date.parse(`${today}T${hhmm}:00+05:30`);
  if (at <= now) at += 86_400_000;
  return at;
}
const STOP_AT_MS = STOP_AT ? nextIstTime(STOP_AT) : null;

/** 15-minute bars built from 3-minute bars, aligned to the 9:15 open like Upstox's own. */
function aggregate15(b3) {
  const out = new Map();
  for (const b of b3) {
    const bucket = b.time - ((((istMinutes(b.time) - (9 * 60 + 15)) % 15) + 15) % 15) * 60_000;
    const cur = out.get(bucket);
    if (!cur) out.set(bucket, { time: bucket, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

/** Fixed ≤30-day chunks, so the cache keys stay the same across runs. */
function monthChunks(from, to) {
  const chunks = [];
  for (let start = from; start <= to; start = istDateOffset(start, 30)) {
    const end = istDateOffset(start, 29) < to ? istDateOffset(start, 29) : to;
    // Upstox's limit is one CALENDAR month (e.g. 23 Feb → 23 Mar), so a 30-day
    // piece that starts late in February is rejected. Split just those in two;
    // every other piece keeps its range, so its saved download is reused.
    const [y, m, d] = start.split("-").map(Number);
    const oneMonthOn = new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
    if (end > oneMonthOn) {
      const mid = istDateOffset(start, 14);
      chunks.push([start, mid], [istDateOffset(mid, 1), end]);
    } else {
      chunks.push([start, end]);
    }
  }
  return chunks;
}

async function prepareYear(underlyings) {
  const fetchFrom = istDateOffset(YEAR_FROM, -21); // warm-up for 200-bar averages
  const chunks = monthChunks(fetchFrom, YESTERDAY);
  const keys = [NIFTY, ...underlyings.map((u) => u.cashKey)];
  console.log(`downloading 3-minute history ${fetchFrom} → ${YESTERDAY}: ${keys.length} instruments × ${chunks.length} chunks (cached after the first run)…`);
  let done = 0;
  const t0 = Date.now();
  for (const key of keys) {
    for (const [a, b] of chunks) await getHistoricalCandles(key, "minutes", 3, a, b).catch(() => []);
    if (++done % 25 === 0) console.log(`  history: ${done}/${keys.length} instruments (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  const daily = new Map();
  for (const u of underlyings) {
    daily.set(u.cashKey, await getDailyCandles(u.cashKey, istDateOffset(YEAR_FROM, -400), YESTERDAY).catch(() => []));
  }
  console.log(`history ready (${Math.round((Date.now() - t0) / 1000)}s)`);

  const loadRange = async (key, from, to) => {
    const parts = [];
    for (const [a, b] of chunks) {
      if (b < from || a > to) continue;
      parts.push(await getHistoricalCandles(key, "minutes", 3, a, b).catch(() => []));
    }
    return mergeBars(parts, BAR3).filter((x) => {
      const d = istDateString(x.time);
      return d >= from && d <= to;
    });
  };

  // One window per calendar month, each loaded with three weeks of warm-up.
  const windows = [];
  for (let m = YEAR_FROM.slice(0, 7); `${m}-01` <= YESTERDAY; ) {
    const [y, mo] = m.split("-").map(Number);
    const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
    const start = `${m}-01` < YEAR_FROM ? YEAR_FROM : `${m}-01`;
    const end = istDateOffset(`${next}-01`, -1) < YESTERDAY ? istDateOffset(`${next}-01`, -1) : YESTERDAY;
    const label = m;
    windows.push({
      label,
      load: async () => {
        const from = istDateOffset(start, -21);
        const idx3 = await loadRange(NIFTY, from, end);
        const index = { b3: idx3, b15: aggregate15(idx3), daily: [] };
        const series = new Map();
        for (const u of underlyings) {
          const b3 = await loadRange(u.cashKey, from, end);
          if (b3.length) series.set(u.underlying, { b3, b15: aggregate15(b3), daily: daily.get(u.cashKey) ?? [] });
        }
        const days = [...new Set(idx3.map((b) => istDateString(b.time)))].filter((d) => d >= start && d <= end).sort();
        return { index, series, days };
      },
    });
    m = next;
  }
  return windows;
}

function reportYear(results, days, originals, dayTypeLog, partial) {
  const books = researchMode
    ? RESEARCH_BOOKS.map((s) => [s.name, (id) => id === s.id])
    : [
    ["15 Sept rules (any day)", (id) => !id.includes("@")],
    ["Trend days 0.4 (live now)", (id) => id.endsWith("@trend-only") && !id.includes("@15m")],
    ["Trend days 0.3", (id) => id.endsWith("@trend-0.3")],
    ["Trend days 0.5", (id) => id.endsWith("@trend-0.5")],
    ["15-minute, trend days 0.4", (id) => id.endsWith("@15m-trend-only")],
  ];
  const untouched = days.filter((d) => d <= UNTOUCHED_LAST_DAY);
  const later = days.filter((d) => d > UNTOUCHED_LAST_DAY);
  const inDays = (ts, ds) => ts.filter((t) => ds.includes(t.day));

  console.log(`\n12-MONTH REPLAY${partial ? " — PARTIAL (stopped early)" : ""}: ${days[0]} → ${days[days.length - 1]}, ${days.length} sessions`);
  console.log("Caveats: today's F&O stock list and lot sizes are used for the whole year; fills at the next 3-minute open; flat 0.065% charges.");

  const months = [...new Set(days.map((d) => d.slice(0, 7)))];
  console.log("\nTYPE OF DAY BY MONTH (at 3:00 PM)");
  for (const m of months) {
    const ds = days.filter((d) => d.startsWith(m));
    const count = (pred) => ds.filter((d) => pred(dayTypeLog.get(d)?.final ?? "")).length;
    console.log(`  ${m}  ${String(ds.length).padStart(2)} days: trend ${count((t) => t.startsWith("trend"))} · flat ${count((t) => t === "flat")} · unclear ${count((t) => t === "unclear")}`);
  }

  console.log("\nBY MONTH — total R (trades) per book");
  console.log(`  ${"month".padEnd(9)}${books.map(([l]) => l.slice(0, 22).padStart(24)).join("")}`);
  for (const m of months) {
    const ts = results.filter((t) => t.day.startsWith(m));
    console.log(
      `  ${m.padEnd(9)}${books
        .map(([, match]) => {
          const b = ts.filter((t) => match(t.strategyId));
          return `${R(b.reduce((a, t) => a + t.rMultiple, 0))} (${b.length})`.padStart(24);
        })
        .join("")}`
    );
  }

  for (const [label, ds] of [
    [`UNTOUCHED MONTHS (${untouched[0] ?? "—"} → ${untouched[untouched.length - 1] ?? "—"}) — the honest test`, untouched],
    [`LATER MONTHS (${later[0] ?? "—"} → ${later[later.length - 1] ?? "—"})`, later],
    ["WHOLE YEAR", days],
  ]) {
    console.log(`\n${label}`);
    for (const [name, match] of books) {
      const st = stats(inDays(results.filter((t) => match(t.strategyId)), ds));
      console.log(
        `  ${name.padEnd(28)} ${String(st.n).padStart(5)} trades  win ${String(Math.round(st.winRate * 100)).padStart(2)}%  ${R(st.avgR).padStart(7)} avg  ${R(st.sumR).padStart(9)}  ${rupees(st.net).padStart(12)}  worst day ${R(st.worstDayR)}`
      );
    }
  }

  if (researchMode) {
    console.log("\nCHARGES AND RISK PER TRADE — whole year");
    for (const [name, match] of books) {
      const ts = results.filter((t) => match(t.strategyId));
      if (!ts.length) continue;
      const risk = ts.reduce((a, t) => a + t.rupeeRisk, 0) / ts.length;
      const chargeR = ts.reduce((a, t) => a + t.costs / t.rupeeRisk, 0) / ts.length;
      const exits = {};
      for (const t of ts) exits[t.exitReason] = (exits[t.exitReason] || 0) + 1;
      console.log(`  ${name.padEnd(28)} risk ${rupees(risk)} · charges ${chargeR.toFixed(2)}R · exits ${Object.entries(exits).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    }
  }
  if (!researchMode) console.log("\nPER STRATEGY — untouched months");
  for (const [name, match] of researchMode ? [] : books) {
    console.log(`  ${name}`);
    for (const o of originals) {
      const st = stats(inDays(results.filter((t) => match(t.strategyId) && t.strategyId.split("@")[0] === o.id), untouched));
      console.log(`      ${o.id.padEnd(24)} ${String(st.n).padStart(5)} trades ${R(st.avgR).padStart(7)} avg ${R(st.sumR).padStart(9)} ${rupees(st.net).padStart(12)}`);
    }
  }

  console.log("\nVERDICT on the untouched months (profit after charges, ≥ +0.1R avg, ≥ 100 trades, worst day ≥ −5R)");
  for (const [name, match] of books) {
    const st = stats(inDays(results.filter((t) => match(t.strategyId)), untouched));
    const checks = [st.net > 0, st.avgR >= YEAR_GATE.minAvgR, st.n >= YEAR_GATE.minTrades, st.worstDayR >= YEAR_GATE.worstDayR];
    console.log(`  ${checks.every(Boolean) ? "PASS" : "FAIL"}  ${name.padEnd(28)} (${checks.map((c) => (c ? "✓" : "✗")).join(" ")})`);
  }
}

// ── Replay ──────────────────────────────────────────────────────────────

async function main() {
  const dbPath = process.env.PAPER_DB_PATH || path.resolve(__dirname, "../../data/replay.db");
  if (path.basename(dbPath) === "screener.db") throw new Error("refusing to write a replay into screener.db");

  console.log("loading futures universe…");
  await loadFuturesUniverse();
  const underlyings = getUnderlyings() || [];
  const contracts = getNearMonthContracts();

  let index = null;
  let series = new Map();
  let days = [];
  let windows;
  if (yearMode) {
    windows = await prepareYear(underlyings);
    if (process.argv.includes("--download-only")) {
      console.log("download complete — run `npm run replay:year` to replay it");
      process.exit(0);
    }
  } else {
    console.log(`loading cached candles for ${underlyings.length} underlyings${withToday ? " (+ today from the API)" : ""}…`);
    index = await loadSeries(NIFTY);
    for (const u of underlyings) {
      const s = await loadSeries(u.cashKey);
      if (s.b3.length) series.set(u.underlying, s);
    }
    const sessions = [...new Set(index.b3.map((b) => istDateString(b.time)))].sort();
    days = sessions.slice(WARMUP_SESSIONS).filter((d) => !onlyDays || onlyDays.includes(d));
    console.log(`sessions cached: ${sessions.join(", ")} → replaying ${days.join(", ")}`);
    windows = [{ label: "all", load: async () => ({ index, series, days }) }];
  }
  if (!yearMode && !days.length) {
    console.error(
      "No sessions to replay — history came back empty. Upstox rejects minute ranges longer than about a month; try a later --from date."
    );
    process.exit(1);
  }

  const originals = listStrategies();
  const selectives = selectiveVariants();
  const strategies = yearMode && researchMode
    ? [...RESEARCH_BOOKS]
    : yearMode
    ? [
        ...originals,
        ...originals.map(trendOnlyOf), // live rule: 0.4% and steadiness 0.4
        ...originals.map((o) => trendVariantOf(o, "trend-0.3", 0.3, 0.3)),
        ...originals.map((o) => trendVariantOf(o, "trend-0.5", 0.5, 0.5)),
        ...originals.map(tf15Of),
      ]
    : dayTypeMode
    ? tf15Mode
      ? [...originals.map(trendOnlyOf), ...originals.map(tf15Of)]
      : orFadeMode
      ? [...FLAT_GRID] // momentum books were settled in the previous run
      : [...originals, ...originals.map(trendOnlyOf), ...FLAT_GRID]
    : [
        ...originals,
        ...originals.flatMap(dayFilterVariantsOf),
        ...(withSelective ? [...selectives, ...selectives.flatMap(variantsOf)] : []),
      ];
  const dayTypeLog = new Map(); // day -> {final, counts}
  const byFamily = new Map();
  for (const s of strategies) {
    const f = familyOf(s);
    if (!byFamily.has(f)) byFamily.set(f, []);
    byFamily.get(f).push(s);
  }

  store.init(dbPath);
  const runId = `replay-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  store.createRun({
    id: runId,
    kind: "backtest",
    params: { days, fills: "next cash bar open", costPct: FLAT_COST_PCT, dayFilters: DAY_FILTERS, selective: withSelective },
    notes: "paper strategies: originals vs trend-day filters",
  });

  const results = []; // closed trades
  const t0 = Date.now();
  const replayed = [];
  let stoppedEarly = false;

  for (const w of windows) {
    if (stoppedEarly) break;
    if (onlyDays && !onlyDays.some((d) => d.startsWith(w.label))) continue;
    ({ index, series, days } = await w.load());
    if (onlyDays) days = days.filter((d) => onlyDays.includes(d));
    if (yearMode) console.log(`— ${w.label}: ${days.length} sessions`);
  for (const day of days) {
    if (STOP_AT_MS && Date.now() >= STOP_AT_MS) {
      stoppedEarly = true;
      console.log(`stopping at ${STOP_AT} IST as asked — results below are PARTIAL`);
      break;
    }
    replayed.push(day);
    const dayBars = index.b3.filter((b) => istDateString(b.time) === day && istMinutes(b.time) < 15 * 60 + 30);
    const positions = new Map(strategies.map((s) => [s.id, new Map()])); // strategyId -> underlying -> position
    const dayStates = new Map(strategies.map((s) => [s.id, createDayState()]));
    const confluence = createConfluence(SELECTION);
    const dailyByName = new Map();
    for (const [name, s] of series) {
      dailyByName.set(name, dailyStatsFrom(s.daily.filter((c) => String(c.time).slice(0, 10) < day), day));
    }
    const hints = new Map();

    const close = (strategy, position, price, reason, now) => {
      const trade = engine.closePosition(position, price, reason, now);
      trade.costs = FLAT_COST_PCT * position.entryPrice * position.qty;
      trade.netPnl = trade.grossPnl - trade.costs;
      trade.rMultiple = trade.rupeeRisk > 0 ? trade.netPnl / trade.rupeeRisk : 0;
      trade.runId = runId;
      trade.costSource = "flat-replay";
      positions.get(strategy.id).delete(position.underlying);
      noteClose(dayStates.get(strategy.id), trade);
      results.push({ ...trade, day });
      store.commitClose(position.id, trade);
    };

    for (let k = 0; k < dayBars.length; k++) {
      const b = dayBars[k].time;
      const T = b + BAR3; // this bar has closed

      // 1. Exits on the bar that just closed.
      for (const s of strategies) {
        for (const p of [...positions.get(s.id).values()]) {
          if (p.entryTime >= T) continue;
          const bars = series.get(p.underlying)?.b3;
          const i = bars ? lastIndexAtOrBefore(bars, b) : -1;
          if (i < 0 || bars[i].time !== b) continue;
          const { exit, position } = engine.applyBar(p, s, bars[i], T);
          if (exit) close(s, position, exit.price, exit.reason, T);
          else positions.get(s.id).set(p.underlying, position);
        }
      }

      // 2. Signals on the closed bar, evaluated once per family.
      const indexBars = index.b3.slice(Math.max(0, lastIndexAtOrBefore(index.b3, b) - MAX_BARS + 1), lastIndexAtOrBefore(index.b3, b) + 1);
      const on15Close = (istMinutes(T) - (9 * 60 + 15)) % 15 === 0;
      const i15 = lastIndexAtOrBefore(index.b15, T - BAR15);
      const indexBars15 = i15 >= 0 ? index.b15.slice(Math.max(0, i15 - MAX_BARS + 1), i15 + 1) : [];
      const trend = dayTrend(indexBars, T);
      if (dayTypeMode || yearMode) {
        const log = dayTypeLog.get(day) ?? { final: null, counts: {} };
        const type = classifyDay(trend);
        log.counts[type] = (log.counts[type] || 0) + 1;
        if (istMinutes(T) <= 15 * 60) log.final = type;
        dayTypeLog.set(day, log);
      }
      const candidates = [];
      for (const u of underlyings) {
        const s = series.get(u.underlying);
        if (!s) continue;
        const i = lastIndexAtOrBefore(s.b3, b, hints.get(u.underlying) ?? 0);
        hints.set(u.underlying, Math.max(0, i));
        if (i < 59 || s.b3[i].time !== b) continue;

        const need = [...byFamily.values()].some((members) =>
          members.some((m) => !positions.get(m.id).has(u.underlying))
        );
        if (!need) continue;

        const bars3m = s.b3.slice(Math.max(0, i - MAX_BARS + 1), i + 1);
        const j = lastIndexAtOrBefore(s.b15, T - BAR15);
        const bars15m = j >= 0 ? s.b15.slice(Math.max(0, j - MAX_BARS + 1), j + 1) : [];
        let ctx = null;

        let ctx15 = null;
        for (const members of byFamily.values()) {
          const free = members.filter((m) => !positions.get(m.id).has(u.underlying));
          if (!free.length) continue;
          const is15 = Boolean(members[0].tf15);
          if (is15 && (!on15Close || bars15m.length < 60)) continue;
          const c = is15
            ? (ctx15 ??= buildContext({
                underlying: u.underlying,
                cashKey: u.cashKey,
                bars3m: bars15m, // the trigger chart is now 15-minute
                bars15m,
                indexBars3m: indexBars15,
                daily: dailyByName.get(u.underlying),
                now: T,
              }))
            : (ctx ??= buildContext({
                underlying: u.underlying,
                cashKey: u.cashKey,
                bars3m,
                bars15m,
                indexBars3m: indexBars,
                daily: dailyByName.get(u.underlying),
                now: T,
              }));
          let signal;
          try {
            signal = members[0].evaluate(c);
          } catch {
            continue;
          }
          if (!signal?.side) continue;
          for (const m of free) candidates.push({ strategy: m, signal, ctx: c, u, next: s.b3[i + 1] });
        }
      }

      // 3. Entries, exactly as paperService orders and gates them.
      for (const c of candidates) confluence.note(familyOf(c.strategy), c.u.underlying, c.signal.side, b);
      for (const c of candidates) {
        c.quality = qualityOf({
          alignedRs: alignedRsOf(c.ctx.relStrength, c.signal.side),
          stopPct: stopPctOf(c.strategy, c.ctx.atr?.["3m"], c.ctx.rows?.["3m"]?.latest?.close),
          confluence: confluence.count(familyOf(c.strategy), c.u.underlying, c.signal.side, b),
        });
      }
      candidates.sort(
        (a, z) => ((z.strategy.selection ? z.quality.score : z.signal.score) ?? 0) - ((a.strategy.selection ? a.quality.score : a.signal.score) ?? 0)
      );
      for (const c of candidates) {
        const { strategy, signal, ctx, u, next } = c;
        if (positions.get(strategy.id).has(u.underlying)) continue;
        if (!engine.entriesAllowed(strategy, T)) continue;
        if (strategy.regimeFilter && !regimeAllows(ctx.regime, signal.side)) continue;
        if (strategy.dayFilter && trendDayVeto(trend, signal.side, strategy.dayFilter)) continue;
        if (dayTypeVeto(strategy, trend, signal.side, strategy.dayTypeCfg)) continue;
        if (strategy.noRetryAfterLoss && dayStates.get(strategy.id).lostNames.has(u.underlying)) continue;
        if (strategy.selection) {
          const day = dayStates.get(strategy.id);
          if (selectionVeto({ underlying: u.underlying, alignedRs: c.quality.alignedRs }, day, strategy.selection)) {
            day.skippedForQuality++;
            continue;
          }
        }
        const contract = contracts.get(u.underlying);
        const atr = ctx.atr?.["3m"];
        if (!contract || !next || next.time !== T || !(atr > 0)) continue;
        const afford = canAfford({
          price: next.open,
          qty: contract.lotSize,
          deployed: deployedCapital([...positions.get(strategy.id).values()]),
          capital: CAPITAL_PER_STRATEGY,
        });
        if (!afford.ok) continue;

        const position = engine.openPosition({
          runId,
          strategy,
          signal,
          underlying: u.underlying,
          futKey: contract.key,
          futLabel: contract.label,
          fillPrice: next.open,
          atr,
          lotSize: contract.lotSize,
          now: T,
          signalBarTime: b,
          cashPriceAtSignal: ctx.rows["3m"].latest.close,
          features: { ...extractFeatures(ctx, signal, { now: T }), quality: c.quality },
        });
        positions.get(strategy.id).set(u.underlying, position);
        dayStates.get(strategy.id).taken++;
      }
    }

    // Anything still open is flattened at its last bar's close.
    for (const s of strategies) {
      for (const p of [...positions.get(s.id).values()]) {
        const bars = series.get(p.underlying).b3.filter((x) => istDateString(x.time) === day);
        const last = bars[bars.length - 1];
        close(s, p, last.close, "squareoff", last.time + BAR3);
      }
    }
    const n = results.filter((t) => t.day === day).length;
    console.log(`  ${day}: ${n} trades across ${strategies.length} strategy variants (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  }

  store.finishRun(runId);
  store.close();
  if (yearMode) reportYear(results, replayed, originals, dayTypeLog, stoppedEarly);
  else if (dayTypeMode) reportDayType(results, days, originals, dayTypeLog);
  else report(results, days, originals);
  console.log(`\nwritten to ${dbPath} as run ${runId}`);
}

// ── Output ──────────────────────────────────────────────────────────────

const rupees = (v) => `${v < 0 ? "−" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
const R = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}R`;

function line(label, ts, nDays) {
  const n = ts.length;
  const wins = ts.filter((t) => t.netPnl > 0).length;
  const sumR = ts.reduce((a, t) => a + t.rMultiple, 0);
  const net = ts.reduce((a, t) => a + t.netPnl, 0);
  const costs = ts.reduce((a, t) => a + t.costs, 0);
  return (
    `  ${label.padEnd(44)} ${String(n).padStart(4)} (${(n / nDays).toFixed(1).padStart(4)}/day)  ` +
    `win ${n ? `${Math.round((wins / n) * 100)}%`.padStart(4) : "   —"}  ` +
    `${n ? R(sumR / n).padStart(7) : "      —"} avg  ${R(sumR).padStart(8)}  net ${rupees(net).padStart(10)}  charges ${rupees(costs)}`
  );
}

function stats(ts) {
  const n = ts.length;
  const sumR = ts.reduce((a, t) => a + t.rMultiple, 0);
  const byDay = new Map();
  for (const t of ts) byDay.set(t.day, (byDay.get(t.day) ?? 0) + t.rMultiple);
  return {
    n,
    sumR,
    avgR: n ? sumR / n : 0,
    net: ts.reduce((a, t) => a + t.netPnl, 0),
    worstDayR: byDay.size ? Math.min(...byDay.values()) : 0,
    winRate: n ? ts.filter((t) => t.netPnl > 0).length / n : 0,
  };
}

function reportDayType(results, days, originals, dayTypeLog) {
  dayTypeLogRef = dayTypeLog;
  const tuneDays = days.filter((d) => d <= TUNE_LAST_DAY);
  const testDays = days.filter((d) => d > TUNE_LAST_DAY);
  const inDays = (ts, ds) => ts.filter((t) => ds.includes(t.day));
  const book = {
    "15 Sept rules": (t) => originals.some((o) => o.id === t.strategyId),
    "Momentum, trend days only": (t) => t.strategyId.endsWith("@trend-only"),
  };

  console.log("\nDAY TYPES (as classified at 3:00 PM; share of the day's bars in brackets)");
  for (const d of days) {
    const log = dayTypeLog.get(d);
    const total = Object.values(log?.counts ?? {}).reduce((a, b) => a + b, 0) || 1;
    const mix = Object.entries(log?.counts ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${Math.round((v / total) * 100)}%`)
      .join(", ");
    console.log(`  ${d}  ${String(log?.final ?? "—").padEnd(11)} (${mix})  ${d <= TUNE_LAST_DAY ? "tuning" : "TEST"}`);
  }

  if (tf15Mode) {
    reportTf15(results, days, originals, tuneDays, testDays, inDays);
    return;
  }

  console.log(`\n${FLAT_NAME} VARIANTS — tuning half (20 Aug – 2 Sept) | test half (3 – 16 Sept)`);
  const variants = FLAT_GRID.map((v) => {
    const ts = results.filter((t) => t.strategyId === v.id);
    return { id: v.id, tune: stats(inDays(ts, tuneDays)), test: stats(inDays(ts, testDays)) };
  });
  for (const v of variants) {
    console.log(
      `  ${v.id.split("@")[1].padEnd(24)} tune ${String(v.tune.n).padStart(3)} trades ${R(v.tune.avgR).padStart(7)} avg ${R(v.tune.sumR).padStart(8)}` +
        `   |   test ${String(v.test.n).padStart(3)} trades ${R(v.test.avgR).padStart(7)} avg ${R(v.test.sumR).padStart(8)} ${rupees(v.test.net).padStart(10)}`
    );
  }

  // Chosen on the tuning half ONLY.
  const eligible = variants.filter((v) => v.tune.n >= 10);
  const chosen = (eligible.length ? eligible : variants).sort((a, b) => b.tune.avgR - a.tune.avgR)[0];
  const t = chosen.test;
  const checks = [
    ["makes money after charges", t.net > 0, rupees(t.net)],
    [`average ≥ +${GATE.minAvgR}R per trade`, t.avgR >= GATE.minAvgR, R(t.avgR)],
    [`at least ${GATE.minTrades} trades`, t.n >= GATE.minTrades, String(t.n)],
    [`worst day no worse than ${GATE.worstDayR}R`, t.worstDayR >= GATE.worstDayR, R(t.worstDayR)],
  ];
  const pass = checks.every((c) => c[1]);
  console.log(`\nCHOSEN ON THE TUNING HALF: ${chosen.id}  (tuning half: ${chosen.tune.n} trades, ${R(chosen.tune.avgR)} avg)`);
  console.log(`TEST HALF VERDICT for ${FLAT_NAME}:`);
  for (const [label, ok, value] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(34)} ${value}`);
  console.log(`  => ${pass ? "PASS — may go live" : "FAIL — do not go live"}`);

  if (orFadeMode) {
    console.log("\nPER DAY — R (trades), chosen setting");
    for (const d of days) {
      const ts = results.filter((x) => x.day === d && x.strategyId === chosen.id);
      console.log(`  ${d.padEnd(12)}${String(dayTypeLog.get(d)?.final ?? "—").padEnd(12)}${`${R(ts.reduce((a, x) => a + x.rMultiple, 0))} (${ts.length})`.padStart(16)}`);
    }
    const all = stats(results.filter((x) => x.strategyId === chosen.id));
    console.log(`\nALL 19 DAYS, chosen setting: ${all.n} trades, win ${Math.round(all.winRate * 100)}%, ${R(all.avgR)} avg, ${R(all.sumR)} total, ${rupees(all.net)}`);
    return;
  }
  console.log("\nMOMENTUM STRATEGIES — test half (3 – 16 Sept)");
  const momentum = {};
  for (const [label, match] of Object.entries(book)) {
    const s = stats(inDays(results.filter(match), testDays));
    momentum[label] = s;
    console.log(
      `  ${label.padEnd(28)} ${String(s.n).padStart(4)} trades  win ${Math.round(s.winRate * 100)}%  ${R(s.avgR).padStart(7)} avg  ${R(s.sumR).padStart(8)}  ${rupees(s.net).padStart(11)}`
    );
    for (const o of originals) {
      const id = label === "15 Sept rules" ? o.id : `${o.id}@trend-only`;
      const so = stats(inDays(results.filter((x) => x.strategyId === id), testDays));
      console.log(`      ${o.id.padEnd(24)} ${String(so.n).padStart(4)} trades ${R(so.sumR).padStart(8)} ${rupees(so.net).padStart(11)}`);
    }
  }
  const trendBetter = momentum["Momentum, trend days only"].sumR > momentum["15 Sept rules"].sumR;
  console.log(`  => trend-days-only ${trendBetter ? "loses less / does better — PASS" : "does NOT beat the 15 Sept rules — FAIL"}`);

  console.log("\nPER DAY — R (trades)");
  console.log(`  ${"day".padEnd(12)}${"type".padEnd(12)}${"15 Sept rules".padStart(18)}${"momentum trend-only".padStart(22)}${"snap-back (chosen)".padStart(22)}`);
  for (const d of days) {
    const dayTs = results.filter((x) => x.day === d);
    const cell = (ts) => `${R(ts.reduce((a, x) => a + x.rMultiple, 0))} (${ts.length})`;
    console.log(
      `  ${d.padEnd(12)}${String(dayTypeLog.get(d)?.final ?? "—").padEnd(12)}${cell(dayTs.filter(book["15 Sept rules"])).padStart(18)}` +
        `${cell(dayTs.filter(book["Momentum, trend days only"])).padStart(22)}${cell(dayTs.filter((x) => x.strategyId === chosen.id)).padStart(22)}`
    );
  }
}

function reportTf15(results, days, originals, tuneDays, testDays, inDays) {
  const books = [
    ["3-minute (live now)", "@trend-only"],
    ["15-minute", "@15m-trend-only"],
  ];
  const riskOf = (ts) => (ts.length ? ts.reduce((a, t) => a + t.rupeeRisk, 0) / ts.length : 0);
  const chargeR = (ts) => (ts.length ? ts.reduce((a, t) => a + t.costs / t.rupeeRisk, 0) / ts.length : 0);

  for (const [half, ds] of [["TUNING HALF (20 Aug – 2 Sept)", tuneDays], ["TEST HALF (3 – 16 Sept)", testDays], ["ALL 19 DAYS", days]]) {
    console.log(`\n${half} — trend days only`);
    for (const [label, suffix] of books) {
      const ts = inDays(results.filter((t) => t.strategyId.endsWith(suffix)), ds);
      const st = stats(ts);
      console.log(
        `  ${label.padEnd(22)} ${String(st.n).padStart(4)} trades  win ${Math.round(st.winRate * 100)}%  ${R(st.avgR).padStart(7)} avg  ${R(st.sumR).padStart(8)}  ${rupees(st.net).padStart(10)}` +
          `  risk/trade ${rupees(riskOf(ts))}  charges ${chargeR(ts).toFixed(2)}R/trade  worst day ${R(st.worstDayR)}`
      );
      for (const o of originals) {
        const so = stats(inDays(results.filter((t) => t.strategyId === `${o.id}${suffix}`), ds));
        console.log(`      ${o.id.padEnd(24)} ${String(so.n).padStart(4)} trades ${R(so.sumR).padStart(8)} ${rupees(so.net).padStart(10)}`);
      }
    }
  }

  const t15 = stats(inDays(results.filter((t) => t.strategyId.endsWith("@15m-trend-only")), testDays));
  const t3 = stats(inDays(results.filter((t) => t.strategyId.endsWith("@trend-only") && !t.strategyId.includes("@15m")), testDays));
  const checks = [
    ["makes money after charges", t15.net > 0, rupees(t15.net)],
    [`average ≥ +${GATE.minAvgR}R per trade`, t15.avgR >= GATE.minAvgR, R(t15.avgR)],
    [`at least ${GATE.minTrades} trades`, t15.n >= GATE.minTrades, String(t15.n)],
    [`worst day no worse than ${GATE.worstDayR}R`, t15.worstDayR >= GATE.worstDayR, R(t15.worstDayR)],
    ["beats the 3-minute versions (total R)", t15.sumR > t3.sumR, `${R(t15.sumR)} vs ${R(t3.sumR)}`],
  ];
  console.log("\nTEST HALF VERDICT for the 15-minute versions:");
  for (const [label, ok, value] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(38)} ${value}`);
  console.log(`  => ${checks.every((c) => c[1]) ? "PASS — switch to 15-minute" : "FAIL — stay on 3-minute"}`);

  console.log("\nPER DAY — R (trades)");
  console.log(`  ${"day".padEnd(12)}${"type".padEnd(12)}${"3-minute".padStart(16)}${"15-minute".padStart(16)}`);
  for (const d of days) {
    const cell = (suffix) => {
      const ts = results.filter((t) => t.day === d && t.strategyId.endsWith(suffix) && (suffix === "@15m-trend-only" || !t.strategyId.includes("@15m")));
      return `${R(ts.reduce((a, t) => a + t.rMultiple, 0))} (${ts.length})`;
    };
    console.log(`  ${d.padEnd(12)}${String(dayTypeLogRef.get(d)?.final ?? "—").padEnd(12)}${cell("@trend-only").padStart(16)}${cell("@15m-trend-only").padStart(16)}`);
  }
}

let dayTypeLogRef = new Map();

function report(results, days, originals) {
  const tagOf = (id) => (id.includes("@") ? id.split("@")[1] : id.endsWith("-selective") ? "selective" : "original");
  const tags = ["original", ...DAY_FILTERS.map((f) => f.tag), ...(withSelective ? ["selective"] : [])];

  console.log("\nPER STRATEGY — all replayed days");
  for (const o of originals) {
    for (const tag of tags) {
      const ts = results.filter((t) => t.strategyId.replace(/-selective$/, "").split("@")[0] === o.id && tagOf(t.strategyId) === tag);
      console.log(line(`${o.id} · ${tag}`, ts, days.length));
    }
    console.log();
  }

  console.log("ALL THREE STRATEGIES COMBINED");
  for (const tag of tags) console.log(line(tag, results.filter((t) => tagOf(t.strategyId) === tag), days.length));

  console.log("\nPER DAY — total R (trades) for each setting, all three strategies combined");
  console.log(`  ${"day".padEnd(12)}${tags.map((t) => t.padStart(26)).join("")}`);
  for (const day of days) {
    const d = results.filter((t) => t.day === day);
    const cells = tags.map((tag) => {
      const ts = d.filter((t) => tagOf(t.strategyId) === tag);
      return `${R(ts.reduce((a, t) => a + t.rMultiple, 0))} (${ts.length})`.padStart(26);
    });
    console.log(`  ${day.padEnd(12)}${cells.join("")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
