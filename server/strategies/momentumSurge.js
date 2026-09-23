import { runChecks } from "./context.js";

/**
 * STRATEGY C — Momentum Surge (intraday).
 *
 * A port of the `ST_Signal` logic from the user's Python screener
 * (screener.py), rewritten to run intraday rather than as a once-a-day snapshot.
 *
 * The original:
 *   if  pct >  1.2 and rsi < 68 and hist > 0 -> "Strong LONG"
 *   elif pct < -1.2 and rsi > 32 and hist < 0 -> "Strong SHORT"
 *   elif pct >  0.8 and hist > 0              -> "LONG Bias"
 *   elif pct < -0.8 and hist < 0              -> "SHORT Bias"
 *   else                                      -> "Wait"
 *
 * Four deliberate changes to make it an intraday strategy:
 *
 * 1. RSI AND MACD MOVED TO 15m BARS. The original computed both on DAILY
 *    candles, which barely change during a session — so intraday they act as a
 *    constant, and only `pct` and volume actually vary. On 15m they respond
 *    within the session, which is what the original's own notes anticipated
 *    ("for pure scalping you can later switch to 15-min candles").
 *
 * 2. `pct` MEASURED FROM TODAY'S OPEN, not the previous close. The Python used
 *    the quote's `net_change`, which includes the overnight gap — so a stock
 *    that gapped +2% and then drifted sideways all day reads as a +2% "surge"
 *    when nothing is actually happening.
 *
 * 3. A GAP GUARD. Following from the above: the move must be something the
 *    session produced, not mostly the gap.
 *
 * 4. ONLY THE "STRONG" TIER TRADES. The "Bias" tier drops the RSI guard, which
 *    is the one rule preventing entry at the top of an extended move.
 *
 * The RSI here is a CEILING for longs (`< 68` — don't chase into overbought),
 * which is close to the opposite of the repo's other momentum rule (`>= 60` —
 * demand strength). Both are defensible; they are different bets, which is
 * precisely why running them side by side is informative.
 */

const PCT_STRONG = 1.2; // minimum intraday move, in % from the open
const RSI_CEILING = 68;
const RSI_FLOOR = 32;
const MAX_GAP_SHARE = 0.6; // at most this fraction of the day's move may be gap
const MIN_VOLUME = Number(process.env.SURGE_MIN_VOLUME) || 250_000;

/** The timeframe the surge's momentum is confirmed on. */
const TF = "15m";

function volumeOf(ctx) {
  return ctx.futVolume ?? ctx.sessionVolume ?? 0;
}

/**
 * Is the day's move genuinely intraday rather than an overnight gap that then
 * went nowhere? Null gap data passes — absence of information is not evidence
 * of a gap.
 */
function moveIsIntraday(ctx) {
  if (ctx.gapPct == null || ctx.pctFromPrevClose == null) return true;
  const total = Math.abs(ctx.pctFromPrevClose);
  if (total < 0.01) return true;
  return Math.abs(ctx.gapPct) / total <= MAX_GAP_SHARE;
}

const longChecks = [
  {
    label: `Up ≥ ${PCT_STRONG}% from today's open`,
    test: (_r, ctx) => ctx.pctFromOpen != null && ctx.pctFromOpen > PCT_STRONG,
  },
  {
    label: `${TF} RSI(14) < ${RSI_CEILING} (room before overbought)`,
    test: (_r, ctx) => ctx.intradayRsi?.[TF] != null && ctx.intradayRsi[TF] < RSI_CEILING,
  },
  {
    label: `${TF} MACD histogram positive`,
    test: (_r, ctx) => ctx.emaMacd?.[TF]?.hist != null && ctx.emaMacd[TF].hist > 0,
  },
  {
    label: "Move is intraday, not an overnight gap",
    test: (_r, ctx) => moveIsIntraday(ctx),
  },
  {
    label: "Session volume above the liquidity floor",
    test: (_r, ctx) => volumeOf(ctx) >= MIN_VOLUME,
  },
];

