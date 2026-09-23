import { runChecks, atrPct } from "./context.js";

/**
 * STRATEGY B — VWAP Relative Strength.
 *
 * Built to be genuinely orthogonal to Strategy A, so comparing them is
 * informative rather than two spellings of the same bet. Four differences:
 *
 * 1. RELATIVE STRENGTH vs NIFTY. Strategy A's checks all measure "price rose
 *    recently vs its own average", which is mostly a reading of the market's
 *    direction — on a strong index day almost everything qualifies. Requiring
 *    the stock to OUTRUN the index is the one input that says something about
 *    this stock rather than about the market.
 *
 * 2. PULLBACK ENTRY, not breakout. A momentum threshold fires after the move;
 *    this waits for price to fall back to the fast average inside an established
 *    session trend and then reclaim it. Worse fill rate, much better reward for
 *    the risk taken, and the stop sits somewhere structurally meaningful.
 *
 * 3. SESSION-ANCHORED. VWAP and the % move both reset at 09:15, so the overnight
 *    gap cannot contaminate them — unlike a 200-bar average that reads straight
 *    through the 15:30 -> 09:15 discontinuity as one enormous bar.
 *
 * 4. TRADEABILITY FLOORS. A volatility floor (the move must be big enough to pay
 *    for slippage and taxes) and a liquidity floor (the name must actually
 *    trade). Strategy A screens names it would be unprofitable to trade.
 */

const RS_MIN = 0.4; // stock must outrun the index by this many % this session
const ATR_PCT_MIN = 0.12; // 3m ATR as % of price — below this, costs eat the edge
const MIN_SESSION_VOLUME = 50_000; // shares traded today; drops the untradeable tail

const longChecks = [
  {
    label: "Price above session VWAP",
    test: (r, ctx) => ctx.vwap != null && r.close > ctx.vwap,
  },
  {
    label: `Outperforming NIFTY by ≥ ${RS_MIN}%`,
    test: (_r, ctx) => ctx.relStrength != null && ctx.relStrength >= RS_MIN,
  },
  {
    label: "Pulled back below EMA9 and reclaimed it",
    test: (r, ctx) => ctx.prevRow != null && ctx.prevRow.close < ctx.prevRow.ema9 && r.close > r.ema9,
  },
  {
    label: `Volatility ≥ ${ATR_PCT_MIN}% ATR`,
    test: (r, ctx) => {
      const p = atrPct(ctx.atr?.["3m"], r.close);
      return p != null && p >= ATR_PCT_MIN;
    },
  },
  {
    label: "Liquid enough to trade",
    test: (_r, ctx) => ctx.sessionVolume >= MIN_SESSION_VOLUME,
  },
];

const shortChecks = [
  {
    label: "Price below session VWAP",
    test: (r, ctx) => ctx.vwap != null && r.close < ctx.vwap,
  },
  {
    label: `Underperforming NIFTY by ≥ ${RS_MIN}%`,
    test: (_r, ctx) => ctx.relStrength != null && ctx.relStrength <= -RS_MIN,
  },
  {
    label: "Rallied above EMA9 and lost it",
    test: (r, ctx) => ctx.prevRow != null && ctx.prevRow.close > ctx.prevRow.ema9 && r.close < r.ema9,
  },
  {
    label: `Volatility ≥ ${ATR_PCT_MIN}% ATR`,
    test: (r, ctx) => {
      const p = atrPct(ctx.atr?.["3m"], r.close);
      return p != null && p >= ATR_PCT_MIN;
    },
  },
  {
    label: "Liquid enough to trade",
    test: (_r, ctx) => ctx.sessionVolume >= MIN_SESSION_VOLUME,
  },
];

export default {
  id: "vwap-relative-strength",
  name: "VWAP Relative Strength",
  tagline: "Outperformers bought on a pullback to VWAP",
  plain: {
    summary: "Buys stocks beating Nifty today after a small dip; sells stocks lagging Nifty after a small bounce.",
    buy: [
      "Price is above today's average traded price (VWAP)",
      `The stock is up at least ${RS_MIN}% more than Nifty since the open`,
      "It dipped below its 9-bar average and climbed back above it (buys the dip, not the spike)",
      `It moves enough to cover charges: a typical 3-minute swing of at least ${ATR_PCT_MIN}% of price`,
      "Enough shares have traded today",
    ],
    sell: [
      "Price is below today's average traded price (VWAP)",
      `The stock is down at least ${RS_MIN}% more than Nifty since the open`,
      "It bounced above its 9-bar average and fell back below it",
      `It moves enough to cover charges: a typical 3-minute swing of at least ${ATR_PCT_MIN}% of price`,
      "Enough shares have traded today",
    ],
  },
  description: {
    long: [
      "Price above session-anchored VWAP",
      `Outperforming NIFTY by ≥ ${RS_MIN}% since the open`,
      "Pulled back below EMA9 and reclaimed it (entry on the dip, not the breakout)",
      `3m ATR ≥ ${ATR_PCT_MIN}% of price`,
      "Session volume above the liquidity floor",
    ],
    short: [
      "Price below session-anchored VWAP",
      `Underperforming NIFTY by ≥ ${RS_MIN}% since the open`,
      "Rallied above EMA9 and lost it",
      `3m ATR ≥ ${ATR_PCT_MIN}% of price`,
      "Session volume above the liquidity floor",
    ],
  },

  timeframes: { trend: "3m", trigger: "3m" },

  exits: {
    stopAtr: 1.2, // tighter than A: a pullback entry sits nearer its invalidation
    trailAtr: 1.5,
    breakevenAtR: 1.0,
    targetR: 2.5,
    // Reverted to the 15 Sept rules on 16 Sept: no bar-count exits. The early
    // "no follow-through" exit (proveItBars 3 / 0.25R) and the time stop cost
    // money in their first live session — prove-it alone ~16R gross over 51
    // trades. Re-enable only after a multi-day replay shows they help.
    timeStopBars: 10_000, // effectively off; the 15:15 square-off ends every trade
    squareOffMin: 15 * 60 + 15,
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

  evaluate(ctx) {
    const r3 = ctx.rows?.["3m"];
    if (!r3) return { side: null, reasons: [], score: null };

    // The reclaim test needs the prior bar; expose it on the context so checks
    // stay single-argument like every other strategy's.
    const withPrev = { ...ctx, prevRow: r3.prev };

    const long = runChecks(longChecks, r3.latest, withPrev);
    if (long.pass) {
      return { side: "long", reasons: long.reasons, score: ctx.relStrength };
    }

    const short = runChecks(shortChecks, r3.latest, withPrev);
    if (short.pass) {
      return { side: "short", reasons: short.reasons, score: Math.abs(ctx.relStrength) };
    }

    return { side: null, reasons: [], score: null };
  },
};
