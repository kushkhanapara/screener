import { Separator } from "@/components/ui/separator"
import { InfoTip } from "@/components/ui/info-tip"
import { cn } from "@/lib/utils"
import { num, pct, rupees, rMultiple, toneClass } from "@/components/paper/format"
import { EXIT, TERMS } from "@/lib/glossary"
import type { ExitReason, PaperMetrics } from "@/lib/api"

/** Label above value, with an optional explanation one hover away. */
function Stat({
  label,
  value,
  tone,
  tip,
  sub,
  emphasis,
}: {
  label: string
  value: string
  tone?: string
  tip?: string
  sub?: string
  emphasis?: boolean
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-muted-foreground flex items-center gap-1 text-[12px] leading-tight">
        {label}
        {tip && <InfoTip label={label}>{tip}</InfoTip>}
      </div>
      <div className={cn("font-mono tabular-nums", emphasis ? "text-lg" : "text-[15px]", tone ?? "text-foreground")}>
        {value}
      </div>
      {sub && <div className="text-muted-foreground text-[11px]">{sub}</div>}
    </div>
  )
}

const EXIT_ORDER: ExitReason[] = ["target", "trail", "breakeven", "proveit", "time", "squareoff", "stop"]
const EXIT_COLOUR: Record<ExitReason, string> = {
  target: "bg-up",
  trail: "bg-up/60",
  breakeven: "bg-muted-foreground/50",
  proveit: "bg-chart-3/80",
  time: "bg-chart-3/50",
  squareoff: "bg-chart-2/60",
  stop: "bg-down/70",
}

/** Where this strategy's trades actually end, with a colour key that explains each ending. */
function ExitMix({ byExitReason, total }: { byExitReason: PaperMetrics["byExitReason"]; total: number }) {
  const entries = EXIT_ORDER.filter((r) => byExitReason?.[r]).map((r) => [r, byExitReason[r] as number] as const)
  if (!entries.length || !total) return null

  return (
    <div className="space-y-2">
      <div className="text-muted-foreground flex items-center gap-1 text-[12px]">
        How trades ended
        <InfoTip label="how trades ended">Each colour is one way a trade can close. Hover a name for what it means.</InfoTip>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full" aria-hidden>
        {entries.map(([reason, n]) => (
          <div key={reason} className={EXIT_COLOUR[reason]} style={{ width: `${(n / total) * 100}%` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
        {entries.map(([reason, n]) => (
          <span key={reason} className="inline-flex items-center gap-1.5">
            <span className={cn("inline-block size-2.5 rounded-sm", EXIT_COLOUR[reason])} aria-hidden />
            <span className="text-foreground/85">{EXIT[reason].label}</span>
            <span className="text-muted-foreground font-mono tabular-nums">
              {n} ({Math.round((n / total) * 100)}%)
            </span>
            <InfoTip label={EXIT[reason].label}>{EXIT[reason].why}</InfoTip>
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Full results panel for one strategy.
 *
 * "Average per trade" leads because it is the one number that answers "does
 * this make money?" — everything else helps decide whether to believe it.
 */
export function MetricsGrid({ m }: { m: PaperMetrics }) {
  const has = m.trades > 0

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat
          label="Average per trade"
          value={has ? rMultiple(m.expectancyR) : "—"}
          tone={has ? toneClass(m.expectancyR) : undefined}
          tip={TERMS.avgPerTrade}
          sub="in R, after charges"
          emphasis
        />
        <Stat
          label="Profit / loss"
          value={has ? rupees(m.netPnl, true) : "—"}
          tone={has ? toneClass(m.netPnl) : undefined}
          tip={TERMS.netPnl}
          sub="after charges"
          emphasis
        />
        <Stat
          label="Total result"
          value={has ? rMultiple(m.totalR, 1) : "—"}
          tone={has ? toneClass(m.totalR) : undefined}
          tip={`${TERMS.totalR} ${TERMS.r}`}
          sub="in R"
          emphasis
        />
        <Stat
          label="Win rate"
          value={has ? pct(m.winRate) : "—"}
          tip={TERMS.winRate}
          sub={has ? `${m.wins} won · ${m.losses} lost` : undefined}
          emphasis
        />
      </div>

      <Separator />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Trades" value={String(m.trades)} sub={has ? `${num(m.tradesPerDay, 1)} a day` : undefined} />
        <Stat
          label="₹ won per ₹ lost"
          value={has ? (Number.isFinite(m.profitFactor) ? num(m.profitFactor) : "no losses") : "—"}
          tip={TERMS.profitFactor}
        />
        <Stat label="Biggest drop" value={has ? rMultiple(m.maxDrawdownR, 1) : "—"} tip={TERMS.biggestDrop} />
        <Stat
          label="Average win"
          value={has ? rMultiple(m.avgWinR) : "—"}
          tone={has ? toneClass(m.avgWinR) : undefined}
          tip="Average result of the winning trades, in R."
        />
        <Stat
          label="Average loss"
          value={has ? rMultiple(m.avgLossR) : "—"}
          tone={has ? toneClass(m.avgLossR) : undefined}
          tip="Average result of the losing trades, in R. Worse than −1R means charges and slippage add to the stop loss."
        />
        <Stat label="Charges paid" value={has ? rupees(m.totalCosts) : "—"} tip={TERMS.charges} />
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Setups seen a day" value={num(m.signalsPerDay, 1)} tip={TERMS.signals} />
        <Stat label="Average time held" value={has ? `${num(m.avgHoldMinutes, 0)} min` : "—"} tip={TERMS.avgHold} />
        <Stat label="Average worst dip" value={has ? rMultiple(m.avgMae) : "—"} tip={TERMS.worstDip} />
        <Stat label="Average best run" value={has ? rMultiple(m.avgMfe) : "—"} tip={TERMS.bestRun} />
        <Stat label="Steadiness" value={has ? num(m.sharpe) : "—"} tip={TERMS.steadiness} />
        <Stat
          label="Buy vs sell"
          value={has ? `${m.bySide.long.trades} / ${m.bySide.short.trades}` : "—"}
          tip={TERMS.buySell}
          sub={
            has
              ? `buys ${rMultiple(m.bySide.long.totalR, 1)} · sells ${rMultiple(m.bySide.short.totalR, 1)}`
              : undefined
          }
        />
      </div>

      <ExitMix byExitReason={m.byExitReason} total={m.trades} />
    </div>
  )
}
