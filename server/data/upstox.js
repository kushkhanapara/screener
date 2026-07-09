import { UPSTOX_TOKEN } from "../config.js";

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
