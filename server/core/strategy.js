/**
 * THE fixed strategy — the single source of truth.
 *
 * Each check has a `label` (shown in the UI) and a `test(latest, prev)`.
 * A contract qualifies when ALL checks pass. This same list drives the daily
 * screen, the live matching set, AND the strategy description shown to users.
 *
 * `latest` / `prev` are row objects exposing:
 *   close, rsi14, macd, macdSignal, macdHist, ma20, ma50, ma200, ema9, ema21
 * (ma200 may be null when history is short — guard for it.)
 *
 * To change the strategy, edit ONLY this array — nothing else changes.
 *
 * >>> INTERIM STRATEGY (LONG "momentum in a confirmed uptrend, not overbought").
 *     A standing condition — a stock stays in the set while it holds, so the
 *     live count grows/shrinks meaningfully. Replace with your real rules. <<<
 */
export const checks = [
  {
    label: "Uptrend — price above 50 & 200-day MA",
    test: (l) => l.close > l.ma50 && l.ma200 != null && l.ma50 > l.ma200,
  },
  {
    label: "Short-term momentum — EMA 9 above EMA 21",
    test: (l) => l.ema9 > l.ema21,
  },
  {
    label: "MACD bullish (above signal, positive histogram)",
    test: (l) => l.macd > l.macdSignal && l.macdHist > 0,
  },
  {
    label: "RSI(14) healthy, not overbought (50–70)",
    test: (l) => l.rsi14 >= 50 && l.rsi14 <= 70,
  },
];

/**
 * Evaluate a contract. Returns { pass, reasons } where `reasons` are the labels
 * of the checks that passed (the full list when pass === true).
 */
export function evaluate(latest, prev) {
  const reasons = [];
  for (const c of checks) {
    if (c.test(latest, prev)) reasons.push(c.label);
  }
  return { pass: reasons.length === checks.length, reasons };
}

/** Human-readable list of conditions for GET /api/strategy. */
export function describe() {
  return checks.map((c) => c.label);
}
