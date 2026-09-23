import { CircleCheck, DoorOpen, Filter } from "lucide-react"
import { num } from "@/components/paper/format"
import { exitRulesInWords } from "@/lib/glossary"
import type { PaperStrategyState } from "@/lib/api"

function RuleList({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[13px] font-medium">{title}</div>
      <ul className="space-y-1">
        {items.map((r) => (
          <li key={r} className="flex items-start gap-2 text-[13px] leading-snug">
            <CircleCheck className={`mt-0.5 size-3.5 shrink-0 ${tone}`} aria-hidden />
            <span className="text-foreground/85">{r}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The selected strategy's rules in everyday words: when it enters, and how it gets out. */
export function StrategyRules({ strategy }: { strategy: PaperStrategyState }) {
  const plain = strategy.plain
  const exits = exitRulesInWords(strategy.exits)
  const extra = [
    ...(strategy.regimeFilter ? ["Skips buys while Nifty is falling, and sells while Nifty is rising."] : []),
    "One trade per stock at a time; it can hold several different stocks if money is free.",
  ]

  return (
    <div className="space-y-4">
      {plain?.summary && <p className="text-[14px]">{plain.summary}</p>}
      <p className="text-[13px]">
        <span className="text-muted-foreground">Trades on: </span>
        <span className="font-medium">
          {strategy.dayTypes?.includes("flat")
            ? "flat days only"
            : strategy.dayTypes?.includes("trend")
              ? "trend days only, in Nifty's direction"
              : "any day"}
        </span>
      </p>

      {plain && (
        <div className="grid gap-4 md:grid-cols-2">
          <RuleList title="Buys when all of these are true" items={plain.buy} tone="text-up" />
          <RuleList title="Sells when all of these are true" items={plain.sell} tone="text-down" />
        </div>
      )}

      {strategy.selection && (
        <div className="bg-primary/5 space-y-1.5 rounded-lg border px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[13px] font-medium">
            <Filter className="size-3.5" aria-hidden /> Extra quality filter (Selective version)
          </div>
          <ul className="text-foreground/85 list-disc space-y-0.5 pl-5 text-[13px]">
            <li>
              Only takes a trade when the stock is beating Nifty by at least +{num(strategy.selection.minAlignedRsPct, 1)}% in
              the trade's direction since the open (for a sell, falling that much more than Nifty).
            </li>
            <li>Never tries the same stock again on a day it already lost on it.</li>
            <li>No limit on trades per day — the number follows how many setups pass the filter.</li>
          </ul>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-[13px] font-medium">
          <DoorOpen className="size-3.5" aria-hidden /> How it gets out of a trade
        </div>
        <ol className="text-foreground/85 list-decimal space-y-0.5 pl-5 text-[13px]">
          {exits.map((r) => (
            <li key={r}>{r}</li>
          ))}
          {extra.map((r) => (
            <li key={r} className="list-none -ml-5 text-muted-foreground">
              {r}
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