const shortChecks = [
  {
    label: `Down ≥ ${PCT_STRONG}% from today's open`,
    test: (_r, ctx) => ctx.pctFromOpen != null && ctx.pctFromOpen < -PCT_STRONG,
  },
  {
    label: `${TF} RSI(14) > ${RSI_FLOOR} (room before oversold)`,
    test: (_r, ctx) => ctx.intradayRsi?.[TF] != null && ctx.intradayRsi[TF] > RSI_FLOOR,
  },
  {
    label: `${TF} MACD histogram negative`,
    test: (_r, ctx) => ctx.emaMacd?.[TF]?.hist != null && ctx.emaMacd[TF].hist < 0,
  },
  {
    label: "Move is intraday, not an overnight gap",
    test: (_r, ctx) => moveIsIntraday(ctx),
  },
  {
    label: "Session volume above the liquidity floor",
    test: (_r, ctx) => volumeOf(ctx) >= MIN_VOLUME,
  },
];

/**
 * The Python's ST_Score, reproduced for ranking only — never as a gate.
 *
 * Worth knowing before trusting it: the `(volume/1e6)*2` term dwarfs the others
 * for liquid names, so this is close to a raw volume ranking. A 1.5% move on
 * 15m shares scores ~38; a 3% move on 0.3m shares scores ~12. The smaller mover
 * wins on liquidity alone.
 */
export function shortTermScore(pct, volume) {
  if (!Number.isFinite(pct) || !Number.isFinite(volume)) return null;
  const abs = Math.abs(pct);
  const activity = abs * (volume / 1e5);
  let score = abs * 2.5 + (volume / 1e6) * 2.0 + activity / 80;
  if (abs >= 2.5) score += 4;
  if (abs >= 3.5) score += 3;
  if (volume >= 10_000_000) score += 2;
  return Math.round(score * 10) / 10;
}

export default {
  id: "momentum-surge",
  name: "Momentum Surge",
  tagline: "Intraday surge, filtered by 15m RSI and MACD",
  plain: {
    summary: "Rides stocks making a big move today, as long as the move isn't already stretched.",
    buy: [
      `Up more than ${PCT_STRONG}% since today's open`,
      `15-minute momentum (RSI) is below ${RSI_CEILING}, so it isn't overheated yet`,
      "15-minute trend push (MACD) is positive",
      "Most of the move happened today, not in an overnight gap",
      "Enough shares have traded today",
    ],
    sell: [
      `Down more than ${PCT_STRONG}% since today's open`,
      `15-minute momentum (RSI) is above ${RSI_FLOOR}, so it isn't oversold yet`,
      "15-minute trend push (MACD) is negative",
      "Most of the move happened today, not in an overnight gap",
      "Enough shares have traded today",
    ],
  },
  description: {
    long: [
      `Up more than ${PCT_STRONG}% from today's open`,
      `${TF} RSI(14) below ${RSI_CEILING} — room left before overbought`,
      `${TF} MACD histogram positive`,
      "The move is intraday, not mostly an overnight gap",
      "Session volume above the liquidity floor",
    ],
    short: [
      `Down more than ${PCT_STRONG}% from today's open`,
      `${TF} RSI(14) above ${RSI_FLOOR} — room left before oversold`,
      `${TF} MACD histogram negative`,
      "The move is intraday, not mostly an overnight gap",
      "Session volume above the liquidity floor",
    ],
  },

  timeframes: { trend: "15m", trigger: "3m" },

  exits: {
    // Wider than the others: entry comes after a >1.2% move, so part of the
    // leg is already spent and the position needs room to breathe.
    stopAtr: 1.8,
    trailAtr: 2.0,
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

    const score = shortTermScore(ctx.pctFromOpen, volumeOf(ctx));

    const long = runChecks(longChecks, r3.latest, ctx);
    if (long.pass) return { side: "long", reasons: long.reasons, score };

    const short = runChecks(shortChecks, r3.latest, ctx);
    if (short.pass) return { side: "short", reasons: short.reasons, score };

    return { side: null, reasons: [], score: null };
  },
};
