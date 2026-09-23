import trendMomentum from "./trendMomentum.js";
import vwapRelativeStrength from "./vwapRelativeStrength.js";
import momentumSurge from "./momentumSurge.js";
import { selective } from "./selective.js";
import { DAY_TYPES } from "../paper/dayType.js";

/**
 * Strategy registry — the single source of truth for what the paper engine
 * trades and what the UI describes.
 *
 * Adding a strategy means adding one file and one line here; nothing else in the
 * system needs to know about it.
 */

const ORIGINALS = [momentumSurge, trendMomentum, vwapRelativeStrength];

// Only the original strategies trade live. The Selective versions (see
// selective.js) were removed on 16 Sept after losing more than the originals in
// their first live session; they remain available to the replay for research.
const REGISTRY = new Map(ORIGINALS.map((s) => [s.id, s]));

/** Selective versions, for the replay only — never registered for live trading. */
export function selectiveVariants() {
  return ORIGINALS.map(selective);
}

/** The family an entry belongs to — an original and its Selective twin share one. */
export function familyOf(strategy) {
  return strategy?.family ?? strategy?.id;
}

/** All registered strategies, in registration order. */
export function list() {
  return [...REGISTRY.values()];
}

/** All strategy ids. */
export function ids() {
  return [...REGISTRY.keys()];
}

/** One strategy by id, or undefined. */
export function get(id) {
  return REGISTRY.get(id);
}

/** UI-facing metadata — never exposes the check functions themselves. */
export function describeAll() {
  return list().map((s) => ({
    id: s.id,
    name: s.name,
    tagline: s.tagline,
    description: s.description,
    timeframes: s.timeframes,
    exits: s.exits,
    family: familyOf(s),
    selection: s.selection ? { version: s.selection.version, minAlignedRsPct: s.selection.minAlignedRsPct } : null,
  }));
}

/**
 * Validate the registry shape at boot, so a malformed strategy fails loudly
 * here rather than silently never firing a signal during a live session.
 */
export function validate() {
  const problems = [];
  for (const s of list()) {
    if (!s.id) problems.push("a strategy is missing an id");
    if (typeof s.evaluate !== "function") problems.push(`${s.id}: evaluate is not a function`);
    if (!s.description?.long || !s.description?.short) {
      problems.push(`${s.id}: description must have long and short`);
    }
    for (const k of ["stopAtr", "trailAtr", "breakevenAtR", "targetR", "timeStopBars", "squareOffMin"]) {
      if (!Number.isFinite(s.exits?.[k])) problems.push(`${s.id}: exits.${k} must be a number`);
    }
    if (s.exits?.stopAtr <= 0) problems.push(`${s.id}: exits.stopAtr must be > 0`);
    for (const t of s.dayTypes ?? []) {
      if (!DAY_TYPES.includes(t)) problems.push(`${s.id}: unknown day type "${t}"`);
    }
    // Live bar-close rules (prove-it, time stop) count 3-minute bars.
    if (s.timeframes?.trigger !== "3m") problems.push(`${s.id}: timeframes.trigger must be "3m"`);
  }
  return problems;
}
