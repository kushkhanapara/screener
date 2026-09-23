import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { Sparkline } from "@/components/paper/Sparkline"
import { num, pct, rMultiple, rupees, toneClass } from "@/components/paper/format"
import { TERMS } from "@/lib/glossary"
import type { PaperStrategyState } from "@/lib/api"

/**
 * Compact per-strategy card, used as the selector.
 *
 * Carries only what's needed to choose between strategies at a glance —
 * expectancy, P&L, how many it's holding, and how selective it is. The full
 * metric panel lives below, for whichever one is selected.
 */
export function StrategyPanel({
  strategy,
  selected,
  onSelect,
}: {
  strategy: PaperStrategyState
  selected?: boolean
  onSelect?: () => void
}) {
  const m = strategy.metrics
  const has = m.trades > 0
  const openR = strategy.open.reduce((a, p) => a + (p.unrealisedR ?? 0), 0)
  const cap = strategy.capital ?? {
    capital: 0,
    deployed: 0,
    free: 0,
    utilisation: 0,
    positions: 0,
  }

  return (
    <Card
      onClick={onSelect}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={(e) => {
        if (onSelect && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        "transition-colors",
        onSelect && "cursor-pointer hover:border-foreground/25",
        selected ? "border-foreground/40 bg-muted/30" : "border-border"
      )}
    >
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  "inline-block size-1.5 shrink-0 rounded-full",
                  selected ? "bg-foreground" : "bg-muted-foreground/30"
                )}
              />
              <span className="truncate text-sm font-medium">{strategy.name}</span>
            </div>
            <div className="text-muted-foreground truncate pl-3 text-[11px]">
              {strategy.tagline}
            </div>
          </div>
          <Sparkline values={m.equityCurveR} className="mt-0.5 shrink-0" width={72} height={24} />
        </div>

        <div className="grid grid-cols-4 gap-2 pl-3">
          <Metric
            label="Profit"
            value={has ? rupees(m.netPnl, true) : "—"}
            tone={has ? toneClass(m.netPnl) : undefined}
            title={TERMS.netPnl}
          />
          <Metric
            label="Avg/trade"
            value={has ? rMultiple(m.expectancyR) : "—"}
            tone={has ? toneClass(m.expectancyR) : undefined}
            title={TERMS.avgPerTrade}
          />
          <Metric label="Win rate" value={has ? pct(m.winRate) : "—"} title={TERMS.winRate} />
          <Metric label="Trades" value={String(m.trades)} />
        </div>

        {strategy.today && (
          <div className="flex flex-wrap items-baseline gap-x-2 pl-3 text-[12px]">
            <span className="text-muted-foreground">Today</span>
            <span className={cn("font-mono tabular-nums", toneClass(strategy.today.netPnl))}>
              {strategy.today.trades ? rupees(strategy.today.netPnl, true) : "—"}
            </span>
            <span className="text-muted-foreground">
              {strategy.today.trades} closed · {strategy.today.wins} won · {rupees(strategy.today.costs)} charges
            </span>
          </div>
        )}

        {/* Capital is the binding constraint — a strategy with nothing free
            cannot act on its next signal however good it is. */}
        <div className="space-y-1 pl-3">
          <div className="text-muted-foreground flex items-baseline justify-between text-[10px]">
            <span title={TERMS.capital}>Money in use</span>
            <span className="font-mono tabular-nums">
              {rupees(cap.deployed)} / {rupees(cap.capital)}
            </span>
          </div>
          <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
            <div
              className={cn(
                "h-full rounded-full",
                cap.utilisation > 0.9 ? "bg-chart-3" : "bg-primary/70"
              )}
              style={{ width: `${Math.min(100, cap.utilisation * 100)}%` }}
            />
          </div>
        </div>

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 pl-3 text-[11px]">
          <span className={strategy.open.length ? "text-foreground/80" : undefined}>
            {strategy.open.length} open {strategy.open.length === 1 ? "trade" : "trades"}
          </span>
          {strategy.open.length > 0 && (
            <span className={cn("font-mono tabular-nums", toneClass(openR))}>
              {rMultiple(openR, 1)}
            </span>
          )}
          <span className="text-border">·</span>
          <span title={TERMS.signals} className={m.signalsPerDay > 40 ? "text-chart-3" : undefined}>
            {num(m.signalsPerDay, 0)} setups seen a day
          </span>
        </div>

        {strategy.selection && (
          <div
            className="text-muted-foreground pl-3 text-[11px]"
            title={`Same signal and exits as the original. Takes a trade only when the stock is beating Nifty by at least +${num(strategy.selection.minAlignedRsPct, 1)}% in the trade's direction, and never retries a stock that already lost today. No daily cap — the count follows the market.`}
          >
            Quality filter today:{" "}
            <span className="text-foreground/80 font-mono tabular-nums">{strategy.selection.taken}</span> taken ·{" "}
            <span className="font-mono tabular-nums">{strategy.selection.skippedForQuality}</span> turned away
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Metric({ label, value, tone, title }: { label: string; value: string; tone?: string; title?: string }) {
  return (
    <div title={title}>
      <div className="text-muted-foreground text-[11px]">{label}</div>
      <div className={cn("font-mono text-[13px] tabular-nums", tone)}>{value}</div>
    </div>
  )
}
