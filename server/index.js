import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { api } from "./routes/api.js";
import { attachLiveSocket } from "./ws/liveSocket.js";
import * as daily from "./services/dailyService.js";
import * as live from "./services/liveService.js";
import { PORT, IS_PROD, HAS_TOKEN } from "./config.js";
import { logger } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// API
app.use("/api", api);

// Serve the built React app in production (single-URL deployment).
const clientDist = path.resolve(__dirname, "../client/dist");
if (IS_PROD) {
  app.use(express.static(clientDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/ws")) return next();
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

const server = http.createServer(app);
attachLiveSocket(server);

server.listen(PORT, () => {
  logger.info(`▶ NSE stock-futures screener on http://localhost:${PORT}`);
  logger.info(
    `mode: ${IS_PROD ? "production (serving client/dist)" : "dev (API only; run Vite separately)"}`
  );
  if (!HAS_TOKEN) {
    logger.warn("UPSTOX_ANALYTICS_TOKEN not set — daily + live data disabled until you set it.");
  }

  // Warm the daily cache on boot, then start the live supervisor.
  if (HAS_TOKEN) {
    logger.info("warming daily cache…");
    daily.refresh();
  }
  live.init();
});
