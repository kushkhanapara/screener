/**
 * Plain-English words for the whole app.
 *
 * Trading tools are full of shorthand (R, LTP, MAE, square-off, regime…). Every
 * label and explanation lives here, so the wording is simple and the same on
 * every tab.
 */

import type { ExitReason, StrategyExits } from "@/lib/api"

export const BUY_SELL = {
  long: "Buy",
  short: "Sell",
} as const

export const sideWord = (side: "long" | "short" | null | undefined) =>
  side === "long" ? "Buy" : side === "short" ? "Sell" : "—"

/** Short explanations used in tooltips across the app. */
export const TERMS = {
  r: "R is profit measured in “risk units”. 1R is the amount the trade would lose if its stop loss is hit. So −1R is a normal loss, +2R made twice what was risked. Always after charges.",
  buySell:
    "Buy (long) makes money if the price rises. Sell (short) makes money if the price falls. These are futures, so selling first is allowed.",
  netPnl: "Profit or loss after all charges (brokerage, STT, exchange fees, stamp duty, GST).",
  charges: "Brokerage, STT, exchange fees, stamp duty and GST, taken from real Upstox rates. Already subtracted from every profit figure.",
  winRate: "Share of closed trades that made money after charges.",
  avgPerTrade: "Average result per trade, in R, after charges. Above 0 means the strategy makes money on average.",
  totalR: "All trade results added up, in R.",
  profitFactor: "Money won on winning trades ÷ money lost on losing trades. Above 1 means winners outweigh losers.",
  biggestDrop: "The largest fall from a high point in the running total, in R — the worst losing streak.",
  steadiness: "How steady the results are (Sharpe ratio per trade). Higher means fewer wild swings between trades.",
  signals: "How many times a day the strategy's conditions were met, including ones it couldn't take (no money free, market mood, etc.).",
  avgHold: "Average time a trade stays open.",
  worstDip: "How far, on average, trades went against us before closing, in R. Much smaller than 1R means stops may be wider than needed.",
  bestRun: "How far, on average, trades went in our favour at best, in R. Much bigger than the final result means profit is being given back.",
  capital: "Each strategy has its own pretend ₹2 lakh. Every open trade blocks about 20% of the contract's value as margin until it closes.",
  openProfit: "Profit or loss on trades still open, at the latest price. Not locked in yet, before exit charges.",
  priceNow: "Last traded price.",
  stop: "The price at which the trade is closed to limit the loss.",
  target: "The price at which the trade is closed to take the profit.",
  usedOfStop: "How close the price is to the stop loss. Full bar = at the stop.",
  score: "The strategy's own ranking number for this setup. Higher is stronger. Scores can't be compared between different strategies.",
  marketMood:
    "Nifty's direction today. When Nifty is falling, buys are skipped; when it's rising, sells are skipped.",
  lot: "Futures trade in fixed lots. Every trade here is one lot.",
  futures: "Near-month futures contract for the stock — the instrument actually traded. Prices come from the live feed.",
  rsi: "RSI measures momentum from 0 to 100. Above 60 is strong buying pressure, below 40 is strong selling pressure.",
  macd: "MACD shows the trend's push. Positive (green) means upward push, negative (red) means downward push.",
  movingAverages: "SMA34 and SMA200 are the average price over the last 34 and 200 bars; EMA5 is a fast 5-bar average. Price above them usually means an uptrend.",
  vwap: "VWAP is today's average traded price, weighted by volume.",
  atr: "ATR is the typical size of one bar's price swing. Stops and targets are set as multiples of it.",
  dayType:
    "Decided from Nifty's move so far, rechecked every 3 minutes. Trend day: Nifty 0.4% or more from its open, moving fairly steadily one way. Flat day: under 0.3%, or moving back and forth. Unclear: in between — nothing new is opened. Too early: before about 9:45.",
} as const

export const EXIT: Record<ExitReason, { label: string; why: string }> = {
  target: { label: "Target hit", why: "Price reached the profit target." },
  trail: { label: "Trailing stop", why: "After moving into profit, the stop followed the price and was then hit — part of the profit was locked in." },
  breakeven: { label: "Closed at entry", why: "After reaching +1R, the stop moved to the entry price and was then hit. Result is roughly zero before charges." },
  stop: { label: "Stop loss hit", why: "Price moved against the trade to the stop loss." },
  proveit: { label: "No follow-through", why: "The trade didn't move in our favour within the first few bars, so it was cut early — smaller than a full stop loss." },
  time: { label: "Time limit", why: "The trade was open too long without reaching +1R, so it was closed." },
  squareoff: { label: "3:15 PM close", why: "All intraday trades are closed at 3:15 PM, whatever the result." },
  days: { label: "20-day limit", why: "Multi-day trades are closed at 3:25 PM on their 20th trading day." },
  roll: { label: "Rolled to next month", why: "The futures contract expired, so the trade was closed and the same trade reopened in next month's contract." },
}

