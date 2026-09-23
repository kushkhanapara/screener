import { ArrowDownRight, ArrowUpRight, Radio } from "lucide-react"
import { cn } from "@/lib/utils"
import { clock, num, rMultiple, rupees, toneClass } from "@/components/paper/format"
import type { PaperEvent } from "@/lib/api"
import { exitWord, sideWord } from "@/lib/glossary"

/**
 * Newest-first stream of entries and exits.
 *
 * Metrics move slowly; events are legible the instant they happen, which is what
 * makes the screen readable at a glance while the market is open.
 */
export function ActivityFeed({
  events,
  strategyNames,
  live,
  className,
}: {
  events: PaperEvent[]
  strategyNames: Record<string, string>
  live?: boolean
  className?: string
}) {
  return (
    <div className={cn("flex flex-col rounded-xl border", className)}>
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Radio className={cn("size-3.5", live ? "text-up" : "text-muted-foreground/50")} />
        <span className="text-[13px] font-medium">Live activity</span>
        <span className="text-muted-foreground ml-auto text-[11px]">
          {events.length ? `latest ${events.length}` : "nothing yet"}
        </span>
      </div>

      {!events.length ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center px-4 py-10 text-center text-xs">
          {live
            ? "Waiting for the first trade. Every buy, sell and close appears here as it happens."
            : "No activity yet."}
        </div>
      ) : (
        <ul className="divide-border/60 max-h-[520px] divide-y overflow-y-auto">
          {events.map((e) => {
            const isLong = e.side === "long"
            const Icon = isLong ? ArrowUpRight : ArrowDownRight
            return (
              <li
                key={e.id ?? `${e.kind}-${e.underlying}-${e.ts}`}
                className="flex items-start gap-2.5 px-4 py-2"
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    isLong ? "text-up" : "text-down"
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-mono text-[13px] font-medium">{e.underlying}</span>
                    <span className="text-muted-foreground text-[11px]">
                      {e.kind === "open" ? `${sideWord(e.side)} opened` : `closed · ${exitWord(e.exitReason ?? "")}`}
                    </span>
                    <span className="text-muted-foreground/70 ml-auto shrink-0 font-mono text-[11px] tabular-nums">
                      {clock(e.ts)}
                    </span>
                  </div>
                  <div className="text-muted-foreground flex items-baseline gap-1.5 text-[11px]">
                    <span className="font-mono tabular-nums">{num(e.price)}</span>
                    {e.kind === "close" && (
                      <>
                        <span className={cn("font-mono tabular-nums", toneClass(e.rMultiple))}>
                          {rMultiple(e.rMultiple)}
                        </span>
                        <span className={cn("font-mono tabular-nums", toneClass(e.netPnl))}>
                          {rupees(e.netPnl, true)}
                        </span>
                      </>
                    )}
                    <span className="truncate opacity-70">
                      {strategyNames[e.strategyId] ?? e.strategyId}
                    </span>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
