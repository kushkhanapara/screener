/**
 * Single-slot residual-momentum strategy, v1.
 *
 * Every threshold here has a trading reason written next to it (plan §11). Bump
 * `version` whenever a number changes, so recorded evaluations and trades stay
 * attributable to the config that produced them.
 *
 * Changelog
 *   v1 (15 Sept 2026) — first live session.
 *   v2 — time-of-day volume norm built from ~10 prior sessions. Under v1 the
 *        norm read the rolling 500-bar store, which holds only 3–4 sessions, so
 *        one abnormal day could dominate it (INDIGO read 73× its "norm").
 *        minNormSessions 3 → 5 for the same reason.
 */

export const SHADOW_RUN_ID = "shadow";

export const SINGLE_SLOT = Object.freeze({
  id: "single-slot",
  version: 2,
  name: "Single-Slot Residual Momentum",

  indexKey: "NSE_INDEX|Nifty 50",
  capital: 200_000,
  marginPct: 0.2,
  minPrice: 100, // the ₹0.05 tick must be small next to a typical move

  entryStartMin: 9 * 60 + 30, // opening range must be complete first
  openingRange: Object.freeze({ startMin: 9 * 60 + 15, endMin: 9 * 60 + 30 }),

  atrPercentile: Object.freeze({ min: 30, max: 85 }), // below: can't clear costs; above: stop is noise
  minStopPct: 0.3, // 3x the ~0.1% round-trip cost
  minResidualPct: 0.3, // stock-specific move must at least cover costs 3x
  minVolumeRatio: 1, // signal bar above its time-of-day norm
  minNormSessions: 5, // fewer sessions and one abnormal day dominates the norm
  persistenceBars: 2,
  volumeCheckCap: 25, // per-bar REST budget for the expensive volume gate

  beta: Object.freeze({ lookback: 300, minReturns: 100, min: -1, max: 3 }),

  weights: Object.freeze({ rs: 0.4, oi: 0.3, volume: 0.2, persistence: 0.1 }),
  // Value at which each component saturates at 1.
  scale: Object.freeze({ rsFullPct: 2, oiFullPct: 5, volumeFullRatio: 3, persistenceFullBars: 4 }),

  recordTopN: 5,

  exits: Object.freeze({
    stopAtr: 1.5,
    trailAtr: 1.5,
    breakevenAtR: 1,
    targetR: 3,
    timeStopBars: 10_000, // no time stop; square-off ends every trade
    squareOffMin: 15 * 60 + 15,
    noEntryAfterMin: 15 * 60,
  }),
});

/** The shape the shared paper engine expects. */
export const engineStrategy = Object.freeze({
  id: SINGLE_SLOT.id,
  timeframes: { trend: "3m", trigger: "3m" },
  exits: SINGLE_SLOT.exits,
});
