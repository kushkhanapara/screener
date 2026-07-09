import { useEffect, useRef, useState } from "react"
import { liveSocketUrl, type MatchRow } from "@/lib/api"

type LiveSocketState = {
  connected: boolean
  count: number
  matching: MatchRow[]
  lastUpdated: string | null
  entered: string[]
}

/**
 * Connect to /ws/live and expose the live matching state. Auto-reconnects with
 * a short backoff. Tracks the most-recently-entered contracts so rows can flash.
 */
export function useLiveSocket(): LiveSocketState {
  const [state, setState] = useState<LiveSocketState>({
    connected: false,
    count: 0,
    matching: [],
    lastUpdated: null,
    entered: [],
  })
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
            count: msg.count,
            matching: msg.matching ?? [],
            entered: msg.entered ?? [],
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
