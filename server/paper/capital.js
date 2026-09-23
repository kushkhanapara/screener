import { CAPITAL_PER_STRATEGY, FUTURES_MARGIN_PCT } from "../config.js";

/**
 * Capital and margin accounting.
 *
 * A futures position blocks margin from the moment it opens until it closes, so
 * the next signal can only be taken if enough is free. This is the constraint
 * that turns a list of signals into a portfolio someone could actually run.
 *
 * It matters more than it first appears. Many F&O lots carry ₹5–10L of contract
 * value, so at ~20% margin a single position can consume most of a ₹2,00,000
 * account — meaning the engine can hold one or two names at a time, not eighty.
 * Which one it picks therefore decides almost the entire result, and picking
 * whichever name happened to come first alphabetically is not a strategy.
 */

/** Contract value of one position. */
export function notional(price, qty) {
  return price * qty;
}

/** Margin blocked by a position, in rupees. */
export function marginRequired(price, qty, marginPct = FUTURES_MARGIN_PCT) {
  if (!Number.isFinite(price) || !Number.isFinite(qty)) return Infinity;
  return price * qty * marginPct;
}

/**
 * Can this strategy afford the position?
 *
 * @returns {{ok:boolean, required:number, free:number, reason?:string}}
 */
export function canAfford({ price, qty, deployed, capital = CAPITAL_PER_STRATEGY, marginPct }) {
  const required = marginRequired(price, qty, marginPct);
  const free = capital - deployed;

  if (!Number.isFinite(required)) {
    return { ok: false, required, free, reason: "cannot price margin" };
  }

  // A lot whose margin exceeds the whole account can never be traded, however
  // good the signal — worth reporting differently from "no room right now",
  // because one is a permanent exclusion and the other is temporary.
  if (required > capital) {
    return {
      ok: false,
      required,
      free,
      reason: `lot too large — needs ${fmt(required)} margin, account is ${fmt(capital)}`,
    };
  }

  if (required > free) {
    return {
      ok: false,
      required,
      free,
      reason: `insufficient capital — needs ${fmt(required)}, ${fmt(free)} free`,
    };
  }

  return { ok: true, required, free };
}

/** Total margin blocked by a set of open positions. */
export function deployedCapital(positions) {
  let total = 0;
  for (const p of positions) {
    total += Number.isFinite(p.marginBlocked)
      ? p.marginBlocked
      : marginRequired(p.entryPrice, p.qty);
  }
  return total;
}

/** Capital summary for one strategy, for the API and UI. */
export function capitalState(positions, capital = CAPITAL_PER_STRATEGY) {
  const deployed = deployedCapital(positions);
  return {
    capital,
    deployed,
    free: capital - deployed,
    utilisation: capital > 0 ? deployed / capital : 0,
    positions: positions.length,
  };
}

function fmt(v) {
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
}
