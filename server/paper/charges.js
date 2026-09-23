import { getBrokerage } from "../data/upstox.js";
import { tradeCosts, DEFAULT_COSTS } from "./costs.js";
import { log } from "../logger.js";

const logger = log("charges");

/**
 * Real transaction charges, calibrated against Upstox.
 *
 * Hardcoded rates were materially wrong — the local model put STT on a ₹7.1L
 * futures sell at ₹88.75 where Upstox actually charges ₹355, understating a
 * round trip by roughly 2.7×. Since costs are deducted before R is computed,
 * that error flattered every metric derived from it.
 *
 * Calling the API per trade would be both slow and rate-limit hungry, so
 * instead each contract is CALIBRATED once per side: one call yields the flat
 * brokerage plus the turnover-proportional rates (STT, stamp, exchange, SEBI),
 * and every later trade in that contract is computed from those locally. The
 * rates are properties of the instrument and the account, not of the price, so
 * this stays accurate as prices move.
 *
 * Falls back to the estimated model if the API is unavailable — a degraded
 * number beats refusing to record the trade, and the result says which was used.
 */

const cache = new Map(); // `${instrumentKey}:${side}:${qty}` -> rates
const inFlight = new Map();

const GST_RATE = 0.18; // applied to brokerage + exchange + SEBI

function cacheKey(instrumentKey, side, qty) {
  return `${instrumentKey}:${side}:${qty}`;
}

/** One API call, decomposed into a flat fee plus per-rupee-of-turnover rates. */
async function calibrate(instrumentKey, side, qty, price, product) {
  const raw = await getBrokerage({ instrumentKey, qty, price, side, product });
  const turnover = price * qty;
  if (!turnover) throw new Error("zero turnover");

  return {
    brokerage: raw.brokerage,
    sttRate: raw.stt / turnover,
    stampRate: raw.stampDuty / turnover,
    transactionRate: raw.transaction / turnover,
    clearingRate: raw.clearing / turnover,
    sebiRate: raw.sebi / turnover,
    source: "upstox",
    calibratedAt: Date.now(),
    referenceTotal: raw.total,
    referenceTurnover: turnover,
  };
}

/**
 * Charge rates for one leg, from cache or a fresh calibration.
 * Concurrent callers for the same contract share a single request.
 */
export async function ratesFor({ instrumentKey, side, qty, price, product = "I" }) {
  const k = cacheKey(instrumentKey, side, qty);
  if (cache.has(k)) return cache.get(k);
  if (inFlight.has(k)) return inFlight.get(k);

  const p = calibrate(instrumentKey, side, qty, price, product)
    .then((rates) => {
      cache.set(k, rates);
      return rates;
    })
    .catch((e) => {
      logger.warn(`charge calibration failed for ${instrumentKey} ${side}: ${e.message}`);
      return null; // caller falls back to the estimated model
    })
    .finally(() => inFlight.delete(k));

  inFlight.set(k, p);
  return p;
}

/**
 * Both legs' rates for a contract, fetched together at position open so the
 * close path stays synchronous (it runs inside a tick handler).
 */
export async function calibrateContract({ instrumentKey, qty, price, product = "I" }) {
  const [buy, sell] = await Promise.all([
    ratesFor({ instrumentKey, side: "BUY", qty, price, product }),
    ratesFor({ instrumentKey, side: "SELL", qty, price, product }),
  ]);
  return buy && sell ? { buy, sell } : null;
}

/** Apply one leg's calibrated rates at an actual fill price. */
function legCharges(rates, price, qty) {
  const turnover = price * qty;
  const brokerage = rates.brokerage;
  const stt = turnover * rates.sttRate;
  const stamp = turnover * rates.stampRate;
  const transaction = turnover * rates.transactionRate;
  const clearing = turnover * rates.clearingRate;
  const sebi = turnover * rates.sebiRate;
  const gst = (brokerage + transaction + clearing + sebi) * GST_RATE;
  return {
    brokerage,
    stt,
    stamp,
    transaction,
    clearing,
    sebi,
    gst,
    total: brokerage + stt + stamp + transaction + clearing + sebi + gst,
  };
}

/**
 * Round-trip charges for a completed trade.
 *
 * @param {object} p
 * @param {"long"|"short"} p.side  position direction
 * @param {{buy:object, sell:object}|null} p.rates calibrated rates, or null
 */
export function roundTripCharges({ side, entryPrice, exitPrice, qty, rates, costConfig = DEFAULT_COSTS }) {
  if (!rates?.buy || !rates?.sell) {
    const est = tradeCosts({ entryPrice, exitPrice, qty, side }, costConfig);
    return { ...est, source: "estimated" };
  }

  // A long buys at entry and sells at exit; a short does the reverse.
  const isLong = side === "long";
  const buyLeg = legCharges(rates.buy, isLong ? entryPrice : exitPrice, qty);
  const sellLeg = legCharges(rates.sell, isLong ? exitPrice : entryPrice, qty);

  return {
    brokerage: buyLeg.brokerage + sellLeg.brokerage,
    stt: buyLeg.stt + sellLeg.stt,
    stamp: buyLeg.stamp + sellLeg.stamp,
    exchange: buyLeg.transaction + sellLeg.transaction,
    clearing: buyLeg.clearing + sellLeg.clearing,
    sebi: buyLeg.sebi + sellLeg.sebi,
    gst: buyLeg.gst + sellLeg.gst,
    total: buyLeg.total + sellLeg.total,
    source: "upstox",
  };
}

export function stats() {
  return { calibrated: cache.size, pending: inFlight.size };
}

/** Test seam. */
export function _seed(instrumentKey, side, qty, rates) {
  cache.set(cacheKey(instrumentKey, side, qty), rates);
}
export function _clear() {
  cache.clear();
  inFlight.clear();
}
