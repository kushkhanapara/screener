import { Badge } from "@/components/ui/badge"
import type { FuturePrice } from "@/lib/api"
import { livePrice, usePrices } from "@/lib/prices"

const fmt = (v: number | null | undefined, d = 2) =>
  v != null && Number.isFinite(v) ? v.toFixed(d) : "—"

/** Compact per-expiry futures price chips, e.g. `JUL 3012.5 · AUG 3025`. */
export function FuturesChips({ futures }: { futures?: FuturePrice[] }) {
  const prices = usePrices()
  if (!futures?.length) return <span className="text-muted-foreground text-xs">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {futures.map((f) => (
        <Badge
          key={f.expiry + f.month}
          variant="outline"
          className="font-mono text-[11px] tabular-nums"
          title={f.label}
        >
          <span className="text-muted-foreground mr-1 font-sans">{f.month}</span>
          {fmt(livePrice(prices, f.key, f.ltp))}
        </Badge>
      ))}
    </div>
  )
}
