import { barTimeMs, sessionStartMs, istDay } from "../../core/session.js";
import { IST_OFFSET_MIN, MARKET_OPEN_MIN } from "../../config.js";

/**
 * VWAP with standard-deviation bands, from any anchor bar.
 *
 * Three running sums — Σ(TP·V), Σ(V) and Σ(V·TP²) — give both the VWAP and the
 * volume-weighted variance in O(1) per bar:
 *
 *   VWAP = Σ(TP·V) / Σ(V)
 *   σ²   = Σ(V·(TP − VWAP)²) / Σ(V) = Σ(V·TP²) / Σ(V) − VWAP²
 *
 * TP is the typical price (H + L + C) / 3. Bars without volume leave the sums
 * unchanged, so their output repeats the previous value; before the first bar
 * with volume the output is null, which is the honest answer (see anchoredVwap
 * in session.js for why live bars can carry zero volume).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * VWAP, σ and ±k·σ bands for every bar from `anchor` to the end.
 *
 * @param {Array<{high:number,low:number,close:number,volume:number}>} bars ascending
 * @param {number} [anchor] index of the first bar in the sums
 * @param {number} [k] band width in σ
 * @returns {{vwap:(number|null)[], sigma:(number|null)[], upper:(number|null)[], lower:(number|null)[]}}
 *   arrays aligned to bars.slice(anchor)
 */
export function vwapSeries(bars, anchor = 0, k = 1) {
  const out = { vwap: [], sigma: [], upper: [], lower: [] };
  if (!Array.isArray(bars) || anchor < 0) return out;
  let pv = 0;
  let v = 0;
  let pv2 = 0;
  for (let i = anchor; i < bars.length; i++) {
    const b = bars[i];
    const vol = Number(b.volume) || 0;
    const tp = (b.high + b.low + b.close) / 3;
    if (vol > 0 && Number.isFinite(tp)) {
      pv += tp * vol;
      v += vol;
      pv2 += tp * tp * vol;
    }
    if (v > 0) {
      const vwap = pv / v;
      // Rounding can push a flat series a hair below zero.
      const sigma = Math.sqrt(Math.max(0, pv2 / v - vwap * vwap));
      out.vwap.push(vwap);
      out.sigma.push(sigma);
      out.upper.push(vwap + k * sigma);
      out.lower.push(vwap - k * sigma);
    } else {
      out.vwap.push(null);
      out.sigma.push(null);
      out.upper.push(null);
      out.lower.push(null);
    }
  }
  return out;
}

/** The latest VWAP/σ/band values from `anchor`, or null when there is no volume. */
export function vwapBandsAt(bars, anchor = 0, k = 1) {
  const s = vwapSeries(bars, anchor, k);
  const i = s.vwap.length - 1;
  if (i < 0 || s.vwap[i] == null) return null;
  return { vwap: s.vwap[i], sigma: s.sigma[i], upper: s.upper[i], lower: s.lower[i] };
}

/**
 * First bar at or after `startMs`, and whether the window reaches back that far.
 *
 * `complete` is false when the first bar in the window is already past the
 * anchor: the store keeps a rolling window, so bars from the start of the
 * anchor period may have been trimmed, and a VWAP over what is left would be
 * silently wrong rather than obviously missing.
 */
export function anchorAt(bars, startMs) {
  if (!Array.isArray(bars) || !bars.length) return { index: -1, complete: false };
  const index = bars.findIndex((b) => barTimeMs(b.time) >= startMs);
  return { index, complete: index > 0 };
}

/** Daily anchor: the 09:15 IST open of the session containing `now`. Always complete when bars exist. */
export function sessionAnchor(bars, now = Date.now()) {
  const start = sessionStartMs(now);
  const index = (bars ?? []).findIndex((b) => barTimeMs(b.time) >= start);
  return { index, complete: index >= 0 };
}

