/**
 * The three live intraday strategies, translated to daily candles and held for
 * days — research only. Each keeps its idea and thresholds; only the timeframe
 * changes:
 *
 *   Momentum Surge   strong day (close ≥ 1.2% from the open, mostly not gap),
 *                    daily RSI(14) < 68, daily MACD histogram positive
 *   Trend Momentum   daily SMA34 above SMA200 and price above SMA34, EMA5 above
 *                    SMA34, daily RSI(14) ≥ 60
 *   VWAP RS          above the 20-day volume-weighted average price, beat Nifty
 *                    by ≥ 0.4% today, dipped below EMA9 yesterday and reclaimed
 *                    it today, daily ATR ≥ 1.5% of price
 *
 * Shorts are the mirror image. A signal counts only on the day it first
 * appears (not every day it stays true), so one move gives one trade.
 */

export const DAILY_BOOKS = [
  { id: "momentum-surge", name: "Momentum Surge (daily)", exits: { stopAtr: 1.8, trailAtr: 2.0, breakevenAtR: 1.0, targetR: 2.5 } },
  { id: "trend-momentum", name: "Trend Momentum (daily)", exits: { stopAtr: 1.5, trailAtr: 1.5, breakevenAtR: 1.0, targetR: 3.0 } },
  { id: "vwap-rs", name: "VWAP Relative Strength (daily)", exits: { stopAtr: 1.2, trailAtr: 1.5, breakevenAtR: 1.0, targetR: 2.5 } },
];

const sma = (v, n) => v.map((_, i) => (i + 1 < n ? null : v.slice(i + 1 - n, i + 1).reduce((a, x) => a + x, 0) / n));
function ema(v, n) {
  const k = 2 / (n + 1);
  const out = [];
  let e = null;
  for (let i = 0; i < v.length; i++) {
    if (i + 1 < n) out.push(null);
    else if (e == null) out.push((e = v.slice(0, n).reduce((a, x) => a + x, 0) / n));
    else out.push((e = v[i] * k + e * (1 - k)));
  }
  return out;
}
function rsi(v, n = 14) {
  const out = [null];
  let g = 0;
  let l = 0;
  for (let i = 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    if (i <= n) {
      g += Math.max(d, 0) / n;
      l += Math.max(-d, 0) / n;
      out.push(i === n ? (l === 0 ? 100 : 100 - 100 / (1 + g / l)) : null);
    } else {
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
      out.push(l === 0 ? 100 : 100 - 100 / (1 + g / l));
    }
  }
  return out;
}

/** Everything the daily rules need, one value per candle (null while warming up). */
export function indicators(candles) {
  const close = candles.map((c) => c.close);
  const e12 = ema(close, 12);
  const e26 = ema(close, 26);
  const line = close.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null));
  const start = line.findIndex((x) => x != null);
  const sig = start < 0 ? line.map(() => null) : [...line.slice(0, start).map(() => null), ...ema(line.slice(start), 9)];
  const vwap20 = candles.map((_, i) => {
    if (i < 19) return null;
    let pv = 0;
    let vol = 0;
    for (let k = i - 19; k <= i; k++) {
      const c = candles[k];
      pv += ((c.high + c.low + c.close) / 3) * c.volume;
      vol += c.volume;
    }
    return vol > 0 ? pv / vol : null;
  });
  return {
    rsi: rsi(close),
    hist: line.map((x, i) => (x != null && sig[i] != null ? x - sig[i] : null)),
    sma34: sma(close, 34),
    sma200: sma(close, 200),
    ema5: ema(close, 5),
    ema9: ema(close, 9),
    vwap20,
  };
}

const MIN_VOLUME = 30_000;

function rawSignal(id, c, ind, i, niftyPct) {
  const k = c[i];
  const p = c[i - 1];
  if (!p || !(k.volume >= MIN_VOLUME)) return null;
  if (id === "momentum-surge") {
    const move = ((k.close - k.open) / k.open) * 100;
    const total = Math.abs(((k.close - p.close) / p.close) * 100);
    const gap = Math.abs(((k.open - p.close) / p.close) * 100);
    const notGap = total < 0.01 || gap / total <= 0.6;
    const { rsi: r, hist: h } = { rsi: ind.rsi[i], hist: ind.hist[i] };
    if (r == null || h == null || !notGap) return null;
    if (move > 1.2 && r < 68 && h > 0) return { side: "long", score: move };
    if (move < -1.2 && r > 32 && h < 0) return { side: "short", score: -move };
    return null;
  }
  if (id === "trend-momentum") {
    const [s34, s200, e5, r] = [ind.sma34[i], ind.sma200[i], ind.ema5[i], ind.rsi[i]];
    if ([s34, s200, e5, r].some((x) => x == null)) return null;
    if (s34 > s200 && k.close > s34 && e5 > s34 && r >= 60) return { side: "long", score: r };
    if (s34 < s200 && k.close < s34 && e5 < s34 && r <= 40) return { side: "short", score: 100 - r };
    return null;
  }
  if (id === "vwap-rs") {
    const [vw, e9, e9p] = [ind.vwap20[i], ind.ema9[i], ind.ema9[i - 1]];
    if (vw == null || e9 == null || e9p == null || niftyPct == null || i < 15) return null;
    let tr = 0;
    for (let j = i - 13; j <= i; j++) tr += Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j - 1].close), Math.abs(c[j].low - c[j - 1].close));
    if ((tr / 14 / k.close) * 100 < 1.5) return null;
    const rs = ((k.close - p.close) / p.close) * 100 - niftyPct;
    if (k.close > vw && rs >= 0.4 && p.close < e9p && k.close > e9) return { side: "long", score: rs };
    if (k.close < vw && rs <= -0.4 && p.close > e9p && k.close < e9) return { side: "short", score: -rs };
    return null;
  }
  throw new Error(`unknown daily strategy ${id}`);
}

/** Signal on candle i only if it wasn't already showing the same side yesterday. */
export function dailySignal(id, candles, ind, i, niftyPctOf) {
  const today = rawSignal(id, candles, ind, i, niftyPctOf(i));
  if (!today) return null;
  const before = rawSignal(id, candles, ind, i - 1, niftyPctOf(i - 1));
  return before?.side === today.side ? null : today;
}
