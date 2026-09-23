import { randomUUID } from "node:crypto";
import { applySlippage, DEFAULT_COSTS } from "./costs.js";
import { roundTripCharges } from "./charges.js";
import { marginRequired } from "./capital.js";
import { istMinutes } from "../core/session.js";

/**
 * Paper-trading position lifecycle and exit state machine.
 *
 * Pure functions over a position object — no I/O, no clock of its own, no
 * database. That is deliberate: the live path and the backtest both drive this
 * same code, so they cannot drift apart. A backtest that quietly used different
 * exit logic than the live engine would be measuring a strategy nobody trades.
 *
 * Exit precedence on any single price observation:
 *   1. square-off  (the clock beats everything; positions must be flat by 15:15)
 *   2. stop        (checked before target — see the note in checkExit)
 *   3. target
 *   4. time stop
 * Trail and break-even adjustments happen only after no exit fired.
 */

/** Exit reasons, in the order they are checked. */
export const EXIT_REASONS = [
  "squareoff",
  "stop",
  "breakeven",
  "trail",
  "target",
  "proveit",
  "time",
];

/**
 * Open a position from a signal.
 *
 * Fill price is whatever the caller observed AFTER the signal bar closed — the
 * live path passes the first futures tick, the backtest passes the next bar's
 * open. Neither may use the signal bar's own close, which would be look-ahead.
 *
 * Sizing is one lot, fixed. R is therefore the comparable unit across names;
 * rupee P&L is secondary and will be uneven between a ₹200 and a ₹4000 stock.
 */
export function openPosition({
  runId,
  strategy,
  signal,
  underlying,
  futKey = null,
  futLabel = null,
  fillPrice,
  atr,
  lotSize,
  now,
  signalBarTime = null,
  cashPriceAtSignal = null,
  costConfig = DEFAULT_COSTS,
  chargeRates = null,
  features = null,
  lots = 1,
}) {
  const side = signal.side;
  if (side !== "long" && side !== "short") throw new Error(`bad side: ${side}`);
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) throw new Error("fillPrice must be positive");
  if (!Number.isFinite(atr) || atr <= 0) throw new Error("atr must be positive to size a stop");
  if (!Number.isFinite(lotSize) || lotSize <= 0) throw new Error("lotSize must be positive");

  const entryPrice = applySlippage(fillPrice, side, true, costConfig);
  const riskPerUnit = strategy.exits.stopAtr * atr;
  const initialStop =
    side === "long" ? entryPrice - riskPerUnit : entryPrice + riskPerUnit;
  const qty = lots * lotSize;

  return {
    id: randomUUID(),
    runId,
    strategyId: strategy.id,
    underlying,
    futKey,
    futLabel,
    side,

    signalBarTime,
    signalTf: strategy.timeframes?.trigger ?? null,
    reasons: signal.reasons ?? [],

    entryTime: now,
    entryPrice,
    lots,
    lotSize,
    qty,

    initialStop,
    currentStop: initialStop,
    atrAtEntry: atr,
    riskPerUnit,

    highWater: entryPrice,
    lowWater: entryPrice,
    breakevenMoved: false,
    barsHeld: 0,

    cashPriceAtSignal,
    basisAtEntry:
      cashPriceAtSignal != null ? entryPrice - cashPriceAtSignal : null,

    // Margin blocked for as long as this position is open. Captured at entry so
    // the account's committed capital is a simple sum over open positions.
    marginBlocked: marginRequired(entryPrice, qty),

    // Real charge rates for this contract, resolved at open so the close path
    // (which runs inside a tick handler) stays synchronous.
    chargeRates,

    // Market conditions at entry, for the trade review.
    features,

    state: "open",
  };
}

/** Profit in price terms at `price`, signed so positive is always good. */
function profitPerUnit(position, price) {
  return position.side === "long"
    ? price - position.entryPrice
    : position.entryPrice - price;
}

/** Profit expressed in R. */
export function unrealisedR(position, price) {
  return profitPerUnit(position, price) / position.riskPerUnit;
}

/** Has price reached or passed the stop, in the direction that matters? */
function stopHit(position, price) {
  return position.side === "long"
    ? price <= position.currentStop
    : price >= position.currentStop;
}

function targetPrice(position, strategy) {
  const dist = strategy.exits.targetR * position.riskPerUnit;
  return position.side === "long"
    ? position.entryPrice + dist
    : position.entryPrice - dist;
}

function targetHit(position, strategy, price) {
  return position.side === "long"
    ? price >= targetPrice(position, strategy)
    : price <= targetPrice(position, strategy);
}

/** Which flavour of stop is currently armed — for the trade's exit_reason. */
function stopFlavour(position) {
  if (position.currentStop === position.initialStop) return "stop";
  const atEntry = Math.abs(position.currentStop - position.entryPrice) < 1e-9;
  return atEntry ? "breakeven" : "trail";
}

