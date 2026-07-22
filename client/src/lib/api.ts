/** Thin fetch wrappers + shared types for the server API. Throw on non-2xx. */

export type Side = "long" | "short"
export type Timeframe = "3m" | "15m"
export type Trend = "bullish" | "bearish" | "neutral"

/** Per-timeframe evaluation for a scrip (from the live feed). */
export type TfState = {
  long?: boolean
  short?: boolean
  dataLimited?: boolean
  close?: number
  rsi14?: number
  rsiSignal?: number
  macd?: number
  macdSignal?: number
  macdHist?: number
  sma34?: number
  sma200?: number | null
}

/** One active futures expiry with its last-traded price. */
export type FuturePrice = {
  label: string
  month: string
  expiry: string
  ltp: number | null
}

/** A matched scrip in the live feed (evaluated on the cash chart). */
export type ScripMatch = {
  underlying: string
  cashKey: string
  cashLtp: number | null
  trend: Trend
  longMatch: boolean
  shortMatch: boolean
  conflict: boolean
  tf: Record<Timeframe, TfState>
  futures: FuturePrice[]
}

/** One matched row in the EOD (daily) scan. */
export type DailyRow = {
  contract: string
  underlying: string
  expiry: string
  close: number
  rsi14: number
  rsiSignal?: number
  macdHist: number
  reasons: string[]
  futures: FuturePrice[]
}

export type SideResult = { count: number; results: DailyRow[] }

export type DailyStatus = {
  updatedAt: string | null
  loaded: number
  total: number
  fetched: number
  skipped: number
  fetching: boolean
  error: string | null
  hasToken: boolean
}

export type ScanResult = {
  updatedAt: string | null
  total: number
  loaded: number
  skipped: number
  long: SideResult
  short: SideResult
}

export type LiveStatus = {
  connected: boolean
  marketOpen: boolean
  hasToken: boolean
  lastTickTs: number | null
  subscribed: number
  counts: { long: number; short: number }
  error: string | null
}

export type LiveUpdate = {
  type: "update"
  ts: string | null
  scrips: ScripMatch[]
  counts: { long: number; short: number }
  entered: { long: string[]; short: string[] }
  exited: { long: string[]; short: string[] }
}

export type StrategyConditions = { long: string[]; short: string[] }

async function jsonFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const getStatus = () => jsonFetch<DailyStatus>("/api/status")
export const getStrategy = () => jsonFetch<StrategyConditions>("/api/strategy")
export const getLiveStatus = () => jsonFetch<LiveStatus>("/api/live/status")
export const refresh = () => jsonFetch<{ fetching: boolean }>("/api/refresh", { method: "POST" })
export const scan = () => jsonFetch<ScanResult>("/api/scan", { method: "POST" })

/** Build the /ws/live URL from the current origin (works in dev via proxy). */
export function liveSocketUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws"
  return `${proto}://${window.location.host}/ws/live`
}
