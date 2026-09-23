/**
 * Diagnose the live market-data feed.
 *
 * One connection must carry the cash keys (signals), the near-month futures
 * (paper-trade pricing) and the NIFTY index (relative strength) — the free tier
 * 403s a second socket. This checks how many keys that connection actually
 * tolerates, and which segments deliver ticks.
 *
 *   node server/scripts/verifyFeed.js [keyCount]
 */
import pkg from "upstox-js-sdk";
import { loadFuturesUniverse, getUniverse, getUnderlyings } from "../data/instruments.js";
import { UPSTOX_TOKEN, HAS_TOKEN } from "../config.js";

const { MarketDataStreamerV3, ApiClient } = pkg;

if (!HAS_TOKEN) {
  console.error("UPSTOX_ANALYTICS_TOKEN not set.");
  process.exit(1);
}

const limit = Number(process.argv[2]) || 0;
const seconds = Number(process.argv[3]) || 25;

await loadFuturesUniverse();
const cash = getUnderlyings()
  .map((u) => u.cashKey)
  .filter(Boolean);

const nearest = new Map();
for (const c of getUniverse()) {
  const cur = nearest.get(c.underlying);
  if (!cur || c.expiryMs < cur.expiryMs) nearest.set(c.underlying, c);
}
const futures = [...nearest.values()].map((c) => c.key);

let keys = [...new Set([...cash, ...futures, "NSE_INDEX|Nifty 50"])];
if (limit > 0) keys = keys.slice(0, limit);

console.log(
  `connecting: ${keys.length} keys (universe has ${cash.length} cash + ${futures.length} near-month futures + 1 index)`
);

ApiClient.instance.authentications.OAUTH2.accessToken = UPSTOX_TOKEN;
const streamer = new MarketDataStreamerV3(keys, "ltpc");
streamer.autoReconnect(false); // surface the raw failure instead of masking it

let messages = 0;
let closes = 0;
const seen = new Set();

streamer.on("open", () => console.log("OPEN"));
streamer.on("message", (d) => {
  messages++;
  if (d?.feeds) for (const k of Object.keys(d.feeds)) seen.add(k);
});
streamer.on("close", (...a) => {
  closes++;
  console.log("CLOSE", JSON.stringify(a).slice(0, 200));
});
streamer.on("error", (e) => console.log("ERROR", String(e?.message || e).slice(0, 200)));
streamer.connect();

setTimeout(() => {
  const eq = [...seen].filter((k) => k.startsWith("NSE_EQ|")).length;
  const fo = [...seen].filter((k) => k.startsWith("NSE_FO|")).length;
  const idx = [...seen].filter((k) => k.startsWith("NSE_INDEX|")).length;
  console.log(
    `\nafter ${seconds}s: messages=${messages} closes=${closes} distinctKeys=${seen.size}` +
      `\n  cash=${eq}/${cash.length}  futures=${fo}/${futures.length}  index=${idx}/1`
  );
  process.exit(0);
}, seconds * 1000);
