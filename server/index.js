import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { api } from "./routes/api.js";
import { attachLiveSocket } from "./ws/liveSocket.js";
import * as daily from "./services/dailyService.js";
import * as live from "./services/liveService.js";
import * as paper from "./services/paperService.js";
import * as shadow from "./services/shadowService.js";
import * as swing from "./services/swingService.js";
import { validate as validateStrategies } from "./strategies/index.js";
import { PORT, IS_PROD, HAS_TOKEN } from "./config.js";
import { logger } from "./logger.js";

// Fail loudly at boot rather than silently never firing a signal all session.
const strategyProblems = validateStrategies();
if (strategyProblems.length) {
  logger.error({ problems: strategyProblems }, "invalid strategy registry");
  process.exit(1);
}

/**
 * Keep a third-party timer callback from killing a long-running service.
 *
 * upstox-js-sdk throws from inside its own reconnect timer (see the
 * clearSubscriptions patch in live/upstoxFeed.js). An exception there is
 * uncatchable from the call site and would otherwise terminate the process,
 * taking the paper engine with it. Only SDK faults are swallowed — anything
 * else still crashes, because a truly unknown exception means unknown state.
 */
process.on("uncaughtException", (err) => {
  const stack = String(err?.stack || err);
  const fromSdk = stack.includes("upstox-js-sdk");
  logger.error({ err: stack.slice(0, 600) }, fromSdk ? "upstox sdk fault (contained)" : "uncaught exception");
  if (!fromSdk) {
    lifecycle(`crash: uncaught exception — ${stack.slice(0, 1500)}`);
    process.exit(1);
  }
});

/*
 * Why did the process stop? The logger writes from a worker thread, so a line
 * logged just before exit can be lost — which is how a server restarting every
 * hour on 16 Sept left no trace. These records are written synchronously.
 */
const LIFECYCLE_LOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/logs/lifecycle.log");
function lifecycle(msg) {
  try {
    fs.mkdirSync(path.dirname(LIFECYCLE_LOG), { recursive: true });
    const ist = new Date(Date.now() + 19_800_000).toISOString().replace("T", " ").slice(0, 19);
    fs.appendFileSync(LIFECYCLE_LOG, `${ist} IST pid ${process.pid} port ${PORT} — ${msg}\n`);
  } catch {
    /* never let diagnostics take the server down */
  }
}
lifecycle(
  `start (node ${process.version}, ${process.execArgv.some((a) => a.startsWith("--watch")) ? "UNDER FILE WATCHER — will restart on file changes" : "no file watcher"}, ${process.env.NODE_ENV || "development"})`
);
process.on("unhandledRejection", (reason) => {
  lifecycle(`unhandled promise rejection — ${String(reason?.stack || reason).slice(0, 1500)}`);
  logger.error({ err: String(reason?.stack || reason).slice(0, 600) }, "unhandled promise rejection");
});
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  process.on(sig, () => {
    lifecycle(`received ${sig} — stopping`);
    process.exit(0);
  });
}
process.on("exit", (code) => lifecycle(`exit code ${code}`));

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

  // The paper engine registers its keys and tick handler on the shared feed, so
  // it MUST be initialised before liveService opens the connection.
  paper.init();
  // After paper: its session-start hook seeds the shared NIFTY store that shadow reads.
  shadow.init();
  // Multi-day paper book: listens to the same feed, keeps its own run and money.
  swing.init();
  live.init();
});
