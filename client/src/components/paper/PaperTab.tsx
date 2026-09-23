import { useEffect, useMemo, useState } from "react"
import { KeyRound, Moon, TriangleAlert } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import { SummaryStrip } from "@/components/paper/SummaryStrip"
import { StrategyPanel } from "@/components/paper/StrategyPanel"
import { MetricsGrid } from "@/components/paper/MetricsGrid"
import { EquityCurve, DailyBars } from "@/components/paper/EquityCurve"
import { ActivityFeed } from "@/components/paper/ActivityFeed"
import { PositionsTable } from "@/components/paper/PositionsTable"
import { SignalsTable } from "@/components/paper/SignalsTable"
import { TradesTable } from "@/components/paper/TradesTable"
import { ReportPanel } from "@/components/paper/ReportPanel"
import { PaperGuide } from "@/components/paper/PaperGuide"
import { StrategyRules } from "@/components/paper/StrategyRules"
import { CompareSelective } from "@/components/paper/CompareSelective"
import { MultiDayBook } from "@/components/paper/MultiDayBook"
import { InfoTip } from "@/components/ui/info-tip"
import { getPaperTrades, type PaperSnapshot, type PaperStrategyState, type PaperTrade } from "@/lib/api"
import { markToMarket, usePrices } from "@/lib/prices"

/**
 * Auto paper-trading view.
 *
 * Every strategy runs on the same live data through the same exit engine, so
 * differences between them isolate the entry logic — which is the only thing
 * that varies.
 */
