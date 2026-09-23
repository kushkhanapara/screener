/**
 * Populate a scratch paper database with synthetic trades, so the UI can be
 * exercised without waiting for a live market session.
 *
 * Writes to PAPER_DB_PATH — point it at a throwaway file. It refuses to run
 * against the default database, because fabricated trades mixed into real
 * accumulated results would quietly corrupt every metric computed from them.
 *
 *   PAPER_DB_PATH=data/demo.db node server/scripts/seedDemoTrades.js
 */
import path from "node:path";
import * as store from "../paper/store.js";
import { openPosition, closePosition, checkExit } from "../paper/engine.js";
import { list as listStrategies } from "../strategies/index.js";
import { compute } from "../paper/metrics.js";

const dbPath = process.env.PAPER_DB_PATH;
if (!dbPath) {
  console.error("Refusing to run: set PAPER_DB_PATH to a throwaway database file.");
  console.error("  PAPER_DB_PATH=data/demo.db node server/scripts/seedDemoTrades.js");
  process.exit(1);
}
if (path.basename(dbPath) === "screener.db") {
  console.error("Refusing to write synthetic trades into the live database.");
  process.exit(1);
}

store.init(dbPath);
store.createRun({ id: store.LIVE_RUN_ID, kind: "live", params: { demo: true } });

const NAMES = [
  ["RELIANCE", 1420, 250], ["TCS", 3180, 175], ["HDFCBANK", 1655, 550],
  ["INFY", 1490, 400], ["ICICIBANK", 1180, 700], ["SBIN", 812, 1500],
  ["TATAMOTORS", 985, 550], ["AXISBANK", 1105, 625], ["LT", 3520, 150],
  ["MARUTI", 12800, 50], ["WIPRO", 292, 3000], ["HINDALCO", 645, 1075],
];

/** Deterministic PRNG so repeated runs produce the same demo data. */
let seed = 42;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

/** 10:00 IST on a weekday `daysAgo` back. */
function sessionTime(daysAgo, minutesIn) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 9 - 5, 15 - 30);
  return utc + minutesIn * 60000;
}

const strategies = listStrategies();
let made = 0;

for (let daysAgo = 9; daysAgo >= 0; daysAgo--) {
  const dow = new Date(Date.now() - daysAgo * 86400000).getUTCDay();
  if (dow === 0 || dow === 6) continue;

  for (const strategy of strategies) {
    // Strategy A fires more often; B is the selective one, by design.
    const count = strategy.id === "trend-momentum" ? 3 + Math.floor(rnd() * 3) : 1 + Math.floor(rnd() * 3);

    for (let i = 0; i < count; i++) {
      const [name, price, lotSize] = pick(NAMES);
      const side = rnd() > 0.45 ? "long" : "short";
      const atr = price * (0.0015 + rnd() * 0.002);
      const entryMin = 20 + Math.floor(rnd() * 240);
      const now = sessionTime(daysAgo, entryMin);

      let p = openPosition({
        runId: store.LIVE_RUN_ID,
        strategy,
        signal: { side, reasons: strategy.description[side].slice(0, 3) },
        underlying: name,
        futKey: `NSE_FO|${name}`,
        futLabel: `${name} FUT`,
        fillPrice: price * (1 + (rnd() - 0.5) * 0.01),
        atr,
        lotSize,
        now,
        signalBarTime: now - 180000,
        cashPriceAtSignal: price,
      });

      store.recordSignal({
        id: `${p.id}-sig`, runId: store.LIVE_RUN_ID, strategyId: strategy.id,
        underlying: name, side, barTime: p.signalBarTime, taken: true, score: rnd() * 2,
      });

      // Walk a random price path through the real exit machine, so the demo
      // data obeys the same stop/trail/target rules as live trading.
      const drift = rnd() > 0.42 ? 1 : -1;
      let px = p.entryPrice;
      let exit = null;
      let t = now;

      for (let bar = 0; bar < 30 && !exit; bar++) {
        t += 180000;
        px += (drift * atr * 0.55 + (rnd() - 0.5) * atr * 1.6) * (side === "long" ? 1 : -1);
        const res = checkExit(p, strategy, px, t);
        p = res.position;
        if (res.exit) {
          exit = res.exit;
          break;
        }
        p = { ...p, barsHeld: p.barsHeld + 1 };
        if (p.barsHeld >= strategy.exits.timeStopBars) {
          exit = { reason: "time", price: px };
        }
      }
      if (!exit) exit = { reason: "squareoff", price: px };

      const isOpen = daysAgo === 0 && rnd() > 0.6;
      store.insertPosition(p);
      if (isOpen) continue; // leave a few open so the positions table is populated

      store.commitClose(p.id, closePosition(p, exit.price, exit.reason, t));
      made++;
    }
  }
}

console.log(`Seeded ${made} closed trades into ${dbPath}\n`);
for (const s of strategies) {
  const m = compute(store.tradesChronological({ runId: store.LIVE_RUN_ID, strategyId: s.id }), {
    signalDays: store.signalsPerDay({ runId: store.LIVE_RUN_ID, strategyId: s.id }),
  });
  console.log(
    `${s.name.padEnd(26)} ${String(m.trades).padStart(3)} trades  ` +
      `exp ${m.expectancyR.toFixed(2)}R  win ${(m.winRate * 100).toFixed(0)}%  ` +
      `total ${m.totalR.toFixed(1)}R  DD ${m.maxDrawdownR.toFixed(1)}R`
  );
}
console.log(`\nOpen positions: ${store.openPositions(store.LIVE_RUN_ID).length}`);
store.close();
