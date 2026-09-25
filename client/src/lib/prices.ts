import { createContext, useContext } from "react"
import { getQuote } from "@/lib/priceStore"

/**
 * Live last-traded prices by instrument key, pushed over the socket as
 * "prices" frames (at most once a second). Views read from here first and fall
 * back to the price in their own payload, which refreshes more slowly.
 */
export type PriceMap = Record<string, number>

export const PricesContext = createContext<PriceMap>({})

export function usePrices(): PriceMap {
  return useContext(PricesContext)
}

/** The live price for a key, else the fallback from the slower payload. */
export function livePrice(prices: PriceMap, key: string | null | undefined, fallback: number | null) {
  const v = key ? prices[key] : undefined
  return v != null && Number.isFinite(v) ? v : fallback
}

type Markable = {
  futKey?: string | null
  side: "long" | "short"
  entryPrice: number
  riskPerUnit?: number | null
  qty: number
  ltp: number | null
  unrealisedR: number | null
  unrealisedPnl?: number | null
  markPrice?: number | null
  markSource?: "bid" | "ask" | "last" | null
}

/**
 * Re-mark an open position to the live price. Same arithmetic as the server's
 * engine.unrealisedR, so the numbers agree once the next snapshot lands. Each
 * view marks only its own positions — paper and shadow are never combined.
 *
 * The mark is the price the position could exit at: the best bid for a long,
 * the best ask for a short. Quotes move between trades, so this stays live
 * while the contract is quiet. Without a quote it is the last trade. `ltp`
 * stays the last trade.
 */
export function markToMarket<T extends Markable>(p: T, prices: PriceMap): T {
  const ltp = livePrice(prices, p.futKey, p.ltp)
  const q = getQuote(p.futKey)
  const quoted = q ? (p.side === "long" ? q[0] : q[1]) : null
  const useQuote = quoted != null && Number.isFinite(quoted) && quoted > 0
  const mark = useQuote ? quoted : ltp
  if (mark == null) return p
  const perUnit = p.side === "long" ? mark - p.entryPrice : p.entryPrice - mark
  return {
    ...p,
    ltp,
    markPrice: mark,
    markSource: useQuote ? (p.side === "long" ? "bid" : "ask") : "last",
    unrealisedR: p.riskPerUnit ? perUnit / p.riskPerUnit : p.unrealisedR,
    unrealisedPnl: perUnit * p.qty,
  }
}