export const exitWord = (reason: string) => EXIT[reason as ExitReason]?.label ?? reason

/**
 * Engine skip reasons in everyday words. The engine writes precise messages;
 * these keep the numbers but drop the shorthand.
 */
export function skipWord(reason: string | null | undefined) {
  if (!reason) return "Skipped"
  if (reason.startsWith("insufficient capital")) {
    const m = reason.match(/needs (₹[\d,]+), (₹[\d,]+) free/)
    return m ? `Not enough money free (needs ${m[1]}, ${m[2]} free)` : "Not enough money free"
  }
  if (reason.startsWith("lot too large")) {
    const m = reason.match(/needs (₹[\d,]+) margin/)
    return m ? `One lot needs ${m[1]} margin — more than the whole account` : "One lot is too big for the account"
  }
  if (reason === "too close to square-off") return "Too late in the day (no new trades after 3:00 PM)"
  if (reason === "market regime is bearish") return "Nifty is falling — no buys"
  if (reason === "market regime is bullish") return "Nifty is rising — no sells"
  if (reason.startsWith("weak vs Nifty")) return reason.replace("weak vs Nifty", "Not strong enough vs Nifty")
  if (reason.startsWith("already lost on")) return reason.replace("already lost on", "Already lost on").replace(" today", " today — no second try")
  if (reason.startsWith("Not a trend day") || reason.startsWith("Not a flat day") || reason.startsWith("Against today's trend")) return reason
  if (reason === "Too early to judge the day") return "Too early to judge the day (before ~9:45)"
  if (reason === "no futures price yet") return "No futures price yet"
  if (reason === "no near-month futures contract") return "No futures contract found"
  if (reason === "no ATR") return "Not enough price history yet"
  return reason
}

const hm = (min: number) => {
  const h = Math.floor(min / 60)
  const m = min % 60
  const h12 = h > 12 ? h - 12 : h
  return `${h12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`
}

/** A strategy's exit settings as numbered plain sentences. */
export function exitRulesInWords(exits: StrategyExits | undefined, barMinutes = 3): string[] {
  if (!exits) return []
  const out = [
    `Stop loss: ${exits.stopAtr}× the typical 3-minute swing (ATR) away from entry. That distance is 1R.`,
    `At +${exits.breakevenAtR}R profit, the stop moves up to the entry price, so a winner can't turn into a loss.`,
    `After that, the stop trails ${exits.trailAtr}× ATR behind the best price reached.`,
    `Target: +${exits.targetR}R.`,
  ]
  if (exits.proveItBars) {
    out.push(
      `If the trade hasn't gone at least +${exits.proveItR ?? 0.25}R in our favour after ${exits.proveItBars} bars (${exits.proveItBars * barMinutes} min), it is cut early.`
    )
  }
  if (exits.timeStopBars && exits.timeStopBars < 1000) {
    out.push(
      `If it's still open after ${exits.timeStopBars} bars (${exits.timeStopBars * barMinutes} min) and below +1R, it is closed.`
    )
  }
  if (exits.noEntryAfterMin) out.push(`No new trades after ${hm(exits.noEntryAfterMin)}.`)
  out.push(`Every trade is closed by ${hm(exits.squareOffMin)}.`)
  return out
}

/** The screener's condition labels (from the server) in everyday words. */
export const SCREENER_CONDITION: Record<string, string> = {
  "LTP above SMA34": "Price is above its 34-bar average",
  "EMA5 above SMA34": "The fast 5-bar average is above the 34-bar average",
  "SMA34 above SMA200": "The 34-bar average is above the 200-bar average (uptrend)",
  "MACD line above signal": "Trend push (MACD) is turning up",
  "LTP below SMA34": "Price is below its 34-bar average",
  "EMA5 below SMA34": "The fast 5-bar average is below the 34-bar average",
  "SMA34 below SMA200": "The 34-bar average is below the 200-bar average (downtrend)",
  "MACD line below signal": "Trend push (MACD) is turning down",
}

export function conditionWord(label: string) {
  if (SCREENER_CONDITION[label]) return SCREENER_CONDITION[label]
  const rsi = label.match(/^RSI\(14\) ([≥≤]) (\d+)/)
  if (rsi) return rsi[1] === "≥" ? `Momentum (RSI) is ${rsi[2]} or higher` : `Momentum (RSI) is ${rsi[2]} or lower`
  return label
}
