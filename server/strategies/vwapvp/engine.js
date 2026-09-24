import * as base from "../../paper/engine.js";

/**
 * Exits for VWAP + Volume Profile, layered on the shared paper engine WITHOUT
 * changing it.
 *
 * This strategy places its own levels — a stop behind a volume zone, a VWAP
 * target, break-even at a prior swing — where every other strategy uses ATR
 * and R multiples. Rather than teach the shared engine about them (and risk
 * the strategies already trading), each trade's levels are translated into the
 * settings the shared engine already understands:
 *
 *   own stop      → the position's initial stop and 1R distance
 *   target price  → a per-trade targetR  = (target − entry) / R
 *   break-even at → a per-trade breakevenAtR = (level − entry) / R
 *
 * The one genuinely new rule — close the trade when a bar CLOSES beyond the
 * zone it was built on ("invalidated") — is checked here, after the shared
 * engine has had its say on the bar.
 *
 * Each level is used only when it still sits on the correct side of the actual
 * fill (the fill comes a bar after the signal and can gap past a level);
 * otherwise the strategy's ATR/R defaults apply, exactly as for any strategy.
 */

/** A copy of the strategy carrying this position's own targetR / breakevenAtR. */
function exitsFor(position, strategy) {
  const lv = position.levels;
  if (!lv || (lv.targetR == null && lv.breakevenAtR == null)) return strategy;
  return {
    ...strategy,
    exits: {
      ...strategy.exits,
      ...(lv.targetR != null ? { targetR: lv.targetR } : {}),
      ...(lv.breakevenAtR != null ? { breakevenAtR: lv.breakevenAtR } : {}),
    },
  };
}

function closedBeyondZone(position, price) {
  const inv = position.levels?.invalidateAt;
  if (inv == null || !Number.isFinite(price)) return false;
  return position.side === "long" ? price < inv : price > inv;
}

/** Same arguments as the shared openPosition; `signal` may carry stop / target / breakevenAt / invalidateAt. */
export function openPosition(args) {
  const position = base.openPosition(args);
  const { signal } = args;
  const entry = position.entryPrice;
  const dir = position.side === "long" ? 1 : -1;
  // Is `price` strictly on the favourable (profit) or adverse (loss) side of the fill?
  const onSide = (price, favourable) => Number.isFinite(price) && dir * (price - entry) * (favourable ? 1 : -1) > 0;

  if (onSide(signal.stop, false)) {
    position.initialStop = signal.stop;
    position.currentStop = signal.stop;
    position.riskPerUnit = Math.abs(entry - signal.stop);
  }
  const R = position.riskPerUnit;
  const inR = (price) => (dir * (price - entry)) / R;

  position.levels = {
    targetPrice: onSide(signal.target, true) ? signal.target : null,
    breakevenAt: onSide(signal.breakevenAt, true) ? signal.breakevenAt : null,
    invalidateAt: onSide(signal.invalidateAt, false) ? signal.invalidateAt : null,
  };
  position.levels.targetR = position.levels.targetPrice != null ? inR(position.levels.targetPrice) : null;
  position.levels.breakevenAtR = position.levels.breakevenAt != null ? inR(position.levels.breakevenAt) : null;
  return position;
}

/** Backtest: one whole bar, as the shared applyBar, then the close-beyond-zone rule. */
export function applyBar(position, strategy, bar, now) {
  const r = base.applyBar(position, exitsFor(position, strategy), bar, now);
  if (r.exit) return r;
  if (closedBeyondZone(r.position, bar.close)) {
    return { exit: { reason: "invalidated", price: bar.close }, position: r.position };
  }
  return r;
}

/** Live tick: stop, target and square-off only — the zone rule waits for a bar close. */
export function checkExit(position, strategy, price, now) {
  return base.checkExit(position, exitsFor(position, strategy), price, now);
}

/** Live bar close: price checks, then the zone rule, then the bar-counted rules. */
export function manageBarClose(position, strategy, price, now) {
  const s = exitsFor(position, strategy);
  const checked = base.checkExit(position, s, price, now);
  if (checked.exit) return checked;
  if (closedBeyondZone(checked.position, price)) {
    return { exit: { reason: "invalidated", price }, position: checked.position };
  }
  return base.onBarClose(checked.position, s, price, now);
}

export const { closePosition, entriesAllowed, unrealisedR } = base;

/**
 * Re-express a signal's cash-chart levels on the futures contract.
 *
 * Live positions are filled and watched on the near-month future, which trades
 * at a premium or discount to cash (the basis). Scaling by futures/cash at the
 * same moment moves each level with it — the conversion the live path already
 * applies to ATR. Needed only if this strategy is ever traded live; the replay
 * fills on cash and does not use it.
 */
export function levelsToFutures(signal, cashPrice, futPrice) {
  const k = cashPrice > 0 && futPrice > 0 ? futPrice / cashPrice : null;
  if (k == null) return signal;
  const out = { ...signal };
  for (const key of ["stop", "target", "breakevenAt", "invalidateAt"]) {
    if (Number.isFinite(signal[key])) out[key] = signal[key] * k;
  }
  return out;
}
