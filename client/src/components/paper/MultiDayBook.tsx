import { useEffect, useMemo, useState } from "react"
import { CalendarRange, CircleCheck, CircleSlash, Clock, Wallet } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { InfoTip } from "@/components/ui/info-tip"
import { PositionsTable } from "@/components/paper/PositionsTable"
import { TradesTable } from "@/components/paper/TradesTable"
import { pct, rMultiple, rupees, toneClass, clock } from "@/components/paper/format"
import { getSwingSnapshot, type SwingCandidate, type SwingSnapshot } from "@/lib/api"
import { markToMarket, usePrices } from "@/lib/prices"
import { skipWord } from "@/lib/glossary"

function Tile({ label, value, sub, tone, tip }: { label: string; value: string; sub?: string; tone?: string; tip?: string }) {
  return (
    <div className="px-4 py-3">
      <div className="text-muted-foreground flex items-center gap-1 text-[12px]">
        {label}
        {tip && <InfoTip label={label}>{tip}</InfoTip>}
      </div>
      <div className={cn("font-mono text-lg tabular-nums", tone ?? "text-foreground")}>{value}</div>
      {sub && <div className="text-muted-foreground truncate text-[12px]">{sub}</div>}
    </div>
  )
}

function statusBadge(c: SwingCandidate) {
  if (c.status === "taken") return <Badge variant="secondary" className="text-up gap-1"><CircleCheck className="size-3" />Bought</Badge>
  if (c.status === "skipped") return <Badge variant="outline" className="text-muted-foreground gap-1"><CircleSlash className="size-3" />Skipped</Badge>
  if (c.status === "done") return <Badge variant="outline">Decided earlier</Badge>
  return <Badge variant="outline" className="gap-1"><Clock className="size-3" />Waiting for open</Badge>
}

/**
 * The multi-day paper book. Its money, positions and results are its own and are
 * never added into the intraday totals above: an overnight position would blur
 * what "today" means for the day-traders.
 */
export function MultiDayBook() {
  const [snap, setSnap] = useState<SwingSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  const prices = usePrices()

  useEffect(() => {
    let alive = true
    const load = () =>
      getSwingSnapshot()
        .then((s) => alive && (setSnap(s), setFailed(false)))
        .catch(() => alive && setFailed(true))
    load()
    const t = setInterval(load, 15_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const positions = useMemo(() => (snap ? snap.positions.map((p) => markToMarket(p, prices)) : []), [snap, prices])
  if (!snap) {
    return failed ? <p className="text-muted-foreground text-sm">Multi-day book unavailable.</p> : null
  }

  const openPnl = positions.reduce((a, p) => a + (p.unrealisedPnl ?? 0), 0)
  const m = snap.metrics
  const plan = snap.plan
  const book = snap.book

  return (
    <Card>
      <CardContent className="space-y-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <CalendarRange className="text-muted-foreground size-4" />
              <h2 className="text-base font-semibold">{book.name}</h2>
              <Badge variant="outline">Paper · multi-day</Badge>
            </div>
            <p className="text-muted-foreground max-w-3xl text-sm">{book.plain.summary}</p>
            <p className="text-muted-foreground text-[12px]">
              Its own {rupees(book.capital)} and its own results — not added to the intraday totals above. On trial: it made
              money in 2021–24 but lost over the last two years, so these paper trades are the real test.
            </p>
          </div>
        </div>

        {snap.error && <p className="text-down text-sm">Problem in the multi-day book: {snap.error}</p>}

        <div className="divide-border grid grid-cols-2 divide-y rounded-xl border sm:grid-cols-4 sm:divide-y-0 sm:[&>*:not(:last-child)]:border-r">
          <Tile
            label="Money in use"
            value={rupees(snap.capital.deployed)}
            sub={`${positions.length} of ${book.maxOpen} open · ${rupees(snap.capital.free)} free`}
            tip="Margin blocked by open positions. New buys are skipped when there isn't enough left for one more lot."
          />
          <Tile
            label="Open trades now"
            value={rupees(openPnl, true)}
            tone={toneClass(openPnl)}
            sub="Profit or loss if all were closed now"
          />
          <Tile
            label="Closed trades"
            value={rupees(m.netPnl, true)}
            tone={toneClass(m.netPnl)}
            sub={m.trades ? `${m.trades} trades · ${pct(m.winRate)} winners` : "None yet"}
            tip="After charges. Rolled trades count once per futures contract."
          />
          <Tile
            label="Average per trade"
            value={m.trades ? rMultiple(m.expectancyR) : "—"}
            tone={toneClass(m.expectancyR)}
            sub="R = profit ÷ the amount risked"
            tip="Above +0.1R after 40 or more trades would suggest a real edge. The replay found +0.29R in rising markets."
          />
        </div>

        <Tabs defaultValue="today">
          <TabsList className="flex-wrap">
            <TabsTrigger value="today">Today's buy list · {plan?.candidates.length ?? 0}</TabsTrigger>
            <TabsTrigger value="open">Open trades · {positions.length}</TabsTrigger>
            <TabsTrigger value="history">Closed trades · {m.trades}</TabsTrigger>
            <TabsTrigger value="rules">How it trades</TabsTrigger>
          </TabsList>

          <TabsContent value="today" className="mt-4 space-y-3">
            {!plan ? (
              <p className="text-muted-foreground text-sm">
                The buy list is made each trading morning from 9:00 AM, from the previous day's daily candles.
              </p>
            ) : (
              <>
                <p className="text-muted-foreground text-sm">
                  From the {plan.signalDate} close, checked at {clock(plan.builtAt)}. Nifty {plan.niftyClose.toFixed(0)} is{" "}
                  <span className={plan.niftyUp ? "text-up" : "text-down"}>
                    {plan.niftyUp ? "above" : "below"} its 50-day average ({plan.niftyAvg50.toFixed(0)})
                  </span>
                  {plan.niftyUp ? " — new buys allowed." : " — no new buys today; open trades keep running."}
                </p>
                {plan.candidates.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No stock met the rules yesterday.</p>
                ) : (
                  <ul className="divide-y rounded-xl border">
                    {plan.candidates.map((c) => (
                      <li key={c.underlying} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                        <span className="font-medium">{c.underlying}</span>
                        <span className="text-muted-foreground font-mono text-[12px]">RSI {c.rsi?.toFixed(0) ?? "—"}</span>
                        <span className="flex items-center gap-2">
                          {c.skipReason && <span className="text-muted-foreground text-[12px]">{skipWord(c.skipReason)}</span>}
                          {statusBadge(c)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="open" className="mt-4">
            <PositionsTable positions={positions} />
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            <TradesTable trades={snap.trades} />
          </TabsContent>

          <TabsContent value="rules" className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                <Wallet className="size-4" /> When it buys
              </h3>
              <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
                {book.plain.buy.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium">When it sells</h3>
              <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
                {book.plain.exits.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
