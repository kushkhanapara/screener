import { compute } from "./metrics.js";
import { istMinutes, istDay, istDateString } from "../core/session.js";

/**
 * Trade review: groups closed trades by the conditions they were entered under
 * and flags the groups that clearly under- or out-perform.
 *
 * Findings are hypotheses to test, not rules to apply. Every one carries its
 * sample size, and groups below MIN_SAMPLE are never flagged — a strategy tuned
 * to a handful of trades learns noise.
 */

export const MIN_SAMPLE = 5;
const FLAG_GAP_R = 0.3; // how far a group's expectancy must sit from the overall
const DAY_MS = 24 * 60 * 60 * 1000;
const JUNK_HOLD_MS = 60_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A bucketing function per condition; returns null when the trade lacks the data. */
function range(v, edges, labels) {
  if (v == null || !Number.isFinite(v)) return null;
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
}

const f = (t) => t.features ?? {};

export const DIMENSIONS = [
  {
    key: "side",
    label: "Side",
    bucket: (t) => t.side,
    order: ["long", "short"],
  },
  {
    key: "time",
    label: "Entry time (IST)",
    bucket: (t) =>
      range(
        istMinutes(t.entryTime),
        [600, 660, 720, 780, 840, 900],
        ["09:15–10:00", "10:00–11:00", "11:00–12:00", "12:00–13:00", "13:00–14:00", "14:00–15:00", "15:00+"]
      ),
    order: ["09:15–10:00", "10:00–11:00", "11:00–12:00", "12:00–13:00", "13:00–14:00", "14:00–15:00", "15:00+"],
  },
  {
    key: "weekday",
    label: "Weekday",
    bucket: (t) => WEEKDAYS[istDay(t.entryTime)],
    order: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  },
  {
    key: "regime",
    label: "Market mood (Nifty)",
    bucket: (t) => f(t).regime ?? null,
    order: ["bullish", "neutral", "bearish"],
  },
  {
    key: "exitReason",
    label: "How the trade ended",
    bucket: (t) => t.exitReason,
    order: ["target", "trail", "breakeven", "proveit", "time", "squareoff", "stop"],
  },
  {
    key: "rsi15m",
    label: "Momentum at entry (15-min RSI)",
    bucket: (t) => range(f(t).rsi15m, [40, 50, 60, 68], ["<40", "40–50", "50–60", "60–68", "68+"]),
    order: ["<40", "40–50", "50–60", "60–68", "68+"],
  },
  {
    key: "atrPct",
    label: "How much it swings (3-min ATR, % of price)",
    bucket: (t) => range(f(t).atrPct, [0.15, 0.3, 0.5], ["<0.15%", "0.15–0.3%", "0.3–0.5%", "0.5%+"]),
    order: ["<0.15%", "0.15–0.3%", "0.3–0.5%", "0.5%+"],
  },
  {
    key: "alignedMove",
    label: "Move already made today, in trade direction",
    bucket: (t) => range(f(t).alignedMove, [0, 1, 2, 3], ["against", "0–1%", "1–2%", "2–3%", "3%+"]),
    order: ["against", "0–1%", "1–2%", "2–3%", "3%+"],
  },
  {
    key: "gap",
    label: "Overnight gap size",
    bucket: (t) => {
      const g = f(t).gapPct;
      return g == null ? null : range(Math.abs(g), [0.5, 1, 2], ["<0.5%", "0.5–1%", "1–2%", "2%+"]);
    },
    order: ["<0.5%", "0.5–1%", "1–2%", "2%+"],
  },
  {
    key: "alignedRs",
    label: "Stock's move vs Nifty, in trade direction",
    bucket: (t) =>
      range(f(t).alignedRs, [0, 0.5, 1, 1.5], ["against", "0–0.5%", "0.5–1%", "1–1.5%", "1.5%+"]),
    order: ["against", "0–0.5%", "0.5–1%", "1–1.5%", "1.5%+"],
  },
  {
    key: "quality",
    label: "Quality score (Selective rules)",
    bucket: (t) =>
      range(f(t).quality?.score, [0.3, 0.45, 0.6, 0.75], ["<0.30", "0.30–0.45", "0.45–0.60", "0.60–0.75", "0.75+"]),
    order: ["<0.30", "0.30–0.45", "0.45–0.60", "0.60–0.75", "0.75+"],
  },
  {
    key: "alignedVwapDist",
    label: "Distance from today's average price (VWAP)",
    bucket: (t) => range(f(t).alignedVwapDist, [0, 0.5, 1], ["wrong side", "0–0.5%", "0.5–1%", "1%+"]),
    order: ["wrong side", "0–0.5%", "0.5–1%", "1%+"],
  },
];

