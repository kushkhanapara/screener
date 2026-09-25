import { useSyncExternalStore } from "react"

/**
 * Live prices, the way a broker terminal does it.
 *
 * The socket delivers only the instruments that moved, several times a second.
 * Putting that in React state would re-render every table on every frame, so
 * each price lives here instead and components subscribe to the ONE key they
 * show. A tick in RELIANCE re-renders the RELIANCE cells and nothing else.
 */

export type Tick = {
  /** Last traded price. */
  ltp: number
  /** The price before this one, for the up/down flash. */
  prev: number
  /** When it arrived, so a cell can stop flashing. */
  ts: number
}

const ticks = new Map<string, Tick>()
/** Futures best [bid, ask] — they move between trades. */
const quotes = new Map<string, [number | null, number | null]>()
const listeners = new Map<string, Set<() => void>>()
let version = 0
const globalListeners = new Set<() => void>()

/** Apply one "prices" frame from the socket. */
export function applyPriceFrame(
  ltp: Record<string, number>,
  full = false,
  quote: Record<string, [number | null, number | null]> = {}
) {
  if (full) {
    ticks.clear()
    quotes.clear()
  }
  const now = Date.now()
  const touched = new Set<string>()
  for (const [key, q] of Object.entries(quote ?? {})) {
    if (!Array.isArray(q)) continue
    quotes.set(key, q)
    touched.add(key)
  }
  for (const [key, price] of Object.entries(ltp ?? {})) {
    if (!Number.isFinite(price)) continue
    const before = ticks.get(key)
    if (before?.ltp === price) continue
    ticks.set(key, { ltp: price, prev: before?.ltp ?? price, ts: now })
    touched.add(key)
  }
  for (const key of touched) {
    const subs = listeners.get(key)
    if (subs) for (const fn of subs) fn()
  }
  version++
  for (const fn of globalListeners) fn()
}

/** Best bid and ask for a futures key, when the feed has quoted it. */
export const getQuote = (key: string | null | undefined) => (key ? (quotes.get(key) ?? null) : null)

export const getTick = (key: string | null | undefined) => (key ? (ticks.get(key) ?? null) : null)

function subscribe(key: string | null | undefined) {
  return (onChange: () => void) => {
    if (!key) return () => {}
    let subs = listeners.get(key)
    if (!subs) listeners.set(key, (subs = new Set()))
    subs.add(onChange)
    return () => {
      subs.delete(onChange)
      if (!subs.size) listeners.delete(key)
    }
  }
}

/** The live tick for one instrument — re-renders only when THAT price moves. */
export function useTick(key: string | null | undefined): Tick | null {
  return useSyncExternalStore(
    subscribe(key),
    () => (key ? (ticks.get(key) ?? null) : null),
    () => null
  )
}

/** Just the price, with a fallback for instruments that haven't traded yet. */
export function usePrice(key: string | null | undefined, fallback: number | null = null) {
  return useTick(key)?.ltp ?? fallback
}

/**
 * Every price at once. For the few places that need the whole map (marking a
 * list of positions); prefer useTick where a component shows one instrument.
 */
export function usePriceMap(): Record<string, number> {
  const v = useSyncExternalStore(
    (onChange) => {
      globalListeners.add(onChange)
      return () => globalListeners.delete(onChange)
    },
    () => version,
    () => 0
  )
  void v
  return Object.fromEntries([...ticks].map(([k, t]) => [k, t.ltp]))
}

/** Percentage move from a reference price (previous close, today's open, …). */
export const changePct = (ltp: number | null, from: number | null | undefined) =>
  ltp != null && from != null && from > 0 ? ((ltp - from) / from) * 100 : null
