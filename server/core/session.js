import { IST_OFFSET_MIN, MARKET_OPEN_MIN, MARKET_CLOSE_MIN } from "../config.js";

/**
 * Trading-session utilities.
 *
 * Intraday strategies need to know where "today" starts. Indicators that run
 * straight through the 15:30 -> 09:15 gap treat an overnight move as one
 * enormous bar-step, which spikes RSI/MACD at the open; anchoring to the session
 * avoids that by construction.
 *
 * All timestamps are epoch ms (UTC). IST is UTC+05:30 with no DST, so the shift
 * is a constant offset.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Normalise a candle timestamp to epoch ms.
 *
 * Candles reach these helpers in two shapes: the REST API returns `time` as an
 * ISO string ("2026-09-11T09:15:00+05:30"), while CandleStore rewrites it to a
 * numeric bucket start. Comparing a string against epoch ms yields false for
 * every bar, so a caller that passed raw REST candles would silently get an
 * empty session — zero volume, null VWAP, null percent change — rather than an
 * error. Accept both shapes instead.
 */
export function barTimeMs(time) {
  if (typeof time === "number") return time;
  const ms = new Date(time).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/** Minutes-from-midnight IST for an epoch-ms timestamp. */
export function istMinutes(tsMs) {
  const shifted = tsMs + IST_OFFSET_MIN * 60 * 1000;
  return Math.floor(shifted / 60000) % (24 * 60);
}

/** Day-of-week in IST (0=Sun … 6=Sat). */
export function istDay(tsMs) {
  return new Date(tsMs + IST_OFFSET_MIN * 60 * 1000).getUTCDay();
}

/** IST calendar date as YYYY-MM-DD. */
export function istDateString(tsMs) {
  return new Date(tsMs + IST_OFFSET_MIN * 60 * 1000).toISOString().slice(0, 10);
}

/** Epoch ms of 09:15 IST on the IST calendar day containing `tsMs`. */
function openOfIstDay(tsMs) {
  const shifted = tsMs + IST_OFFSET_MIN * 60 * 1000;
  const midnight = Math.floor(shifted / DAY_MS) * DAY_MS;
  return midnight + MARKET_OPEN_MIN * 60 * 1000 - IST_OFFSET_MIN * 60 * 1000;
}

/**
 * Start (09:15 IST) of the session that `tsMs` belongs to.
 *
 * Before today's open the relevant session is the previous trading day, so we
 * walk back over the weekend. Does NOT know about trading holidays — a holiday
 * simply yields a session with no bars, which callers already handle.
 */
export function sessionStartMs(tsMs = Date.now()) {
  let start = openOfIstDay(tsMs);
  if (tsMs < start) start -= DAY_MS;
  // Skip back over Sat(6)/Sun(0).
  for (let i = 0; i < 7; i++) {
    const d = istDay(start);
    if (d !== 0 && d !== 6) break;
    start -= DAY_MS;
  }
  return start;
}

/** End (15:30 IST) of the session that starts at `startMs`. */
export function sessionEndMs(startMs) {
  return startMs + (MARKET_CLOSE_MIN - MARKET_OPEN_MIN) * 60 * 1000;
}

/** Do two timestamps fall in the same trading session? */
export function isSameSession(a, b) {
  return sessionStartMs(a) === sessionStartMs(b);
}

/** Bars belonging to the session containing `now` (ascending in, ascending out). */
export function sessionBars(bars, now = Date.now()) {
  const start = sessionStartMs(now);
  return (bars ?? []).filter((b) => barTimeMs(b.time) >= start);
}

/**
 * Volume-weighted average price anchored to the session open.
 *
 * Returns null when no bar in the session carries volume — which is the honest
 * answer early in a session, and also guards the known tick-volume gap (the ltpc
 * feed reports last-trade quantity, not cumulative volume, so live bars can
 * under-report until the periodic REST reconciliation corrects them).
 *
 * @param {Array<{time:number,high:number,low:number,close:number,volume:number}>} bars
 */
export function anchoredVwap(bars, now = Date.now()) {
  const start = sessionStartMs(now);
  let pv = 0;
  let vol = 0;
  for (const b of bars ?? []) {
    if (!(barTimeMs(b.time) >= start)) continue;
    const v = Number(b.volume) || 0;
    if (v <= 0) continue;
    const typical = (b.high + b.low + b.close) / 3;
    if (!Number.isFinite(typical)) continue;
    pv += typical * v;
    vol += v;
  }
  return vol > 0 ? pv / vol : null;
}

/** Open price of the session's first bar, or null when the session has no bars. */
export function sessionOpen(bars, now = Date.now()) {
  const inSession = sessionBars(bars, now);
  return inSession.length ? inSession[0].open : null;
}

/**
 * Percent change from the session open to the latest bar's close.
 * This is the building block for relative strength: a stock's session move
 * minus the index's session move.
 */
export function pctFromSessionOpen(bars, now = Date.now()) {
  const inSession = sessionBars(bars, now);
  if (inSession.length < 1) return null;
  const open = inSession[0].open;
  const close = inSession[inSession.length - 1].close;
  if (!Number.isFinite(open) || !Number.isFinite(close) || open === 0) return null;
  return ((close - open) / open) * 100;
}

/** Session total volume — used for the turnover/liquidity floor. */
export function sessionVolume(bars, now = Date.now()) {
  return sessionBars(bars, now).reduce((sum, b) => sum + (Number(b.volume) || 0), 0);
}