/** An original strategy and its Selective version share a family id. */
export function familyIdOf(strategyId) {
  return String(strategyId).replace(/-selective$/, "");
}

function aggregate(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.netPnl > 0).length;
  const totalR = trades.reduce((a, t) => a + t.rMultiple, 0);
  return {
    trades: n,
    wins,
    winRate: n ? wins / n : 0,
    expectancyR: n ? totalR / n : 0,
    totalR,
    netPnl: trades.reduce((a, t) => a + t.netPnl, 0),
  };
}

function breakdown(dim, trades) {
  const groups = new Map();
  let covered = 0;
  for (const t of trades) {
    const b = dim.bucket(t);
    if (b == null) continue;
    covered++;
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(t);
  }
  const rank = (b) => {
    const i = dim.order.indexOf(b);
    return i < 0 ? dim.order.length : i;
  };
  const rows = [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([bucket, ts]) => ({ bucket, ...aggregate(ts) }));
  return { key: dim.key, label: dim.label, covered, rows };
}

const pctile = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(p * (s.length - 1))];
};

const fmtR = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}R`;
const inr = (v) => `${v < 0 ? "−" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;

function findingsFor(real, overall, breakdowns) {
  const out = [];
  const E = overall.expectancyR;

  if (real.length < 30) {
    out.push({
      severity: "info",
      title: "Sample too small to act on",
      detail: `Only ${real.length} real trades in this window. Treat every finding below as something to watch, not a rule to change — a few more sessions will confirm or kill it.`,
      n: real.length,
      impactR: 0,
    });
  }

  for (const b of breakdowns) {
    if (b.key === "exitReason") continue; // an outcome, not an entry condition
    if (b.rows.length < 2) continue; // one bucket is just the overall number again

    const N = b.rows.reduce((a, r) => a + r.trades, 0);
    const T = b.rows.reduce((a, r) => a + r.totalR, 0);

    for (const row of b.rows) {
      if (row.trades < MIN_SAMPLE) continue;
      // Compare against the REST of the trades, not the overall average: a group
      // that dominates the sample drags the average toward itself and would
      // otherwise never look out of line.
      const restN = N - row.trades;
      if (restN < MIN_SAMPLE) continue;
      const restExp = (T - row.totalR) / restN;

      if (row.expectancyR <= restExp - FLAG_GAP_R && row.totalR < 0) {
        out.push({
          severity: "warn",
          title: `${b.label}: ${row.bucket} is losing`,
          detail: `${row.trades} trades averaging ${fmtR(row.expectancyR)} against ${fmtR(restExp)} for the other ${restN}, ${fmtR(row.totalR)} in total. Candidate for a filter that skips these entries.`,
          dimension: b.key,
          bucket: row.bucket,
          n: row.trades,
          impactR: row.totalR,
        });
      } else if (row.expectancyR >= restExp + FLAG_GAP_R && row.expectancyR > 0) {
        out.push({
          severity: "good",
          title: `${b.label}: ${row.bucket} is working`,
          detail: `${row.trades} trades averaging ${fmtR(row.expectancyR)} against ${fmtR(restExp)} for the other ${restN}. Worth protecting when changing anything else.`,
          dimension: b.key,
          bucket: row.bucket,
          n: row.trades,
          impactR: row.totalR,
        });
      }
    }
  }

  const winners = real.filter((t) => t.netPnl > 0);
  const losers = real.filter((t) => t.netPnl <= 0);

  const winnerMae = winners.map((t) => t.mae).filter(Number.isFinite);
  if (winnerMae.length >= MIN_SAMPLE) {
    const p90 = pctile(winnerMae, 0.9);
    if (p90 < 0.8) {
      out.push({
        severity: "warn",
        title: "Stop may be wider than winners need",
        detail: `90% of the ${winnerMae.length} winners never went more than ${p90.toFixed(2)}R against the entry. A stop near ${Math.max(0.5, p90 + 0.1).toFixed(1)}R of the current distance would keep most of them and make every loss smaller.`,
        n: winnerMae.length,
        impactR: 0,
      });
    }
  }

  const loserMfe = losers.map((t) => t.mfe).filter(Number.isFinite);
  if (loserMfe.length >= MIN_SAMPLE) {
    const dead = loserMfe.filter((v) => v < 0.25).length;
    const share = dead / loserMfe.length;
    if (share >= 0.5) {
      out.push({
        severity: "warn",
        title: "Losers were wrong from the start",
        detail: `${dead} of ${loserMfe.length} losing trades (${Math.round(share * 100)}%) never got more than +0.25R in their favour. The entry timing is the problem, not the exit — look at the entry breakdowns below.`,
        n: loserMfe.length,
        impactR: losers.reduce((a, t) => a + t.rMultiple, 0),
      });
    }
  }

  const clocked = real.filter((t) => t.exitReason === "squareoff" || t.exitReason === "time").length;
  if (real.length >= MIN_SAMPLE && clocked / real.length >= 0.4) {
    out.push({
      severity: "warn",
      title: "Trades are being ended by the clock",
      detail: `${clocked} of ${real.length} trades (${Math.round((clocked / real.length) * 100)}%) closed on square-off or the time stop rather than reaching their stop or target. Entries are coming too late in the session, or the target is too far to reach intraday.`,
      n: real.length,
      impactR: 0,
    });
  }

  const gross = real.reduce((a, t) => a + (t.grossPnl ?? 0), 0);
  const costs = real.reduce((a, t) => a + (t.costs ?? 0), 0);
  const grossWins = real.filter((t) => t.grossPnl > 0).reduce((a, t) => a + t.grossPnl, 0);
  if (real.length >= MIN_SAMPLE && grossWins > 0 && costs / grossWins >= 0.25) {
    out.push({
      severity: "warn",
      title: "Charges are eating the edge",
      detail: `Charges of ${inr(costs)} came to ${Math.round((costs / grossWins) * 100)}% of gross profits (gross P&L ${inr(gross)}). Small moves on large lots can't clear this — favour bigger expected moves or fewer trades.`,
      n: real.length,
      impactR: 0,
    });
  }

  const order = { warn: 0, good: 1, info: 2 };
  return out.sort(
    (a, b) => order[a.severity] - order[b.severity] || Math.abs(b.impactR) - Math.abs(a.impactR)
  );
}

/**
 * @param {Array} trades closed trades (any order)
 * @param {{days?:number|null, now?:number, strategyId?:string|null}} [opts]
 *   days = number of IST calendar days including today; null for all history
 */
export function buildReport(trades, { days = 7, now = Date.now(), strategyId = null } = {}) {
  const todayStart = Date.parse(`${istDateString(now)}T00:00:00+05:30`);
  const from = days ? todayStart - (days - 1) * DAY_MS : null;

  const inWindow = trades
    .filter((t) => (strategyId ? t.strategyId === strategyId : true))
    .filter((t) => (from == null ? true : t.exitTime >= from))
    .sort((a, b) => a.exitTime - b.exitTime);

  // Trades flattened within a minute of opening never had market exposure; they
  // were churn from entries at the square-off, and would drown every signal here.
  const junk = inWindow.filter((t) => t.exitTime - t.entryTime < JUNK_HOLD_MS);
  const real = inWindow.filter((t) => t.exitTime - t.entryTime >= JUNK_HOLD_MS);

  const metrics = compute(real);
  const overall = aggregate(real);
  const breakdowns = DIMENSIONS.map((d) => breakdown(d, real)).filter((b) => b.covered > 0);
  const withFeatures = real.filter((t) => t.features).length;

  const strategies = [...new Set(real.map((t) => t.strategyId))].sort().map((id) => ({
    strategyId: id,
    ...aggregate(real.filter((t) => t.strategyId === id)),
  }));

  // Each original beside its Selective version — same signal and exits, so the
  // gap between the two rows is what the quality bar is worth.
  const familyIds = [...new Set(real.map((t) => familyIdOf(t.strategyId)))].sort();
  const sessionDays = new Set(real.map((t) => istDateString(t.entryTime))).size || 1;
  const families = familyIds.map((family) => {
    const side = (ts) => ({
      ...aggregate(ts),
      costs: ts.reduce((a, t) => a + (t.costs ?? 0), 0),
      tradesPerDay: ts.length / sessionDays,
    });
    return {
      family,
      original: side(real.filter((t) => t.strategyId === family)),
      selective: side(real.filter((t) => t.strategyId === `${family}-selective`)),
    };
  });

  return {
    generatedAt: now,
    window: {
      days: days ?? null,
      from,
      to: now,
      label: days ? `Last ${days} day${days === 1 ? "" : "s"}` : "All history",
    },
    strategyId,
    counts: {
      total: inWindow.length,
      real: real.length,
      excludedJunk: junk.length,
      junkCosts: junk.reduce((a, t) => a + (t.costs ?? 0), 0),
      withFeatures,
    },
    summary: {
      ...overall,
      profitFactor: metrics.profitFactor,
      maxDrawdownR: metrics.maxDrawdownR,
      avgMae: metrics.avgMae,
      avgMfe: metrics.avgMfe,
      grossPnl: metrics.grossPnl,
      totalCosts: metrics.totalCosts,
    },
    strategies,
    families,
    breakdowns,
    findings: findingsFor(real, overall, breakdowns),
    minSample: MIN_SAMPLE,
  };
}
