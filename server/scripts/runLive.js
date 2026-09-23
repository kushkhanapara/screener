/**
 * Run the trading server for a market session.
 *
 *   npm run live
 *
 * Why this exists: on 16 Sept the server ran under `npm run dev`, which uses
 * `node --watch` and restarts on file changes. It restarted every hour and was
 * blind for ~3 minutes each time. For a trading session the server must:
 *   - never restart because a file changed (no --watch);
 *   - run exactly once (a second copy is refused, not silently started);
 *   - come back by itself if it crashes, with the reason written down.
 *
 * Serves the built web app on the same port (NODE_ENV=production), so there is
 * one URL: http://localhost:8080
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const PORT = Number(process.env.PORT) || 8080;
const LOG = path.join(ROOT, "data/logs/lifecycle.log");
const RESTART_DELAY_MS = 5_000;
const MAX_RESTARTS_PER_HOUR = 5;

function note(msg) {
  const ist = new Date(Date.now() + 19_800_000).toISOString().replace("T", " ").slice(0, 19);
  const line = `${ist} IST supervisor — ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${line}\n`);
  } catch {
    /* console still has it */
  }
}

/** Is something already listening on the port? */
function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

if (await portInUse(PORT)) {
  note(`port ${PORT} is already in use — another server (maybe \`npm run dev\`) is running. Stop it first; not starting a second copy.`);
  process.exit(1);
}

if (!fs.existsSync(path.join(ROOT, "client/dist/index.html"))) {
  note("client/dist is missing — run `npm run build` once first.");
  process.exit(1);
}

let child = null;
let stopping = false;
const restarts = [];

function start() {
  child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT) },
  });
  note(`server started (pid ${child.pid}) on http://localhost:${PORT}`);

  child.on("exit", (code, signal) => {
    if (stopping) return;
    note(`server stopped unexpectedly (code ${code}, signal ${signal ?? "none"}) — see data/logs/lifecycle.log for the reason`);
    const now = Date.now();
    while (restarts.length && now - restarts[0] > 3_600_000) restarts.shift();
    if (restarts.length >= MAX_RESTARTS_PER_HOUR) {
      note(`crashed ${restarts.length} times in the last hour — giving up so the problem gets looked at`);
      process.exit(1);
    }
    restarts.push(now);
    setTimeout(start, RESTART_DELAY_MS);
  });
}

for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.on(sig, () => {
    stopping = true;
    note(`received ${sig} — stopping the server`);
    child?.kill();
    setTimeout(() => process.exit(0), 3_000).unref();
  });
}

start();
