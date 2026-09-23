import { buildRows } from "../core/rows.js";
import { latestAtr, macdEma, rsi } from "../core/indicators.js";
import { anchoredVwap, pctFromSessionOpen, sessionVolume, sessionOpen } from "../core/session.js";

/** Latest standard (EMA) MACD reading for a candle series. */
function emaMacdOf(bars) {
  const closes = (bars ?? []).map((b) => b.close).filter(Number.isFinite);
  if (closes.length < 35) return { macd: null, signal: null, hist: null };
  const m = macdEma(closes);
  const i = m.hist.length - 1;
  if (i < 0) return { macd: null, signal: null, hist: null };
  return { macd: m.macd[i], signal: m.signal[i], hist: m.hist[i] };
}

/** Latest RSI(14) for a candle series, or null when there aren't enough bars. */
function rsiOf(bars, period = 14) {
  const closes = (bars ?? []).map((b) => b.close).filter(Number.isFinite);
  if (closes.length <= period) return null;
  const r = rsi(closes, period);
  return r.length ? r[r.length - 1] : null;
}

/**
 * Assemble the evaluation context handed to every strategy.
 *
 * This is deliberately the ONLY place a context is built, because it is where
 * look-ahead bias would creep in. Live and backtest both call it with CLOSED
 * bars only; if the two paths built their own contexts they would inevitably
 * drift, and a backtest that silently peeks at the forming bar reports profits
 * that cannot be earned.
 *
 * @param {object}   p
 * @param {string}   p.underlying
 * @param {string}   p.cashKey
 * @param {Array}    p.bars3m       CLOSED 3-minute cash candles, ascending
 * @param {Array}    p.bars15m      CLOSED 15-minute cash candles, ascending
 * @param {Array}    [p.indexBars3m] CLOSED 3-minute NIFTY candles, for relative strength
 * @param {number}   [p.now]
 */
export function buildContext({
  underlying,
  cashKey,
  bars3m,
  bars15m,
  indexBars3m,
  daily = null,
  futVolume = null,
  now = Date.now(),
}) {
  const rows3 = buildRows(bars3m);
  const rows15 = buildRows(bars15m);

  const stockPct = pctFromSessionOpen(bars3m, now);
  const hasIndex = Boolean(indexBars3m?.length);
  const indexPct = hasIndex ? pctFromSessionOpen(indexBars3m, now) : null;
  const indexVwap = hasIndex ? anchoredVwap(indexBars3m, now) : null;
  const indexClose = hasIndex ? indexBars3m[indexBars3m.length - 1].close : null;

  // Change from the PREVIOUS DAY'S close, which includes the overnight gap —
  // a different quantity from the move since today's open, and the one a
  // "% change" column on a broker screen actually shows.
  const lastClose = rows3?.latest?.close ?? null;
  const pctFromPrevClose =
    daily?.prevClose && lastClose != null && daily.prevClose !== 0
      ? ((lastClose - daily.prevClose) / daily.prevClose) * 100
      : null;

  // How much of today's move is just the overnight gap. An intraday strategy
  // wants the part the session actually produced, not a gap that opened and
  // then went nowhere.
  const openToday = sessionOpen(bars3m, now);
  const gapPct =
    daily?.prevClose && openToday != null
      ? ((openToday - daily.prevClose) / daily.prevClose) * 100
      : null;

  return {
    daily,
    pctFromPrevClose,
    gapPct,
    futVolume,
    // Standard EMA MACD and RSI at each intraday timeframe. `rows` carries the
    // SMA-variant MACD the screener uses; these are the conventional ones.
    emaMacd: { "3m": emaMacdOf(bars3m), "15m": emaMacdOf(bars15m) },
    intradayRsi: { "3m": rsiOf(bars3m), "15m": rsiOf(bars15m) },
    underlying,
    cashKey,
    now,
    bars: { "3m": bars3m, "15m": bars15m },
    rows: { "3m": rows3, "15m": rows15 },
    atr: {
      "3m": latestAtr(bars3m, 14),
      "15m": latestAtr(bars15m, 14),
    },
    vwap: anchoredVwap(bars3m, now),
    pctFromOpen: stockPct,
    sessionVolume: sessionVolume(bars3m, now),
    index: { pctFromOpen: indexPct, vwap: indexVwap, close: indexClose },

    /*
     * Market regime, from the index itself.
     *
     * The recorded trades show shorts at −120R against longs at −5R: the
     * strategies were shorting almost everything whenever the index dipped,
     * which is a bet on market direction rather than on any stock. Gating the
     * permitted side on the index's own state stops a strategy from fighting
     * the tape. Null means unknown, and a strategy may choose to trade anyway.
     */
    regime: marketRegime(indexPct, indexClose, indexVwap),
    // Relative strength: how much the stock outran the index this session.
    // Null (not zero) when the index is unavailable, so a strategy can tell
    // "flat vs index" apart from "no index data".
    relStrength: stockPct != null && indexPct != null ? stockPct - indexPct : null,
  };
}

/**
 * Which side the broad market permits right now.
 *
 * "bullish"/"bearish" require the index's move since the open AND its position
 * against its own VWAP to agree; when they disagree the tape is chop and
 * neither side is favoured. Returns null when there is no index data, which a
 * strategy should treat as "unknown", not as "neutral".
 */
export function marketRegime(indexPct, indexClose, indexVwap, band = 0.15) {
  if (indexPct == null) return null;
  const aboveVwap = indexVwap != null && indexClose != null ? indexClose > indexVwap : null;

  if (indexPct >= band && aboveVwap !== false) return "bullish";
  if (indexPct <= -band && aboveVwap !== true) return "bearish";
  return "neutral";
}

/** Does the market regime permit taking this side? */
export function regimeAllows(regime, side) {
  if (regime == null) return true; // unknown market is not a veto
  if (side === "long") return regime !== "bearish";
  if (side === "short") return regime !== "bullish";
  return true;
}

/** ATR as a percentage of price — the volatility floor's unit. */
export function atrPct(atrValue, price) {
  if (!Number.isFinite(atrValue) || !Number.isFinite(price) || price === 0) return null;
  return (atrValue / price) * 100;
}

/**
 * Run a check list against a row, returning the labels that passed.
 * Shared so every strategy reports its reasons the same way.
 */
export function runChecks(checks, row, ctx) {
  const reasons = [];
  for (const c of checks) {
    let ok = false;
    try {
      ok = Boolean(c.test(row, ctx));
    } catch {
      ok = false; // a missing/null input fails its check rather than crashing the scan
    }
    if (ok) reasons.push(c.label);
  }
  return { pass: reasons.length === checks.length, reasons };
}
