/**
 * Trade selection for the Selective strategy variants.
 *
 * The original strategies take every signal their checks allow, and on
 * 15 Sept that meant 49 trades at a 47% win rate with charges eating 47% of the
 * gross. What most separated the winners from the losers was not the signal
 * itself but how hard the stock was moving against the index in the trade's
 * direction: winners (R ≥ 0.5) had a median +1.62% relative strength at entry,
 * losers +0.34%. A stock that is merely drifting with Nifty gives the trade
 * nothing of its own to ride.
 *
 * So Selective variants keep the same signal and the same exits, and add a
 * quality bar in front of the entry. There is deliberately NO daily trade cap:
 * how many trades a day produces should follow from how many setups clear the
 * bar — a quiet day may give two, a strong one fifteen.
 *
 * Pure functions only — the live engine and the replay both call these, so a
 * replayed result measures exactly the rule that trades live.
 */

const BAR_MS = 3 * 60 * 1000;

export const SELECTION = Object.freeze({
  // Bump whenever a number below changes, so trades stay attributable.
  //   v1 — minAlignedRsPct 1.0, read from 15 Sept live trades alone.
  //   v2 — 1.5, from the replay of 7–11 and 15 Sept (npm run replay): 1.5 beat
  //        1.0 on 5 of 6 sessions and in all three strategy families, with a
  //        quarter fewer trades (−51R vs −99R in total; originals −185R).
  //        Every variant still lost over those days — this bar reduces damage,
  //        it does not by itself make the signals profitable.
  version: 2,

  // The stock must be beating Nifty by at least this much (% from the open) in
  // the direction of the trade. Below it the move is mostly the index's.
  minAlignedRsPct: 1.5,

  // A name that already stopped this strategy out today has shown the setup is
  // not working there; re-entering it repeatedly is how PFC, PATANJALI and
  // VEDL turned into 13 trades and −₹8.2k on 15 Sept.
  noRetryAfterLoss: true,

  // Another strategy family signalling the same stock and side within this many
  // bars counts as independent confirmation.
  confluenceBars: 2,

  // Quality score — used to ORDER candidates competing for the same capital.
  // It never gates on its own and never changes the stop.
  weights: Object.freeze({ rs: 0.5, room: 0.25, confluence: 0.25 }),
  scale: Object.freeze({
    rsFullPct: 2.5, // relative strength at which the rs component saturates
    roomFullPct: 0.5, // stop distance (% of price) at which charges stop mattering
  }),
});

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** Relative strength signed so positive always favours the trade. */
export function alignedRsOf(relStrength, side) {
  if (relStrength == null || !Number.isFinite(relStrength)) return null;
  return side === "short" ? -relStrength : relStrength;
}

/**
 * Stop distance as a percentage of price. Charges are roughly a fixed
 * percentage of notional, so a wider stop means charges are a smaller slice of
 * the risk. This only ranks trades; it does not move the stop.
 */
export function stopPctOf(strategy, atr, price) {
  if (!(atr > 0) || !(price > 0)) return null;
  return ((strategy.exits.stopAtr * atr) / price) * 100;
}

/**
 * Bounded 0–1 quality score with its parts.
 * @param {{alignedRs:number|null, stopPct:number|null, confluence:number}} inp
 */
export function qualityOf({ alignedRs, stopPct, confluence = 0 }, cfg = SELECTION) {
  const components = {
    rs: clamp01((alignedRs ?? 0) / cfg.scale.rsFullPct),
    room: clamp01((stopPct ?? 0) / cfg.scale.roomFullPct),
    confluence: confluence > 0 ? 1 : 0,
  };
  let score = 0;
  for (const [k, w] of Object.entries(cfg.weights)) score += w * components[k];
  const r = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
  return {
    v: cfg.version,
    score: r(score),
    components: { rs: r(components.rs), room: r(components.room), confluence: components.confluence },
    alignedRs: r(alignedRs),
    stopPct: r(stopPct),
    confluence,
  };
}

const signedPct = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;

/**
 * Why a Selective strategy should NOT take this candidate, or null to allow it.
 * @param {{underlying:string, alignedRs:number|null}} candidate
 * @param {{lostNames:Set<string>}} dayState
 */
export function selectionVeto({ underlying, alignedRs }, dayState, cfg = SELECTION) {
  if (alignedRs == null) return "no strength-vs-Nifty reading";
  if (alignedRs < cfg.minAlignedRsPct) {
    return `weak vs Nifty (${signedPct(alignedRs)}, needs ${signedPct(cfg.minAlignedRsPct)})`;
  }
  if (cfg.noRetryAfterLoss && dayState?.lostNames?.has(underlying)) {
    return `already lost on ${underlying} today`;
  }
  return null;
}

/** Skip reasons produced by selectionVeto, for counting them back from the store. */
export const SELECTION_SKIP_PREFIXES = ["weak vs Nifty", "already lost on", "no strength-vs-Nifty"];

export function isSelectionSkip(reason) {
  return typeof reason === "string" && SELECTION_SKIP_PREFIXES.some((p) => reason.startsWith(p));
}

/** Empty per-strategy state for one session. */
export function createDayState() {
  return { lostNames: new Set(), taken: 0, skippedForQuality: 0 };
}

/**
 * Rebuild each strategy's day state from what is already recorded today, so a
 * restart mid-session keeps "already lost today" and the counts intact.
 *
 * @param {{trades:object[], openPositions:object[], skips?:{strategyId:string,n:number}[]}} p
 * @returns {Map<string, ReturnType<typeof createDayState>>}
 */
export function buildDayStates({ trades = [], openPositions = [], skips = [] }) {
  const states = new Map();
  const of = (id) => {
    if (!states.has(id)) states.set(id, createDayState());
    return states.get(id);
  };
  for (const t of trades) {
    const s = of(t.strategyId);
    s.taken++;
    if (t.netPnl < 0) s.lostNames.add(t.underlying);
  }
  for (const p of openPositions) of(p.strategyId).taken++;
  for (const k of skips) of(k.strategyId).skippedForQuality += k.n;
  return states;
}

/** Update a day state when one of its trades closes. */
export function noteClose(dayState, trade) {
  if (trade.netPnl < 0) dayState.lostNames.add(trade.underlying);
}

/**
 * Recent signals by stock and side, for confluence. A family is an original
 * strategy and its Selective twin — they share a signal, so they must never
 * count as confirming each other.
 */
export function createConfluence(cfg = SELECTION) {
  const recent = new Map(); // `${underlying}:${side}` -> [{family, barTime}]
  const windowMs = cfg.confluenceBars * BAR_MS;

  return {
    note(family, underlying, side, barTime) {
      const k = `${underlying}:${side}`;
      const list = recent.get(k) ?? [];
      if (!list.some((e) => e.family === family && e.barTime === barTime)) list.push({ family, barTime });
      recent.set(k, list);
    },
    /** Other families that signalled this stock and side within the window. */
    count(family, underlying, side, barTime) {
      const list = recent.get(`${underlying}:${side}`) ?? [];
      const others = new Set();
      for (const e of list) {
        if (e.family !== family && Math.abs(e.barTime - barTime) <= windowMs) others.add(e.family);
      }
      return others.size;
    },
    prune(now) {
      for (const [k, list] of recent) {
        const kept = list.filter((e) => now - e.barTime <= windowMs + BAR_MS);
        if (kept.length) recent.set(k, kept);
        else recent.delete(k);
      }
    },
  };
}
