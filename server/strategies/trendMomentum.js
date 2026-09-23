import { runChecks } from "./context.js";

/**
 * STRATEGY A — Trend Momentum.
 *
 * The original screener strategy, restructured into something tradable. The
 * conditions are kept in spirit; three things changed:
 *
 * 1. TIMEFRAME HIERARCHY, not OR. The screener matched when 3m OR 15m agreed,
 *    which let the noisier 3m dominate and produced the "conflict" case where a
 *    name was long on one timeframe and short on the other. Here 15m decides the
 *    permitted DIRECTION and 3m supplies the TRIGGER — a name can only ever fire
 *    one way.
 *
 * 2. TREND ANCHORED ON 15m. `sma34 > ma200` silently meant ~1.6 trading days on
 *    3m bars and ~8 days on 15m. Evaluating the trend only on 15m gives it one
 *    consistent meaning.
 *
 * 3. EVENT, NOT STANDING STATE. The screener re-reported a name for as long as
 *    the conditions held, so a stock extended for 90 minutes looked identical to
 *    one that just turned. For entries that is how you buy the top. The full
 *    condition set must hold NOW and NOT have held on the previous bar, so each
 *    setup fires once, on the transition.
 *
 * The MACD check from the original is dropped: it was computed with the SMA
 * variant (laggy) and moved almost in lockstep with `ema5 > sma34`, so it added
 * delay rather than information.
 */

const RSI_LONG = 60;
const RSI_SHORT = 40;

/** 15m — is an uptrend in force? Decides the permitted direction. */
const longTrend = [
  { label: "15m trend: SMA34 above SMA200", test: (r) => r.ma200 != null && r.sma34 > r.ma200 },
  { label: "15m trend: price above SMA34", test: (r) => r.close > r.sma34 },
];

/** 3m — has momentum turned up inside that trend? Supplies the trigger. */
const longTrigger = [
  { label: "3m: EMA5 above SMA34", test: (r) => r.ema5 > r.sma34 },
  { label: `3m: RSI(14) ≥ ${RSI_LONG}`, test: (r) => r.rsi14 >= RSI_LONG },
];

const shortTrend = [
  { label: "15m trend: SMA34 below SMA200", test: (r) => r.ma200 != null && r.sma34 < r.ma200 },
  { label: "15m trend: price below SMA34", test: (r) => r.close < r.sma34 },
];

const shortTrigger = [
  { label: "3m: EMA5 below SMA34", test: (r) => r.ema5 < r.sma34 },
  { label: `3m: RSI(14) ≤ ${RSI_SHORT}`, test: (r) => r.rsi14 <= RSI_SHORT },
];

const SIDES = {
  long: { trend: longTrend, trigger: longTrigger },
  short: { trend: shortTrend, trigger: shortTrigger },
};

/** Does `side` fully qualify on the given 15m/3m rows? */
function qualifies(side, row15, row3, ctx) {
  const { trend, trigger } = SIDES[side];
  const t = runChecks(trend, row15, ctx);
  if (!t.pass) return { pass: false, reasons: t.reasons };
  const g = runChecks(trigger, row3, ctx);
  return { pass: g.pass, reasons: [...t.reasons, ...g.reasons] };
}

export default {
  id: "trend-momentum",
  name: "Trend Momentum",
  tagline: "15m trend gate, 3m momentum trigger",
  // The same rules in everyday words, for the UI.
  plain: {
    summary: "Joins a stock that is already trending, at the moment short-term momentum kicks in.",
    buy: [
      "The 15-minute chart is in an uptrend (34-bar average above the 200-bar average)",
      "Price is above its 15-minute 34-bar average",
      "On the 3-minute chart, the fast average has crossed above the slower one",
      `Momentum (RSI) is strong: ${RSI_LONG} or higher`,
      "Takes the trade on the bar the setup first appears",
    ],
    sell: [
      "The 15-minute chart is in a downtrend (34-bar average below the 200-bar average)",
      "Price is below its 15-minute 34-bar average",
      "On the 3-minute chart, the fast average has crossed below the slower one",
      `Momentum (RSI) is weak: ${RSI_SHORT} or lower`,
      "Takes the trade on the bar the setup first appears",
    ],
  },
  description: {
    long: [
      "15m: SMA34 above SMA200 (uptrend in force)",
      "15m: price above SMA34",
      "3m: EMA5 above SMA34",
      `3m: RSI(14) ≥ ${RSI_LONG}`,
      "Fires on the bar the setup completes, not while it persists",
    ],
    short: [
      "15m: SMA34 below SMA200 (downtrend in force)",
      "15m: price below SMA34",
      "3m: EMA5 below SMA34",
      `3m: RSI(14) ≤ ${RSI_SHORT}`,
      "Fires on the bar the setup completes, not while it persists",
    ],
  },

  timeframes: { trend: "15m", trigger: "3m" },

  exits: {
    stopAtr: 1.5, // initial stop distance = 1.5 x ATR(14) on the trigger timeframe
    trailAtr: 1.5, // trail the same distance behind the high-water mark
    breakevenAtR: 1.0, // move the stop to entry once +1R is banked
    targetR: 3.0,
    // Reverted to the 15 Sept rules on 16 Sept: no bar-count exits. The early
    // "no follow-through" exit (proveItBars 3 / 0.25R) and the time stop cost
    // money in their first live session — prove-it alone ~16R gross over 51
    // trades. Re-enable only after a multi-day replay shows they help.
    timeStopBars: 10_000, // effectively off; the 15:15 square-off ends every trade
    squareOffMin: 15 * 60 + 15, // 15:15 IST, before the close-auction illiquidity
    // No new entries close to the square-off: a setup needing multiple R
    // cannot travel that far in the minutes left before it is force-flattened.
    noEntryAfterMin: 15 * 60, // no new entries from 15:00 IST
  },

  /** Don't fight the index — see the regime note in context.js. */
  regimeFilter: true,

  /**
   * Trend days only (paper/dayType.js), in Nifty's direction. In the replay's
   * test half (3–16 Sept) the three momentum strategies lost −114.5R on the
   * 15 Sept rules and made +5.5R when limited to trend days.
   */
  dayTypes: ["trend"],

  /**
   * @param {object} ctx from buildContext()
   * @returns {{side:"long"|"short"|null, reasons:string[], score:number|null}}
   */
  evaluate(ctx) {
    const r15 = ctx.rows?.["15m"];
    const r3 = ctx.rows?.["3m"];
    if (!r15 || !r3) return { side: null, reasons: [], score: null };

    for (const side of ["long", "short"]) {
      const now = qualifies(side, r15.latest, r3.latest, ctx);
      if (!now.pass) continue;

      // Event semantics: skip if the same setup already held on the prior bar.
      const before = qualifies(side, r15.prev, r3.prev, ctx);
      if (before.pass) continue;

      // Rank by how far RSI has pushed past its threshold.
      const score =
        side === "long" ? r3.latest.rsi14 - RSI_LONG : RSI_SHORT - r3.latest.rsi14;

      return { side, reasons: now.reasons, score };
    }

    return { side: null, reasons: [], score: null };
  },
};
