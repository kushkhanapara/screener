import { SINGLE_SLOT } from "./config.js";

export const BAR_MS = 3 * 60 * 1000;

/** Rejection codes in funnel order, cheapest check first. */
export const REJECT_ORDER = [
  "no_quote",
  "price_below_min",
  "margin_exceeds_capital",
  "no_data",
  "banned",
  "no_daily_data",
  "atr_percentile",
  "stop_too_tight",
  "rs_weak",
  "market_context",
  "no_oi_baseline",
  "oi_not_building",
  "oi_price_mismatch",
  "volume_unchecked",
  "no_volume_norm",
  "volume_missing",
  "volume_low",
  "not_persistent",
];

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

export function scoreOf(components, weights = SINGLE_SLOT.weights) {
  let s = 0;
  for (const [k, w] of Object.entries(weights)) s += w * clamp01(components[k] ?? 0);
  return s;
}

/** Tier 1: is this contract mechanically tradeable with the account? */
export function tier1(contract, quote, cfg = SINGLE_SLOT) {
  if (!contract || !quote || !(quote.ltp > 0)) return { eligible: false, rejectCode: "no_quote" };
  if (quote.ltp < cfg.minPrice) return { eligible: false, rejectCode: "price_below_min" };
  const notional = quote.ltp * contract.lotSize;
  const margin = notional * cfg.marginPct;
  if (margin > cfg.capital) return { eligible: false, rejectCode: "margin_exceeds_capital", margin };
  return { eligible: true, margin, notional };
}

/**
 * Tier 2 and the cheap Tier 3 gates, in cost order. Each is a hard veto.
 * `null` inputs mean "unknown" for the ban list and market context, which do
 * not veto; missing price data always does.
 *
 * @returns {{pass, rejectCode, side, gates, components, partial, passedRs}}
 */
export function preGates(inp, cfg = SINGLE_SLOT) {
  const gates = {};
  let side = null;
  let passedRs = false;
  const fail = (code) => ({ pass: false, rejectCode: code, side, gates, components: null, partial: 0, passedRs });

  gates.ban = inp.banned == null ? null : !inp.banned;
  if (inp.banned === true) return fail("banned");

  if (inp.atrPercentile == null) return fail("no_daily_data");
  gates.atrPercentile =
    inp.atrPercentile >= cfg.atrPercentile.min && inp.atrPercentile <= cfg.atrPercentile.max;
  if (!gates.atrPercentile) return fail("atr_percentile");

  if (inp.atrPct3m == null) return fail("no_data");
  gates.minStop = cfg.exits.stopAtr * inp.atrPct3m >= cfg.minStopPct;
  if (!gates.minStop) return fail("stop_too_tight");

  if (inp.residualPct == null) return fail("no_data");
  side = inp.residualPct > 0 ? "long" : "short";
  gates.rs = Math.abs(inp.residualPct) >= cfg.minResidualPct;
  if (!gates.rs) return fail("rs_weak");
  passedRs = true;

  const orKnown = inp.indexClose != null && inp.orHigh != null && inp.orLow != null;
  if (!orKnown) {
    gates.context = null;
  } else {
    gates.context = side === "long" ? inp.indexClose > inp.orLow : inp.indexClose < inp.orHigh;
    if (!gates.context) return fail("market_context");
  }

  if (!inp.hasOiBaseline || inp.oiChangePct == null) return fail("no_oi_baseline");
  gates.oiBuilding = inp.oiChangePct > 0;
  if (!gates.oiBuilding) return fail("oi_not_building");
  const dir = side === "long" ? 1 : -1;
  gates.oiPriceAgree = inp.futPriceChangePct != null && inp.futPriceChangePct * dir > 0;
  if (!gates.oiPriceAgree) return fail("oi_price_mismatch");

  const components = {
    rs: clamp01(Math.abs(inp.residualPct) / cfg.scale.rsFullPct),
    oi: clamp01(inp.oiChangePct / cfg.scale.oiFullPct),
  };
  return {
    pass: true,
    rejectCode: null,
    side,
    gates,
    components,
    partial: cfg.weights.rs * components.rs + cfg.weights.oi * components.oi,
    passedRs,
  };
}

/**
 * Volume and persistence gates, then the bounded score.
 * `nextState` is the persistence streak to carry to the next bar — null once
 * any non-persistence gate fails, which resets the streak.
 */
export function finalize(pre, vol, prev, barTime, cfg = SINGLE_SLOT) {
  const gates = { ...pre.gates };
  const base = { side: pre.side, gates, components: pre.components, score: null, streak: 0 };
  const fail = (code, extra = {}) => ({ ...base, pass: false, rejectCode: code, nextState: null, ...extra });

  if (!vol?.volumeChecked) return fail("volume_unchecked");
  if (vol.volumeRatio == null) {
    return fail((vol.normSessions ?? 0) < cfg.minNormSessions ? "no_volume_norm" : "volume_missing");
  }
  gates.volume = vol.volumeRatio >= cfg.minVolumeRatio;
  if (!gates.volume) return fail("volume_low");

  const streak =
    prev && prev.barTime === barTime - BAR_MS && prev.side === pre.side ? prev.streak + 1 : 1;
  const nextState = { barTime, side: pre.side, streak };
  gates.persistence = streak >= cfg.persistenceBars;

  const components = {
    ...pre.components,
    volume: clamp01((vol.volumeRatio - 1) / (cfg.scale.volumeFullRatio - 1)),
    persistence: clamp01((streak - 1) / (cfg.scale.persistenceFullBars - 1)),
  };
  const score = scoreOf(components, cfg.weights);

  if (!gates.persistence) {
    return { ...base, gates, components, score, streak, pass: false, rejectCode: "not_persistent", nextState };
  }
  return { ...base, gates, components, score, streak, pass: true, rejectCode: null, nextState };
}
