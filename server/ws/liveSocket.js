import { WebSocketServer } from "ws";
import { getSnapshot, setBroadcaster } from "../services/liveService.js";

/**
 * WebSocket endpoint at /ws/live.
 * - On connect: immediately send the current full matching set so a late joiner
 *   sees the correct count right away.
 * - Every minute: liveService pushes an "update" to all connected clients.
 */
export function attachLiveSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws/live" });

  wss.on("connection", (ws) => {
    try {
      ws.send(JSON.stringify(getSnapshot()));
    } catch {
      /* client may have closed immediately */
    }
  });

  setBroadcaster((payload) => {
    const msg = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(msg);
      }
    }
  });

  return wss;
}
