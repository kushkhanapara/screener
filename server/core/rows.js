import { rsi, macd, sma, ema, rightAlign } from "./indicators.js";
import { MIN_BARS } from "../config.js";

/**
 * Build right-aligned indicator rows from an OHLC series.
 *
 * @param {Array<{close:number}>} candles  ordered oldest -> newest
 * @returns {{latest:Row, prev:Row}|null}   null if too few bars or NaN present
 *
 * A Row is: { close, rsi14, macd, macdSignal, macdHist, ma20, ma50, ma200, ema9, ema21 }
 * The same shape is used for daily candles and live 1-minute candles.
 *
 * Alignment: the CORE series (rsi/macd/ma20/ma50/ema — the short-lookback ones
 * the strategy relies on) drive the common length so `latest`/`prev` line up
 * bar-for-bar. ma200 needs 200 bars, which short-lived futures contracts and the
 * early live session rarely have, so it is exposed as `null` when unavailable
 * rather than forcing the whole row to be rejected. A strategy check that reads
 * a long MA must guard for null, e.g. `l.ma200 != null && l.close > l.ma200`.
 */
export function buildRows(candles) {
  if (!Array.isArray(candles) || candles.length < MIN_BARS) return null;

  const closes = candles.map((c) => c.close);
  if (closes.some((c) => !Number.isFinite(c))) return null;

  const rsi14 = rsi(closes, 14);
  const { macd: macdLine, signal: macdSignal, hist: macdHist } = macd(closes);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200); // may be shorter than the core window
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);

  // Right-align the core series (and closes) to their shortest common length.
  const [aClose, aRsi, aMacd, aSignal, aHist, aMa20, aMa50, aE9, aE21] =
    rightAlign(closes, rsi14, macdLine, macdSignal, macdHist, ma20, ma50, e9, e21);

  const L = aClose.length;
  if (L < 2) return null;

  // Align ma200 to the same tail; front-pad with null when it's shorter.
  const aMa200 = tail(ma200, L);

  const at = (arr, i) => arr[arr.length - i];
  const row = (i) => ({
    close: at(aClose, i),
    rsi14: at(aRsi, i),
    macd: at(aMacd, i),
    macdSignal: at(aSignal, i),
    macdHist: at(aHist, i),
    ma20: at(aMa20, i),
    ma50: at(aMa50, i),
    ma200: at(aMa200, i), // null if <200 bars
    ema9: at(aE9, i),
    ema21: at(aE21, i),
  });

  const latest = row(1);
  const prev = row(2);

  // Reject only if a CORE field is not finite. ma200 is allowed to be null.
  for (const r of [latest, prev]) {
    for (const [k, v] of Object.entries(r)) {
      if (k === "ma200") continue;
      if (!Number.isFinite(v)) return null;
    }
  }

  return { latest, prev };
}

/** Last `n` values of `arr`, front-padded with null if arr is shorter. */
function tail(arr, n) {
  if (arr.length >= n) return arr.slice(arr.length - n);
  return new Array(n - arr.length).fill(null).concat(arr);
}
