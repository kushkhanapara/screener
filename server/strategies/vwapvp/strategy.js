import { atrPct } from "../context.js";
import { istMinutes } from "../../core/session.js";
import { vwapSeries, sessionAnchor, weekAnchor, fractalSwings } from "./vwapBands.js";
import { volumeProfile, dualPoc, consolidationBox } from "./volumeProfile.js";
import { classifyRegime } from "./regime.js";
import * as vpEngine from "./engine.js";

/**
 * VWAP + Volume Profile — Trader Dale's two setups, on 3-minute cash bars.
 *
 *   Trend pullback  VWAP bands sloping: buy a pullback into VWAP or the upper
 *                   1σ band (sell the mirror), where two volume profiles agree
 *                   on the same price.
 *   Rotation        bands flat: buy the lower 1σ band, sell the upper, target
 *                   VWAP.
 *
 * No isolated band touch is traded. Each candidate level is scored on three
 * conditions, and at least `minConfluence` must hold:
 *
 *   A  the signal bar closed within proximityAtr × ATR of the level
 *   B  a dual-POC level — the consolidation box's POC and the trend leg's POC
 *      within pocMatchAtr × ATR of each other — sits within pocDistAtr × ATR of
 *      the level (the trend setup requires B)
 *   C  the level or the dual POC is within srAtr × ATR of a confirmed swing
 *      high or low
 *
 * Entry is on a CLOSED reaction bar (close beyond open, wick ≥ wickPct of the
 * range), filled at the next bar's open by the engine. A resting limit order at
 * the level cannot be modelled by the engine, so that variant is not offered.
 *
 * Levels (one lot, so TP1 moves the stop instead of halving the position):
 *   stop     1 × ATR behind the zone: min(level, dual POC, VWAP for trend)
 *   exit     a bar closing beyond that zone ends the trade ("invalidated")
 *   trend    break-even at the prior swing high/low, then a 1.5 × ATR trail
 *   rotation target at VWAP, only when that is ≥ minRR × the risk
 *
 * Everything is computed from ctx.bars — closed bars only — so the replay and
 * live read the same inputs, and the other strategies pay nothing for it.
 *
 * Paper-traded live beside the other strategies (strategies/index.js), but its
 * exits run through its own ./engine.js, which layers on the shared paper
 * engine without modifying it. Compare its setups with `npm run replay -- --vwapvp`.
 */

export const VWAP_VP_DEFAULTS = Object.freeze({
  modes: ["trend", "rotation"],
  anchor: "session", // "session" (09:15 reset) or "week" (Monday 09:15, from 15-minute bars)
  startMin: 9 * 60 + 30, // no signals while the day's VWAP is still settling
  bandK: 1, // band width in σ

  regimeBars: 10, // M: trailing values fitted for the slope
  regimeEpsAtr: 0.05, // ε = this × ATR, per bar
  regimeSource: "vwap", // "vwap" | "upper" (as first specified) | "bands"

  touchAtr: 0.1, // slack for "the bar reached the level"
  proximityAtr: 0.3, // condition A
  pocMatchAtr: 0.25, // two POCs agree within this
  pocDistAtr: 0.3, // condition B: dual POC near the level
  srAtr: 0.3, // condition C: near a swing high/low
  minConfluence: 2,

  swingBars: 10, // fractal N: bars each side of a swing point
  boxBars: 10, // consolidation box length (the heaviest window this narrow)
  boxMaxRangeAtr: 3, // a box wider than this is not a consolidation
  legMinBars: 10, // shorter legs fall back to the whole session
  binPct: 0.0015, // profile bin width, as a fraction of price
  nodePct: 0.7,

  wickPct: 0.4, // reaction bar: rejecting wick ≥ this share of the range
  stopAtr: 1.0, // stop distance behind the zone
  maxStopAtr: 3.0, // skip when the zone puts the stop further than this from the close
  invalidateOnClose: true,
  trailAtr: 1.5,
  minRR: 1.5, // rotation: target ÷ risk
  minTargetPct: 0.25, // rotation: target at least this % away, or charges eat it

  atrPctMin: 0.1,
  minSessionVolume: 50_000,
});

