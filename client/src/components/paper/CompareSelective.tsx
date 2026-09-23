import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { InfoTip } from "@/components/ui/info-tip"
import { cn } from "@/lib/utils"
import { pct, rMultiple, rupees, toneClass } from "@/components/paper/format"
import { TERMS } from "@/lib/glossary"
import type { PaperStrategyState } from "@/lib/api"

/**
 * Each original strategy next to its Selective twin. They see the same setups
 * and use the same stops, so the difference between the two rows is exactly
 * what the quality filter is worth.
 */
export function CompareSelective({ strategies }: { strategies: PaperStrategyState[] }) {
  const originals = strategies.filter((s) => !s.selection)
  const pairs = originals
    .map((o) => ({ o, s: strategies.find((x) => x.selection && x.family === o.id) }))
    .filter((p) => p.s)
  if (!pairs.length) return null

  const row = (st: PaperStrategyState, label: string, first: boolean) => {
    const m = st.metrics
    const has = m.trades > 0
    return (
      <TableRow key={st.id} className={cn("hover:bg-transparent", !first && "border-b-2")}>
        <TableCell className="text-[13px]">
          {first ? <span className="font-medium">{st.name}</span> : <span className="text-muted-foreground pl-3">↳ {label}</span>}
        </TableCell>
        <TableCell className="text-right font-mono tabular-nums">{m.trades}</TableCell>
        <TableCell className="text-right font-mono tabular-nums">{has ? pct(m.winRate) : "—"}</TableCell>
        <TableCell className={cn("text-right font-mono tabular-nums", has && toneClass(m.expectancyR))}>
          {has ? rMultiple(m.expectancyR) : "—"}
        </TableCell>
        <TableCell className={cn("text-right font-mono tabular-nums", has && toneClass(m.netPnl))}>
          {has ? rupees(m.netPnl, true) : "—"}
        </TableCell>
        <TableCell className="text-muted-foreground text-right font-mono tabular-nums">{has ? rupees(m.totalCosts) : "—"}</TableCell>
        <TableCell className={cn("text-right font-mono tabular-nums", st.today?.trades ? toneClass(st.today.netPnl) : "text-muted-foreground")}>
          {st.today?.trades ? `${rupees(st.today.netPnl, true)} (${st.today.trades})` : "—"}
        </TableCell>
      </TableRow>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Strategy</TableHead>
            <TableHead className="text-right">Trades</TableHead>
            <TableHead className="text-right">Win rate</TableHead>
            <TableHead className="text-right">
              <span className="inline-flex items-center justify-end gap-1">
                Avg per trade <InfoTip label="Average per trade">{TERMS.avgPerTrade}</InfoTip>
              </span>
            </TableHead>
            <TableHead className="text-right">Profit</TableHead>
            <TableHead className="text-right">
              <span className="inline-flex items-center justify-end gap-1">
                Charges <InfoTip label="Charges">{TERMS.charges}</InfoTip>
              </span>
            </TableHead>
            <TableHead className="text-right">Today (trades)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pairs.flatMap(({ o, s }) => [row(o, "Original", true), row(s!, "Selective (with quality filter)", false)])}
        </TableBody>
      </Table>
    </div>
  )
}
