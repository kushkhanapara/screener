import pkg from "upstox-js-sdk";
import { UPSTOX_TOKEN } from "../config.js";

const { MarketDataStreamerV3, ApiClient } = pkg;

/**
 * Thin wrapper around the Upstox V3 market-data streamer (ltpc mode).
 *
 * ONE connection subscribes to all futures keys (parallel connections 403 on
 * the free tier). The SDK handles the protobuf decode + the wss redirect;
 * ping/pong is automatic. We surface a simple onTick(key, ltp, tsMs, qty) plus
 * connection-state callbacks.
 *
 * Keys passed as `fullKeys` (the futures) are subscribed in "full" mode as well,
 * which adds the best bid and ask — surfaced as onQuote(key, bid, ask, tsMs).
 * Quotes change far more often than trades, so an open position can be marked
 * at the price it could actually exit at between trades.
 */
/**
 * Work around a crash in upstox-js-sdk.
 *
 * Streamer.js calls `this.streamer.clearSubscriptions()` when its auto-reconnect
 * retries are exhausted, but MarketDataFeederV3 only defines that method
 * privately — so the cleanup path throws `clearSubscriptions is not a function`
 * from inside a timer, which is an uncaught exception that kills the process.
 *
 * Any sustained disconnect therefore takes the whole server down, which for a
 * long-running trading tool is far worse than a dead feed. Patching the
 * prototype fixes every future instance, including the ones reconnect creates.
 */
function patchSdkCleanupBug(streamer) {
  const feeder = streamer?.streamer;
  if (!feeder) return false;
  const proto = Object.getPrototypeOf(feeder);
  if (proto && typeof proto.clearSubscriptions !== "function") {
    proto.clearSubscriptions = function clearSubscriptions() {};
  }
  return true;
}

export class UpstoxFeed {
  constructor({ onTick, onQuote, onState } = {}) {
    this.onTick = onTick || (() => {});
    this.onQuote = onQuote || (() => {});
    // Full-mode keys: the last trade each message repeated, so a quote-only
    // update is not replayed as a fresh trade (it would double-count volume).
    this.lastTrade = new Map();
    // Full-mode keys: cumulative volume traded today, per key. Bar volume is
    // its increase. Summing each snapshot's last-trade quantity instead counted
    // about a tenth of the real volume (measured 25 Sept 2026), because the feed
    // sends snapshots, not every trade.
    this.lastVtt = new Map();
    this.lastLtp = new Map();
    this.lastRange = new Map();
    // Diagnostics: the last few raw OHLC blocks per key (see liveService.debugFeed).
    this.rawOhlc = new Map();
    this.onState = onState || (() => {});
    this.streamer = null;
    this.connected = false;
    this.fatalError = null;
    this.authFailures = 0;
    this.firstAuthFailureAt = 0;
  }

