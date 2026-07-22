import { useEffect, useMemo, useState } from "react"
import { Radio, Moon, KeyRound } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LiveResultsTable } from "@/components/LiveResultsTable"
import { useLiveSocket } from "@/hooks/useLiveSocket"
import { getLiveStatus, type LiveStatus, type Side } from "@/lib/api"
import { cn } from "@/lib/utils"

const clockFmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("en-IN", { hour12: false }) : "—"

export function LiveTab({ onLiveStatus }: { onLiveStatus?: (s: LiveStatus) => void }) {
  const live = useLiveSocket()
  const [status, setStatus] = useState<LiveStatus | null>(null)

  useEffect(() => {
    let active = true
    const tick = () =>
      getLiveStatus()
        .then((s) => {
          if (!active) return
          setStatus(s)
          onLiveStatus?.(s)
        })
        .catch(() => {})
    tick()
    const id = setInterval(tick, 5000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [onLiveStatus])

  const enteredLong = useMemo(() => new Set(live.enteredLong), [live.enteredLong])
  const enteredShort = useMemo(() => new Set(live.enteredShort), [live.enteredShort])
  const noToken = status ? status.hasToken === false : false
  const marketClosed = status ? !status.marketOpen : false
  const feedLive = Boolean(status?.connected)

  const scoreboard = (side: Side, count: number) => (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-2 py-8">
        <div className="text-muted-foreground flex items-center gap-2 text-xs tracking-[0.15em] uppercase">
          <Radio className={cn("size-4", feedLive && "text-emerald-600")} />
          {feedLive ? `matching ${side} now` : "waiting for live feed"}
        </div>
        <div className="font-mono text-6xl font-semibold tabular-nums">{count}</div>
        <div className="text-muted-foreground text-sm">
          scrips matching {side}
          {status?.subscribed ? ` · ${status.subscribed} tracked` : ""}
        </div>
        <div className="text-muted-foreground/70 text-xs">last updated {clockFmt(live.lastUpdated)}</div>
      </CardContent>
    </Card>
  )

  return (
    <div className="space-y-4">
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
            The live feed runs during market hours (09:15–15:30 IST, Mon–Fri). Counts show the last
            computed set.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="long">
        <TabsList>
          <TabsTrigger value="long">Long · {live.counts.long}</TabsTrigger>
          <TabsTrigger value="short">Short · {live.counts.short}</TabsTrigger>
        </TabsList>

        <TabsContent value="long" className="mt-4 space-y-4">
          {scoreboard("long", live.counts.long)}
          <LiveResultsTable
            scrips={live.scrips}
            side="long"
            enteredSet={enteredLong}
            emptyHint={
              feedLive
                ? "No scrips match the Long setup right now — the list updates as the market moves."
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
                ? "No scrips match the Short setup right now — the list updates as the market moves."
                : "The live list populates once the feed connects during market hours."
            }
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
