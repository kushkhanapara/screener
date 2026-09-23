import { runChecks, atrPct } from "./context.js";
import { istMinutes, sessionBars } from "../core/session.js";

/**
 * Research strategies — replay only, never registered for live trading.
 *
 * What the replays so far taught: charges decide everything (0.2–0.3R per
 * 3-minute trade), most days are flat, and fewer, larger trades lose least. So
 * every idea here trades rarely, decides on 15-minute bars (stops sized on the
 * 15-minute ATR), and lets winners run to the 3:15 close behind a wide trail
 * instead of taking a quick target.
 *
 * All three are evaluated with a context built on 15-minute bars (the replay's
 * `tf15` path), so `ctx.atr["3m"]` and `ctx.bars["3m"]` hold 15-minute values.
 */

const OPEN_MIN = 9 * 60 + 15;
const DAY_MINUTES = 375; // 9:15 – 15:30

/** Today's traded value so far vs a normal day's pace (1.0 = usual). */
export function relativeVolume(ctx) {
  const avg = ctx.daily?.avgTurnover20;
  const close = ctx.rows?.["3m"]?.latest?.close;
  const elapsed = istMinutes(ctx.now) - OPEN_MIN;
  if (!(avg > 0) || !(close > 0) || !(elapsed > 0) || !(ctx.sessionVolume > 0)) return null;
  return (ctx.sessionVolume * close) / (avg * Math.min(1, elapsed / DAY_MINUTES));
}

const HOLD_EXITS = Object.freeze({
  stopAtr: 1.5,
  trailAtr: 2.5,
  breakevenAtR: 1.5,
  targetR: 20, // no quick target: winners run until the trail or 3:15
  timeStopBars: 10_000,
  squareOffMin: 15 * 60 + 15,
});

function build({ id, name, tagline, plain, noEntryAfterMin, exits = {}, longChecks, shortChecks, score }) {
  return Object.freeze({
    id,
    name,
    tagline,
    description: { long: longChecks.map((c) => c.label), short: shortChecks.map((c) => c.label) },
    plain,
    timeframes: { trend: "15m", trigger: "3m" },
    exits: { ...HOLD_EXITS, noEntryAfterMin, ...exits },
    tf15: true,
    regimeFilter: false,
    noRetryAfterLoss: true,
    evaluate(ctx) {
      const r = ctx.rows?.["3m"];
      if (!r) return { side: null, reasons: [], score: null };
      const long = runChecks(longChecks, r.latest, ctx);
      if (long.pass) return { side: "long", reasons: long.reasons, score: score(ctx, "long") };
      const short = runChecks(shortChecks, r.latest, ctx);
      if (short.pass) return { side: "short", reasons: short.reasons, score: score(ctx, "short") };
      return { side: null, reasons: [], score: null };
    },
  });
}

const minutesBetween = (a, b) => (ctx) => istMinutes(ctx.now) >= a && istMinutes(ctx.now) <= b;
const volAtLeast = (x) => ({ label: `Volume ≥ ${x}× a normal day's pace`, test: (_r, ctx) => (relativeVolume(ctx) ?? 0) >= x });
const atrAtLeast = (x) => ({ label: `15-min ATR ≥ ${x}% of price`, test: (r, ctx) => (atrPct(ctx.atr?.["3m"], r.close) ?? 0) >= x });

/** Opening range (first 30 minutes) from today's 15-minute bars. */
function openingRange(ctx) {
  const today = sessionBars(ctx.bars?.["3m"] ?? [], ctx.now);
  if (today.length < 3) return null;
  const first = today.slice(0, 2);
  return {
    high: Math.max(...first.map((b) => b.high)),
    low: Math.min(...first.map((b) => b.low)),
    prevClose: today[today.length - 2].close,
  };
}

/** 1. Opening-range breakout, held to the close. */
export function orbHold(over = {}) {
  const p = { rsMin: 0.5, volMin: 1.5, maxRangePct: 2.5, ...over };
  const window = { label: "Between 10:00 AM and 1:00 PM", test: (_r, ctx) => minutesBetween(600, 780)(ctx) };
  const rangeOk = {
    label: `Opening range narrower than ${p.maxRangePct}% (not already exhausted)`,
    test: (r, ctx) => {
      const rg = openingRange(ctx);
      return rg != null && ((rg.high - rg.low) / r.close) * 100 <= p.maxRangePct;
    },
  };
  return build({
    id: over.id ?? "research-orb-hold",
    name: "Breakout held to close",
    tagline: "Fresh 15-min break of the 9:15–9:45 range, with Nifty and volume",
    plain: null,
    noEntryAfterMin: 13 * 60,
    longChecks: [
      window,
      { label: "15-min close breaks above the opening range", test: (r, ctx) => { const rg = openingRange(ctx); return rg != null && r.close > rg.high && rg.prevClose <= rg.high; } },
      { label: "Nifty up since the open", test: (_r, ctx) => (ctx.index?.pctFromOpen ?? 0) > 0 },
      { label: `Beating Nifty by ≥ ${p.rsMin}%`, test: (_r, ctx) => (ctx.relStrength ?? -99) >= p.rsMin },
      rangeOk,
      volAtLeast(p.volMin),
      atrAtLeast(0.25),
    ],
    shortChecks: [
      window,
      { label: "15-min close breaks below the opening range", test: (r, ctx) => { const rg = openingRange(ctx); return rg != null && r.close < rg.low && rg.prevClose >= rg.low; } },
      { label: "Nifty down since the open", test: (_r, ctx) => (ctx.index?.pctFromOpen ?? 0) < 0 },
      { label: `Lagging Nifty by ≥ ${p.rsMin}%`, test: (_r, ctx) => (ctx.relStrength ?? 99) <= -p.rsMin },
      rangeOk,
      volAtLeast(p.volMin),
      atrAtLeast(0.25),
    ],
    score: (ctx) => Math.abs(ctx.relStrength ?? 0),
  });
}

