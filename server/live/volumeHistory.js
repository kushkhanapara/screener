/**
 * Completed-session 3-minute volume history per cash key.
 *
 * The live candle store keeps only 500 bars (~4 sessions), so a time-of-day
 * volume norm read from it saw just 3–4 prior sessions, and one abnormal day
 * could dominate it. Seeding fetches ~10 sessions anyway; this keeps the slice
 * the norm needs — time and volume only — before the store trims it.
 */

const history = new Map(); // cashKey -> [{time, volume}]

export function set(key, candles) {
  if (!key) return;
  history.set(
    key,
    (candles ?? [])
      .map((c) => ({ time: c.time, volume: Number(c.volume) || 0 }))
      .filter((c) => c.time != null)
  );
}

/** Bars for a key, or an empty array. */
export function bars(key) {
  return history.get(key) ?? [];
}

export function clear() {
  history.clear();
}
