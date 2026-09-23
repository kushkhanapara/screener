import { MAX_LIVE_BARS } from "../config.js";

/**
 * In-memory rolling candle store, per instrument key, at a fixed bucket size.
 *
 * Each candle: { time: bucketStartMs, open, high, low, close, volume }.
 * seed() loads an initial ascending window; addTick() extends/updates the
 * current bucket as live ltpc ticks arrive. Only the last MAX_LIVE_BARS kept.
 *
 * The bucket size is a constructor parameter so the same class backs the live
 * 3-minute and 15-minute stores (both fed from the same cash tick stream).
 */

class CandleStore {
  #data = new Map(); // key -> { bars: candle[], lastBucket: number }
  #bucketMs;

  constructor(bucketMs) {
    this.#bucketMs = bucketMs;
  }

  /** Bucket a timestamp (ms) to its bucket start. */
  #bucket(ms) {
    return Math.floor(ms / this.#bucketMs) * this.#bucketMs;
  }

  /** Load an initial ascending candle window (from seeding). */
  seed(key, candles) {
    const bars = candles
      .map((c) => ({
        time: this.#bucket(new Date(c.time).getTime()),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0,
      }))
      .filter((c) => Number.isFinite(c.close));
    // Dedupe by bucket (keep last), sort ascending, trim.
    const byBucket = new Map();
    for (const b of bars) byBucket.set(b.time, b);
    const merged = [...byBucket.values()].sort((a, b) => a.time - b.time);
    const trimmed = merged.slice(-MAX_LIVE_BARS);
    this.#data.set(key, {
      bars: trimmed,
      lastBucket: trimmed.length ? trimmed[trimmed.length - 1].time : -1,
    });
  }

  /** Apply a live trade tick. */
  addTick(key, price, tsMs, qty = 0) {
    if (!Number.isFinite(price)) return;
    let entry = this.#data.get(key);
    if (!entry) {
      entry = { bars: [], lastBucket: -1 };
      this.#data.set(key, entry);
    }
    const b = this.#bucket(tsMs);
    if (b < entry.lastBucket) return; // ignore stale ticks

    if (b === entry.lastBucket && entry.bars.length) {
      const c = entry.bars[entry.bars.length - 1];
      c.high = Math.max(c.high, price);
      c.low = Math.min(c.low, price);
      c.close = price;
      c.volume += qty;
    } else {
      entry.bars.push({ time: b, open: price, high: price, low: price, close: price, volume: qty });
      entry.lastBucket = b;
      if (entry.bars.length > MAX_LIVE_BARS) entry.bars.shift();
    }
  }

  /** Ascending candle array for a key (or empty). Includes the FORMING bar. */
  bars(key) {
    return this.#data.get(key)?.bars ?? [];
  }

  /** Bucket size in ms, so callers can reason about bar boundaries. */
  get bucketMs() {
    return this.#bucketMs;
  }

  /**
   * Ascending candles EXCLUDING the still-forming bar.
   *
   * Evaluating the forming bar is what makes signals repaint: a 15m bar
   * re-evaluated every minute yields 15 different answers, so a name can enter
   * and exit a matching set several times within one bar. Anything that opens a
   * position must read this, not bars().
   *
   * Closure is time-based rather than tick-based, so an illiquid name that stops
   * ticking still resolves its last bar instead of hanging forever.
   */
  closedBars(key, now = Date.now()) {
    const bars = this.#data.get(key)?.bars ?? [];
    if (!bars.length) return bars;
    const last = bars[bars.length - 1];
    return last.time + this.#bucketMs > now ? bars.slice(0, -1) : bars;
  }

  /** Bucket start of the newest CLOSED bar, or -1 when there is none. */
  lastClosedBucket(key, now = Date.now()) {
    const closed = this.closedBars(key, now);
    return closed.length ? closed[closed.length - 1].time : -1;
  }

  /**
   * How many buckets have elapsed since the newest closed bar. A name whose data
   * has gone stale (feed gap, halted scrip) returns a large number; callers use
   * it to skip rather than act on a stale price.
   */
  stalenessBuckets(key, now = Date.now()) {
    const last = this.lastClosedBucket(key, now);
    if (last < 0) return Infinity;
    return Math.floor((now - (last + this.#bucketMs)) / this.#bucketMs);
  }

  keys() {
    return [...this.#data.keys()];
  }

  size() {
    return this.#data.size;
  }

  clear() {
    this.#data.clear();
  }
}

export { CandleStore };

// Live cash-equity stores at the two strategy timeframes, keyed by cash key.
export const store3m = new CandleStore(3 * 60 * 1000);
export const store15m = new CandleStore(15 * 60 * 1000);

// NIFTY 3-minute bars, shared by every consumer so the index is seeded and fed once.
export const storeIndex3m = new CandleStore(3 * 60 * 1000);
