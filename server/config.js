import dotenv from "dotenv";
dotenv.config();

/**
 * Central configuration. Everything env-driven lives here so the rest of the
 * code never reads process.env directly.
 */

export const PORT = Number(process.env.PORT) || 8080;
export const IS_PROD = process.env.NODE_ENV === "production";

// Upstox Analytics Token — required for both historical (daily) and live feed.
export const UPSTOX_TOKEN = process.env.UPSTOX_ANALYTICS_TOKEN || "";
export const HAS_TOKEN = UPSTOX_TOKEN.length > 0;

// Concurrency for historical/seed fetches. Kept modest because Upstox sits
// behind Cloudflare, which rate-limits (429 / error 1015) on bursts.
export const FETCH_CONCURRENCY = Number(process.env.FETCH_CONCURRENCY) || 4;

// Minimum bars required before we compute indicators for a contract.
export const MIN_BARS = Number(process.env.MIN_BARS) || 60;

/**
 * Trading capital available to EACH strategy, in rupees.
 *
 * Real money is the binding constraint the engine was missing: a position
 * blocks margin until it is closed, so the next signal can only be taken if
 * enough is free. Without this the engine happily held 80 positions at once,
 * which is not a portfolio anyone could actually run — and it made the metrics
 * meaningless, because they measured trades that could never have been placed.
 */
export const CAPITAL_PER_STRATEGY = Number(process.env.CAPITAL_PER_STRATEGY) || 200_000;

/**
 * Fraction of contract value blocked as margin on an NSE stock-futures
 * position. Actual SPAN + exposure varies by scrip and volatility (roughly
 * 15–25%); this is a flat approximation, so treat position counts as indicative
 * rather than exact. Raise it to be more conservative.
 */
export const FUTURES_MARGIN_PCT = Number(process.env.FUTURES_MARGIN_PCT) || 0.2;

// Rolling window of 1-minute candles kept per contract in the live store.
export const MAX_LIVE_BARS = Number(process.env.MAX_LIVE_BARS) || 500;

// How much daily history to request per futures contract (days back).
export const DAILY_LOOKBACK_DAYS = Number(process.env.DAILY_LOOKBACK_DAYS) || 400;

/**
 * Underlyings excluded from the futures universe (index futures, not single
 * stocks). Override with EXCLUDE_UNDERLYINGS="A,B,C".
 */
const DEFAULT_INDEX_UNDERLYINGS = [
  "NIFTY",
  "BANKNIFTY",
  "FINNIFTY",
  "MIDCPNIFTY",
  "NIFTYNXT50",
  "BANKEX",
  "SENSEX",
];
export const EXCLUDE_UNDERLYINGS = new Set(
  (process.env.EXCLUDE_UNDERLYINGS
    ? process.env.EXCLUDE_UNDERLYINGS.split(",")
    : DEFAULT_INDEX_UNDERLYINGS
  ).map((s) => s.trim().toUpperCase())
);

/**
 * Which expiries to include per underlying.
 *   "all"       -> every active (non-expired) monthly contract   (default)
 *   "near-next" -> only the two nearest active expiries
 */
export const EXPIRY_POLICY = (process.env.EXPIRY_POLICY || "all").toLowerCase();

// ── Market hours (IST 09:15–15:30) ──────────────────────────────────────
// Stored as minutes-from-midnight IST for cheap comparison.
export const MARKET_OPEN_MIN = 9 * 60 + 15; // 555
export const MARKET_CLOSE_MIN = 15 * 60 + 30; // 930
export const IST_OFFSET_MIN = 5 * 60 + 30; // UTC+05:30

/**
 * Is the NSE cash/F&O session currently open? (Mon–Fri, 09:15–15:30 IST.)
 * Does NOT account for trading holidays — acceptable for a personal tool.
 */
export function isMarketOpen(now = new Date()) {
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const istMin = (utcMin + IST_OFFSET_MIN) % (24 * 60);
  // Day-of-week in IST (add offset, may roll over midnight).
  const istMs = now.getTime() + IST_OFFSET_MIN * 60 * 1000;
  const istDay = new Date(istMs).getUTCDay(); // 0=Sun … 6=Sat
  const isWeekday = istDay >= 1 && istDay <= 5;
  return isWeekday && istMin >= MARKET_OPEN_MIN && istMin <= MARKET_CLOSE_MIN;
}
