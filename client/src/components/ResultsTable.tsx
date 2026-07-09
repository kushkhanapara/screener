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
import type { MatchRow } from "@/lib/api"

const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—")

function tag(reason: string): string {
  if (reason.startsWith("Uptrend")) return "Uptrend"
  if (reason.startsWith("Short-term")) return "EMA 9>21"
  if (reason.startsWith("MACD")) return "MACD+"
  if (reason.startsWith("RSI")) return "RSI 50–70"
  return reason
}

type Props = {
  rows?: MatchRow[]
  loading?: boolean
  error?: string | null
  priceLabel?: string
  firstColLabel?: string
  lastColLabel?: string
  enteredSet?: Set<string>
  emptyHint?: string
}

export function ResultsTable({
  rows,
  loading,
  error,
  priceLabel = "Close",
  firstColLabel = "Contract",
  lastColLabel = "Expiry",
  enteredSet,
  emptyHint = "No contracts match the strategy right now.",
}: Props) {
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
        <p className="text-sm">{emptyHint}</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{firstColLabel}</TableHead>
            <TableHead className="text-right">{priceLabel}</TableHead>
            <TableHead className="text-right">RSI(14)</TableHead>
            <TableHead className="text-right">MACD hist</TableHead>
            <TableHead>Matched conditions</TableHead>
            <TableHead className="text-right">{lastColLabel}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.contract} className={cn(enteredSet?.has(r.contract) && "flash-in")}>
              <TableCell className="font-mono text-[13px] font-medium">{r.contract}</TableCell>
              <TableCell className="text-right font-mono text-[13px] tabular-nums">
                {fmt(r.close)}
              </TableCell>
              <TableCell className="text-muted-foreground text-right font-mono text-[13px] tabular-nums">
                {fmt(r.rsi14, 1)}
              </TableCell>
              <TableCell
                className={cn(
                  "text-right font-mono text-[13px] tabular-nums",
                  r.macdHist >= 0 ? "text-emerald-600" : "text-red-600"
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
