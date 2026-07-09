import { useEffect, useMemo, useState } from "react"
import { Radio, Moon, KeyRound } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ResultsTable } from "@/components/ResultsTable"
import { useLiveSocket } from "@/hooks/useLiveSocket"
import { getLiveStatus, type LiveStatus } from "@/lib/api"
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

  const enteredSet = useMemo(() => new Set(live.entered ?? []), [live.entered])
  const noToken = status ? status.hasToken === false : false
  const marketClosed = status ? !status.marketOpen : false
  const feedLive = Boolean(status?.connected)

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
            The live feed runs during market hours (09:15–15:30 IST, Mon–Fri). The counter shows the
            last computed set.
          </AlertDescription>
        </Alert>
      )}

      {/* Live scoreboard */}
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 py-10">
          <div className="text-muted-foreground flex items-center gap-2 text-xs tracking-[0.15em] uppercase">
            <Radio className={cn("size-4", feedLive && "text-emerald-600")} />
            {feedLive ? "matching now" : "waiting for live feed"}
          </div>
          <div className="font-mono text-7xl font-semibold tabular-nums">{live.count}</div>
          <div className="text-muted-foreground text-sm">
            contracts matching right now
            {status?.subscribed ? ` · ${status.subscribed} tracked` : ""}
          </div>
          <div className="text-muted-foreground/70 text-xs">
            last updated {clockFmt(live.lastUpdated)}
          </div>
        </CardContent>
      </Card>

      <ResultsTable
        rows={live.matching}
        priceLabel="LTP"
        enteredSet={enteredSet}
        emptyHint={
          feedLive
            ? "No contracts match the strategy right now — the list updates as the market moves."
            : "The live list populates once the feed connects during market hours."
        }
      />
    </div>
  )
}
