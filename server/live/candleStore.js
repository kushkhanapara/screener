import { MAX_LIVE_BARS } from "../config.js";

/**
 * In-memory rolling 1-minute candle store, per instrument key.
 *
 * Each candle: { time: minuteStartMs, open, high, low, close, volume }.
 * seed() loads an initial ascending window; addTick() extends/updates the
 * current minute as live ltpc ticks arrive. Only the last MAX_LIVE_BARS are kept.
 */

const MINUTE = 60 * 1000;

class CandleStore {
  #data = new Map(); // key -> { bars: candle[], lastMin: number }

  /** Bucket a timestamp (ms) to its minute start. */
  #bucket(ms) {
    return Math.floor(ms / MINUTE) * MINUTE;
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
    // Dedupe by minute (keep last), sort ascending, trim.
    const byMin = new Map();
    for (const b of bars) byMin.set(b.time, b);
    const merged = [...byMin.values()].sort((a, b) => a.time - b.time);
    const trimmed = merged.slice(-MAX_LIVE_BARS);
    this.#data.set(key, {
      bars: trimmed,
      lastMin: trimmed.length ? trimmed[trimmed.length - 1].time : -1,
    });
  }

  /** Apply a live trade tick. */
  addTick(key, price, tsMs, qty = 0) {
    if (!Number.isFinite(price)) return;
    let entry = this.#data.get(key);
    if (!entry) {
      entry = { bars: [], lastMin: -1 };
      this.#data.set(key, entry);
    }
    const min = this.#bucket(tsMs);
    if (min < entry.lastMin) return; // ignore stale ticks

    if (min === entry.lastMin && entry.bars.length) {
      const c = entry.bars[entry.bars.length - 1];
      c.high = Math.max(c.high, price);
      c.low = Math.min(c.low, price);
      c.close = price;
      c.volume += qty;
    } else {
      entry.bars.push({ time: min, open: price, high: price, low: price, close: price, volume: qty });
      entry.lastMin = min;
      if (entry.bars.length > MAX_LIVE_BARS) entry.bars.shift();
    }
  }

  /** Ascending candle array for a key (or empty). */
  bars(key) {
    return this.#data.get(key)?.bars ?? [];
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

export const candleStore = new CandleStore();