const NONE = Object.freeze({ side: null, reasons: [], score: null });
const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : "—");

/** Session (or week) VWAP bands, their series for the regime, and the ATR they are judged against. */
function bandsOf(ctx, p) {
  if (p.anchor === "week") {
    const b15 = ctx.bars?.["15m"];
    const a = weekAnchor(b15, ctx.now);
    if (!a.complete) return null; // the window no longer reaches Monday's open
    return { series: vwapSeries(b15, a.index, p.bandK), regimeAtr: ctx.atr?.["15m"] };
  }
  const b3 = ctx.bars?.["3m"];
  const a = sessionAnchor(b3, ctx.now);
  if (a.index < 0) return null;
  return { series: vwapSeries(b3, a.index, p.bandK), regimeAtr: ctx.atr?.["3m"], anchor: a.index };
}

/** Close beyond open with a rejecting wick on the side the trade is taken from. */
export function isReactionBar(bar, side, wickPct) {
  const range = bar.high - bar.low;
  if (!(range > 0)) return false;
  if (side === "long") return bar.close > bar.open && Math.min(bar.open, bar.close) - bar.low >= wickPct * range;
  return bar.close < bar.open && bar.high - Math.max(bar.open, bar.close) >= wickPct * range;
}

/**
 * The two profiles: the trend leg (from the session's extreme against the
 * trade to the bar before the signal, or the whole session for rotation), and
 * the heaviest narrow box inside that leg.
 */
function profilesOf(sessionBars, side, setup, atr, p) {
  const body = sessionBars.slice(0, -1); // the signal bar is the reaction, not the structure
  let start = 0;
  if (setup === "trend" && body.length) {
    const key = side === "long" ? "low" : "high";
    const better = side === "long" ? (a, b) => a < b : (a, b) => a > b;
    for (let i = 1; i < body.length; i++) if (better(body[i][key], body[start][key])) start = i;
    if (body.length - start < p.legMinBars) start = 0;
  }
  const leg = body.slice(start);
  const box = consolidationBox(leg, p.boxBars, p.boxMaxRangeAtr * atr);
  const opt = { binPct: p.binPct, nodePct: p.nodePct };
  const legProfile = volumeProfile(leg, opt);
  const boxProfile = box ? volumeProfile(leg.slice(box.start, box.end + 1), opt) : null;
  return { legProfile, boxProfile, dual: dualPoc(boxProfile, legProfile, p.pocMatchAtr * atr) };
}

