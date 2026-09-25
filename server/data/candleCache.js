import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * On-disk cache for historical candle responses.
 *
 * Seeding the live stores costs ~420 candle requests, which is exactly what
 * trips Cloudflare's sustained-rate rule (429 / error 1015). Most of that data
 * is immutable — a candle from a previous trading day never changes — so
 * re-fetching it on every restart is pure waste and the main source of rate-limit
 * pressure during development, where restarts are frequent.
 *
 * Ranges that end before today are cached indefinitely. Ranges including today
 * get a short TTL, because today's last candle is still forming.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, "../../data/cache/candles");

/** Today's partial data goes stale quickly; completed days never do. */
const TODAY_TTL_MS = Number(process.env.CANDLE_CACHE_TTL_MS) || 3 * 60 * 1000;

let enabled = process.env.CANDLE_CACHE !== "0";

export function setEnabled(v) {
  enabled = v;
}

function istToday() {
  return new Date(Date.now() + (5 * 60 + 30) * 60 * 1000).toISOString().slice(0, 10);
}

/** Filenames must survive instrument keys containing "|" and spaces. */
function cacheFile(parts) {
  const raw = parts.join("_");
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
  const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return path.join(CACHE_DIR, `${safe}_${hash}.json`);
}

/**
 * Read a cached response, or null on a miss/stale/corrupt entry.
 * @param {string[]} keyParts identifying the request
 * @param {string} toDate the range's end date (YYYY-MM-DD)
 */
export function read(keyParts, toDate) {
  if (!enabled) return null;
  const file = cacheFile(keyParts);
  try {
    const stat = fs.statSync(file);
    const includesToday = toDate >= istToday();
    if (includesToday && Date.now() - stat.mtimeMs > TODAY_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null; // miss, unreadable, or malformed — all mean "fetch it"
  }
}

/** Persist a response. Cache failures must never break a live fetch. */
export function write(keyParts, value) {
  if (!enabled) return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const file = cacheFile(keyParts);
    // Write-then-rename, so a crash mid-write cannot leave a truncated entry
    // that later parses as valid-but-wrong.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  } catch {
    /* cache is an optimisation, never a requirement */
  }
}

/** Remove every cached entry. */
export function clear() {
  try {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  } catch {
    /* nothing to clear */
  }
}

export function stats() {
  try {
    const files = fs.readdirSync(CACHE_DIR);
    return { enabled, entries: files.length, dir: CACHE_DIR };
  } catch {
    return { enabled, entries: 0, dir: CACHE_DIR };
  }
}
