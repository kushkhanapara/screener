import { runChecks, atrPct } from "./context.js";
import { istMinutes } from "../core/session.js";

/**
 * VWAP Snap-back — the flat-day strategy.
 *
 * The momentum strategies lose on flat days because moves reverse. This bets
 * on exactly that: when the market as a whole is going nowhere, a stock that
 * has been pushed far from its own average price for the day (VWAP) tends to
 * drift back toward it. It waits for the push to stall (the bar closes back
 * beyond the previous bar's extreme) rather than catching a falling price.
 *
 * It only trades on flat days (see paper/dayType.js), and it avoids stocks
 * moving hard on their own against Nifty, which usually means news that keeps
 * going rather than a stretch that snaps back.
 *
 * `vwapSnapback(params)` builds variants for the replay; the default export is
 * the setting chosen there.
 */

export const SNAPBACK_DEFAULTS = Object.freeze({
  stretchAtr: 2.5, // how far from VWAP, in 3-minute ATRs, before it counts as stretched
  rsiMax: 30, // oversold for a buy (and 100 − this, overbought, for a sell)
  maxRelStrengthPct: 1.0, // skip stocks moving this much more (or less) than Nifty today
  atrPctMin: 0.12, // the snap must be big enough to pay charges
  minSessionVolume: 50_000,
  startMin: 10 * 60, // let the first 45 minutes set the day's range first
  targetR: 1.5,
});

const prevBar = (ctx) => {
  const bars = ctx.bars?.["3m"];
  return bars?.length >= 2 ? bars[bars.length - 2] : null;
};

/** Distance from VWAP in ATRs: positive when price is below VWAP, negative above. */
const stretchOf = (r, ctx) => {
  const atr = ctx.atr?.["3m"];
  if (!(atr > 0) || ctx.vwap == null) return null;
  return (ctx.vwap - r.close) / atr;
};

export function vwapSnapback(over = {}) {
  const { id, name, ...rest } = over;
  const p = { ...SNAPBACK_DEFAULTS, ...rest };

  const common = [
    { label: "After 10:00 AM", test: (_r, ctx) => istMinutes(ctx.now) >= p.startMin },
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

  const longChecks = [
    { label: `≥ ${p.stretchAtr} ATR below VWAP`, test: (r, ctx) => (stretchOf(r, ctx) ?? -Infinity) >= p.stretchAtr },
    { label: `RSI ≤ ${p.rsiMax}`, test: (r) => r.rsi14 <= p.rsiMax },
    { label: "Closed above the previous bar's high", test: (r, ctx) => prevBar(ctx) != null && r.close > prevBar(ctx).high },
    ...common,
  ];
  const shortChecks = [
    { label: `≥ ${p.stretchAtr} ATR above VWAP`, test: (r, ctx) => (stretchOf(r, ctx) ?? Infinity) <= -p.stretchAtr },
    { label: `RSI ≥ ${100 - p.rsiMax}`, test: (r) => r.rsi14 >= 100 - p.rsiMax },
    { label: "Closed below the previous bar's low", test: (r, ctx) => prevBar(ctx) != null && r.close < prevBar(ctx).low },
    ...common,
  ];

  return Object.freeze({
    id: id ?? "vwap-snapback",
    name: name ?? "VWAP Snap-back",
    tagline: "Flat days: fades stretched moves back toward VWAP",
    description: {
      long: longChecks.map((c) => c.label),
      short: shortChecks.map((c) => c.label),
    },
    plain: {
      summary:
        "Only on flat days. Buys a stock that has been pushed far below today's average price and has started to turn back up; sells the mirror case.",
      buy: [
        `Price is far below today's average traded price (VWAP): at least ${p.stretchAtr}× its typical 3-minute swing`,
        `Momentum is oversold (RSI ${p.rsiMax} or lower)`,
        "The fall has stalled: the latest 3-minute bar closed above the previous bar's high",
        `The stock isn't on its own big move today (within ${p.maxRelStrengthPct}% of Nifty)`,
        "It moves enough to cover charges, and enough shares have traded",
        "Only after 10:00 AM",
      ],
      sell: [
        `Price is far above today's average traded price (VWAP): at least ${p.stretchAtr}× its typical 3-minute swing`,
        `Momentum is overbought (RSI ${100 - p.rsiMax} or higher)`,
        "The rise has stalled: the latest 3-minute bar closed below the previous bar's low",
        `The stock isn't on its own big move today (within ${p.maxRelStrengthPct}% of Nifty)`,
        "It moves enough to cover charges, and enough shares have traded",
        "Only after 10:00 AM",
      ],
    },
    params: p,
    timeframes: { trend: "3m", trigger: "3m" },
    exits: {
      stopAtr: 1.2, // just beyond the stretch; if it keeps going, the snap-back idea is wrong
      trailAtr: 1.0,
      breakevenAtR: 1.0,
      targetR: p.targetR, // roughly back toward VWAP, which sits ≥ stretchAtr ATRs away
      timeStopBars: 10_000, // no time stop
      squareOffMin: 15 * 60 + 15,
      noEntryAfterMin: 14 * 60 + 30,
    },
    dayTypes: ["flat"],
    regimeFilter: false,
    noRetryAfterLoss: true,

    evaluate(ctx) {
      const r3 = ctx.rows?.["3m"];
      if (!r3) return { side: null, reasons: [], score: null };
      const long = runChecks(longChecks, r3.latest, ctx);
      if (long.pass) return { side: "long", reasons: long.reasons, score: stretchOf(r3.latest, ctx) };
      const short = runChecks(shortChecks, r3.latest, ctx);
      if (short.pass) return { side: "short", reasons: short.reasons, score: -stretchOf(r3.latest, ctx) };
      return { side: null, reasons: [], score: null };
    },
  });
}

export default vwapSnapback();