export function vwapVolumeProfile(over = {}) {
  const { id, name, ...rest } = over;
  const p = { ...VWAP_VP_DEFAULTS, ...rest };
  const trendOn = p.modes.includes("trend");
  const rotationOn = p.modes.includes("rotation");

  /** Candidate levels for a side under the regime, in order of preference. */
  function levelsFor(regime, bands) {
    const out = [];
    if (trendOn && regime === "up") out.push(["long", "trend", "VWAP", bands.vwap], ["long", "trend", "upper band", bands.upper]);
    if (trendOn && regime === "down") out.push(["short", "trend", "VWAP", bands.vwap], ["short", "trend", "lower band", bands.lower]);
    if (rotationOn && regime === "rotation") out.push(["long", "rotation", "lower band", bands.lower], ["short", "rotation", "upper band", bands.upper]);
    return out;
  }

  function evaluate(ctx) {
    const bars = ctx.bars?.["3m"];
    const atr = ctx.atr?.["3m"];
    if (!bars?.length || !(atr > 0)) return NONE;
    if (istMinutes(ctx.now) < p.startMin) return NONE;
    const bar = bars[bars.length - 1];
    if ((atrPct(atr, bar.close) ?? 0) < p.atrPctMin) return NONE;
    if (!(ctx.sessionVolume >= p.minSessionVolume)) return NONE;

    const b = bandsOf(ctx, p);
    if (!b) return NONE;
    const s = b.series;
    const last = s.vwap.length - 1;
    if (last < 0 || s.vwap[last] == null) return NONE;
    const bands = { vwap: s.vwap[last], upper: s.upper[last], lower: s.lower[last], sigma: s.sigma[last] };
    const reg = classifyRegime(s, b.regimeAtr, { bars: p.regimeBars, epsAtr: p.regimeEpsAtr, source: p.regimeSource });
    if (!reg) return NONE;

    const tol = p.touchAtr * atr;
    // Cheap checks first: most bars touch nothing, so the profiles and swing
    // points are only built for a bar that reacted at a level.
    const touched = levelsFor(reg.regime, bands).filter(([side, , , L]) =>
      side === "long"
        ? bar.low <= L + tol && bar.close >= L && isReactionBar(bar, "long", p.wickPct)
        : bar.high >= L - tol && bar.close <= L && isReactionBar(bar, "short", p.wickPct)
    );
    if (!touched.length) return NONE;

    const sessionBars = b.anchor != null ? bars.slice(b.anchor) : bars.slice(sessionAnchor(bars, ctx.now).index);
    const swings = fractalSwings(bars, p.swingBars);
    const srNear = (x) => x != null && swings.some((w) => Math.abs(w.price - x) <= p.srAtr * atr);

    let best = null;
    for (const [side, setup, label, L] of touched) {
      const { dual } = profilesOf(sessionBars, side, setup, atr, p);
      const A = Math.abs(bar.close - L) <= p.proximityAtr * atr;
      const B = dual != null && Math.abs(dual.price - L) <= p.pocDistAtr * atr;
      const C = srNear(L) || (B && srNear(dual.price));
      const confluence = [A, B, C].filter(Boolean).length;
      if (confluence < p.minConfluence) continue;
      if (setup === "trend" && !B) continue;

      // The zone the trade leans on, and the stop behind it.
      const dir = side === "long" ? 1 : -1;
      const pick = side === "long" ? Math.min : Math.max;
      const zone = pick(L, B ? dual.price : L, setup === "trend" ? bands.vwap : L);
      const stop = zone - dir * p.stopAtr * atr;
      const risk = dir * (bar.close - stop);
      if (!(risk > 0) || risk > p.maxStopAtr * atr) continue;

      let target = null;
      let breakevenAt = null;
      let rr = null;
      if (setup === "rotation") {
        target = bands.vwap;
        const reward = dir * (target - bar.close);
        rr = reward / risk;
        if (!(rr >= p.minRR) || (reward / bar.close) * 100 < p.minTargetPct) continue;
      } else {
        // TP1: the nearest prior swing extreme in the trade's direction.
        const ahead = swings
          .filter((w) => w.type === (side === "long" ? "high" : "low") && dir * (w.price - bar.close) > 0)
          .map((w) => w.price);
        if (ahead.length) breakevenAt = side === "long" ? Math.min(...ahead) : Math.max(...ahead);
      }

      const score = confluence + (rr ?? 0) / 10;
      if (best && best.score >= score) continue;
      best = {
        side,
        setup,
        score,
        stop,
        target,
        breakevenAt,
        invalidateAt: p.invalidateOnClose ? zone : null,
        reasons: [
          setup === "trend"
            ? `${reg.regime === "up" ? "Uptrend" : "Downtrend"}: VWAP slope ${fmt(reg.slope)}/bar vs ε ${fmt(reg.eps)}`
            : `Rotation: VWAP slope ${fmt(reg.slope)}/bar within ±${fmt(reg.eps)}`,
          `${side === "long" ? "Bullish" : "Bearish"} reaction bar at the ${label} (${fmt(L)})`,
          ...(A ? [`A: closed within ${p.proximityAtr} ATR of the ${label}`] : []),
          ...(B ? [`B: box and leg POCs agree at ${fmt(dual.price)}`] : []),
          ...(C ? ["C: at a prior swing high/low"] : []),
          `Stop ${fmt(stop)}, ${p.stopAtr} ATR behind the zone at ${fmt(zone)}`,
          setup === "rotation"
            ? `Target VWAP ${fmt(target)} (${rr.toFixed(2)}R)`
            : breakevenAt != null
            ? `Break-even at the prior swing ${fmt(breakevenAt)}, then ${p.trailAtr} ATR trail`
            : `Break-even at +1R, then ${p.trailAtr} ATR trail`,
        ],
      };
    }
    return best ?? NONE;
  }

  const condition = (side) => [
    `After ${Math.floor(p.startMin / 60)}:${String(p.startMin % 60).padStart(2, "0")} AM`,
    ...(trendOn
      ? [
          `Trend: VWAP sloping ${side === "long" ? "up" : "down"}; ${side === "long" ? "bullish" : "bearish"} reaction bar at VWAP or the ${side === "long" ? "upper" : "lower"} ${p.bandK}σ band, with the box and leg POCs agreeing there`,
        ]
      : []),
    ...(rotationOn
      ? [`Rotation: VWAP flat; ${side === "long" ? "bullish" : "bearish"} reaction bar at the ${side === "long" ? "lower" : "upper"} ${p.bandK}σ band; VWAP ≥ ${p.minRR}R away`]
      : []),
    `At least ${p.minConfluence} of: close near the level · dual-POC level · prior swing high/low`,
    `Volatility ≥ ${p.atrPctMin}% ATR, liquid enough to trade`,
  ];

  return Object.freeze({
    id: id ?? "vwap-volume-profile",
    name: name ?? "VWAP + Volume Profile",
    tagline: "Pullbacks to VWAP in trends, band-to-VWAP rotation in ranges, at volume confluence",
    description: { long: condition("long"), short: condition("short") },
    plain: {
      summary:
        "Trades around today's average traded price (VWAP). When a stock is trending it buys the dip back to that average; when it is going sideways it buys near the bottom of its usual range and sells near the top, aiming back at the average. It only trades where a lot of volume changed hands before.",
      buy: [
        "Trending up: price dips back to today's average price (VWAP) or the line just above it, and the 3-minute bar closes back up with a clear lower wick",
        "Sideways: price touches the bottom of its usual range around VWAP and bounces the same way",
        "At least two reasons agree on the price: it closed right at the line, heavy volume traded there earlier, or it was a turning point before",
        "Stop loss just below that heavy-volume zone; if a bar closes below the zone the trade is closed early",
        "Sideways trades take profit back at VWAP, and only when that is at least 1.5× the risk",
        "Trending trades move the stop to entry at the previous high, then trail it to let the winner run",
        "Only after 9:30 AM, and no new trades after 2:30 PM",
      ],
      sell: [
        "Trending down: price rallies back to today's average price (VWAP) or the line just below it, and the 3-minute bar closes back down with a clear upper wick",
        "Sideways: price touches the top of its usual range around VWAP and turns down the same way",
        "At least two reasons agree on the price: it closed right at the line, heavy volume traded there earlier, or it was a turning point before",
        "Stop loss just above that heavy-volume zone; if a bar closes above the zone the trade is closed early",
        "Sideways trades take profit back at VWAP, and only when that is at least 1.5× the risk",
        "Trending trades move the stop to entry at the previous low, then trail it to let the winner run",
        "Only after 9:30 AM, and no new trades after 2:30 PM",
      ],
    },
    params: p,
    timeframes: { trend: "3m", trigger: "3m" },
    exits: {
      stopAtr: p.stopAtr, // fallback only: signals carry their own stop
      trailAtr: p.trailAtr,
      breakevenAtR: 1.0, // fallback when no prior swing lies ahead
      targetR: 20, // trend trades run on the trail; rotation carries its own target
      timeStopBars: 10_000,
      squareOffMin: 15 * 60 + 15,
      noEntryAfterMin: 14 * 60 + 30,
    },
    regimeFilter: false,
    noRetryAfterLoss: true,
    // The replay and the paper service use this instead of the shared engine.
    engine: vpEngine,
    evaluate,
  });
}

export default vwapVolumeProfile();
