import { Activity, Briefcase, CalendarDays, Clock, Receipt, TrendingUp } from "lucide-react"
import { cn } from "@/lib/utils"
import { InfoTip } from "@/components/ui/info-tip"
import { pct, rMultiple, rupees, toneClass, clock } from "@/components/paper/format"
import { TERMS } from "@/lib/glossary"
import type { PaperSnapshot } from "@/lib/api"

function Cell({
  icon: Icon,
  label,
  value,
  sub,
  tone,
  tip,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  sub?: string
  tone?: string
  tip?: string
}) {
  return (
    <div className="flex items-start gap-2.5 px-4 py-3">
      <Icon className="text-muted-foreground/60 mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <div className="text-muted-foreground flex items-center gap-1 text-[12px]">
          {label}
          {tip && <InfoTip label={label}>{tip}</InfoTip>}
        </div>
        <div className={cn("font-mono text-lg tabular-nums", tone ?? "text-foreground")}>{value}</div>
        {sub && <div className="text-muted-foreground truncate text-[12px]">{sub}</div>}
      </div>
    </div>
  )
}

function dayTypeLabel(type: string | undefined) {
  switch (type) {
    case "trend-up":
      return "Trend day ↑"
    case "trend-down":
      return "Trend day ↓"
    case "flat":
      return "Flat day"
    case "unclear":
      return "Unclear"
    case "early":
      return "Too early"
    default:
      return "—"
  }
}

/** All paper strategies together, in one line: is it running, and is it making money? */
export function SummaryStrip({ snapshot, openCount, openPnl }: { snapshot: PaperSnapshot; openCount: number; openPnl: number }) {
  const t = snapshot.totals
  const live = snapshot.running && snapshot.marketOpen

  const state = !snapshot.hasToken
    ? { label: "No Upstox token", tone: "text-down" }
    : !snapshot.marketOpen
      ? { label: "Market closed", tone: "text-muted-foreground" }
      : snapshot.running
        ? { label: "Trading", tone: "text-up" }
        : { label: "Starting…", tone: "text-chart-3" }

  return (
    <div className="divide-border grid grid-cols-2 divide-y rounded-xl border sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-7 [&>*]:border-r-0 sm:[&>*:not(:last-child)]:border-r">
      <Cell
        icon={Activity}
        label="Status"
        value={state.label}
        tone={state.tone}
        sub={live ? `last checked ${clock(snapshot.lastEvalTs)}` : "runs 9:15 AM – 3:30 PM"}
      />
      <Cell
        icon={CalendarDays}
        label="Type of day"
        value={dayTypeLabel(snapshot.dayType?.type)}
        tone={
          snapshot.dayType?.type?.startsWith("trend")
            ? "text-up"
            : snapshot.dayType?.type === "flat"
              ? "text-chart-3"
              : "text-muted-foreground"
        }
        sub={
          snapshot.dayType?.movePct != null
            ? `Nifty ${snapshot.dayType.movePct >= 0 ? "+" : "−"}${Math.abs(snapshot.dayType.movePct).toFixed(2)}% · steadiness ${(snapshot.dayType.efficiency ?? 0).toFixed(2)}`
            : "decided after ~9:45"
        }
        tip={TERMS.dayType}
      />
      <Cell
        icon={Briefcase}
        label="Open trades"
        value={String(openCount)}
        tone={openCount ? undefined : "text-muted-foreground"}
        sub={openCount ? `${rupees(openPnl, true)} open profit` : "none right now"}
        tip={TERMS.openProfit}
      />
      <Cell
        icon={Clock}
        label="Today's profit"
        value={rupees(t.todayNetPnl, true)}
        tone={toneClass(t.todayNetPnl)}
        sub={`${t.todayTrades} closed${t.todayWins != null ? ` · ${t.todayWins} won` : ""} · ${rMultiple(t.todayR, 1)}`}
        tip={`${TERMS.netPnl} Counts trades closed today.`}
      />
      <Cell
        icon={Receipt}
        label="Charges today"
        value={t.todayCosts != null ? rupees(t.todayCosts) : "—"}
        sub={t.totalCosts != null ? `${rupees(t.totalCosts)} all time` : undefined}
        tip={TERMS.charges}
      />
      <Cell
        icon={TrendingUp}
        label="All-time profit"
        value={rupees(t.netPnl, true)}
        tone={toneClass(t.netPnl)}
        sub={`${t.closedTrades} trades · ${rMultiple(t.totalR, 1)}`}
        tip={TERMS.netPnl}
      />
      <Cell
        icon={TrendingUp}
        label="Win rate"
        value={t.closedTrades ? pct(t.winRate) : "—"}
        sub={t.closedTrades ? `of ${t.closedTrades} trades` : "no trades yet"}
        tip={TERMS.winRate}
      />
    </div>
  )
}
