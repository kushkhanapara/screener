import { ChevronUp, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

/** Zone label + color from the 60 / 50 / 40 bands. */
function zone(rsi: number) {
  if (rsi >= 60) return { label: "Aggressive overbought", cls: "text-emerald-600" }
  if (rsi >= 50) return { label: "Bullish (50–60)", cls: "text-emerald-600/70" }
  if (rsi > 40) return { label: "Bearish (40–50)", cls: "text-red-600/70" }
  return { label: "Aggressive oversold", cls: "text-red-600" }
}

/**
 * Compact RSI(14) momentum cell: value colored by the 60/50/40 zone, plus a
 * chevron for the RSI-vs-5-EMA-signal crossover state. Tooltip spells out both.
 */
export function RsiMomentum({
  rsi,
  signal,
}: {
  rsi?: number | null
  signal?: number | null
}) {
  if (rsi == null || !Number.isFinite(rsi)) {
    return <span className="text-muted-foreground font-mono text-[13px]">—</span>
  }
  const z = zone(rsi)
  const hasSig = signal != null && Number.isFinite(signal)
  const above = hasSig && rsi >= (signal as number)
  const crossTxt = hasSig
    ? `${above ? "above" : "below"} 5-EMA signal (${(signal as number).toFixed(1)})`
    : "no signal yet"

  return (
    <span
      className={cn("inline-flex items-center justify-end gap-0.5 font-mono text-[13px] tabular-nums", z.cls)}
      title={`RSI ${rsi.toFixed(1)} — ${z.label}; ${crossTxt}`}
    >
      {rsi.toFixed(1)}
      {hasSig &&
        (above ? (
          <ChevronUp className="size-3.5 shrink-0" aria-label="above signal" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0" aria-label="below signal" />
        ))}
    </span>
  )
}