  /** Extract the last-traded price from a decoded ltpc feed, defensively. */
  static #ltpc(feed) {
    return (
      feed?.ltpc ??
      feed?.fullFeed?.marketFF?.ltpc ??
      feed?.fullFeed?.indexFF?.ltpc ??
      feed?.firstLevelWithGreeks?.ltpc ??
      null
    );
  }

  /**
   * The exchange's candle for the last COMPLETED minute ("I1"), or null.
   * Observed 25 Sept 2026: at 12:37:xx it carries the 12:36 minute, with that
   * minute's final open/high/low/close and volume.
   */
  static #lastMinute(feed) {
    const list = feed?.fullFeed?.marketFF?.marketOHLC?.ohlc ?? feed?.fullFeed?.indexFF?.marketOHLC?.ohlc;
    const c = Array.isArray(list) ? list.find((o) => o?.interval === "I1") : null;
    if (!c) return null;
    const m = {
      ts: Number(c.ts),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.vol) || 0,
    };
    return Number.isFinite(m.ts) && m.open > 0 && m.high > 0 && m.low > 0 && m.close > 0 ? m : null;
  }

  /** Best bid/ask from a decoded full feed, or null. */
  static #quote(feed) {
    const q = feed?.fullFeed?.marketFF?.marketLevel?.bidAskQuote?.[0];
    if (!q) return null;
    const bid = Number(q.bidP);
    const ask = Number(q.askP);
    return { bid: bid > 0 ? bid : null, ask: ask > 0 ? ask : null };
  }

  connect(instrumentKeys, { fullKeys = [] } = {}) {
    if (this.streamer) return;
    const full = new Set(fullKeys);
    const ltpcKeys = instrumentKeys.filter((k) => !full.has(k));
    instrumentKeys = ltpcKeys;
    // Authorize the SDK's shared ApiClient with the Analytics Token.
    ApiClient.instance.authentications.OAUTH2.accessToken = UPSTOX_TOKEN;

    const streamer = new MarketDataStreamerV3(instrumentKeys, "ltpc");
    this.streamer = streamer;
    // interval(s), retries — 5s x 60 spans ~5 minutes, long enough to ride out
    // a transient auth or network fault rather than giving up in 40 seconds.
    streamer.autoReconnect(true, 5, 60);

    streamer.on("open", () => {
      this.connected = true;
      this.authFailures = 0; // a successful connect clears the transient run
      // Ensure the full set is subscribed (constructor keys + explicit subscribe).
      try {
        streamer.subscribe(instrumentKeys, "ltpc");
      } catch {
        /* already subscribed via constructor */
      }
      if (full.size) {
        try {
          streamer.subscribe([...full], "full");
        } catch (e) {
          this.onState({ connected: true, event: "error", error: `full-mode subscribe failed: ${e.message}` });
        }
      }
      this.onState({ connected: true, event: "open" });
    });

    streamer.on("message", (data) => {
      const msg = UpstoxFeed.#parse(data);
      if (!msg?.feeds) return;
      const topTs = Number(msg.currentTs) || Date.now();
      for (const [key, feed] of Object.entries(msg.feeds)) {
        if (full.has(key)) {
          const q = UpstoxFeed.#quote(feed);
          if (q && (q.bid != null || q.ask != null)) this.onQuote(key, q.bid, q.ask, topTs);
        }
        const ltpc = UpstoxFeed.#ltpc(feed);
        if (!ltpc) continue;
        const ltp = Number(ltpc.ltp);
        if (!Number.isFinite(ltp)) continue;
        const ts = Number(ltpc.ltt) || topTs;
        let qty = Number(ltpc.ltq) || 0;
        let minute = null;
        if (full.has(key)) {
          minute = UpstoxFeed.#lastMinute(feed);
          const raw = feed?.fullFeed?.marketFF?.marketOHLC?.ohlc;
          if (raw) {
            const hist = this.rawOhlc.get(key) ?? [];
            hist.push({ at: Date.now(), ltt: ts, ltp, vtt: feed.fullFeed.marketFF.vtt, ohlc: raw });
            if (hist.length > 40) hist.shift();
            this.rawOhlc.set(key, hist);
          }
          // Pass the completed minute on only when it is new or revised.
          const minuteSig = minute ? `${minute.ts}:${minute.open}:${minute.high}:${minute.low}:${minute.close}:${minute.volume}` : null;
          const minuteNew = minuteSig !== this.lastRange.get(key);
          this.lastRange.set(key, minuteSig);
          if (!minuteNew) minute = null;
          const vtt = Number(feed?.fullFeed?.marketFF?.vtt);
          if (Number.isFinite(vtt) && vtt > 0) {
            const prev = this.lastVtt.get(key);
            this.lastVtt.set(key, vtt);
            // First snapshot sets the baseline: its volume is already in the
            // seeded bars. A drop means a new day's counter; count nothing.
            const delta = prev == null || vtt < prev ? 0 : vtt - prev;
            const moved = this.lastLtp.get(key) !== ltp;
            this.lastLtp.set(key, ltp);
            if (delta === 0 && !moved && !minute) continue; // quote-only update
            qty = delta;
          } else {
            const sig = `${ts}:${ltp}:${qty}`;
            if (this.lastTrade.get(key) === sig && !minute) continue; // quote moved, no new trade
            if (this.lastTrade.get(key) === sig) qty = 0;
            this.lastTrade.set(key, sig);
          }
        }
        this.onTick(key, ltp, ts, qty, minute);
      }
    });

    streamer.on("close", () => {
      this.connected = false;
      this.onState({ connected: false, event: "close" });
    });
    streamer.on("error", (err) => {
      const msg = String(err?.message || err);

      // Upstox returns transient 401s on tokens that are demonstrably valid, so
      // one is not grounds for giving up — the feed must ride it out. Only a
      // sustained run of them means the token is actually dead.
      if (msg.includes("401") || /unauthor/i.test(msg)) {
        this.authFailures++;
        if (this.authFailures === 1) this.firstAuthFailureAt = Date.now();

        const spanMs = Date.now() - this.firstAuthFailureAt;
        if (this.authFailures >= 8 && spanMs >= 3 * 60 * 1000) {
          this.fatalError =
            `Upstox rejected the feed token ${this.authFailures} times over ` +
            `${Math.round(spanMs / 60000)} minutes. Update UPSTOX_ANALYTICS_TOKEN and restart.`;
          try {
            streamer.autoReconnect(false);
          } catch {
            /* already stopping */
          }
          this.onState({ connected: false, event: "error", error: this.fatalError, fatal: true });
          return;
        }

        this.onState({
          connected: false,
          event: "error",
          error: `auth rejected (attempt ${this.authFailures}) — retrying`,
        });
        return;
      }

      this.onState({ connected: this.connected, event: "error", error: msg });
    });
    streamer.on("reconnecting", () => {
      this.connected = false;
      this.onState({ connected: false, event: "reconnecting" });
    });

    streamer.connect();

    // `this.streamer` is assigned inside connect(), so the patch target may not
    // exist yet; retry briefly rather than assuming either ordering.
    if (!patchSdkCleanupBug(streamer)) {
      let tries = 0;
      const timer = setInterval(() => {
        if (patchSdkCleanupBug(streamer) || ++tries > 20) clearInterval(timer);
      }, 250);
      timer.unref?.();
    }
  }

  static #parse(data) {
    if (data && typeof data === "object" && !Buffer.isBuffer(data)) return data;
    try {
      return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    } catch {
      return null;
    }
  }

  disconnect() {
    if (!this.streamer) return;
    try {
      this.streamer.autoReconnect(false);
      this.streamer.disconnect();
    } catch {
      /* ignore */
    }
    this.streamer = null;
    this.connected = false;
    this.onState({ connected: false, event: "disconnected" });
  }
}
