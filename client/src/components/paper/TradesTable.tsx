import { Inbox } from "lucide-react"
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
import { cn } from "@/lib/utils"
import type { PaperTrade, ExitReason } from "@/lib/api"
import { InfoTip } from "@/components/ui/info-tip"
import { EXIT, TERMS, sideWord } from "@/lib/glossary"

const num = (v: number | null | undefined, d = 2) =>
  v != null && Number.isFinite(v) ? v.toFixed(d) : "—"

const rupees = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return "—"
  const sign = v < 0 ? "−" : "+"
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`
}

// Pinned to IST so the times read the same on any device, wherever it is viewed.
const time = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  })

const day = (ms: number) =>
  new Date(ms).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  })

/** Held duration with seconds, so sub-minute trades don't all read "0m". */
function held(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  if (m >= 24 * 60) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`
}

function Stamp({ ms }: { ms: number }) {
  return (
    <div className="font-mono tabular-nums">
      <div className="text-[13px]">{time(ms)}</div>
      <div className="text-muted-foreground text-[11px]">{day(ms)}</div>
    </div>
  )
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

function ExitBadge({ reason }: { reason: ExitReason }) {
  return (
    <Badge
      variant="outline"
      title={EXIT[reason]?.why}
      className={cn(
        "font-normal",
        reason === "stop" && "text-down",
        reason === "target" && "text-up"
      )}
    >
      {EXIT[reason]?.label ?? reason}
    </Badge>
  )
}

export function TradesTable({
  trades,
  loading,
}: {
  trades?: PaperTrade[]
  loading?: boolean
}) {
  if (loading) {
    return (
      <div className="space-y-2.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    )
  }

  if (!trades?.length) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-14">
        <Inbox className="size-6 opacity-60" />
        <p className="text-sm">No closed trades yet.</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <Th>Stock</Th>
            <Th tip={TERMS.buySell}>Direction</Th>
            <Th>Opened</Th>
            <Th right>Entry price</Th>
            <Th>Closed</Th>
            <Th right>Exit price</Th>
            <Th tip="Hover a label to see what it means.">How it ended</Th>
            <Th right tip={TERMS.r}>Result (R)</Th>
            <Th right tip={TERMS.netPnl}>Profit</Th>
            <Th right tip={`${TERMS.worstDip} ${TERMS.bestRun}`}>Worst dip / best run</Th>
            <Th right>Held for</Th>
          </TableRow>
        </TableHeader>
        <TableBody>
          {trades.map((t) => (
            <TableRow key={t.id} className="hover:bg-transparent">
              <TableCell className="font-mono text-[13px] font-medium">
                <span title={t.reasons.join(" · ")}>{t.underlying}</span>
              </TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={cn("font-normal", t.side === "long" ? "text-up" : "text-down")}
                >
                  {sideWord(t.side)}
                </Badge>
              </TableCell>
              <TableCell>
                <Stamp ms={t.entryTime} />
              </TableCell>
              <TableCell className="text-right font-mono text-[13px] tabular-nums">
                {num(t.entryPrice)}
              </TableCell>
              <TableCell>
                <Stamp ms={t.exitTime} />
              </TableCell>
              <TableCell className="text-right font-mono text-[13px] tabular-nums">
                {num(t.exitPrice)}
              </TableCell>
              <TableCell>
                <ExitBadge reason={t.exitReason} />
              </TableCell>
              <TableCell
                className={cn(
                  "text-right font-mono text-[13px] font-medium tabular-nums",
                  t.rMultiple >= 0
                    ? "text-up"
                    : "text-down"
                )}
              >
                {num(t.rMultiple)}R
              </TableCell>
              <TableCell
                className={cn(
                  "text-right font-mono text-[13px] tabular-nums",
                  t.netPnl >= 0
                    ? "text-up"
                    : "text-down"
                )}
              >
                {rupees(t.netPnl)}
                <div className="text-muted-foreground text-[11px]">after ₹{Math.round(t.costs).toLocaleString("en-IN")} charges</div>
              </TableCell>
              <TableCell
                className="text-muted-foreground text-right font-mono text-[12px] tabular-nums"
                title="How far it went against us / in our favour while open, in R"
              >
                −{num(t.mae, 1)}R / +{num(t.mfe, 1)}R
              </TableCell>
              <TableCell className="text-muted-foreground text-right font-mono text-[12px] tabular-nums">
                {held(t.exitTime - t.entryTime)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