export function PaperTab({ snapshot }: { snapshot: PaperSnapshot | null }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [trades, setTrades] = useState<PaperTrade[]>([])
  // Only true before the FIRST load. Flipping it on every refetch replaced the
  // table with skeletons for a frame each time, which reads as flicker.
  const [everLoaded, setEverLoaded] = useState(false)
  const prices = usePrices()

  const strategies = useMemo(() => snapshot?.strategies ?? [], [snapshot])

  useEffect(() => {
    if (!selected && strategies.length) setSelected(strategies[0].id)
  }, [strategies, selected])

  // Closed trades are paginated history rather than live state, so they are
  // fetched instead of pushed — refreshed only when a position actually opened
  // or closed, not on every heartbeat.
  const revision = snapshot?.revision ?? 0
  useEffect(() => {
    if (!selected) return
    let active = true
    getPaperTrades(selected, 200)
      .then((t) => active && setTrades(t))
      .catch(() => active && setTrades([]))
      .finally(() => active && setEverLoaded(true))
    return () => {
      active = false
    }
  }, [selected, revision])

  const strategyNames = useMemo(
    () => Object.fromEntries(strategies.map((s) => [s.id, s.name])),
    [strategies]
  )

  const currentId = strategies.find((s) => s.id === selected)?.id ?? strategies[0]?.id
  const currentNow = strategies.find((s) => s.id === currentId)

  /*
   * Panels below are pure functions of the trade history, which only changes
   * when `revision` does. The socket pushes every few seconds and JSON parsing
   * hands back brand-new objects each time, so without this every table and
   * chart re-rendered on every heartbeat — that repaint is the flicker.
   *
   * Keying the memo on `revision` deliberately holds the previous elements
   * while nothing has changed; the values inside are identical, so the stale
   * closure is the point rather than a bug.
   */
  /* eslint-disable react-hooks/exhaustive-deps */
  const metricsPanel = useMemo(
    () =>
      currentNow ? (
        <>
          <MetricsGrid m={currentNow.metrics} />
          <Separator />
          <div className="grid gap-5 sm:grid-cols-2">
            <EquityCurve values={currentNow.metrics.equityCurveR} />
            <DailyBars days={currentNow.dailyPnl} />
          </div>
        </>
      ) : null,
    [revision, currentId]
  )

  const picksPanel = useMemo(
    () => (currentNow ? <SignalsTable signals={currentNow.recentSignals} /> : null),
    [revision, currentId]
  )

  const historyPanel = useMemo(
    () => <TradesTable trades={trades} loading={!everLoaded} />,
    [trades, everLoaded]
  )
  /* eslint-enable react-hooks/exhaustive-deps */

  if (!snapshot) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full rounded-xl" />
        <div className="grid gap-3 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-36 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    )
  }

  const current = strategies.find((s) => s.id === selected) ?? strategies[0]
  const live = snapshot.running && snapshot.marketOpen
  const markOpen = (s: PaperStrategyState) => ({ ...s, open: s.open.map((p) => markToMarket(p, prices)) })
  const marked = strategies.map(markOpen)
  const openCount = marked.reduce((a, s) => a + s.open.length, 0)
  const openPnl = marked.reduce((a, s) => a + s.open.reduce((b, p) => b + (p.unrealisedPnl ?? 0), 0), 0)
  const originals = marked.filter((s) => !s.selection)
  const selectives = marked.filter((s) => s.selection)
  const currentMarked = marked.find((s) => s.id === current?.id)

  const cards = (list: PaperStrategyState[]) => (
    <div className="grid gap-3 md:grid-cols-3">
      {list.map((s) => (
        <StrategyPanel key={s.id} strategy={s} selected={s.id === current?.id} onSelect={() => setSelected(s.id)} />
      ))}
    </div>
  )

  return (
    <div className="space-y-5">
      {!snapshot.hasToken && (
        <Alert>
          <KeyRound />
          <AlertTitle>Upstox token not set</AlertTitle>
          <AlertDescription>
            Set <code className="font-mono">UPSTOX_ANALYTICS_TOKEN</code> on the server to run the
            paper engine.
          </AlertDescription>
        </Alert>
      )}

      {snapshot.hasToken && !snapshot.marketOpen && (
        <Alert>
          <Moon />
          <AlertTitle>Market closed</AlertTitle>
          <AlertDescription>
            Paper trading runs from 9:15 AM to 3:30 PM and closes every trade by 3:15 PM. Everything
            below is from earlier sessions.
          </AlertDescription>
        </Alert>
      )}

      {snapshot.error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Something went wrong in the trading engine</AlertTitle>
          <AlertDescription>{snapshot.error}</AlertDescription>
        </Alert>
      )}

      <PaperGuide capital={snapshot.capitalPerStrategy ?? 200_000} />

      <SummaryStrip snapshot={snapshot} openCount={openCount} openPnl={openPnl} />

      <section className="space-y-2">
        <h2 className="text-[15px] font-semibold tracking-tight">Strategies</h2>
        <p className="text-muted-foreground text-[13px]">Click a card to see its details, rules and trades below.</p>
        {cards(originals)}
      </section>

      {selectives.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-1.5 text-[15px] font-semibold tracking-tight">
            Selective versions
            <InfoTip label="Selective versions">
              Same rules and stops as the strategy above them, plus a quality filter that only lets through setups
              clearly stronger than Nifty. Each has its own pretend money, so the two can be compared fairly.
            </InfoTip>
          </h2>
          <p className="text-muted-foreground text-[13px]">
            Same setups as the originals, but choosier. Fewer trades — the question is whether they're better ones.
          </p>
          {cards(selectives)}
        </section>
      )}

      {selectives.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[15px] font-semibold tracking-tight">Original vs Selective</h2>
          <p className="text-muted-foreground text-[13px]">
            Each original next to its Selective twin. If the Selective row keeps a better average per trade with
            fewer trades and lower charges, the quality filter is working.
          </p>
          <CompareSelective strategies={marked} />
        </section>
      )}

      {current && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-5">
            <Card>
              <CardContent className="space-y-5 py-5">
                <div>
                  <h3 className="text-[15px] font-semibold">{current.name}</h3>
                  <p className="text-muted-foreground text-[13px]">Results so far, after all charges</p>
                </div>

                {metricsPanel}
              </CardContent>
            </Card>

            <Tabs defaultValue="open">
              <TabsList className="flex-wrap">
                <TabsTrigger value="open">Open trades · {current.open.length}</TabsTrigger>
                <TabsTrigger value="rules">How it trades</TabsTrigger>
                <TabsTrigger value="picks">Setups seen · {current.recentSignals.length}</TabsTrigger>
                <TabsTrigger value="history">Closed trades · {current.metrics.trades}</TabsTrigger>
                <TabsTrigger value="review">What's working</TabsTrigger>
              </TabsList>

              <TabsContent value="open" className="mt-4">
                <PositionsTable positions={currentMarked?.open ?? []} targetR={current.exits?.targetR} />
              </TabsContent>

              <TabsContent value="rules" className="mt-4">
                <StrategyRules strategy={current} />
              </TabsContent>

              <TabsContent value="picks" className="mt-4">
                {picksPanel}
              </TabsContent>

              <TabsContent value="history" className="mt-4">
                {historyPanel}
              </TabsContent>

              <TabsContent value="review" className="mt-4">
                <ReportPanel
                  strategyId={current.id}
                  strategyName={current.name}
                  revision={revision}
                />
              </TabsContent>
            </Tabs>
          </div>

          <ActivityFeed
            events={snapshot.activity}
            strategyNames={strategyNames}
            live={live}
            className="h-fit lg:sticky lg:top-4"
          />
        </div>
      )}

      <MultiDayBook />
    </div>
  )
}
