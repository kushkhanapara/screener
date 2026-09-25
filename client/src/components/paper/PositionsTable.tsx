import { Inbox, Shield } from "lucide-react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { InfoTip } from "@/components/ui/info-tip"
import { Legend } from "@/components/ui/legend"
import { cn } from "@/lib/utils"
import { hhmm, num, rMultiple, rupees, toneClass } from "@/components/paper/format"
import { TERMS, sideWord } from "@/lib/glossary"
import type { PaperPosition } from "@/lib/api"
import { usePriceMap } from "@/lib/priceStore"
import { markToMarket } from "@/lib/prices"

/** How far price has travelled from entry toward the stop, as a 0–1 fraction. */
function riskUsed(p: PaperPosition) {
  const price = p.markPrice ?? p.ltp
  if (price == null || !p.riskPerUnit) return null
  const adverse = p.side === "long" ? p.entryPrice - price : price - p.entryPrice
  return Math.max(0, Math.min(1, adverse / p.riskPerUnit))
}

function heldFor(since: number) {
  const min = Math.max(0, Math.round((Date.now() - since) / 60000))
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`
}

function Th({ children, tip, right }: { children: string; tip?: string; right?: boolean }) {
  return (
    <TableHead className={right ? "text-right" : undefined}>
      <span className={cn("inline-flex items-center gap-1", right && "justify-end")}>
        {children}
        {tip && <InfoTip label={children}>{tip}</InfoTip>}
      </span>
    </TableHead>
  )
}

/** Open paper trades, marked to the live futures price. */
export function PositionsTable({ positions: incoming, targetR }: { positions: PaperPosition[]; targetR?: number }) {
  // Marked here from the live store, so price, R and open profit move with the
  // market rather than with the 3-second snapshot.
  const prices = usePriceMap()
  const positions = incoming.map((p) => markToMarket(p, prices))
  if (!positions.length) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-14">
        <Inbox className="size-6 opacity-60" />
        <p className="text-sm">No open trades.</p>
        <p className="text-xs opacity-70">Trades appear here the moment the strategy enters one.</p>
      </div>
    )
  }

  const totalR = positions.reduce((a, p) => a + (p.unrealisedR ?? 0), 0)
  const totalPnl = positions.reduce((a, p) => a + (p.unrealisedPnl ?? 0), 0)
  const targetOf = (p: PaperPosition) => {
    // A strategy that sets its own target (VWAP + Volume Profile) carries it;
    // a trend trade there has none and runs on the trailing stop.
    if (p.features?.vpLevels) return p.features.vpLevels.targetPrice ?? null
    return targetR ? p.entryPrice + (p.side === "long" ? 1 : -1) * targetR * p.riskPerUnit : null
  }

  return (
    <div className="space-y-2">
      <div className="text-muted-foreground text-[13px]">
        <span className="text-foreground/80">{positions.length}</span> open ·{" "}
        <span className={cn("font-mono tabular-nums", toneClass(totalPnl))}>{rupees(totalPnl, true)}</span> ·{" "}
        <span className={cn("font-mono tabular-nums", toneClass(totalR))}>{rMultiple(totalR, 1)}</span> open profit (not
        locked in)
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <Th tip={TERMS.lot}>Stock</Th>
              <Th tip={TERMS.buySell}>Direction</Th>
              <Th right>Entry (futures)</Th>
              <Th right tip={TERMS.priceNow}>Price now</Th>
              <Th right tip={TERMS.stop}>Stop loss</Th>
              <Th right tip={TERMS.target}>Target</Th>
              <Th tip={TERMS.usedOfStop}>Near stop?</Th>
              <Th right tip={TERMS.r}>Result (R)</Th>
              <Th right tip={TERMS.openProfit}>Open profit</Th>
              <Th right>Opened</Th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {positions.map((p) => {
              const used = riskUsed(p)
              const target = targetOf(p)
              return (
                <TableRow key={p.id} className="hover:bg-transparent">
                  <TableCell className="font-mono text-[13px] font-medium">
                    <span title={p.futLabel ?? undefined}>{p.underlying}</span>
                    {p.futLabel && (
                      <div className="text-muted-foreground text-[11px] font-normal" title="Always the nearest expiry">
                        {p.futLabel.replace(`${p.underlying} `, "")} · near month
                      </div>
                    )}
                    <div className="text-muted-foreground text-[11px] font-normal">
                      {p.lots} lot · {p.qty} shares
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("font-normal", p.side === "long" ? "text-up" : "text-down")}>
                      {sideWord(p.side)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-[13px] tabular-nums">
                    {num(p.entryPrice)}
                    {p.cashPriceAtSignal != null && (
                      <div className="text-muted-foreground text-[11px]" title="Cash (spot) price when the signal fired">
                        spot {num(p.cashPriceAtSignal)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[13px] tabular-nums">
                    {num(p.markPrice ?? p.ltp)}
                    {p.markSource && p.markSource !== "last" && (
                      <div
                        className="text-muted-foreground text-[11px]"
                        title={`Best ${p.markSource} — what this trade could exit at now. Last trade ${num(p.ltp)}.`}
                      >
                        {p.markSource} · last {num(p.ltp)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[13px] tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      {p.breakevenMoved && <Shield className="text-up size-3" aria-label="stop moved to entry or better" />}
                      {num(p.currentStop)}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right font-mono text-[13px] tabular-nums">
                    {num(target)}
                  </TableCell>
                  <TableCell>
                    <div
                      className="bg-muted h-1.5 w-20 overflow-hidden rounded-full"
                      title={used == null ? "no live price" : `${Math.round(used * 100)}% of the way to the stop loss`}
                    >
                      <div
                        className={cn("h-full rounded-full", (used ?? 0) > 0.66 ? "bg-down/70" : "bg-chart-3/60")}
                        style={{ width: `${(used ?? 0) * 100}%` }}
                      />
                    </div>
                  </TableCell>
                  <TableCell className={cn("text-right font-mono text-[13px] font-medium tabular-nums", toneClass(p.unrealisedR))}>
                    {rMultiple(p.unrealisedR)}
                  </TableCell>
                  <TableCell className={cn("text-right font-mono text-[13px] tabular-nums", toneClass(p.unrealisedPnl))}>
                    {rupees(p.unrealisedPnl, true)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right font-mono text-[13px]">
                    {hhmm(p.entryTime)}
                    <div className="text-[11px]">{heldFor(p.entryTime)} ago</div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <Legend
        items={[
          { mark: <Shield className="text-up size-3" aria-hidden />, label: "Stop moved to entry or better", meaning: "— this trade can no longer lose much" },
          { swatch: "bg-chart-3/60", label: "Near stop? bar", meaning: "— fills up as price moves toward the stop; red past two-thirds" },
        ]}
      />
    </div>
  )
}
