import { MAX_LIVE_BARS } from "../config.js";

const MINUTE_MS = 60 * 1000;

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

    // The live feed opens before seeding finishes, so ticks may already have
    // built bars for this key. Keep them rather than wiping them: bars after the
    // seeded window are added as they are, and the bar both saw (the one that
    // was forming when the REST call returned) takes the seed's open, the wider
    // range and the live close. Anything older is the seed's alone.
    const seededLast = bars.length ? Math.max(...byBucket.keys()) : -1;
    for (const live of this.#data.get(key)?.bars ?? []) {
      if (live.time < seededLast) continue;
      const s = byBucket.get(live.time);
      byBucket.set(
        live.time,
        s
          ? {
              time: live.time,
              open: s.open,
              high: Math.max(s.high, live.high),
              low: Math.min(s.low, live.low),
              close: live.close,
              volume: Math.max(s.volume, live.volume),
            }
          : { ...live }
      );
    }
    const merged = [...byBucket.values()].sort((a, b) => a.time - b.time);
    const trimmed = merged.slice(-MAX_LIVE_BARS);
    const prev = this.#data.get(key);
    const entry = {
      bars: trimmed,
      lastBucket: trimmed.length ? trimmed[trimmed.length - 1].time : -1,
      minutes: new Map(),
      base: new Map(),
      locked: new Set(),
      coveredUntil: -1, // minutes before this are inside the REST bars
    };
    this.#data.set(key, entry);

    // Minutes the feed built before this seed: the REST candles already cover
    // every minute up to the one in progress, so keep only that one and later,
    // and let the REST bar be the base of the bucket it falls in. That bucket
    // stays approximate until it closes and is repaired from REST.
    const nowMinute = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    entry.coveredUntil = nowMinute;
    for (const [m, c] of prev?.minutes ?? []) {
      if (m >= nowMinute || this.#bucket(m) > seededLast) entry.minutes.set(m, c);
    }
    const s = bars.length ? byBucket.get(seededLast) : null;
    if (s && entry.minutes.size) {
      const restBar = bars.filter((b) => b.time === seededLast).at(-1);
      entry.base.set(seededLast, { ...restBar });
    }
    for (const b of new Set([...entry.minutes.keys()].map((m) => this.#bucket(m)))) this.#rebuild(entry, b);
  }

  /*
   * Live bars are built from MINUTES.
   *
   * The feed sends snapshots (about two a second on a liquid name), not every
   * trade. Building a 3m bar straight from snapshots gets its edges wrong: the
   * first snapshot after a boundary carries trades from before it, so volume
   * slides into the next bar and the open/close come from the wrong side
   * (measured 25 Sept 2026: 8 of 50 bars off by up to 0.12%, volume +45%).
   *
   * The full feed also carries "I1", the exchange's own candle for the last
   * COMPLETED minute. So each bar is the aggregate of its minutes: completed
   * minutes from I1 (exact), the minute still forming from snapshots (close
   * to exact, and replaced by I1 a moment after it completes). Any error is
   * confined to the forming minute and corrects itself.
   */

  #entry(key) {
    let entry = this.#data.get(key);
    if (!entry) {
      entry = { bars: [], lastBucket: -1 };
      this.#data.set(key, entry);
    }
    entry.minutes ??= new Map(); // minuteStartMs -> { open, high, low, close, volume, final }
    entry.base ??= new Map(); // bucket -> the part of a seeded bar from before the feed
    entry.locked ??= new Set(); // buckets replaced by REST candles: exact, never rebuilt
    return entry;
  }

  /** Recompute the bar for `bucket` from its minutes (plus any seeded base). */
  #rebuild(entry, bucket) {
    if (entry.locked.has(bucket)) return;
    const parts = [];
    const base = entry.base.get(bucket);
    if (base) parts.push(base);
    for (let m = bucket; m < bucket + this.#bucketMs; m += MINUTE_MS) {
      const c = entry.minutes.get(m);
      if (c) parts.push(c);
    }
    if (!parts.length) return;
    const bar = {
      time: bucket,
      open: parts[0].open,
      high: Math.max(...parts.map((p) => p.high)),
      low: Math.min(...parts.map((p) => p.low)),
      close: parts[parts.length - 1].close,
      volume: parts.reduce((a, p) => a + (p.volume || 0), 0),
    };
    const i = entry.bars.findIndex((b) => b.time === bucket);
    if (i >= 0) entry.bars[i] = bar;
    else if (bucket > entry.lastBucket) {
      entry.bars.push(bar);
      entry.lastBucket = bucket;
      if (entry.bars.length > MAX_LIVE_BARS) entry.bars.shift();
    } else return; // older than the window: nothing to update
    this.#prune(entry);
  }

  /** The newest bucket the seed covered (the one a seed base is kept for). */
  #seededLastOf(entry) {
    const bases = [...entry.base.keys()];
    return bases.length ? Math.max(...bases) : this.#bucket(entry.coveredUntil ?? 0);
  }

  /** Keep minutes for the last two buckets only; older bars are final. */
  #prune(entry) {
    const keepFrom = entry.lastBucket - this.#bucketMs;
    for (const m of entry.minutes.keys()) if (m < keepFrom) entry.minutes.delete(m);
    for (const b of entry.base.keys()) if (b < keepFrom) entry.base.delete(b);
    for (const b of entry.locked) if (b < keepFrom) entry.locked.delete(b);
  }

  /** Before a bucket's first minute lands, keep whatever a seed put there. */
  #captureBase(entry, bucket) {
    if (entry.base.has(bucket)) return;
    for (let m = bucket; m < bucket + this.#bucketMs; m += MINUTE_MS) if (entry.minutes.has(m)) return;
    const seeded = entry.bars.find((b) => b.time === bucket);
    if (seeded) entry.base.set(bucket, { ...seeded });
  }

  /** Apply a live snapshot: last price, and the volume traded since the previous one. */
  addTick(key, price, tsMs, qty = 0) {
    if (!Number.isFinite(price)) return;
    const entry = this.#entry(key);
    const b = this.#bucket(tsMs);
    if (b < entry.lastBucket) return; // ignore stale ticks
    const m = Math.floor(tsMs / MINUTE_MS) * MINUTE_MS;
    if (m < (entry.coveredUntil ?? -1) && this.#bucket(m) <= this.#seededLastOf(entry)) return; // already in the seed
    const cur = entry.minutes.get(m);
    if (cur?.final) return; // the exchange's candle for this minute is already in
    this.#captureBase(entry, b);
    if (cur) {
      cur.high = Math.max(cur.high, price);
      cur.low = Math.min(cur.low, price);
      cur.close = price;
      cur.volume += qty;
    } else {
      entry.minutes.set(m, { open: price, high: price, low: price, close: price, volume: qty, final: false });
    }
    this.#rebuild(entry, b);
  }

  /** Apply the exchange's candle for a completed minute; it replaces the snapshot-built one. */
  applyMinute(key, minuteMs, candle) {
    const { open, high, low, close, volume } = candle ?? {};
    if (![open, high, low, close].every(Number.isFinite)) return;
    const entry = this.#entry(key);
    const b = this.#bucket(minuteMs);
    if (b < entry.lastBucket - this.#bucketMs) return; // too old to matter
    if (minuteMs < (entry.coveredUntil ?? -1) && b <= this.#seededLastOf(entry)) return; // already in the seed
    this.#captureBase(entry, b);
    entry.minutes.set(minuteMs, { open, high, low, close, volume: Number(volume) || 0, final: true });
    this.#rebuild(entry, b);
  }

  /**
   * Replace CLOSED bars with authoritative ones (the REST candles), keeping
   * everything else. Used after a feed gap: bars built while ticks were missing
   * are wrong or absent, and the exchange's own candles are exact. The forming
   * bar is left to live ticks.
   */
  reconcile(key, candles, now = Date.now(), minAgeMs = 0) {
    const entry = this.#entry(key);
    const byBucket = new Map(entry.bars.map((b) => [b.time, b]));
    let replaced = 0;
    for (const c of candles) {
      const time = this.#bucket(new Date(c.time).getTime());
      // minAgeMs: the REST candle for a bar that closed moments ago is still
      // incomplete (seen 20s after the close: GODREJCP 7 shares against a real
      // 736), and locking it in would overwrite a correct live bar.
      if (!Number.isFinite(c.close) || time + this.#bucketMs + minAgeMs > now) continue;
      byBucket.set(time, { time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
      entry.locked.add(time);
      entry.base.delete(time);
      replaced++;
    }
    entry.bars = [...byBucket.values()].sort((a, b) => a.time - b.time).slice(-MAX_LIVE_BARS);
    entry.lastBucket = entry.bars.length ? entry.bars[entry.bars.length - 1].time : -1;
    return replaced;
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