/** 2. Relative-strength leaders, decided once at 10:15. */
export function rsLeaders(over = {}) {
  const p = { rsMin: 1.5, moveMin: 1.5, volMin: 2, indexMin: 0.2, ...over };
  const at1015 = { label: "At the 10:15 AM check", test: (_r, ctx) => minutesBetween(615, 629)(ctx) };
  return build({
    id: over.id ?? "research-rs-leaders",
    name: "10:15 strength leaders",
    tagline: "Stocks far ahead of Nifty by 10:15, in Nifty's direction, held to close",
    plain: null,
    noEntryAfterMin: 10 * 60 + 45,
    exits: { stopAtr: 2.0, trailAtr: 3.0 },
    longChecks: [
      at1015,
      { label: `Nifty up ≥ ${p.indexMin}%`, test: (_r, ctx) => (ctx.index?.pctFromOpen ?? 0) >= p.indexMin },
      { label: `Up ≥ ${p.moveMin}% since the open`, test: (_r, ctx) => (ctx.pctFromOpen ?? 0) >= p.moveMin },
      { label: `Beating Nifty by ≥ ${p.rsMin}%`, test: (_r, ctx) => (ctx.relStrength ?? -99) >= p.rsMin },
      { label: "Above today's VWAP", test: (r, ctx) => ctx.vwap != null && r.close > ctx.vwap },
      volAtLeast(p.volMin),
      atrAtLeast(0.25),
    ],
    shortChecks: [
      at1015,
      { label: `Nifty down ≥ ${p.indexMin}%`, test: (_r, ctx) => (ctx.index?.pctFromOpen ?? 0) <= -p.indexMin },
      { label: `Down ≥ ${p.moveMin}% since the open`, test: (_r, ctx) => (ctx.pctFromOpen ?? 0) <= -p.moveMin },
      { label: `Lagging Nifty by ≥ ${p.rsMin}%`, test: (_r, ctx) => (ctx.relStrength ?? 99) <= -p.rsMin },
      { label: "Below today's VWAP", test: (r, ctx) => ctx.vwap != null && r.close < ctx.vwap },
      volAtLeast(p.volMin),
      atrAtLeast(0.25),
    ],
    score: (ctx) => Math.abs(ctx.relStrength ?? 0),
  });
}

/** 3. Gap continuation: a big opening gap that holds through the first 30–45 minutes. */
export function gapGo(over = {}) {
  const p = { gapMin: 1.0, volMin: 1.5, ...over };
  const window = { label: "At the 9:45 or 10:00 AM check", test: (_r, ctx) => minutesBetween(585, 600)(ctx) };
  const todayLowHigh = (ctx) => {
    const today = sessionBars(ctx.bars?.["3m"] ?? [], ctx.now);
    return today.length
      ? { low: Math.min(...today.map((b) => b.low)), high: Math.max(...today.map((b) => b.high)), open: today[0].open }
      : null;
  };
  return build({
    id: over.id ?? "research-gap-go",
    name: "Gap continuation",
    tagline: "Gapped ≥1% and held the gap through the first 30–45 minutes",
    plain: null,
    noEntryAfterMin: 10 * 60 + 15,
    longChecks: [
      window,
      { label: `Gapped up ≥ ${p.gapMin}%`, test: (_r, ctx) => (ctx.gapPct ?? 0) >= p.gapMin },
      {
        label: "Held at least half the gap all morning",
        test: (_r, ctx) => {
          const t = todayLowHigh(ctx);
          const pc = ctx.daily?.prevClose;
          return t != null && pc > 0 && t.low > pc + 0.5 * (t.open - pc);
        },
      },
      { label: "Trading above today's open", test: (r, ctx) => { const t = todayLowHigh(ctx); return t != null && r.close >= t.open; } },
      { label: "Nifty not falling hard", test: (_r, ctx) => (ctx.index?.pctFromOpen ?? 0) > -0.3 },
      volAtLeast(p.volMin),
      atrAtLeast(0.25),
    ],
    shortChecks: [
      window,
      { label: `Gapped down ≥ ${p.gapMin}%`, test: (_r, ctx) => (ctx.gapPct ?? 0) <= -p.gapMin },
      {
        label: "Held at least half the gap all morning",
        test: (_r, ctx) => {
          const t = todayLowHigh(ctx);
          const pc = ctx.daily?.prevClose;
          return t != null && pc > 0 && t.high < pc - 0.5 * (pc - t.open);
        },
      },
      { label: "Trading below today's open", test: (r, ctx) => { const t = todayLowHigh(ctx); return t != null && r.close <= t.open; } },
      { label: "Nifty not rising hard", test: (_r, ctx) => (ctx.index?.pctFromOpen ?? 0) < 0.3 },
      volAtLeast(p.volMin),
      atrAtLeast(0.25),
    ],
    score: (ctx) => Math.abs(ctx.gapPct ?? 0),
  });
}

/** The research books the 12-month replay runs with --research. */
export const RESEARCH_BOOKS = [orbHold(), rsLeaders(), gapGo()];
