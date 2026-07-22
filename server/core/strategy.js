/**
 * THE strategy — two-sided (Long / Short), the single source of truth.
 *
 * Standing-state semantics: a contract qualifies for a side when ALL of that
 * side's checks currently hold on the latest bar (not a momentary crossover
 * event). A scrip therefore stays in the set while the state holds, so the live
 * count grows/shrinks meaningfully. The same lists drive the live 3m/15m screen,
 * the daily (EOD) screen, AND the strategy description shown to users.
 *
 * `latest` is a row object exposing:
 *   close, rsi14, macd, macdSignal, macdHist, sma34, ma20, ma50, ma200, ema5, ema9, ema21
 * (ma200 is SMA200 and may be null when history is short — guard for it.)
 *
 * To change the strategy, edit ONLY these arrays — nothing else changes.
 *
 * Thresholds are hardcoded constants here (not env-configurable for now).
 */

const RSI_LONG = 60; // RSI(14) >= 60 for Long
const RSI_SHORT = 40; // RSI(14) <= 40 for Short

/**
 * LONG — momentum + confirmed uptrend on the equity chart.
 *   1. LTP above SMA34
 *   2. EMA5 above SMA34
 *   3. SMA34 above SMA200
 *   4. RSI(14) >= 60
 *   5. MACD (SMA 12/26/9) line above signal  (histogram > 0)
 */
export const longChecks = [
  { label: "LTP above SMA34", test: (l) => l.close > l.sma34 },
  { label: "EMA5 above SMA34", test: (l) => l.ema5 > l.sma34 },
  { label: "SMA34 above SMA200", test: (l) => l.ma200 != null && l.sma34 > l.ma200 },
  { label: `RSI(14) ≥ ${RSI_LONG}`, test: (l) => l.rsi14 >= RSI_LONG },
  { label: "MACD line above signal", test: (l) => l.macd > l.macdSignal },
];

/**
 * SHORT — mirror of Long: momentum + confirmed downtrend.
 *   1. LTP below SMA34
 *   2. EMA5 below SMA34
 *   3. SMA34 below SMA200
 *   4. RSI(14) <= 40
 *   5. MACD (SMA 12/26/9) line below signal  (histogram < 0)
 */
export const shortChecks = [
  { label: "LTP below SMA34", test: (l) => l.close < l.sma34 },
  { label: "EMA5 below SMA34", test: (l) => l.ema5 < l.sma34 },
  { label: "SMA34 below SMA200", test: (l) => l.ma200 != null && l.sma34 < l.ma200 },
  { label: `RSI(14) ≤ ${RSI_SHORT}`, test: (l) => l.rsi14 <= RSI_SHORT },
  { label: "MACD line below signal", test: (l) => l.macd < l.macdSignal },
];

const CHECKS = { long: longChecks, short: shortChecks };

/**
 * Evaluate a contract for one side. Returns { pass, reasons } where `reasons`
 * are the labels of the checks that passed (the full list when pass === true).
 * SMA34 > SMA200 (check 3) requires ma200; when it's null that check simply
 * fails — see `hasHistory` to distinguish "data-limited" from "not matching".
 */
export function evaluate(latest, side = "long") {
  const checks = CHECKS[side] || longChecks;
  const reasons = [];
  for (const c of checks) {
    if (c.test(latest)) reasons.push(c.label);
  }
  return { pass: reasons.length === checks.length, reasons };
}

/** True when the long-MA (SMA200) is available — else the row is data-limited. */
export function hasHistory(latest) {
  return latest?.ma200 != null;
}

/** Human-readable list of conditions for GET /api/strategy. */
export function describe(side = "long") {
  return (CHECKS[side] || longChecks).map((c) => c.label);
}
