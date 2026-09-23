/**
 * NSE equity-futures transaction costs.
 *
 * These rates are CONFIG, not constants buried in the maths, because they change
 * (STT and exchange charges have both moved in recent years) and stale rates
 * silently invalidate every metric computed from them.
 *
 * Why this matters more than it looks: on a ₹5,00,000 notional with a 1R stop of
 * ~0.5%, a round trip costs roughly ₹150–400 against an R of ~₹2,500 — so costs
 * eat 6–16% of every R. A backtest that ignores them reports an edge that does
 * not survive contact with a broker.
 *
 * Defaults reflect a discount broker. VERIFY against your own contract notes
 * before trusting the rupee figures; the R-multiples are far less sensitive.
 */

export const DEFAULT_COSTS = {
  brokeragePerOrder: 20, // ₹ flat cap per executed order
  brokeragePct: 0.0003, // 0.03% — brokerage is the lower of the two
  sttPct: 0.000125, // 0.0125%, SELL side only
  exchangePct: 0.000019, // ~0.0019% NSE futures turnover charge
  sebiPct: 0.000001, // ₹10 per crore
  stampPct: 0.00002, // 0.002%, BUY side only
  gstPct: 0.18, // on brokerage + exchange + SEBI
  slippagePct: 0.0002, // 0.02% assumed adverse fill on each leg
};

/** Brokerage for one leg: the lower of the flat cap and the percentage. */
function brokerageFor(turnover, cfg) {
  return Math.min(cfg.brokeragePerOrder, turnover * cfg.brokeragePct);
}

/**
 * Full round-trip cost breakdown for one futures trade.
 *
 * STT falls on the sell leg and stamp duty on the buy leg, which differ by
 * direction: a long sells at exit, a short sells at entry.
 *
 * @returns {{brokerage,stt,exchange,sebi,stamp,gst,total}} all in ₹
 */
export function tradeCosts({ entryPrice, exitPrice, qty, side }, config = DEFAULT_COSTS) {
  const cfg = { ...DEFAULT_COSTS, ...config };

  const entryTurnover = entryPrice * qty;
  const exitTurnover = exitPrice * qty;
  const totalTurnover = entryTurnover + exitTurnover;

  const isLong = side === "long";
  const buyTurnover = isLong ? entryTurnover : exitTurnover;
  const sellTurnover = isLong ? exitTurnover : entryTurnover;

  const brokerage = brokerageFor(entryTurnover, cfg) + brokerageFor(exitTurnover, cfg);
  const stt = sellTurnover * cfg.sttPct;
  const exchange = totalTurnover * cfg.exchangePct;
  const sebi = totalTurnover * cfg.sebiPct;
  const stamp = buyTurnover * cfg.stampPct;
  const gst = (brokerage + exchange + sebi) * cfg.gstPct;

  const total = brokerage + stt + exchange + sebi + stamp + gst;
  return { brokerage, stt, exchange, sebi, stamp, gst, total };
}

/**
 * Adjust a fill price for slippage, always against the trader.
 *
 * Entering long or exiting short means buying, so the fill is worse (higher);
 * entering short or exiting long means selling, so the fill is worse (lower).
 * Modelling slippage optimistically is one of the easier ways to build a
 * backtest that cannot be traded.
 */
export function applySlippage(price, side, isEntry, config = DEFAULT_COSTS) {
  const cfg = { ...DEFAULT_COSTS, ...config };
  const buying = (side === "long") === isEntry;
  return buying ? price * (1 + cfg.slippagePct) : price * (1 - cfg.slippagePct);
}