/**
 * Evaluate one price observation against an open position.
 *
 * Stop is checked BEFORE target. On a tick stream a single price cannot be both,
 * so the order is immaterial there — but the backtest replays whole bars, where
 * a bar's range may contain both levels and the true sequence is unknowable.
 * Assuming the stop came first keeps the pessimistic reading, which is the only
 * safe bias when the alternative is inventing profits.
 *
 * @returns {{exit: {reason:string, price:number}|null, position: object}}
 */
export function checkExit(position, strategy, price, now) {
  if (!Number.isFinite(price)) return { exit: null, position };

  // 1. Hard square-off. Intraday futures must be flat before the close, and the
  //    live feed itself stops at 15:30.
  if (istMinutes(now) >= strategy.exits.squareOffMin) {
    return { exit: { reason: "squareoff", price }, position };
  }

  const next = trackExcursion(position, price);

  // 2. Stop (including break-even and trail, which are the same mechanism).
  if (stopHit(next, price)) {
    return { exit: { reason: stopFlavour(next), price: next.currentStop }, position: next };
  }

  // 3. Target.
  if (targetHit(next, strategy, price)) {
    return { exit: { reason: "target", price: targetPrice(next, strategy) }, position: next };
  }

  // 4. Nothing fired — advance the stop if this price earned it.
  return { exit: null, position: manageStop(next, strategy, price) };
}

/** Update the high/low watermarks that drive the trail and MAE/MFE. */
function trackExcursion(position, price) {
  if (price <= position.highWater && price >= position.lowWater) return position;
  return {
    ...position,
    highWater: Math.max(position.highWater, price),
    lowWater: Math.min(position.lowWater, price),
  };
}

/**
 * Move the stop to break-even at +1R, then trail it behind the best price seen.
 * The stop only ever moves in the trader's favour — a trail that could loosen
 * would let a winner turn into a loser without ever touching the stop.
 */
function manageStop(position, strategy, price) {
  const { breakevenAtR, trailAtr } = strategy.exits;
  const rNow = unrealisedR(position, price);
  let { currentStop, breakevenMoved } = position;

  if (!breakevenMoved && rNow >= breakevenAtR) {
    currentStop = position.entryPrice;
    breakevenMoved = true;
  }

  if (breakevenMoved) {
    const trailDist = trailAtr * position.atrAtEntry;
    const candidate =
      position.side === "long"
        ? position.highWater - trailDist
        : position.lowWater + trailDist;
    currentStop =
      position.side === "long"
        ? Math.max(currentStop, candidate)
        : Math.min(currentStop, candidate);
  }

  if (currentStop === position.currentStop && breakevenMoved === position.breakevenMoved) {
    return position;
  }
  return { ...position, currentStop, breakevenMoved };
}

/**
 * Advance the bar counter and apply the time stops.
 *
 * TWO stops, because the trade data shows two distinct failure modes:
 *
 *   prove-it — 61% of losing trades never got more than +0.25R above entry and
 *              were dead within ~8 minutes, while winners showed themselves
 *              fast (median +1.49R excursion, only 0.25R of heat). A trade that
 *              has not moved in its favour within a few bars was simply wrong
 *              at entry, and riding it to a full 1R stop pays the maximum price
 *              for information already available.
 *
 *   time     — a trade that is alive but going nowhere after `timeStopBars` is
 *              costing opportunity and drifting toward a reversal. Trades past
 *              1R are exempt: this exists to kill dead trades, not cap winners.
 */
export function onBarClose(position, strategy, price, now) {
  const next = { ...position, barsHeld: position.barsHeld + 1 };
  const r = Number.isFinite(price) ? unrealisedR(next, price) : 0;

  const proveBars = strategy.exits.proveItBars;
  const proveR = strategy.exits.proveItR ?? 0.25;
  if (Number.isFinite(proveBars) && next.barsHeld >= proveBars) {
    // Judge on the best the trade ever managed, not where it happens to sit —
    // a trade that spiked and gave it back has at least shown follow-through.
    const bestR = bestExcursionR(next);
    if (bestR < proveR && r < proveR) {
      return { exit: { reason: "proveit", price }, position: next };
    }
  }

  if (next.barsHeld < strategy.exits.timeStopBars) return { exit: null, position: next };
  if (r >= 1) return { exit: null, position: next };
  return { exit: { reason: "time", price }, position: next };
}

/**
 * Everything that happens to a live position when a bar closes: the price
 * checks first (a stop or target reached at the close still exits as such),
 * then the bar-counted rules — prove-it and the time stop.
 *
 * Live paper and shadow logging both drive this, so the bar-close rules cannot
 * be wired into one path and forgotten in the other.
 */
export function manageBarClose(position, strategy, price, now) {
  const checked = checkExit(position, strategy, price, now);
  if (checked.exit) return checked;
  return onBarClose(checked.position, strategy, price, now);
}

