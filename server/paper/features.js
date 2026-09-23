import { istMinutes, istDay } from "../core/session.js";
import { atrPct } from "../strategies/context.js";

/**
 * Snapshot of the market conditions a trade was entered under.
 *
 * Stored with every position and carried onto the closed trade, so the weekly
 * report can group outcomes by the conditions that produced them. Bump
 * FEATURE_VERSION when a field's meaning changes, so old and new trades are not
 * silently mixed in one bucket.
 */
export const FEATURE_VERSION = 1;

const round = (v, dp = 3) => {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/**
 * @param {object} ctx     from strategies/context.js buildContext()
 * @param {{side:"long"|"short", score?:number|null}} signal
 * @param {{now:number}} opts
 */
export function extractFeatures(ctx, signal, { now }) {
  const r3 = ctx?.rows?.["3m"]?.latest ?? null;
  const r15 = ctx?.rows?.["15m"]?.latest ?? null;
  const close = r3?.close ?? null;
  // +1 when a positive value favours the trade, -1 when it works against it.
  const dir = signal.side === "long" ? 1 : -1;

  const vwapDistPct =
    ctx?.vwap && close != null ? ((close - ctx.vwap) / ctx.vwap) * 100 : null;

  const aligned = (v) => (v == null || !Number.isFinite(v) ? null : round(v * dir));

  return {
    v: FEATURE_VERSION,
    side: signal.side,
    entryMinuteIst: istMinutes(now),
    weekday: istDay(now),
    regime: ctx?.regime ?? null,
    score: round(signal.score),

    rsi3m: round(r3?.rsi14, 2),
    rsi15m: round(ctx?.intradayRsi?.["15m"] ?? r15?.rsi14, 2),
    macdHist15m: round(ctx?.emaMacd?.["15m"]?.hist, 4),
    atrPct: round(atrPct(ctx?.atr?.["3m"], close)),

    pctFromOpen: round(ctx?.pctFromOpen),
    pctFromPrevClose: round(ctx?.pctFromPrevClose),
    gapPct: round(ctx?.gapPct),
    relStrength: round(ctx?.relStrength),
    indexPctFromOpen: round(ctx?.index?.pctFromOpen),
    vwapDistPct: round(vwapDistPct),
    sessionVolume: ctx?.sessionVolume ?? null,

    alignedMove: aligned(ctx?.pctFromOpen),
    alignedRs: aligned(ctx?.relStrength),
    alignedVwapDist: aligned(vwapDistPct),
  };
}
