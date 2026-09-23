import { UPSTOX_TOKEN } from "../config.js";
import { upstoxLimiter } from "./rateLimiter.js";
import * as candleCache from "./candleCache.js";

/**
 * Low-level Upstox V3 REST helpers (historical + intraday candles).
 * Uses global fetch (Node 20+). The Analytics Token authorizes these.
 *
 * All candle getters return candles ordered OLDEST -> NEWEST as:
 *   { time: string, open, high, low, close, volume, oi }
 * (the API returns them newest-first, so we reverse).
 */

const BASE = "https://api.upstox.com";

function authHeaders() {
  return {
    Authorization: `Bearer ${UPSTOX_TOKEN}`,
    Accept: "application/json",
  };
}

/** Map a raw [ts,o,h,l,c,v,oi] candle to an object. */
function mapCandle(c) {
  return {
    time: c[0],
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5],
    oi: c[6],
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Auth-failure tracking.
 *
 * Upstox returns transient 401s — observed mid-session on a token that was
 * issued hours earlier, valid for a year, and answering 200 again minutes
 * later. So a single 401 must NOT be treated as terminal: latching on the first
 * one kills every subsequent request until a restart, over what turns out to be
 * a blip.
 *
 * But a genuinely dead token must not turn every startup into a grind either —
 * ~630 doomed requests dragged out over minutes by the rate limiter, with
 * nothing saying plainly that the token is the problem.
 *
 * So: retry 401s like any other transient fault, and only declare the token
 * dead after repeated failures spanning a meaningful window.
 */
const AUTH_FAIL_THRESHOLD = 6; // consecutive 401s before giving up
const AUTH_FAIL_WINDOW_MS = 3 * 60 * 1000; // ...and they must span this long

let tokenRejected = null;
let authFailures = 0;
let firstAuthFailureAt = 0;
let lastAuthFailure = null;

function noteAuthFailure(status, body) {
  const now = Date.now();
  if (!authFailures) firstAuthFailureAt = now;
  authFailures++;
  lastAuthFailure = `${status}: ${body.slice(0, 120)}`;

  if (authFailures >= AUTH_FAIL_THRESHOLD && now - firstAuthFailureAt >= AUTH_FAIL_WINDOW_MS) {
    tokenRejected =
      `Upstox rejected the token ${authFailures} times over ` +
      `${Math.round((now - firstAuthFailureAt) / 60000)} minutes (${status}). It is invalid, ` +
      `expired, or was revoked — generating a new Analytics token silently revokes the ` +
      `previous one. Update UPSTOX_ANALYTICS_TOKEN and restart.`;
  }
}

function noteAuthSuccess() {
  authFailures = 0;
  firstAuthFailureAt = 0;
}

export function tokenStatus() {
  return {
    rejected: Boolean(tokenRejected),
    reason: tokenRejected,
    recentAuthFailures: authFailures,
    lastAuthFailure,
  };
}

/** Clear the flag (after the operator updates the token). */
export function resetTokenStatus() {
  tokenRejected = null;
  authFailures = 0;
  firstAuthFailureAt = 0;
  lastAuthFailure = null;
}

/**
 * GET JSON with retry + backoff on 429 (rate limit) and 5xx. Honors the
 * Retry-After header when present. Upstox sits behind Cloudflare, which returns
 * 429 (error 1015) if requests burst too fast.
 */
async function getJson(url, retries = 5) {
  if (tokenRejected) throw new Error(tokenRejected);

  let attempt = 0;
  for (;;) {
    await upstoxLimiter.acquire();
    const res = await fetch(url, { headers: authHeaders() });
    if (res.ok) {
      noteAuthSuccess();
      return res.json();
    }

    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => "");
      noteAuthFailure(res.status, body);
      if (tokenRejected) throw new Error(tokenRejected);

      // Transient until proven otherwise. Pause everything briefly rather than
      // letting hundreds of queued requests each discover the same 401.
      if (attempt < retries) {
        upstoxLimiter.penalise(5_000);
        await sleep(2_000 * (attempt + 1));
        attempt++;
        continue;
      }
      throw new Error(`Upstox ${res.status}: ${body.slice(0, 160)}`);
    }

    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const body = await res.text().catch(() => "");
      const ra = Number(res.headers.get("retry-after"));

      // Cloudflare's 1015 is a sustained-rate ban, not a momentary burst reject:
      // it keeps firing for a while even after traffic stops. Pausing the whole
      // limiter is what actually clears it — letting each request retry on its
      // own just keeps the pressure on and extends the ban.
      if (body.includes("1015")) {
        upstoxLimiter.penalise(30_000);
      }

      const waitMs =
        Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(1500 * 2 ** attempt, 12000);
      await sleep(waitMs + Math.floor(Math.random() * 400));
      attempt++;
      continue;
    }

    const body = await res.text().catch(() => "");
    throw new Error(`Upstox ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
}

/**
 * Daily historical candles for a contract.
 * @param {string} instrumentKey e.g. "NSE_FO|53001"
 * @param {string} fromDate YYYY-MM-DD
 * @param {string} toDate   YYYY-MM-DD
 */
export async function getDailyCandles(instrumentKey, fromDate, toDate) {
  const cacheKey = [instrumentKey, "days", "1", fromDate, toDate];
  const hit = candleCache.read(cacheKey, toDate);
  if (hit) return hit;

  const key = encodeURIComponent(instrumentKey);
  const url = `${BASE}/v3/historical-candle/${key}/days/1/${toDate}/${fromDate}`;
  const json = await getJson(url);
  const candles = (json?.data?.candles ?? []).map(mapCandle).reverse(); // newest-first -> oldest-first
  if (candles.length) candleCache.write(cacheKey, candles);
  return candles;
}

/**
 * Today's 1-minute intraday candles for a contract (used to seed the live window).
 * @param {string} instrumentKey
 */
export async function getIntradayMinuteCandles(instrumentKey) {
  const key = encodeURIComponent(instrumentKey);
  const url = `${BASE}/v3/historical-candle/intraday/${key}/minutes/1`;
  const json = await getJson(url);
  const candles = json?.data?.candles ?? [];
  return candles.map(mapCandle).reverse();
}

/**
 * TODAY's candles at any supported unit/interval.
 *
 * The historical endpoint only returns COMPLETED trading days — a range ending
 * today still stops at yesterday's close. Today's bars live behind this separate
 * intraday endpoint, so anything session-scoped (VWAP, volume, move from the
 * open) needs both or it is computing over an empty session.
 *
 * Never cached: this is the one response that changes every minute.
 */
export async function getIntradayCandles(instrumentKey, unit, interval) {
  const key = encodeURIComponent(instrumentKey);
  const url = `${BASE}/v3/historical-candle/intraday/${key}/${unit}/${interval}`;
  const json = await getJson(url);
  return (json?.data?.candles ?? []).map(mapCandle).reverse();
}

/**
 * Historical 1-minute candles over a date range (prior trading days). Combined
 * with today's intraday candles this gives enough bars to compute indicators
 * from the market open instead of waiting an hour into the session.
 * @param {string} instrumentKey
 * @param {string} fromDate YYYY-MM-DD
 * @param {string} toDate   YYYY-MM-DD
 */
export async function getHistoricalMinuteCandles(instrumentKey, fromDate, toDate) {
  const key = encodeURIComponent(instrumentKey);
  const url = `${BASE}/v3/historical-candle/${key}/minutes/1/${toDate}/${fromDate}`;
  const json = await getJson(url);
  const candles = json?.data?.candles ?? [];
  return candles.map(mapCandle).reverse();
}

/**
 * Generic historical candles at any supported unit/interval over a date range.
 * Upstox v3 supports unit "minutes" with interval 1..300 (e.g. minutes/3,
 * minutes/15), plus hours/days/weeks/months.
 * @param {string} instrumentKey
 * @param {string} unit      "minutes" | "hours" | "days" | "weeks" | "months"
 * @param {number|string} interval  e.g. 3 or 15
 * @param {string} fromDate  YYYY-MM-DD
 * @param {string} toDate    YYYY-MM-DD
 */
export async function getHistoricalCandles(instrumentKey, unit, interval, fromDate, toDate) {
  const cacheKey = [instrumentKey, unit, String(interval), fromDate, toDate];
  const hit = candleCache.read(cacheKey, toDate);
  if (hit) return hit;

  const key = encodeURIComponent(instrumentKey);
  const url = `${BASE}/v3/historical-candle/${key}/${unit}/${interval}/${toDate}/${fromDate}`;
  const json = await getJson(url);
  const candles = (json?.data?.candles ?? []).map(mapCandle).reverse();
  if (candles.length) candleCache.write(cacheKey, candles);
  return candles;
}

/**
 * Real brokerage and statutory charges for one order leg, straight from Upstox.
 *
 * Worth using rather than hardcoding rates: the published STT for futures and
 * the figure this returns disagree materially, and the rates move (STT on F&O
 * has changed twice in recent years). A cost model that is wrong by a factor of
 * two silently flatters every R-multiple derived from it.
 *
 * @param {object} p
 * @param {string} p.instrumentKey
 * @param {number} p.qty
 * @param {number} p.price
 * @param {"BUY"|"SELL"} p.side
 * @param {"I"|"D"} [p.product] intraday or delivery
 * @returns {Promise<{total:number, brokerage:number, stt:number, stampDuty:number,
 *                    transaction:number, sebi:number, gst:number, clearing:number}>}
 */
export async function getBrokerage({ instrumentKey, qty, price, side, product = "I" }) {
  const key = encodeURIComponent(instrumentKey);
  const url =
    `${BASE}/v2/charges/brokerage?instrument_token=${key}&quantity=${qty}` +
    `&product=${product}&transaction_type=${side}&price=${price}`;
  const json = await getJson(url);
  const c = json?.data?.charges;
  if (!c) throw new Error("no charges in response");

  const other = c.other_charges ?? c.otherTaxes ?? {};
  return {
    total: Number(c.total) || 0,
    brokerage: Number(c.brokerage) || 0,
    stt: Number(c.taxes?.stt) || 0,
    stampDuty: Number(c.taxes?.stamp_duty) || 0,
    gst: Number(c.taxes?.gst) || 0,
    transaction: Number(other.transaction) || 0,
    clearing: Number(other.clearing) || 0,
    sebi: Number(other.sebi_turnover) || 0,
  };
}

/**
 * Full quotes for many instruments: LTP, cumulative volume, open interest and
 * top-of-book. The shadow engine needs OI (commitment behind a move) and the
 * best bid/ask (spreads can't be obtained historically, so they are recorded
 * live from the start).
 * @param {string[]} instrumentKeys
 * @returns {Promise<Map<string, {ltp, volume, oi, oiDayHigh, oiDayLow, avgPrice, bid, ask, lastTradeTime}>>}
 */
export async function getQuotes(instrumentKeys) {
  const out = new Map();
  const keys = [...new Set(instrumentKeys)].filter(Boolean);
  const CHUNK = 200;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const qs = encodeURIComponent(keys.slice(i, i + CHUNK).join(","));
    const json = await getJson(`${BASE}/v2/market-quote/quotes?instrument_key=${qs}`);
    for (const v of Object.values(json?.data ?? {})) {
      const k = v?.instrument_token;
      if (!k) continue;
      out.set(k, {
        ltp: Number(v.last_price) || null,
        volume: Number(v.volume) || 0,
        oi: Number(v.oi) || 0,
        oiDayHigh: Number(v.oi_day_high) || null,
        oiDayLow: Number(v.oi_day_low) || null,
        avgPrice: Number(v.average_price) || null,
        bid: Number(v.depth?.buy?.[0]?.price) || null,
        ask: Number(v.depth?.sell?.[0]?.price) || null,
        lastTradeTime: Number(v.last_trade_time) || null,
      });
    }
  }
  return out;
}

/**
 * Last-traded price for many instruments in one call (market-quote LTP).
 * Used to price futures for matched scrips only (not the whole universe).
 * @param {string[]} instrumentKeys
 * @returns {Promise<Map<string, number>>} instrumentKey -> ltp
 */
export async function getLtp(instrumentKeys) {
  const out = new Map();
  const keys = [...new Set(instrumentKeys)].filter(Boolean);
  if (!keys.length) return out;

  // Chunk to keep the query string sane; the endpoint accepts many keys per call.
  const CHUNK = 200;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    const qs = encodeURIComponent(slice.join(","));
    const url = `${BASE}/v3/market-quote/ltp?instrument_key=${qs}`;
    const json = await getJson(url).catch(() => null);
    const data = json?.data ?? {};
    // Response is keyed by "EXCHANGE:SYMBOL" (not the request instrument_key), but
    // each value carries `instrument_token` = the original key. Map via that.
    for (const v of Object.values(data)) {
      const k = v?.instrument_token;
      const ltp = Number(v?.last_price);
      if (k && Number.isFinite(ltp)) out.set(k, ltp);
    }
  }
  return out;
}
