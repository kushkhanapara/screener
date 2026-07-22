import { useEffect, useRef, useState } from "react"
import { liveSocketUrl, type ScripMatch } from "@/lib/api"

type LiveSocketState = {
  connected: boolean
  counts: { long: number; short: number }
  scrips: ScripMatch[]
  lastUpdated: string | null
  enteredLong: string[]
  enteredShort: string[]
}

const initial: LiveSocketState = {
  connected: false,
  counts: { long: 0, short: 0 },
  scrips: [],
  lastUpdated: null,
  enteredLong: [],
  enteredShort: [],
}

/**
 * Connect to /ws/live and expose the two-sided live state. Auto-reconnects with
 * a short backoff. Tracks the most-recently-entered scrips per side so rows flash.
 */
export function useLiveSocket(): LiveSocketState {
  const [state, setState] = useState<LiveSocketState>(initial)
  const wsRef = useRef<WebSocket | null>(null)
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let closed = false

    function connect() {
      const ws = new WebSocket(liveSocketUrl())
      wsRef.current = ws

      ws.onopen = () => setState((s) => ({ ...s, connected: true }))

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type !== "update") return
          setState((s) => ({
            ...s,
            connected: true,
            counts: msg.counts ?? { long: 0, short: 0 },
            scrips: msg.scrips ?? [],
            enteredLong: msg.entered?.long ?? [],
            enteredShort: msg.entered?.short ?? [],
            lastUpdated: msg.ts ?? new Date().toISOString(),
          }))
        } catch {
          /* ignore malformed frame */
        }
      }

      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }))
        if (!closed) retryRef.current = setTimeout(connect, 3000)
      }
      ws.onerror = () => ws.close()
    }

    connect()
    return () => {
      closed = true
      if (retryRef.current) clearTimeout(retryRef.current)
      wsRef.current?.close()
    }
  }, [])

  return state
}
