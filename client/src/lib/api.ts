/** Thin fetch wrappers + shared types for the server API. Throw on non-2xx. */

export type MatchRow = {
  contract: string
  underlying: string
  expiry: string
  close: number
  rsi14: number
  macdHist: number
  reasons: string[]
}

export type DailyStatus = {
  updatedAt: string | null
  loaded: number
  total: number
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
  count: number
  results: MatchRow[]
}

export type LiveStatus = {
  connected: boolean
  marketOpen: boolean
  hasToken: boolean
  lastTickTs: number | null
  subscribed: number
  count: number
  error: string | null
}

export type LiveUpdate = {
  type: "update"
  count: number
  matching: MatchRow[]
  entered: string[]
  exited: string[]
  ts: string | null
}

async function jsonFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const getStatus = () => jsonFetch<DailyStatus>("/api/status")
export const getStrategy = () => jsonFetch<{ conditions: string[] }>("/api/strategy")
export const getLiveStatus = () => jsonFetch<LiveStatus>("/api/live/status")
export const refresh = () => jsonFetch<{ fetching: boolean }>("/api/refresh", { method: "POST" })
export const scan = () => jsonFetch<ScanResult>("/api/scan", { method: "POST" })

/** Build the /ws/live URL from the current origin (works in dev via proxy). */
export function liveSocketUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws"
  return `${proto}://${window.location.host}/ws/live`
}
