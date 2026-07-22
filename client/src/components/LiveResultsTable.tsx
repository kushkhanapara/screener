import { Check, X, Clock, TriangleAlert, Inbox } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { FuturesChips } from "@/components/FuturesChips"
import { RsiMomentum } from "@/components/RsiMomentum"
import type { ScripMatch, Side, TfState, Timeframe } from "@/lib/api"

const fmt = (v: number | null | undefined, d = 2) =>
  v != null && Number.isFinite(v) ? v.toFixed(d) : "—"

/** Prefer the 3m row for live numbers; fall back to 15m when 3m has no data. */
function primaryTf(s: ScripMatch): TfState {
  const a = s.tf["3m"]
  return a && a.close != null ? a : s.tf["15m"]
}

/** ✓ / ✗ / insufficient-history badge for one timeframe on one side. */
function TfBadge({ tf, side, label }: { tf: TfState; side: Side; label: Timeframe }) {
  if (tf?.dataLimited) {
    return (
      <Badge variant="secondary" className="gap-1 font-normal" title="Insufficient history (SMA200)">
        <Clock className="opacity-70" />
        {label}
      </Badge>
    )
  }
  const matched = side === "long" ? tf?.long : tf?.short
  return matched ? (
    <Badge
      className="gap-1 border-transparent bg-emerald-600/15 font-medium text-emerald-700 dark:text-emerald-400"
      title={`${label} matches ${side}`}
    >
      <Check /> {label}
    </Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground gap-1 font-normal" title={`${label} does not match`}>
      <X /> {label}
    </Badge>
  )
}

function TrendBadge({ trend }: { trend: ScripMatch["trend"] }) {
  const map = {
    bullish: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400",
    bearish: "bg-red-600/15 text-red-700 dark:text-red-400",
    neutral: "bg-muted text-muted-foreground",
  } as const
  return (
    <Badge className={cn("border-transparent font-medium capitalize", map[trend])}>{trend}</Badge>
  )
}

type Props = {
  scrips?: ScripMatch[]
  side: Side
  enteredSet?: Set<string>
  emptyHint?: string
}

/** Live matches for one side (Long/Short), sorted with both-timeframe hits first. */
export function LiveResultsTable({ scrips, side, enteredSet, emptyHint }: Props) {
  const rows = (scrips ?? [])
    .filter((s) => (side === "long" ? s.longMatch : s.shortMatch))
    .sort((a, b) => {
      const bothA = Number(Boolean(a.tf["3m"]?.[side]) && Boolean(a.tf["15m"]?.[side]))
      const bothB = Number(Boolean(b.tf["3m"]?.[side]) && Boolean(b.tf["15m"]?.[side]))
      if (bothA !== bothB) return bothB - bothA
      return a.underlying.localeCompare(b.underlying)
    })

  if (!rows.length) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-16">
        <Inbox className="size-7 opacity-60" />
        <p className="text-sm">{emptyHint ?? `No scrips match the ${side} setup right now.`}</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Scrip</TableHead>
            <TableHead className="text-right">LTP</TableHead>
            <TableHead className="text-right">RSI(14)</TableHead>
            <TableHead className="text-right">MACD hist</TableHead>
            <TableHead>Trend</TableHead>
            <TableHead>3m</TableHead>
            <TableHead>15m</TableHead>
            <TableHead>Futures (LTP)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => {
            const p = primaryTf(s)
            return (
              <TableRow
                key={s.underlying}
                className={cn(enteredSet?.has(s.underlying) && "flash-in")}
              >
                <TableCell className="font-mono text-[13px] font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    {s.underlying}
                    {s.conflict && (
                      <span title="Long on one timeframe, Short on the other" className="inline-flex">
                        <TriangleAlert className="size-3.5 text-amber-500" aria-label="conflict" />
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono text-[13px] tabular-nums">
                  {fmt(s.cashLtp)}
                </TableCell>
                <TableCell className="text-right">
                  <RsiMomentum rsi={p?.rsi14} signal={p?.rsiSignal} />
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right font-mono text-[13px] tabular-nums",
                    (p?.macdHist ?? 0) >= 0 ? "text-emerald-600" : "text-red-600"
                  )}
                >
                  {fmt(p?.macdHist, 3)}
                </TableCell>
                <TableCell>
                  <TrendBadge trend={s.trend} />
                </TableCell>
                <TableCell>
                  <TfBadge tf={s.tf["3m"]} side={side} label="3m" />
                </TableCell>
                <TableCell>
                  <TfBadge tf={s.tf["15m"]} side={side} label="15m" />
                </TableCell>
                <TableCell>
                  <FuturesChips futures={s.futures} />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
