/**
 * Proactive Upstox REST rate limiter.
 *
 * Upstox documents 50 req/s · 500/min · 2000/30min for the Standard APIs, but
 * those are NOT the binding constraint. The API sits behind Cloudflare, which
 * enforces its own much stricter sustained-rate rule and answers with
 * `429 / error code: 1015` — and once tripped it keeps returning 1015 for a
 * while even after traffic stops. Seeding ~420 candle requests at boot trips it
 * every time at the documented rates, so the defaults here are deliberately far
 * below what the docs allow.
 *
 * Two mechanisms:
 *   1. Sliding windows, enforced together, BEFORE the request goes out.
 *   2. A global circuit breaker. Per-request backoff is not enough on its own —
 *      if every in-flight request retries independently, they collectively keep
 *      hammering and extend the ban. On a 1015 the whole limiter pauses.
 *
 * Tune with UPSTOX_RPS / UPSTOX_RPM if your account behaves differently.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RPS = Number(process.env.UPSTOX_RPS) || 5;
const RPM = Number(process.env.UPSTOX_RPM) || 180;

export class SlidingLimiter {
  /** @param {{limit:number,windowMs:number}[]} windows */
  constructor(windows) {
    this.windows = windows.map((w) => ({ ...w, hits: [] }));
    this.pausedUntil = 0;
    this.penalties = 0;
  }

  /**
   * Pause every caller for `ms`. Called when the upstream signals we are over
   * the line, so the whole process backs off in unison instead of each request
   * retrying into the same wall.
   */
  penalise(ms) {
    const until = Date.now() + ms;
    if (until > this.pausedUntil) this.pausedUntil = until;
    this.penalties++;
  }

  /** Milliseconds remaining on the global pause (0 when running normally). */
  pausedFor() {
    return Math.max(0, this.pausedUntil - Date.now());
  }

  /** Drop timestamps older than each window and return the soonest free time. */
  #earliestFreeAt(now) {
    let waitUntil = 0;
    for (const w of this.windows) {
      const cutoff = now - w.windowMs;
      while (w.hits.length && w.hits[0] <= cutoff) w.hits.shift();
      if (w.hits.length >= w.limit) {
        const freeAt = w.hits[0] + w.windowMs;
        if (freeAt > waitUntil) waitUntil = freeAt;
      }
    }
    return waitUntil; // 0 => a slot is available now
  }

  /** Block until the pause has lapsed and every window has room, then record. */
  async acquire() {
    // Serialize waiters so concurrent callers don't all grab the same slot.
    const prev = this._tail || Promise.resolve();
    let release;
    this._tail = new Promise((r) => (release = r));
    await prev;

    try {
      for (;;) {
        const paused = this.pausedFor();
        if (paused > 0) {
          await sleep(paused);
          continue;
        }
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

  stats() {
    return {
      rps: RPS,
      rpm: RPM,
      pausedForMs: this.pausedFor(),
      penalties: this.penalties,
    };
  }
}

export const upstoxLimiter = new SlidingLimiter([
  { limit: RPS, windowMs: 1000 },
  { limit: RPM, windowMs: 60 * 1000 },
  { limit: 2000, windowMs: 30 * 60 * 1000 },
]);
