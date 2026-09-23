/**
 * Every plain-English label and explanation on the Shadow tab, in one place.
 *
 * Shadow logging runs the single-slot strategy on paper-free, pretend trades,
 * and its numbers are its own — nothing here describes paper trading.
 */

export type RejectGroup = "cantTrade" | "volatility" | "noMove" | "unconfirmed"

export const REJECT_GROUPS: { id: RejectGroup; label: string; hint: string }[] = [
  {
    id: "cantTrade",
    label: "Can't be traded",
    hint: "Price, lot size, ban list or missing data rule the stock out before any analysis.",
  },
  {
    id: "volatility",
    label: "Wrong volatility",
    hint: "Too quiet to beat charges, or too wild for a sensible stop.",
  },
  {
    id: "noMove",
    label: "No clear move of its own",
    hint: "The stock isn't moving independently of Nifty, or the move fights the market.",
  },
  {
    id: "unconfirmed",
    label: "Move not confirmed",
    hint: "Open interest, volume or persistence didn't back the move up.",
  },
]

export const REJECTS: Record<string, { label: string; why: string; group: RejectGroup }> = {
  no_quote: {
    group: "cantTrade",
    label: "No futures price",
    why: "The futures contract had no live quote, so there is nothing to trade.",
  },
  price_below_min: {
    group: "cantTrade",
    label: "Price under ₹100",
    why: "At low prices the ₹0.05 tick is too large a share of a normal move.",
  },
  margin_exceeds_capital: {
    group: "cantTrade",
    label: "Lot too big for ₹2 lakh",
    why: "One lot needs more margin than the whole account.",
  },
  no_data: {
    group: "cantTrade",
    label: "Not enough price bars",
    why: "Fewer than 60 recent 3-minute bars, or the price stopped updating.",
  },
  banned: {
    group: "cantTrade",
    label: "In the F&O ban list",
    why: "NSE doesn't allow new positions in this stock today.",
  },
  no_daily_data: {
    group: "cantTrade",
    label: "No daily history",
    why: "Daily candles are missing, so today's volatility can't be judged.",
  },
  atr_percentile: {
    group: "volatility",
    label: "Too quiet or too wild today",
    why: "Today's volatility is outside this stock's 30th–85th percentile for the past year. Too quiet can't beat charges; too wild puts the stop inside normal noise.",
  },
  stop_too_tight: {
    group: "volatility",
    label: "Move too small to beat charges",
    why: "A stop of 1.5× the 3-minute ATR would be under 0.3% of price — about three times the round-trip charges. Very common around midday, when prices go quiet.",
  },
  rs_weak: {
    group: "noMove",
    label: "Not moving on its own",
    why: "After taking out what Nifty's move explains (adjusted for the stock's beta), the stock moved less than 0.3%.",
  },
  market_context: {
    group: "noMove",
    label: "Fighting the market",
    why: "A buy while Nifty is below its first-15-minute low, or a sell while Nifty is above its first-15-minute high.",
  },
  no_oi_baseline: {
    group: "unconfirmed",
    label: "No open-interest starting point",
    why: "Open-interest change is measured from the day's first snapshot, which hadn't been taken yet.",
  },
  oi_not_building: {
    group: "unconfirmed",
    label: "Open interest not rising",
    why: "No new futures positions are being added, so the move lacks fresh participation.",
  },
  oi_price_mismatch: {
    group: "unconfirmed",
    label: "Price and open interest disagree",
    why: "Open interest is rising but the futures price moved the other way.",
  },
  volume_unchecked: {
    group: "unconfirmed",
    label: "Volume not checked",
    why: "Only the strongest 25 candidates get the volume check on each scan.",
  },
  no_volume_norm: {
    group: "unconfirmed",
    label: "No usual-volume history",
    why: "Too few earlier sessions to know what normal volume is at this time of day.",
  },
  volume_missing: {
    group: "unconfirmed",
    label: "Volume missing for this bar",
    why: "The exchange data for this 3-minute bar didn't arrive.",
  },
  volume_low: {
    group: "unconfirmed",
    label: "Volume below usual",
    why: "This bar traded less than the stock normally does at this time of day.",
  },
  not_persistent: {
    group: "unconfirmed",
    label: "Not held for 2 scans yet",
    why: "It passed this scan but not the one before; a pick must pass two scans in a row.",
  },
}

export const rejectLabel = (code: string | null) => (code ? (REJECTS[code]?.label ?? code) : "—")

export const TERMS = {
  score:
    "How strong the setup is, from 0 to 1: own move vs Nifty 40%, open-interest build-up 30%, volume vs usual 20%, scans in a row 10%. The highest score is the pick.",
  residual:
    "How far the stock has moved since the open after taking out what Nifty's move explains (beta-adjusted). + is stronger than the market, − is weaker.",
  oi: "Change in futures open interest since the day's first snapshot. Rising means new positions are being opened.",
  volume:
    "This bar's volume divided by the usual volume at the same time of day on earlier sessions. 2.0× is twice the usual.",
  streak: "How many 3-minute scans in a row this stock has passed on the same side.",
  spread: "Gap between the best buy and sell quotes, as % of price. Smaller is cheaper to trade.",
  liquidity: "Rank by today's futures turnover among all eligible stocks. 1 is the most traded.",
  slot: "This test strategy can hold only ONE trade at a time. “Would take” = it was free, so this is a trade it would actually make. “Skipped (busy)” = it was already in another trade, so it had to skip this one — we still follow it to see what was given up.",
  r: "Profit in units of the risk taken, after charges. The stop sits 1R away, so −1R is a normal loss and +2R made twice what was risked.",
  netNotional: "Profit after charges as a percentage of the contract's value. The goal is at least +0.25% per trade.",
  floor:
    "If only picks scoring at least this much were traded: how many days would have had a trade, and how those trades did.",
  health:
    "Inputs the scan depends on. If any is missing, the related check is skipped or rejects everything.",
  banList: "Stocks NSE has put in the F&O ban period today. They can't be traded.",
  oiBaseline: "Time of the first open-interest snapshot. Open-interest change is measured from here.",
} as const

export const EXIT_LABEL: Record<string, string> = {
  stop: "Stop loss hit",
  trail: "Trailing stop",
  breakeven: "Stopped at entry",
  target: "Target hit",
  squareoff: "Closed at 3:15 PM",
  time: "Time limit",
  proveit: "No follow-through",
}

export const exitLabel = (reason: string) => EXIT_LABEL[reason] ?? reason

export const sideLabel = (side: "long" | "short" | null | undefined) =>
  side === "long" ? "Buy" : side === "short" ? "Sell" : "—"

export const BAN_STATUS_LABEL: Record<string, string> = {
  current: "Up to date",
  stale: "Older list",
  unavailable: "Not available",
}

/** Sessions of evidence needed before the cross-session numbers mean much. */
export const SESSIONS_TO_JUDGE = 20
