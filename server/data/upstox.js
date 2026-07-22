import { UPSTOX_TOKEN } from "../config.js";
import { upstoxLimiter } from "./rateLimiter.js";

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
 * GET JSON with retry + backoff on 429 (rate limit) and 5xx. Honors the
 * Retry-After header when present. Upstox sits behind Cloudflare, which returns
 * 429 (error 1015) if requests burst too fast.
 */
async function getJson(url, retries = 5) {
  let attempt = 0;
  for (;;) {
    await upstoxLimiter.acquire(); // proactively stay under 50/s · 500/m · 2000/30m
    const res = await fetch(url, { headers: authHeaders() });
    if (res.ok) return res.json();

    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get("retry-after"));
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
  const key = encodeURIComponent(instrumentKey);
  const url = `${BASE}/v3/historical-candle/${key}/days/1/${toDate}/${fromDate}`;
  const json = await getJson(url);
  const candles = json?.data?.candles ?? [];
  return candles.map(mapCandle).reverse(); // newest-first -> oldest-first
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
  const key = encodeURIComponent(instrumentKey);
  const url = `${BASE}/v3/historical-candle/${key}/${unit}/${interval}/${toDate}/${fromDate}`;
  const json = await getJson(url);
  const candles = json?.data?.candles ?? [];
  return candles.map(mapCandle).reverse();
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
