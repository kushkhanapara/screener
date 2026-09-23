import { SELECTION } from "../paper/selection.js";

/**
 * The Selective version of a strategy: identical signal, identical stops and
 * exits, plus the quality bar in paper/selection.js in front of every entry.
 *
 * It runs alongside the original with its own capital, so on the same days and
 * the same signals the difference between the two is exactly what the quality
 * bar is worth.
 */
export function selective(base) {
  return Object.freeze({
    ...base,
    id: `${base.id}-selective`,
    family: base.id,
    name: `${base.name} · Selective`,
    tagline: "Only setups clearly stronger than Nifty",
    selection: SELECTION,
  });
}
