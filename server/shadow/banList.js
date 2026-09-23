import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { istDateString } from "../core/session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BAN_DIR = path.resolve(__dirname, "../../data/cache/ban");
const BAN_URL = "https://nsearchives.nseindia.com/content/fo/fo_secban.csv";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const MONTHS = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

/** Parse NSE's fo_secban.csv: a "Trade Date DD-MMM-YYYY" header, then "n,SYMBOL" lines. */
export function parseBanList(text) {
  const t = String(text ?? "");
  const m = t.match(/Trade Date\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})/i);
  const mon = m ? MONTHS[m[2].toUpperCase()] : null;
  const tradeDate = m && mon ? `${m[3]}-${mon}-${m[1].padStart(2, "0")}` : null;

  const symbols = [];
  for (const line of t.split(/\r?\n/)) {
    const s = line.match(/^\s*\d+\s*,\s*([A-Z0-9&.\-]+)\s*,?\s*$/i);
    if (s) symbols.push(s[1].toUpperCase());
  }
  return { tradeDate, symbols };
}

function writeCache(dir, parsed) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${parsed.tradeDate}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(parsed));
  fs.renameSync(tmp, file);
}

function readCached(dir, date) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${date}.json`), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Today's ban list. Fetches the latest file and caches it by its trade date,
 * then resolves today's list: exact date if cached, otherwise the most recent
 * earlier list (bans usually run several days), otherwise unavailable.
 */
export async function loadBanList({ now = Date.now(), fetchImpl = fetch, dir = DEFAULT_BAN_DIR } = {}) {
  const today = istDateString(now);
  let fetchError = null;

  try {
    const res = await fetchImpl(BAN_URL, {
      headers: { "User-Agent": UA, Accept: "text/csv,*/*" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseBanList(await res.text());
    if (!parsed.tradeDate) throw new Error("unrecognised ban list format");
    writeCache(dir, parsed);
  } catch (e) {
    fetchError = String(e?.message || e);
  }

  const exact = readCached(dir, today);
  if (exact) {
    return { status: "current", tradeDate: today, symbols: new Set(exact.symbols), fetchError };
  }

  let dates = [];
  try {
    dates = fs
      .readdirSync(dir)
      .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
      .filter((d) => d && d < today)
      .sort();
  } catch {
    /* no cache yet */
  }
  const latest = dates.at(-1);
  if (latest) {
    const cached = readCached(dir, latest);
    if (cached) {
      return { status: "stale", tradeDate: latest, symbols: new Set(cached.symbols), fetchError };
    }
  }

  return { status: "unavailable", tradeDate: null, symbols: new Set(), fetchError };
}
