import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { marginRequired, canAfford, deployedCapital, capitalState, notional } from "./capital.js";
import { roundTripCharges, _seed, _clear } from "./charges.js";

const CAPITAL = 200_000;

afterEach(() => _clear());

test("margin is a fraction of contract value", () => {
  // 1420 x 500 = 7.1L notional, 20% margin
  assert.ok(Math.abs(marginRequired(1420, 500, 0.2) - 142_000) < 1e-6);
  assert.equal(marginRequired(NaN, 500), Infinity);
});

test("notional is price x quantity", () => {
  assert.equal(notional(1420, 500), 710_000);
});

test("a position fits when there is room", () => {
  const r = canAfford({ price: 500, qty: 250, deployed: 0, capital: CAPITAL });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.required - 25_000) < 1e-6);
  assert.equal(r.free, CAPITAL);
});

test("capital already deployed blocks the next trade", () => {
  // 1.5L blocked leaves 50k free; this needs 1.42L.
  const r = canAfford({ price: 1420, qty: 500, deployed: 150_000, capital: CAPITAL });
  assert.equal(r.ok, false);
  assert.match(r.reason, /insufficient capital/);
  assert.ok(Math.abs(r.free - 50_000) < 1e-6);
});

test("freeing capital lets the next trade through", () => {
  const price = 1420;
  const qty = 500;
  assert.equal(canAfford({ price, qty, deployed: 150_000, capital: CAPITAL }).ok, false);
  // ...the earlier position closes...
  assert.equal(canAfford({ price, qty, deployed: 0, capital: CAPITAL }).ok, true);
});

test("a lot bigger than the whole account is reported as permanently untradeable", () => {
  // A ₹12,800 stock with a 250 lot is ₹32L notional -> ₹6.4L margin.
  const r = canAfford({ price: 12_800, qty: 250, deployed: 0, capital: CAPITAL });
  assert.equal(r.ok, false);
  assert.match(r.reason, /lot too large/);
  // Distinct from "no room right now" — this one never becomes affordable.
  assert.doesNotMatch(r.reason, /insufficient capital/);
});

test("a position exactly filling the account is allowed", () => {
  // 4000 x 250 x 0.2 = exactly 200,000
  assert.equal(canAfford({ price: 4000, qty: 250, deployed: 0, capital: CAPITAL }).ok, true);
});

test("deployedCapital prefers the recorded margin over recomputing it", () => {
  const positions = [
    { entryPrice: 1000, qty: 100, marginBlocked: 12_345 },
    { entryPrice: 500, qty: 100 }, // no record -> derived: 500*100*0.2 = 10,000
  ];
  assert.ok(Math.abs(deployedCapital(positions) - 22_345) < 1e-6);
});

test("capitalState summarises utilisation", () => {
  const s = capitalState([{ entryPrice: 1000, qty: 100, marginBlocked: 50_000 }], CAPITAL);
  assert.equal(s.deployed, 50_000);
  assert.equal(s.free, 150_000);
  assert.ok(Math.abs(s.utilisation - 0.25) < 1e-9);
  assert.equal(s.positions, 1);
});

test("an empty book has the full account free", () => {
  const s = capitalState([], CAPITAL);
  assert.equal(s.deployed, 0);
  assert.equal(s.free, CAPITAL);
  assert.equal(s.utilisation, 0);
});

// ── Real charges ───────────────────────────────────────────────────────

/** Rates derived from an actual Upstox response for RELIANCE futures. */
const REAL = {
  // BUY leg at 1420 x 500: brokerage 20, stamp 14.20, txn 12.99, stt 0
  buy: {
    brokerage: 20,
    sttRate: 0,
    stampRate: 14.2 / 710_000,
    transactionRate: 12.99 / 710_000,
    clearingRate: 0,
    sebiRate: 0,
    source: "upstox",
  },
  // SELL leg at 1420 x 500: brokerage 20, stt 355, txn 12.99, stamp 0
  sell: {
    brokerage: 20,
    sttRate: 355 / 710_000,
    stampRate: 0,
    transactionRate: 12.99 / 710_000,
    clearingRate: 0,
    sebiRate: 0,
    source: "upstox",
  },
}

test("calibrated rates reproduce the Upstox round-trip total", () => {
  const c = roundTripCharges({
    side: "long",
    entryPrice: 1420,
    exitPrice: 1420,
    qty: 500,
    rates: REAL,
  });
  // Upstox: buy ₹53.13 + sell ₹393.93 = ₹447.06
  assert.equal(c.source, "upstox");
  assert.ok(Math.abs(c.total - 447.06) < 0.5, `expected ~447.06, got ${c.total.toFixed(2)}`);
  assert.ok(Math.abs(c.brokerage - 40) < 1e-6);
  assert.ok(Math.abs(c.stt - 355) < 0.5, "STT falls on the sell leg only");
});

test("real charges are far higher than the estimated model", () => {
  const args = { side: "long", entryPrice: 1420, exitPrice: 1420, qty: 500 };
  const real = roundTripCharges({ ...args, rates: REAL });
  const estimated = roundTripCharges({ ...args, rates: null });

  assert.equal(estimated.source, "estimated");
  // This is why calibrating matters: the estimate understates by ~2.5x, and
  // costs are deducted before R is computed.
  assert.ok(
    real.total > estimated.total * 2,
    `real ${real.total.toFixed(0)} vs estimated ${estimated.total.toFixed(0)}`
  );
});

test("charges scale with price, so one calibration serves every fill", () => {
  const at1420 = roundTripCharges({ side: "long", entryPrice: 1420, exitPrice: 1420, qty: 500, rates: REAL });
  const at2840 = roundTripCharges({ side: "long", entryPrice: 2840, exitPrice: 2840, qty: 500, rates: REAL });

  // Turnover doubles; the flat ₹40 brokerage does not, so the total is a little
  // under double.
  assert.ok(at2840.total > at1420.total * 1.8);
  assert.ok(at2840.total < at1420.total * 2);
  assert.ok(Math.abs(at2840.brokerage - at1420.brokerage) < 1e-6);
});

test("STT lands on the sell leg whichever direction the trade is", () => {
  // Long sells at the exit; short sells at the entry. Same sell price here, so
  // the STT must match.
  const long = roundTripCharges({ side: "long", entryPrice: 1400, exitPrice: 1500, qty: 500, rates: REAL });
  const short = roundTripCharges({ side: "short", entryPrice: 1500, exitPrice: 1400, qty: 500, rates: REAL });
  assert.ok(Math.abs(long.stt - short.stt) < 1e-6);
});

test("missing calibration falls back rather than refusing the trade", () => {
  const c = roundTripCharges({ side: "long", entryPrice: 1420, exitPrice: 1430, qty: 500, rates: null });
  assert.equal(c.source, "estimated");
  assert.ok(c.total > 0);
});
