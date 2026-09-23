import { Inbox, TriangleAlert } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { cn } from "@/lib/utils"
import { FuturesChips } from "@/components/FuturesChips"
import { RsiMomentum } from "@/components/RsiMomentum"
import type { DailyRow } from "@/lib/api"

const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—")

/** Shorten a condition label into a compact badge tag. */
function tag(reason: string): string {
  if (reason.startsWith("LTP")) return reason.includes("above") ? "LTP>SMA34" : "LTP<SMA34"
  if (reason.startsWith("EMA5")) return reason.includes("above") ? "EMA5>SMA34" : "EMA5<SMA34"
  if (reason.startsWith("SMA34")) return reason.includes("above") ? "SMA34>SMA200" : "SMA34<SMA200"
  if (reason.startsWith("RSI")) return reason.replace("RSI(14) ", "RSI ")
  if (reason.startsWith("MACD")) return reason.includes("above") ? "MACD+" : "MACD−"
  return reason
}

type Props = {
  rows?: DailyRow[]
  loading?: boolean
  error?: string | null
  emptyHint?: string
}

/** EOD matches for one side (daily cash candles) with per-expiry futures prices. */
export function DailyResultsTable({ rows, loading, error, emptyHint }: Props) {
  if (error) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>Couldn't reach the server</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  if (loading) {
    return (
      <div className="space-y-2.5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    )
  }

  if (!rows?.length) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-16">
        <Inbox className="size-7 opacity-60" />
        <p className="text-sm">{emptyHint ?? "No stocks matched this side in the latest daily data."}</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Stock</TableHead>
            <TableHead className="text-right">Closing price</TableHead>
            <TableHead className="text-right" title="Momentum, 0–100. Above 60 strong buying, below 40 strong selling.">Momentum (RSI)</TableHead>
            <TableHead className="text-right" title="Trend push. Positive = upward, negative = downward.">Trend push (MACD)</TableHead>
            <TableHead>Rules matched</TableHead>
            <TableHead title="Futures price for each expiry month">Futures price</TableHead>
            <TableHead className="text-right">Expiry</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.contract} className="hover:bg-transparent">
              <TableCell className="font-mono text-[13px] font-medium">{r.contract}</TableCell>
              <TableCell className="text-right font-mono text-[13px] tabular-nums">
                {fmt(r.close)}
              </TableCell>
              <TableCell className="text-right">
                <RsiMomentum rsi={r.rsi14} signal={r.rsiSignal} />
              </TableCell>
              <TableCell
                className={cn(
                  "text-right font-mono text-[13px] tabular-nums",
                  r.macdHist >= 0 ? "text-up" : "text-down"
                )}
              >
                {fmt(r.macdHist, 3)}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {r.reasons.map((reason) => (
                    <Badge key={reason} variant="secondary" className="font-normal">
                      {tag(reason)}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell>
                <FuturesChips futures={r.futures} />
              </TableCell>
              <TableCell className="text-muted-foreground text-right font-mono text-[13px]">
                {r.expiry}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
