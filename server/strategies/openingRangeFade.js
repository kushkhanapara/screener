import { runChecks, atrPct } from "./context.js";
import { istMinutes, sessionBars } from "../core/session.js";

/**
 * Opening Range Fade — a flat-day candidate.
 *
 * Each stock's first 30 minutes (9:15–9:45) set its opening range. On a flat
 * day, breakouts from that range tend to fail: price pokes above the high (or
 * below the low), finds no follow-through, and falls back inside. This sells
 * the failed break above and buys the failed break below, expecting a drift
 * back into the range.
 *
 * Research only until it passes the replay's tune/test check.
 */

export const ORFADE_DEFAULTS = Object.freeze({
  rangeMinutes: 30,
  pokeBars: 3, // the break must have happened within the last few bars
  pokeAtr: 0.25, // how far beyond the range the poke must reach, in 3-minute ATRs
  minRangeAtr: 3, // the range must be wide enough to leave room to fade into
  maxRelStrengthPct: 1.0, // skip stocks on their own big move vs Nifty
  atrPctMin: 0.12,
  minSessionVolume: 50_000,
  stopAtr: 1.5,
  targetR: 1.5,
});

/** Today's opening range and the bars after it, or null until it is complete. */
function rangeOf(ctx, p) {
  const today = sessionBars(ctx.bars?.["3m"] ?? [], ctx.now);
  if (!today.length) return null;
  const endMs = new Date(today[0].time).getTime() + p.rangeMinutes * 60_000;
  const inRange = today.filter((b) => new Date(b.time).getTime() < endMs);
  const after = today.filter((b) => new Date(b.time).getTime() >= endMs);
  if (inRange.length < p.rangeMinutes / 3 || !after.length) return null;
  const high = Math.max(...inRange.map((b) => b.high));
  const low = Math.min(...inRange.map((b) => b.low));
  return { high, low, mid: (high + low) / 2, after };
}

export function openingRangeFade(over = {}) {
  const { id, name, ...rest } = over;
  const p = { ...ORFADE_DEFAULTS, ...rest };

  const common = [
    {
      label: "Opening range is wide enough",
      test: (_r, ctx) => {
        const rg = rangeOf(ctx, p);
        const atr = ctx.atr?.["3m"];
        return rg != null && atr > 0 && (rg.high - rg.low) / atr >= p.minRangeAtr;
      },
    },
    {
      label: `Not moving more than ${p.maxRelStrengthPct}% differently from Nifty`,
      test: (_r, ctx) => ctx.relStrength != null && Math.abs(ctx.relStrength) <= p.maxRelStrengthPct,
    },
    {
      label: `Volatility ≥ ${p.atrPctMin}% ATR`,
      test: (r, ctx) => {
        const v = atrPct(ctx.atr?.["3m"], r.close);
        return v != null && v >= p.atrPctMin;
      },
    },
    { label: "Liquid enough to trade", test: (_r, ctx) => ctx.sessionVolume >= p.minSessionVolume },
  ];

  const recent = (rg) => rg.after.slice(-p.pokeBars);

  const shortChecks = [
    {
      label: "Poked above the opening-range high recently",
      test: (_r, ctx) => {
        const rg = rangeOf(ctx, p);
        const atr = ctx.atr?.["3m"];
        return rg != null && atr > 0 && recent(rg).some((b) => b.high >= rg.high + p.pokeAtr * atr);
      },
    },
    {
      label: "Closed back inside the range, above its middle",
      test: (r, ctx) => {
        const rg = rangeOf(ctx, p);
        return rg != null && r.close < rg.high && r.close > rg.mid;
      },
    },
    ...common,
  ];
  const longChecks = [
    {
      label: "Poked below the opening-range low recently",
      test: (_r, ctx) => {
        const rg = rangeOf(ctx, p);
        const atr = ctx.atr?.["3m"];
        return rg != null && atr > 0 && recent(rg).some((b) => b.low <= rg.low - p.pokeAtr * atr);
      },
    },
    {
      label: "Closed back inside the range, below its middle",
      test: (r, ctx) => {
        const rg = rangeOf(ctx, p);
        return rg != null && r.close > rg.low && r.close < rg.mid;
      },
    },
    ...common,
  ];

  const pokeSize = (ctx, side) => {
    const rg = rangeOf(ctx, p);
    const atr = ctx.atr?.["3m"];
    if (!rg || !(atr > 0)) return null;
    return side === "short"
      ? (Math.max(...recent(rg).map((b) => b.high)) - rg.high) / atr
      : (rg.low - Math.min(...recent(rg).map((b) => b.low))) / atr;
  };

  return Object.freeze({
    id: id ?? "opening-range-fade",
    name: name ?? "Opening Range Fade",
    tagline: "Flat days: fades failed breaks of the first 30 minutes' range",
    description: { long: longChecks.map((c) => c.label), short: shortChecks.map((c) => c.label) },
    plain: {
      summary:
        "Only on flat days. When a stock breaks out of its first 30 minutes' range and then falls back inside, it trades the fall back.",
      buy: [
        "The stock dipped below its 9:15–9:45 low in the last few bars",
        "It has closed back inside that range, in the lower half",
        "The range is wide enough to leave room for the move back",
        `It isn't on its own big move today (within ${p.maxRelStrengthPct}% of Nifty), moves enough to cover charges, and trades enough shares`,
      ],
      sell: [
        "The stock pushed above its 9:15–9:45 high in the last few bars",
        "It has closed back inside that range, in the upper half",
        "The range is wide enough to leave room for the move back",
        `It isn't on its own big move today (within ${p.maxRelStrengthPct}% of Nifty), moves enough to cover charges, and trades enough shares`,
      ],
    },
    params: p,
    timeframes: { trend: "3m", trigger: "3m" },
    exits: {
      stopAtr: p.stopAtr,
      trailAtr: 1.0,
      breakevenAtR: 1.0,
      targetR: p.targetR,
      timeStopBars: 10_000,
      squareOffMin: 15 * 60 + 15,
      noEntryAfterMin: 13 * 60 + 30, // later breaks rarely have time to fall back
    },
    dayTypes: ["flat"],
    regimeFilter: false,
    noRetryAfterLoss: true,

    evaluate(ctx) {
      const r3 = ctx.rows?.["3m"];
      if (!r3 || istMinutes(ctx.now) < 9 * 60 + 15 + p.rangeMinutes) return { side: null, reasons: [], score: null };
      const short = runChecks(shortChecks, r3.latest, ctx);
      if (short.pass) return { side: "short", reasons: short.reasons, score: pokeSize(ctx, "short") };
      const long = runChecks(longChecks, r3.latest, ctx);
      if (long.pass) return { side: "long", reasons: long.reasons, score: pokeSize(ctx, "long") };
      return { side: null, reasons: [], score: null };
    },
  });
}

export default openingRangeFade();
