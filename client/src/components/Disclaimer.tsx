import { Info } from "lucide-react"

export function Disclaimer() {
  return (
    <p className="text-muted-foreground flex items-start gap-2 text-xs leading-relaxed">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Flags <strong>technical matches only</strong>, against a fixed strategy on NSE single-stock
        futures. Not investment advice; places no trades and makes no recommendation. Data via
        Upstox.
      </span>
    </p>
  )
}
