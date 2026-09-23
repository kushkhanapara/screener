import { WebSocketServer } from "ws";
import { getSnapshot, setBroadcaster, onPrices, getPricesSnapshot } from "../services/liveService.js";
import {
  getSnapshot as paperSnapshot,
  setBroadcaster as setPaperBroadcaster,
} from "../services/paperService.js";

/**
 * WebSocket endpoint at /ws/live.
 *
 * Carries two message types on ONE connection, distinguished by `type`:
 *   "update" — the screener's provisional matching set, refreshed each minute
 *   "paper"  — paper-trading positions and metrics, pushed when a trade opens
 *              or closes
 *   "prices" — last-traded prices that changed, at most once a second, so every
 *              view can show live prices without waiting for its own refresh
 *
 * They are different questions ("what matches right now" vs "what was actually
 * entered"), but sharing a socket keeps the client to a single connection and a
 * single reconnect path.
 */
export function attachLiveSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws/live" });

  const send = (client, payload) => {
    if (client.readyState !== client.OPEN) return;
    try {
      client.send(JSON.stringify(payload));
    } catch {
      /* client went away mid-send */
    }
  };

  wss.on("connection", (ws) => {
    // Send both snapshots immediately so a late joiner is not blank until the
    // next tick of either loop.
    send(ws, getSnapshot());
    send(ws, paperSnapshot());
    send(ws, getPricesSnapshot());
  });

  const broadcast = (payload) => {
    for (const client of wss.clients) send(client, payload);
  };

  setBroadcaster(broadcast);
  setPaperBroadcaster(broadcast);
  onPrices(broadcast);

  // Open positions mark to market on every tick, so push regularly even when no
  // trade opened or closed — otherwise the screen looks frozen between events,
  // which is exactly when you most want to see P&L moving.
  const heartbeat = setInterval(() => {
    if (wss.clients.size) broadcast(paperSnapshot());
  }, 3000);

  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}