/** 09:15 IST on the Monday of the week containing the session of `now`. */
export function weekStartMs(now = Date.now()) {
  const start = sessionStartMs(now);
  const back = (istDay(start) + 6) % 7; // Mon → 0, Tue → 1 … Sun → 6
  return start - back * DAY_MS;
}

/** Weekly anchor: the first bar of the week, which is Monday's 09:15 bar unless Monday was a holiday. */
export function weekAnchor(bars, now = Date.now()) {
  return anchorAt(bars, weekStartMs(now));
}

/** 09:15 IST on 1 January of the IST year containing `now`. */
export function yearStartMs(now = Date.now()) {
  const y = new Date(now + IST_OFFSET_MIN * 60 * 1000).getUTCFullYear();
  return Date.UTC(y, 0, 1) + (MARKET_OPEN_MIN - IST_OFFSET_MIN) * 60 * 1000;
}

/**
 * Yearly anchor: the first session of the year. Meant for daily candles, whose
 * `time` is the session date, so the anchor is the first bar on or after 1 Jan.
 */
export function yearAnchor(bars, now = Date.now()) {
  const y = new Date(now + IST_OFFSET_MIN * 60 * 1000).getUTCFullYear();
  return anchorAt(bars, Date.UTC(y, 0, 1) - IST_OFFSET_MIN * 60 * 1000);
}

/**
 * Confirmed fractal swing points.
 *
 * Bar i is a swing high when its high is the highest of the N bars on each
 * side (ties go to the earliest bar), and likewise for lows. A swing can only
 * be KNOWN N bars after it happened, so points whose right-hand side has not
 * finished yet are left out. Using them early would be look-ahead: the
 * backtest would "know" a top that live trading could not yet see.
 *
 * @returns {Array<{index:number, price:number, type:"high"|"low", confirmedAt:number}>} ascending by index
 */
export function fractalSwings(bars, n = 10) {
  const out = [];
  if (!Array.isArray(bars) || n < 1) return out;
  for (let i = n; i + n < bars.length; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    let isHigh = Number.isFinite(h);
    let isLow = Number.isFinite(l);
    for (let j = i - n; j <= i + n && (isHigh || isLow); j++) {
      if (j === i) continue;
      // Strict on the left, non-strict on the right: of two equal highs, only
      // the first is the swing.
      if (isHigh && (j < i ? bars[j].high >= h : bars[j].high > h)) isHigh = false;
      if (isLow && (j < i ? bars[j].low <= l : bars[j].low < l)) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: h, type: "high", confirmedAt: i + n });
    if (isLow) out.push({ index: i, price: l, type: "low", confirmedAt: i + n });
  }
  return out;
}

/**
 * Opening-gap anchors: the first bar of each session whose open is at least
 * `minPct` (0.008 = 0.8%) away from the previous session's last close.
 * @returns {number[]} bar indices
 */
export function gapAnchors(bars, minPct = 0.008) {
  const out = [];
  if (!Array.isArray(bars)) return out;
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    if (sessionStartMs(barTimeMs(bars[i].time)) === sessionStartMs(barTimeMs(prev.time))) continue;
    if (!(prev.close > 0)) continue;
    if (Math.abs(bars[i].open - prev.close) / prev.close >= minPct) out.push(i);
  }
  return out;
}

/**
 * Event anchors (RBI policy, results, macro releases): the first bar at or
 * after each timestamp. Events outside the window are dropped.
 * @param {number[]} timestamps epoch ms
 * @returns {number[]} bar indices, ascending, de-duplicated
 */
export function eventAnchors(bars, timestamps = []) {
  if (!Array.isArray(bars) || !bars.length) return [];
  const first = barTimeMs(bars[0].time);
  const idx = new Set();
  for (const t of timestamps) {
    if (!(t >= first)) continue;
    const i = bars.findIndex((b) => barTimeMs(b.time) >= t);
    if (i >= 0) idx.add(i);
  }
  return [...idx].sort((a, b) => a - b);
}
