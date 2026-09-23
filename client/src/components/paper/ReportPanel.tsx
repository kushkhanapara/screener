import { useEffect, useState } from "react"
import { CircleCheck, Info, TriangleAlert, Inbox } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { cn } from "@/lib/utils"
import { num, pct, rMultiple, rupees, toneClass } from "@/components/paper/format"
import {
  getPaperReport,
  type ReportBreakdown,
  type ReportFinding,
  type TradeReport,
} from "@/lib/api"

type Window = 7 | 30 | "all"

const WINDOWS: { value: Window; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: "all", label: "All" },
]

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="bg-muted inline-flex rounded-md p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded px-3 py-1 text-[12px] transition-colors",
            o.value === value
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="space-y-0.5" title={hint}>
      <div className="text-muted-foreground text-[12px]">{label}</div>
      <div className={cn("font-mono text-[15px] tabular-nums", tone ?? "text-foreground")}>{value}</div>
    </div>
  )
}

const SEVERITY = {
  warn: { icon: TriangleAlert, className: "text-chart-3", label: "Problem" },
  good: { icon: CircleCheck, className: "text-up", label: "Working" },
  info: { icon: Info, className: "text-muted-foreground", label: "Note" },
} as const

function Finding({ f }: { f: ReportFinding }) {
  const s = SEVERITY[f.severity]
  const Icon = s.icon
  return (
    <li className="flex gap-3 px-4 py-3">
      <Icon className={cn("mt-0.5 size-4 shrink-0", s.className)} aria-label={s.label} />
      <div className="min-w-0 space-y-0.5">
        <div className="text-[13px] font-medium">{f.title}</div>
        <div className="text-muted-foreground text-[12px] leading-relaxed">{f.detail}</div>
      </div>
    </li>
  )
}

function BreakdownTable({
  b,
  minSample,
  flagged,
}: {
  b: ReportBreakdown
  minSample: number
  flagged: Map<string, ReportFinding["severity"]>
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-foreground/80 text-[13px] font-medium">{b.label}</div>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Group</TableHead>
              <TableHead className="text-right">Trades</TableHead>
              <TableHead className="text-right">Win rate</TableHead>
              <TableHead className="text-right">Avg per trade</TableHead>
              <TableHead className="text-right">Total (R)</TableHead>
              <TableHead className="text-right">Profit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {b.rows.map((row) => {
              const thin = row.trades < minSample
              const flag = flagged.get(`${b.key}:${row.bucket}`)
              return (
                <TableRow
                  key={row.bucket}
                  className={cn(
                    "hover:bg-transparent",
                    thin && "opacity-50",
                    flag === "warn" && "bg-chart-3/10",
                    flag === "good" && "bg-up/10"
                  )}
                  title={thin ? `Fewer than ${minSample} trades — too few to judge` : undefined}
                >
                  <TableCell className="font-mono">{row.bucket}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{row.trades}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{pct(row.winRate)}</TableCell>
                  <TableCell className={cn("text-right font-mono tabular-nums", toneClass(row.expectancyR))}>
                    {rMultiple(row.expectancyR)}
                  </TableCell>
                  <TableCell className={cn("text-right font-mono tabular-nums", toneClass(row.totalR))}>
                    {rMultiple(row.totalR, 1)}
                  </TableCell>
                  <TableCell className={cn("text-right font-mono tabular-nums", toneClass(row.netPnl))}>
                    {rupees(row.netPnl, true)}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

/**
 * Trade review for the selected strategy (or all of them): what is working,
 * what is losing, and the entry conditions behind each.
 */
export function ReportPanel({
  strategyId,
  strategyName,
  revision,
}: {
  strategyId: string
  strategyName: string
  revision: number
}) {
  const [days, setDays] = useState<Window>(7)
  const [scope, setScope] = useState<"one" | "all">("one")
  const [report, setReport] = useState<TradeReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setError(null)
    getPaperReport(days, scope === "one" ? strategyId : null)
      .then((r) => active && setReport(r))
      .catch((e) => active && setError((e as Error).message))
    return () => {
      active = false
    }
  }, [days, scope, strategyId, revision])

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented value={days} options={WINDOWS} onChange={setDays} />
      <Segmented
        value={scope}
        options={[
          { value: "one", label: strategyName },
          { value: "all", label: "All strategies" },
        ]}
        onChange={setScope}
      />
    </div>
  )

  if (error) {
    return (
      <div className="space-y-4">
        {controls}
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Couldn't load the review</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    )
  }

  if (!report) {
    return (
      <div className="space-y-4">
        {controls}
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    )
  }

  const s = report.summary
  const c = report.counts
  const flagged = new Map(
    report.findings
      .filter((f) => f.dimension && f.bucket)
      .map((f) => [`${f.dimension}:${f.bucket}`, f.severity] as const)
  )

  return (
    <div className="space-y-5">
      {controls}

      {c.real === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-14">
          <Inbox className="size-6 opacity-60" />
          <p className="text-sm">No completed trades in this window.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4 rounded-xl border p-4 sm:grid-cols-6">
            <Stat label="Trades" value={String(c.real)} />
            <Stat label="Win rate" value={pct(s.winRate)} />
            <Stat
              label="Average per trade"
              value={rMultiple(s.expectancyR)}
              tone={toneClass(s.expectancyR)}
              hint="Average result per trade in R (risk units), after charges"
            />
            <Stat label="Profit / loss" value={rupees(s.netPnl, true)} tone={toneClass(s.netPnl)} />
            <Stat
              label="₹ won per ₹ lost"
              value={s.profitFactor == null ? "no losses" : num(s.profitFactor)}
              hint="Money won on winners divided by money lost on losers. Above 1 is good."
            />
            <Stat label="Charges" value={rupees(s.totalCosts)} />
          </div>

          {c.excludedJunk > 0 && (
            <p className="text-muted-foreground text-[12px]">
              {c.excludedJunk} trades that closed within a minute of opening are left out. They
              barely touched the market and would distort the numbers ({rupees(c.junkCosts)} in
              charges).
            </p>
          )}

          {c.withFeatures < c.real && (
            <Alert>
              <Info />
              <AlertTitle>Entry conditions are recorded from now on</AlertTitle>
              <AlertDescription>
                {c.withFeatures} of {c.real} trades in this window have them. Groupings by momentum,
                price swing, market mood and strength vs Nifty fill in as new trades close. Direction,
                time and how trades ended are available for every trade already.
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <div className="text-muted-foreground text-[11px] tracking-[0.1em] uppercase">
              What stands out
            </div>
            {report.findings.length ? (
              <ul className="divide-border/60 divide-y rounded-xl border">
                {report.findings.map((f, i) => (
                  <Finding key={`${f.title}-${i}`} f={f} />
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">Nothing stands out in this window.</p>
            )}
            <p className="text-muted-foreground text-[11px]">
              These are ideas to test, not rules to follow. Groups with fewer than{" "}
              {report.minSample} trades are never flagged (too few to tell) and are shown greyed out.
            </p>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            {report.breakdowns.map((b) => (
              <BreakdownTable key={b.key} b={b} minSample={report.minSample} flagged={flagged} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
