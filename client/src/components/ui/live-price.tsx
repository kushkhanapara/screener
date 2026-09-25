import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { changePct, useTick } from "@/lib/priceStore"

const FLASH_MS = 600

/** Green/red tint for a moment after the price moves, the way a terminal does. */
function useFlash(ltp: number | null, prev: number | null) {
  const [flash, setFlash] = useState<"up" | "down" | null>(null)
  const last = useRef<number | null>(null)
  useEffect(() => {
    if (ltp == null || prev == null || ltp === last.current) return
    last.current = ltp
    if (ltp === prev) return
    setFlash(ltp > prev ? "up" : "down")
    const t = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(t)
  }, [ltp, prev])
  return flash
}

const fmt = (v: number | null, digits = 2) =>
  v == null ? "—" : v.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })

/**
 * One instrument's live price. Subscribes to its own key, so a tick elsewhere
 * in a 200-row table costs nothing here.
 */
export function LivePrice({
  instrument,
  fallback = null,
  digits = 2,
  className,
}: {
  instrument: string | null | undefined
  fallback?: number | null
  digits?: number
  className?: string
}) {
  const tick = useTick(instrument)
  const ltp = tick?.ltp ?? fallback
  const flash = useFlash(tick?.ltp ?? null, tick?.prev ?? null)
  return (
    <span
      className={cn(
        "font-mono tabular-nums transition-colors duration-150",
        flash === "up" && "bg-up/15 text-up rounded px-1",
        flash === "down" && "bg-down/15 text-down rounded px-1",
        className
      )}
    >
      {fmt(ltp, digits)}
    </span>
  )
}

/**
 * The move against a reference price, recomputed on every tick. `from` is
 * whatever the number should be measured against — usually the previous close,
 * sometimes today's open.
 */
export function LiveChange({
  instrument,
  from,
  fallback = null,
  showPoints = false,
  className,
}: {
  instrument: string | null | undefined
  from: number | null | undefined
  fallback?: number | null
  showPoints?: boolean
  className?: string
}) {
  const ltp = useTick(instrument)?.ltp ?? fallback
  const pct = changePct(ltp, from)
  if (pct == null) return <span className={cn("text-muted-foreground", className)}>—</span>
  const points = ltp != null && from != null ? ltp - from : null
  return (
    <span className={cn("font-mono tabular-nums", pct >= 0 ? "text-up" : "text-down", className)}>
      {pct >= 0 ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}%
      {showPoints && points != null && <span className="ml-1 opacity-70">{`${points >= 0 ? "+" : "−"}${Math.abs(points).toFixed(2)}`}</span>}
    </span>
  )
}
