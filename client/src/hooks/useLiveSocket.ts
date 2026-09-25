import { useEffect, useRef, useState } from "react"
import { liveSocketUrl, type ScripMatch, type PaperSnapshot } from "@/lib/api"
import type { PriceMap } from "@/lib/prices"
import { applyPriceFrame } from "@/lib/priceStore"

export type LiveSocketState = {
  connected: boolean
  counts: { long: number; short: number }
  scrips: ScripMatch[]
  lastUpdated: string | null
  enteredLong: string[]
  enteredShort: string[]
  /** Paper-trading snapshot, pushed over the same socket as a "paper" frame. */
  paper: PaperSnapshot | null
  /** Live last-traded prices by instrument key, updated at most once a second. */
  prices: PriceMap
}

const initial: LiveSocketState = {
  connected: false,
  counts: { long: 0, short: 0 },
  scrips: [],
  lastUpdated: null,
  enteredLong: [],
  enteredShort: [],
  paper: null,
  prices: {},
}

/** Coalesce price frames into one render a second, however fast they arrive. */
const PRICE_FLUSH_MS = 1000

/**
 * Connect to /ws/live and expose both the screener state and the paper-trading
 * snapshot. They share ONE socket — the server sends "update" frames for the
 * screener and "paper" frames for the engine — so there is a single connection
 * and a single reconnect path. Auto-reconnects with a short backoff.
 */
export function useLiveSocket(): LiveSocketState {
  const [state, setState] = useState<LiveSocketState>(initial)
  const wsRef = useRef<WebSocket | null>(null)
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pricesRef = useRef<PriceMap>({})
  const pricesDirty = useRef(false)

  useEffect(() => {
    const id = setInterval(() => {
      if (!pricesDirty.current) return
      pricesDirty.current = false
      const next = { ...pricesRef.current }
      setState((s) => ({ ...s, prices: next }))
    }, PRICE_FLUSH_MS)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    let closed = false
    let attempt = 0

    /**
     * Back off on repeated failures instead of hammering.
     *
     * A flat 3s retry means a backend that is down, restarting, or rejecting
     * credentials produces twenty failed upgrades a minute, forever — which in
     * dev floods the Vite proxy log with ECONNABORTED and makes a real error
     * impossible to spot. Doubling to a 30s ceiling keeps reconnection prompt
     * for a blip while staying quiet through an outage.
     */
    const retryDelay = () => {
      const base = Math.min(3000 * 2 ** attempt, 30000)
      return base + Math.random() * 500 // jitter, so tabs don't retry in lockstep
    }

    function connect() {
      const ws = new WebSocket(liveSocketUrl())
      wsRef.current = ws

      ws.onopen = () => {
        attempt = 0 // a good connection clears the backoff
        setState((s) => ({ ...s, connected: true }))
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type === "prices") {
            // Straight into the price store: components subscribed to one
            // instrument update on this frame, without re-rendering the app.
            applyPriceFrame(msg.ltp ?? {}, Boolean(msg.full))
            if (msg.full) pricesRef.current = {}
            Object.assign(pricesRef.current, msg.ltp ?? {})
            pricesDirty.current = true
            return
          }
          if (msg.type === "paper") {
            setState((s) => ({ ...s, connected: true, paper: msg as PaperSnapshot }))
            return
          }
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
        if (closed) return
        retryRef.current = setTimeout(connect, retryDelay())
        attempt++
      }
      // Let onclose own the retry — onerror always fires alongside it, and
      // scheduling from both would double the reconnection rate.
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
