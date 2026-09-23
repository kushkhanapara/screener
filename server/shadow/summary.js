/**
 * Outcome arithmetic for shadow virtual trades.
 *
 * Shadow trades are a separate book from paper trading: one slot, virtual
 * fills, no paper capital. These numbers describe shadow alone and are never
 * combined with paper results.
 */

/** Win rate, expectancy and cost drag for a set of shadow virtual trades. */
export function outcome(trades) {
  const n = trades.length;
  if (!n) return { trades: 0, winRate: null, expectancyR: null, avgNetPct: null, netPnl: 0, costPctOfGrossWins: null };
  const grossWins = trades.filter((t) => t.grossPnl > 0).reduce((s, t) => s + t.grossPnl, 0);
  const costs = trades.reduce((s, t) => s + (t.costs || 0), 0);
  return {
    trades: n,
    winRate: trades.filter((t) => t.netPnl > 0).length / n,
    expectancyR: trades.reduce((s, t) => s + t.rMultiple, 0) / n,
    avgNetPct: trades.reduce((s, t) => s + (t.netPnl / (t.entryPrice * t.qty)) * 100, 0) / n,
    netPnl: trades.reduce((s, t) => s + t.netPnl, 0),
    costPctOfGrossWins: grossWins > 0 ? (costs / grossWins) * 100 : null,
  };
}
