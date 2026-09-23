import { istDateString } from "../core/session.js";

/**
 * Trade metrics. One implementation, consumed by both live paper results and
 * backtest runs — if these diverged, comparing a backtest to live trading would
 * be comparing two different questions.
 *
 * Expectancy is reported in R rather than rupees because position sizing is one
 * fixed lot: rupee P&L is dominated by whichever expensive stocks happened to
 * signal, while R is comparable across names and across strategies.
 */

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);

/**
 * @param {Array} trades closed trades, CHRONOLOGICAL (oldest first)
 * @param {object} [opts]
 * @param {Array}  [opts.signalDays] rows from store.signalsPerDay()
 */
export function compute(trades = [], opts = {}) {
  const n = trades.length;
  if (!n) return empty(opts);

  const rs = trades.map((t) => t.rMultiple);
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);

  const grossWin = sum(wins.map((t) => t.netPnl));
  const grossLoss = Math.abs(sum(losses.map((t) => t.netPnl)));

  const equityR = cumulative(rs);
  const equityRupees = cumulative(trades.map((t) => t.netPnl));

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / n,

    // Expectancy: average R per trade. This is the single number that answers
    // "does this make money?" — positive and stable means yes.
    expectancyR: mean(rs),
    totalR: sum(rs),
    avgWinR: mean(wins.map((t) => t.rMultiple)),
    avgLossR: mean(losses.map((t) => t.rMultiple)),

    netPnl: sum(trades.map((t) => t.netPnl)),
    grossPnl: sum(trades.map((t) => t.grossPnl)),
    totalCosts: sum(trades.map((t) => t.costs)),

    // Infinity when there are no losses yet — a real state early on, and more
    // honest than a fabricated finite number.
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : 0,

    maxDrawdownR: maxDrawdown(equityR),
    maxDrawdownRupees: maxDrawdown(equityRupees),
    sharpe: sharpeOf(rs),

    avgHoldMinutes: mean(
      trades.map((t) => (t.exitTime - t.entryTime) / 60000).filter(Number.isFinite)
    ),
    avgBarsHeld: mean(trades.map((t) => t.barsHeld).filter(Number.isFinite)),
    avgMae: mean(trades.map((t) => t.mae).filter(Number.isFinite)),
    avgMfe: mean(trades.map((t) => t.mfe).filter(Number.isFinite)),

    bySide: {
      long: sideStats(trades.filter((t) => t.side === "long")),
      short: sideStats(trades.filter((t) => t.side === "short")),
    },
    byExitReason: countBy(trades, (t) => t.exitReason),

    equityCurveR: equityR,
    tradingDays: uniqueDays(trades).length,
    tradesPerDay: n / Math.max(1, uniqueDays(trades).length),
    ...signalStats(opts.signalDays),
  };
}

function empty(opts = {}) {
  return {
    trades: 0, wins: 0, losses: 0, winRate: 0,
    expectancyR: 0, totalR: 0, avgWinR: 0, avgLossR: 0,
    netPnl: 0, grossPnl: 0, totalCosts: 0,
    profitFactor: 0, maxDrawdownR: 0, maxDrawdownRupees: 0, sharpe: 0,
    avgHoldMinutes: 0, avgBarsHeld: 0, avgMae: 0, avgMfe: 0,
    bySide: { long: sideStats([]), short: sideStats([]) },
    byExitReason: {},
    equityCurveR: [],
    tradingDays: 0, tradesPerDay: 0,
    ...signalStats(opts.signalDays),
  };
}

function sideStats(trades) {
  if (!trades.length) return { trades: 0, winRate: 0, expectancyR: 0, totalR: 0 };
  const wins = trades.filter((t) => t.netPnl > 0).length;
  const rs = trades.map((t) => t.rMultiple);
  return {
    trades: trades.length,
    winRate: wins / trades.length,
    expectancyR: mean(rs),
    totalR: sum(rs),
  };
}

/**
 * Signal selectivity. There is deliberately no cap on concurrent positions —
 * the strategy is meant to be the filter — so this is how that claim gets
 * audited. A strategy firing 60 signals on a trending day is not being
 * selective, and the fix belongs in the strategy.
 */
function signalStats(signalDays) {
  if (!signalDays?.length) {
    return { signalsPerDay: 0, peakSignalsInADay: 0, signalDays: [] };
  }
  const counts = signalDays.map((d) => d.signals);
  return {
    signalsPerDay: mean(counts),
    peakSignalsInADay: Math.max(...counts),
    signalDays,
  };
}

/** Running total, one entry per trade. */
function cumulative(values) {
  let acc = 0;
  return values.map((v) => (acc += v));
}

/** Largest peak-to-trough decline of an equity curve (positive number). */
export function maxDrawdown(curve) {
  let peak = 0;
  let worst = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > worst) worst = dd;
  }
  return worst;
}

/**
 * Per-trade Sharpe-like ratio: mean R over the standard deviation of R.
 * Not annualised — intraday trade counts vary far too much for an annualisation
 * factor to mean anything, and a fabricated one would invite false confidence.
 */
export function sharpeOf(rs) {
  if (rs.length < 2) return 0;
  const m = mean(rs);
  const variance = mean(rs.map((r) => (r - m) ** 2));
  const sd = Math.sqrt(variance);
  return sd > 0 ? m / sd : 0;
}

function uniqueDays(trades) {
  return [...new Set(trades.map((t) => istDateString(t.entryTime)))];
}

function countBy(items, keyFn) {
  const out = {};
  for (const it of items) {
    const k = keyFn(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** Compare two strategies' metrics side by side, for the UI. */
export function compare(a, b) {
  const delta = (k) => (a?.[k] ?? 0) - (b?.[k] ?? 0);
  return {
    expectancyR: delta("expectancyR"),
    winRate: delta("winRate"),
    totalR: delta("totalR"),
    profitFactor: delta("profitFactor"),
    maxDrawdownR: delta("maxDrawdownR"),
  };
}
