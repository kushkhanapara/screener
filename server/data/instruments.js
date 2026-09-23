import zlib from "node:zlib";
import { EXCLUDE_UNDERLYINGS, EXPIRY_POLICY } from "../config.js";

/**
 * Build the NSE single-stock-futures universe from the Upstox instrument master.
 *
 * A "contract" is one tradable futures instrument:
 *   { key, underlying, underlyingKey, expiryMs, expiry, tradingSymbol, label, lotSize }
 *
 * The same list drives BOTH the daily scan and the live WebSocket subscription.
 */

const MASTER_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

let cachedContracts = null;
let cachedUnderlyings = null;

/** Download + gunzip + parse the instrument master (array of records). */
async function fetchMaster() {
  const res = await fetch(MASTER_URL);
  if (!res.ok) throw new Error(`Instrument master fetch failed: ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  const json = zlib.gunzipSync(gz).toString("utf8");
  return JSON.parse(json);
}

/** Short expiry label like "31 JUL" from an epoch-ms expiry. */
function expiryLabel(ms) {
  const d = new Date(ms);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
  return `${day} ${mon}`;
}

function ymd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Derive the futures universe. Filters NSE_FO + FUT, excludes index
 * underlyings, keeps active (non-expired) expiries per EXPIRY_POLICY, and
 * groups by underlying so "near-next" can pick the two nearest per name.
 *
 * @param {number} nowMs  reference time (defaults to Date.now())
 */
export async function loadFuturesUniverse(nowMs = Date.now()) {
  const master = await fetchMaster();

  const futs = master.filter(
    (r) =>
      r.segment === "NSE_FO" &&
      r.instrument_type === "FUT" &&
      r.expiry &&
      r.expiry > nowMs &&
      !EXCLUDE_UNDERLYINGS.has(String(r.underlying_symbol || "").toUpperCase())
  );

  // Group active contracts by underlying, sorted by nearest expiry first.
  const byUnderlying = new Map();
  for (const r of futs) {
    const u = r.underlying_symbol;
    if (!byUnderlying.has(u)) byUnderlying.set(u, []);
    byUnderlying.get(u).push(r);
  }

  const contracts = [];
  for (const [underlying, rows] of byUnderlying) {
    rows.sort((a, b) => a.expiry - b.expiry);
    const keep = EXPIRY_POLICY === "near-next" ? rows.slice(0, 2) : rows;
    for (const r of keep) {
      contracts.push({
        key: r.instrument_key,
        underlying,
        underlyingKey: r.underlying_key || null,
        expiryMs: r.expiry,
        expiry: ymd(r.expiry),
        tradingSymbol: r.trading_symbol,
        label: `${underlying} ${expiryLabel(r.expiry)} FUT`,
        lotSize: r.lot_size,
      });
    }
  }

  contracts.sort((a, b) =>
    a.underlying === b.underlying
      ? a.expiryMs - b.expiryMs
      : a.underlying.localeCompare(b.underlying)
  );

  // Deduped underlyings with their cash-equity key — used for the daily scan,
  // which runs on the cash stock (long history) rather than the short-lived
  // futures contract.
  const um = new Map();
  for (const c of contracts) {
    if (c.underlyingKey && !um.has(c.underlying)) {
      um.set(c.underlying, { underlying: c.underlying, cashKey: c.underlyingKey });
    }
  }
  cachedUnderlyings = [...um.values()].sort((a, b) =>
    a.underlying.localeCompare(b.underlying)
  );

  cachedContracts = contracts;
  return contracts;
}

/** Return the last-loaded futures contracts (or null if not loaded yet). */
export function getUniverse() {
  return cachedContracts;
}

/** Deduped underlyings with cash keys (or null if not loaded yet). */
export function getUnderlyings() {
  return cachedUnderlyings;
}

/** Nearest-expiry futures contract per underlying (empty until the universe loads). */
export function getNearMonthContracts() {
  const nearest = new Map();
  for (const c of cachedContracts || []) {
    const cur = nearest.get(c.underlying);
    if (!cur || c.expiryMs < cur.expiryMs) nearest.set(c.underlying, c);
  }
  return nearest;
}
