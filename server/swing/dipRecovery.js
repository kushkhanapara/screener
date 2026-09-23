/**
 * Daily "dip and recovery" swing test — research only, never traded live.
 *
 * The pattern (from Upstox's MTF idea): the stock dipped below yesterday's
 * close during the day, then closed at least 1% above today's open. The short
 * is the mirror: poked above yesterday's close, closed at least 1% below the
 * open. "Baseline" drops the dip condition (any strong candle) so the test can
 * show whether the dip adds anything.
 *
 * Signals use only the signal day's completed candle; entry is the next day's
 * open. Stops are checked on daily candles: a gap through the stop fills at
 * the open, otherwise at the stop.
 */

export const SWING = Object.freeze({
  bodyPct: 1.0, // close vs open, %
  minPrice: 30,
  minVolume: 30_000,
  lookback3m: 63, // trading days in ~3 months
  atrDays: 14,
  costPct: 0.00065, // charges per round trip, share of notional
  trailMaxDays: 20,
});

export const dateOf = (c) => String(c.time).slice(0, 10);

/** Simple average true range over the `n` candles ending at index i (inclusive). */
export function atrAt(candles, i, n = SWING.atrDays) {
  if (i < n) return null;
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const c = candles[k];
    const pc = candles[k - 1].close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  }
  return sum / n;
}

/**
 * The signal on candle i, or null.
 * @param {"pattern"|"baseline"} kind
 * @returns {{side:"long"|"short", score:number}|null}
 */
export function signalAt(candles, i, kind, cfg = SWING) {
  if (i < Math.max(cfg.lookback3m, cfg.atrDays + 1)) return null;
  const c = candles[i];
  const prev = candles[i - 1];
  if (!(c.close > cfg.minPrice) || !(c.volume > cfg.minVolume)) return null;
  const body = ((c.close - c.open) / c.open) * 100;
  const window = candles.slice(i - cfg.lookback3m, i);
  if (body >= cfg.bodyPct) {
    const low3m = Math.min(...window.map((x) => x.low));
    const dip = c.low < prev.close;
    if (c.high > low3m && (kind === "baseline" || dip)) return { side: "long", score: body };
  }
  if (body <= -cfg.bodyPct) {
    const high3m = Math.max(...window.map((x) => x.high));
    const poke = c.high > prev.close;
    if (c.low < high3m && (kind === "baseline" || poke)) return { side: "short", score: -body };
  }
  return null;
}

/**
 * Follow one trade from the day after signal day `i`.
 * @param {{stop:"signal"|"atr2", exit:number|"trail"}} v  exit = days to hold, or a 3×ATR trail
 * @returns {null|{entryDate,exitDate,entryIdx,exitIdx,entry,exit,risk,r,costR,reason}}
 */
export function simulate(candles, i, side, v, cfg = SWING) {
  const e = i + 1;
  if (e >= candles.length) return null;
  const sig = candles[i];
  const entry = candles[e].open;
  const atr = atrAt(candles, i, cfg.atrDays);
  if (!(atr > 0)) return null;
  const dir = side === "long" ? 1 : -1;
  let stop = v.stop === "signal" ? (side === "long" ? sig.low : sig.high) : entry - dir * (v.stopAtr ?? 2) * atr;
  const risk = dir * (entry - stop);
  if (!(risk > 0)) return null; // opened through the stop already
  const maxDays = v.exit === "trail" || v.exit === "original" ? cfg.trailMaxDays : v.exit;
  const target = v.exit === "original" ? entry + dir * v.targetR * risk : null;
  let best = entry;
  let exitIdx = null;
  let exit = null;
  let reason = null;
  for (let d = e; d < candles.length && d < e + maxDays; d++) {
    const c = candles[d];
    const gapThrough = d > e && dir * (c.open - stop) <= 0;
    if (gapThrough) {
      [exitIdx, exit, reason] = [d, c.open, "gap through stop"];
      break;
    }
    if (dir * ((side === "long" ? c.low : c.high) - stop) <= 0) {
      [exitIdx, exit, reason] = [d, stop, (v.exit === "trail" || v.exit === "original") && dir * (stop - entry) >= 0 ? (stop === entry ? "breakeven" : "trail") : "stop"];
      break;
    }
    if (target != null && dir * ((side === "long" ? c.high : c.low) - target) >= 0) {
      [exitIdx, exit, reason] = [d, dir * (c.open - target) > 0 ? c.open : target, "target"];
      break;
    }
    if (v.exit === "original") {
      // The intraday exits on daily candles: breakeven at +1R, then an ATR trail.
      best = side === "long" ? Math.max(best, c.high) : Math.min(best, c.low);
      if (dir * (best - entry) >= v.breakevenAtR * risk && dir * (entry - stop) > 0) stop = entry;
      const a = atrAt(candles, d, cfg.atrDays) ?? atr;
      const trail = best - dir * v.trailAtr * a;
      if (dir * (best - entry) >= v.breakevenAtR * risk && dir * (trail - stop) > 0) stop = trail;
    }
    if (v.exit === "trail") {
      best = side === "long" ? Math.max(best, c.close) : Math.min(best, c.close);
      const a = atrAt(candles, d, cfg.atrDays) ?? atr;
      const trail = best - dir * 3 * a;
      if (dir * (trail - stop) > 0) stop = trail;
    }
  }
  if (exitIdx == null) {
    const last = Math.min(candles.length - 1, e + maxDays - 1);
    if (last < e + maxDays - 1) return null; // data ends before the trade would finish
    [exitIdx, exit, reason] = [last, candles[last].close, "time"];
  }
  const costR = (entry * cfg.costPct) / risk;
  return {
    entryDate: dateOf(candles[e]),
    exitDate: dateOf(candles[exitIdx]),
    entryIdx: e,
    exitIdx,
    entry,
    exit,
    risk,
    r: (dir * (exit - entry)) / risk - costR,
    costR,
    reason,
  };
}

/** Exit variants the test tries (chosen on the older year only). */
export const VARIANTS = ["signal", "atr2"].flatMap((stop) =>
  [3, 5, 10, "trail"].map((exit) => ({ stop, exit, tag: `stop ${stop === "signal" ? "signal-day low/high" : "2×ATR"}, ${exit === "trail" ? "3×ATR trail (≤20d)" : `hold ${exit}d`}` }))
);
