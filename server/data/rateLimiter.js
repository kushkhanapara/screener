/**
 * Proactive Upstox REST rate limiter.
 *
 * Upstox Standard APIs (incl. Historical Candles + Market Quote) are capped at:
 *   50 requests / second, 500 / minute, 2000 / 30 minutes.
 * (https://upstox.com/developer/api-documentation/rate-limiting/)
 *
 * A single shared limiter enforces ALL THREE sliding windows at once: a caller
 * awaits acquire() and is released only when every window has room. This throttles
 * seeding + daily refresh + live futures-price fetches globally, BEFORE hitting the
 * network — the 429 backoff in upstox.js stays as a safety net for bursts we miss.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SlidingLimiter {
  /** @param {{limit:number,windowMs:number}[]} windows */
  constructor(windows) {
    this.windows = windows.map((w) => ({ ...w, hits: [] }));
  }

  /** Drop timestamps older than each window and return the soonest free time. */
  #earliestFreeAt(now) {
    let waitUntil = 0;
    for (const w of this.windows) {
      // prune
      const cutoff = now - w.windowMs;
      while (w.hits.length && w.hits[0] <= cutoff) w.hits.shift();
      if (w.hits.length >= w.limit) {
        // the oldest hit must fall out of the window before we get a slot
        const freeAt = w.hits[0] + w.windowMs;
        if (freeAt > waitUntil) waitUntil = freeAt;
      }
    }
    return waitUntil; // 0 => a slot is available now
  }

  /** Block until a slot exists in every window, then record the hit. */
  async acquire() {
    // Serialize waiters so concurrent callers don't all grab the same slot.
    const prev = this._tail || Promise.resolve();
    let release;
    this._tail = new Promise((r) => (release = r));
    await prev;

    try {
      for (;;) {
        const now = Date.now();
        const freeAt = this.#earliestFreeAt(now);
        if (!freeAt) {
          for (const w of this.windows) w.hits.push(now);
          return;
        }
        await sleep(Math.max(1, freeAt - now));
      }
    } finally {
      release();
    }
  }
}

export const upstoxLimiter = new SlidingLimiter([
  { limit: 50, windowMs: 1000 },
  { limit: 500, windowMs: 60 * 1000 },
  { limit: 2000, windowMs: 30 * 60 * 1000 },
]);
