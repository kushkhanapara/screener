/**
 * First-run setup for a fresh clone: `npm run setup`.
 *
 * Everything this creates is local and private — the repository ships no token
 * and no database. It:
 *   1. checks the Node version (node:sqlite needs 22.5 or newer);
 *   2. creates .env from .env.example and puts your Upstox token in it;
 *   3. creates the data folders and your own empty SQLite database;
 *   4. checks the token really works against Upstox;
 *   5. with --warm, downloads today's daily candles so the first morning is quick.
 *
 *   npm run setup                     asks for the token if one isn't set
 *   npm run setup -- --token=abc123   takes it from the command line
 *   npm run setup -- --warm           also downloads the daily candles (~1 min)
 *   npm run setup -- --db=data/my.db  a database somewhere other than the default
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENV_FILE = path.join(ROOT, ".env");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");
const TOKEN_VAR = "UPSTOX_ANALYTICS_TOKEN";
const MIN_NODE = [22, 5]; // node:sqlite (DatabaseSync) landed in 22.5

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const has = (name) => process.argv.includes(`--${name}`);

const ok = (m) => console.log(`  ok    ${m}`);
const info = (m) => console.log(`  ..    ${m}`);
const warn = (m) => console.log(`  !     ${m}`);
const step = (n, m) => console.log(`\n${n}. ${m}`);

/** Is this Node new enough? Exported for the test. */
export function nodeIsNewEnough(version, min = MIN_NODE) {
  const [major, minor] = String(version).replace(/^v/, "").split(".").map(Number);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

/**
 * The .env text with the token set, keeping every other line as it is.
 * Exported for the test.
 */
export function envWithToken(text, token, name = TOKEN_VAR) {
  const line = `${name}=${token}`;
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim().startsWith(`${name}=`));
  if (at >= 0) lines[at] = line;
  else {
    while (lines.length && lines.at(-1).trim() === "") lines.pop(); // no blank gap
    lines.push(line);
  }
  return lines.join("\n").replace(/\n*$/, "\n");
}

/** Never print a token in full — enough to recognise it, not enough to use it. */
export const mask = (token) => (token.length <= 8 ? "•".repeat(token.length) : `${token.slice(0, 4)}…${token.slice(-4)} (${token.length} characters)`);

/** The token already available from the environment or .env, or null. */
function existingToken() {
  if (process.env[TOKEN_VAR]?.trim()) return process.env[TOKEN_VAR].trim();
  if (!fs.existsSync(ENV_FILE)) return null;
  const line = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/).find((l) => l.trim().startsWith(`${TOKEN_VAR}=`));
  const value = line?.slice(line.indexOf("=") + 1).trim() ?? "";
  return value || null;
}

async function askForToken() {
  if (!process.stdin.isTTY) return null;
  console.log(`
  Get a token from the Upstox Developer Apps page → "Analytics" tab → generate.
  It is read-only, lasts a year, and is written to .env, which git ignores.
  Press Enter to skip and paste it into .env yourself later.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question("\n  Upstox analytics token: ")).trim() || null;
  } finally {
    rl.close();
  }
}

async function main() {
  console.log("\nSetting up your own copy of the screener.\n(Your token and your database stay on this machine; neither is in the repository.)");

  step(1, "Node version");
  if (!nodeIsNewEnough(process.version)) {
    warn(`Node ${process.version} is too old — the database needs ${MIN_NODE.join(".")} or newer. Install a newer Node and run this again.`);
    process.exitCode = 1;
    return;
  }
  ok(`Node ${process.version}`);

  step(2, "Your Upstox token");
  let token = existingToken();
  if (token) ok(`already set: ${mask(token)}`);
  else {
    token = arg("token") ?? (await askForToken());
    if (!fs.existsSync(ENV_FILE)) {
      fs.writeFileSync(ENV_FILE, fs.readFileSync(ENV_EXAMPLE, "utf8"));
      ok("created .env from .env.example");
    }
    if (token) {
      fs.writeFileSync(ENV_FILE, envWithToken(fs.readFileSync(ENV_FILE, "utf8"), token));
      ok(`saved to .env: ${mask(token)}`);
    } else {
      warn(`no token yet — open .env and put it after ${TOKEN_VAR}=, then run this again`);
    }
  }
  if (token) process.env[TOKEN_VAR] = token;

  step(3, "Folders and your database");
  for (const dir of ["data", "data/cache/candles", "data/logs", "data/archive"]) {
    fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
  }
  ok("data folders ready (all ignored by git)");

  const store = await import("../paper/store.js");
  const dbPath = path.resolve(ROOT, arg("db") ?? process.env.PAPER_DB_PATH ?? "data/screener.db");
  const existed = fs.existsSync(dbPath);
  store.init(dbPath);
  const counts = {
    trades: store.countTrades({ runId: "live" }) + store.countTrades({ runId: "swing" }),
    open: store.openPositions("live").length + store.openPositions("swing").length,
  };
  ok(
    existed
      ? `using the database already here: ${path.relative(ROOT, dbPath)} (${counts.trades} trades, ${counts.open} open — nothing was overwritten)`
      : `created an empty database: ${path.relative(ROOT, dbPath)}`
  );

  step(4, "Checking the token against Upstox");
  if (!token) {
    warn("skipped — no token yet");
  } else {
    const { loadFuturesUniverse, getUnderlyings } = await import("../data/instruments.js");
    const { getDailyCandles } = await import("../data/upstox.js");
    try {
      await loadFuturesUniverse();
      const stocks = getUnderlyings() || [];
      if (!stocks.length) throw new Error("the futures list came back empty");
      ok(`futures list: ${stocks.length} stocks`);
      const to = new Date(Date.now() + 19_800_000 - 86_400_000).toISOString().slice(0, 10);
      const from = new Date(Date.now() + 19_800_000 - 30 * 86_400_000).toISOString().slice(0, 10);
      const candles = await getDailyCandles("NSE_INDEX|Nifty 50", from, to);
      if (!candles.length) throw new Error("no Nifty candles came back");
      ok(`historical data: Nifty ${candles.length} days, last close ${candles.at(-1).close} on ${String(candles.at(-1).time).slice(0, 10)}`);

      if (has("warm")) {
        step(5, "Downloading daily candles (about a minute)");
        const queue = [...stocks];
        let done = 0;
        await Promise.all(
          Array.from({ length: 4 }, async () => {
            for (let s = queue.shift(); s; s = queue.shift()) {
              await getDailyCandles(s.cashKey, from, to).catch(() => []);
              if (++done % 50 === 0) info(`${done}/${stocks.length}`);
            }
          })
        );
        ok(`cached daily candles for ${done} stocks`);
      }
    } catch (e) {
      warn(`Upstox says: ${e.message}`);
      warn("A 401 means the token is wrong or expired — generate a new one and run this again.");
      process.exitCode = 1;
    }
  }

  console.log(`
Next steps
  npm run install:all     install server and client packages (if you haven't)
  npm test                should be all green
  npm run build           build the web page
  npm run live            start it — open http://localhost:8080

The app trades on paper only and places no real orders. Your results live in
${path.relative(ROOT, dbPath)}; back that file up yourself, it is not in git.
`);
}

// Only when run as a command — importing this file (the test does) must do nothing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
