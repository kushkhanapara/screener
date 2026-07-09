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
export class UpstoxFeed {
  constructor({ onTick, onState } = {}) {
    this.onTick = onTick || (() => {});
    this.onState = onState || (() => {});
    this.streamer = null;
    this.connected = false;
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
    streamer.autoReconnect(true, 2, 20); // enable, interval(s), retries

    streamer.on("open", () => {
      this.connected = true;
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
      this.onState({ connected: this.connected, event: "error", error: String(err?.message || err) });
    });
    streamer.on("reconnecting", () => {
      this.connected = false;
      this.onState({ connected: false, event: "reconnecting" });
    });

    streamer.connect();
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
