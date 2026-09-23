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
  constructor({ onTick, onState } = {}) {
    this.onTick = onTick || (() => {});
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

  connect(instrumentKeys) {
    if (this.streamer) return;
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
      this.onState({ connected: true, event: "open" });
    });

    streamer.on("message", (data) => {
      const msg = UpstoxFeed.#parse(data);
      if (!msg?.feeds) return;
      const topTs = Number(msg.currentTs) || Date.now();
      for (const [key, feed] of Object.entries(msg.feeds)) {
        const ltpc = UpstoxFeed.#ltpc(feed);
        if (!ltpc) continue;
        const ltp = Number(ltpc.ltp);
        if (!Number.isFinite(ltp)) continue;
        const ts = Number(ltpc.ltt) || topTs;
        this.onTick(key, ltp, ts, Number(ltpc.ltq) || 0);
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