/** Best excursion so far, in R. */
function bestExcursionR(position) {
  const best =
    position.side === "long"
      ? position.highWater - position.entryPrice
      : position.entryPrice - position.lowWater;
  return best / position.riskPerUnit;
}

/**
 * May a NEW position be opened at this moment?
 *
 * Entering shortly before the square-off is structurally hopeless: a setup
 * needing 2.5R cannot travel that far in the few minutes left, so the trade is
 * flattened at whatever the clock dictates. In the recorded data 152 such
 * trades cost −53.5R between them.
 */
export function entriesAllowed(strategy, now) {
  const cutoff = strategy.exits.noEntryAfterMin;
  if (!Number.isFinite(cutoff)) return true;
  return istMinutes(now) < cutoff;
}

/**
 * Turn an open position plus an exit into the immutable trade record.
 *
 * R is computed on NET P&L, after costs. Measuring R on gross would flatter
 * every strategy by exactly the amount the broker takes.
 */
export function closePosition(position, exitPrice, exitReason, now, costConfig = DEFAULT_COSTS) {
  const filled = applySlippage(exitPrice, position.side, false, costConfig);

  // A trade cannot end before it began. Clock skew between the wall clock and
  // exchange tick timestamps has produced exactly that, and a negative holding
  // period silently corrupts every duration-based metric downstream.
  const exitTime = Math.max(now, position.entryTime);

  const grossPnl =
    position.side === "long"
      ? (filled - position.entryPrice) * position.qty
      : (position.entryPrice - filled) * position.qty;

  // Real Upstox charges when the contract was calibrated at entry; the
  // estimated model otherwise. `costs.source` records which was used, because a
  // metric computed on estimated costs is not comparable to one computed on
  // real ones.
  const costs = roundTripCharges({
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice: filled,
    qty: position.qty,
    rates: position.chargeRates,
    costConfig,
  });

  const netPnl = grossPnl - costs.total;
  const rupeeRisk = position.riskPerUnit * position.qty;

  // Excursions in R, measured from the watermarks rather than the exit price, so
  // a trade that ran to +3R before stopping out at break-even still shows it.
  const favourable =
    position.side === "long"
      ? position.highWater - position.entryPrice
      : position.entryPrice - position.lowWater;
  const adverse =
    position.side === "long"
      ? position.entryPrice - position.lowWater
      : position.highWater - position.entryPrice;

  return {
    id: position.id,
    runId: position.runId,
    strategyId: position.strategyId,
    underlying: position.underlying,
    futKey: position.futKey,
    futLabel: position.futLabel,
    side: position.side,

    signalBarTime: position.signalBarTime,
    signalTf: position.signalTf,
    reasons: position.reasons,

    entryTime: position.entryTime,
    entryPrice: position.entryPrice,
    lots: position.lots,
    lotSize: position.lotSize,
    qty: position.qty,

    initialStop: position.initialStop,
    atrAtEntry: position.atrAtEntry,
    riskPerUnit: position.riskPerUnit,
    rupeeRisk,

    exitTime,
    exitPrice: filled,
    exitReason,

    marginBlocked: position.marginBlocked,

    grossPnl,
    costs: costs.total,
    costBreakdown: costs,
    costSource: costs.source,
    netPnl,
    rMultiple: rupeeRisk > 0 ? netPnl / rupeeRisk : 0,

    mae: Math.max(0, adverse) / position.riskPerUnit,
    mfe: Math.max(0, favourable) / position.riskPerUnit,
    barsHeld: position.barsHeld,
    cashPriceAtSignal: position.cashPriceAtSignal,
    basisAtEntry: position.basisAtEntry,
    features: position.features ?? null,
    slotTaken: position.slotTaken ?? null,
  };
}

/**
 * Replay one whole BAR against a position, for the backtest.
 *
 * Without ticks the intrabar path is unknown, so this takes the pessimistic
 * reading: if the bar's range contains the stop, the stop is taken, even when
 * the target is also inside the range. Any other assumption manufactures
 * winners that the live engine would not have produced.
 */
export function applyBar(position, strategy, bar, now) {
  if (istMinutes(now) >= strategy.exits.squareOffMin) {
    return { exit: { reason: "squareoff", price: bar.close }, position };
  }

  const worst = position.side === "long" ? bar.low : bar.high;
  const best = position.side === "long" ? bar.high : bar.low;

  const tracked = trackExcursion(trackExcursion(position, worst), best);

  if (stopHit(tracked, worst)) {
    return { exit: { reason: stopFlavour(tracked), price: tracked.currentStop }, position: tracked };
  }
  if (targetHit(tracked, strategy, best)) {
    return { exit: { reason: "target", price: targetPrice(tracked, strategy) }, position: tracked };
  }

  const managed = manageStop(tracked, strategy, bar.close);
  return onBarClose(managed, strategy, bar.close, now);
}
