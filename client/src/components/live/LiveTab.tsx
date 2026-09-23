import { useMemo } from "react"
import { Radio, Moon, KeyRound } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LiveResultsTable } from "@/components/LiveResultsTable"
import { StrategySection } from "@/components/StrategyCard"
import type { LiveSocketState } from "@/hooks/useLiveSocket"
import type { LiveStatus, Side } from "@/lib/api"
import { cn } from "@/lib/utils"

const clockFmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("en-IN", { hour12: false }) : "—"

/**
 * The socket state is passed in rather than opened here: the app holds a single
 * /ws/live connection shared with the paper view, so this must not create a
 * second one.
 */
export function LiveTab({ live, status }: { live: LiveSocketState; status: LiveStatus | null }) {
  const enteredLong = useMemo(() => new Set(live.enteredLong), [live.enteredLong])
  const enteredShort = useMemo(() => new Set(live.enteredShort), [live.enteredShort])
  const noToken = status ? status.hasToken === false : false
  const marketClosed = status ? !status.marketOpen : false
  const feedLive = Boolean(status?.connected)

  const scoreboard = (side: Side, count: number) => (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-2 py-8">
        <div className="text-muted-foreground flex items-center gap-2 text-xs tracking-[0.15em] uppercase">
          <Radio className={cn("size-4", feedLive && "text-up")} />
          {feedLive ? `${side === "long" ? "buy" : "sell"} setups right now` : "waiting for live prices"}
        </div>
        <div className="font-mono text-6xl font-semibold tabular-nums">{count}</div>
        <div className="text-muted-foreground text-sm">
          stocks matching the {side === "long" ? "buy" : "sell"} rules
          {status?.subscribed ? ` · ${status.subscribed} tracked` : ""}
        </div>
        <div className="text-muted-foreground/70 text-xs">last updated {clockFmt(live.lastUpdated)}</div>
      </CardContent>
    </Card>
  )

  return (
    <div className="space-y-4">
      {/* The screener's own conditions live here, beside the view they
          describe — they are a different question from what the paper engine
          trades, and showing both at the top of the page conflated the two. */}
      <StrategySection />

      {noToken && (
        <Alert>
          <KeyRound />
          <AlertTitle>Upstox token not set</AlertTitle>
          <AlertDescription>
            Set <code className="font-mono">UPSTOX_ANALYTICS_TOKEN</code> on the server to enable
            the live feed.
          </AlertDescription>
        </Alert>
      )}
      {!noToken && marketClosed && (
        <Alert>
          <Moon />
          <AlertTitle>Market closed</AlertTitle>
          <AlertDescription>
            Live prices run during market hours (9:15 AM – 3:30 PM, Mon–Fri). The lists show the last
            result from the session.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="long">
        <TabsList>
          <TabsTrigger value="long">Buy setups · {live.counts.long}</TabsTrigger>
          <TabsTrigger value="short">Sell setups · {live.counts.short}</TabsTrigger>
        </TabsList>

        <TabsContent value="long" className="mt-4 space-y-4">
          {scoreboard("long", live.counts.long)}
          <LiveResultsTable
            scrips={live.scrips}
            side="long"
            enteredSet={enteredLong}
            emptyHint={
              feedLive
                ? "No stocks match the buy rules right now. The list updates as the market moves."
                : "The live list populates once the feed connects during market hours."
            }
          />
        </TabsContent>

        <TabsContent value="short" className="mt-4 space-y-4">
          {scoreboard("short", live.counts.short)}
          <LiveResultsTable
            scrips={live.scrips}
            side="short"
            enteredSet={enteredShort}
            emptyHint={
              feedLive
                ? "No stocks match the sell rules right now. The list updates as the market moves."
                : "The live list populates once the feed connects during market hours."
            }
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
