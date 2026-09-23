import { sessionBars } from "../core/session.js";

/**
 * Is today a trending day for the market, so far?
 *
 * The paper strategies all chase momentum. On 16 Sept Nifty stayed within
 * ~0.3% of its open all day; the strategies took 128 trades and lost on both
 * sides, because every move reversed. This measures, from Nifty's own bars up
 * to now (never the future), whether the day is going somewhere:
 *
 *   movePct    — Nifty's move since the open, in %.
 *   efficiency — net move ÷ total distance travelled bar to bar (0..1). A
 *                straight trend scores near 1; back-and-forth chop near 0.
 *
 * Research only until the replay shows it helps across many days.
 */

export function dayTrend(indexBars, now = Date.now()) {
  const bars = sessionBars(indexBars ?? [], now);
  if (!bars.length) return { bars: 0, movePct: null, efficiency: null, direction: null };
  const open = bars[0].open;
  const last = bars[bars.length - 1].close;
  let path = Math.abs(bars[0].close - open);
  for (let i = 1; i < bars.length; i++) path += Math.abs(bars[i].close - bars[i - 1].close);
  const net = last - open;
  return {
    bars: bars.length,
    movePct: open > 0 ? (net / open) * 100 : null,
    efficiency: path > 0 ? Math.abs(net) / path : 0,
    direction: net > 0 ? "up" : net < 0 ? "down" : null,
  };
}

/**
 * Why a trade should be skipped on the kind of day it is, or null to allow it.
 * @param {{minBars:number, minMovePct:number, minEfficiency:number}} cfg
 */
export function trendDayVeto(trend, side, cfg) {
  if (trend.bars < cfg.minBars) return "too early to judge the day";
  const move = trend.movePct ?? 0;
  const sign = `${move >= 0 ? "+" : "−"}${Math.abs(move).toFixed(2)}%`;
  if (Math.abs(move) < cfg.minMovePct) return `Nifty flat today (${sign})`;
  if ((trend.efficiency ?? 0) < cfg.minEfficiency) return `Nifty choppy today (${sign})`;
  if ((side === "long") !== (trend.direction === "up")) return `against Nifty's direction today (${sign})`;
  return null;
}

/**
 * Day-type switch: which kind of strategy may trade right now.
 *
 * Thresholds come from the 19-session replay (20 Aug – 16 Sept): momentum
 * strategies only made money when Nifty had moved ≥0.4% from its open in a
 * fairly straight line. Bump `version` whenever a number changes.
 */
export const DAY_TYPE = Object.freeze({
  version: 1,
  minBars: 10, // ~30 minutes before judging the day
  trend: Object.freeze({ minMovePct: 0.4, minEfficiency: 0.4 }),
  flat: Object.freeze({ maxMovePct: 0.3, maxEfficiency: 0.3 }),
});

/** Day types a strategy can ask for in `dayTypes`. */
export const DAY_TYPES = Object.freeze(["trend", "flat"]);

/** "trend-up" | "trend-down" | "flat" | "unclear" | "early", from Nifty's bars so far. */
export function classifyDay(trend, cfg = DAY_TYPE) {
  if (!trend || trend.bars < cfg.minBars) return "early";
  const move = Math.abs(trend.movePct ?? 0);
  const eff = trend.efficiency ?? 0;
  if (move >= cfg.trend.minMovePct && eff >= cfg.trend.minEfficiency) {
    return trend.direction === "up" ? "trend-up" : "trend-down";
  }
  if (move < cfg.flat.maxMovePct || eff < cfg.flat.maxEfficiency) return "flat";
  return "unclear";
}

/**
 * Why this strategy may not trade on the day as it stands, or null to allow it.
 * Strategies without `dayTypes` trade on any day.
 */
export function dayTypeVeto(strategy, trend, side, cfg = DAY_TYPE) {
  const allowed = strategy?.dayTypes;
  if (!allowed?.length) return null;
  const type = classifyDay(trend, cfg);
  const move = trend?.movePct ?? 0;
  const m = `Nifty ${move >= 0 ? "+" : "−"}${Math.abs(move).toFixed(2)}%`;

  if (type === "early") return "Too early to judge the day";
  if (type.startsWith("trend") && allowed.includes("trend")) {
    const up = type === "trend-up";
    return (side === "long") === up ? null : `Against today's trend (${m})`;
  }
  if (type === "flat" && allowed.includes("flat")) return null;

  if (allowed.includes("trend")) {
    return type === "flat" ? `Not a trend day — flat or choppy (${m})` : `Not a trend day — unclear (${m})`;
  }
  return type.startsWith("trend")
    ? `Not a flat day — trending ${type === "trend-up" ? "up" : "down"} (${m})`
    : `Not a flat day — unclear (${m})`;
}
