import { useState } from "react"
import { Play, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ResultsTable } from "@/components/ResultsTable"
import { scan, refresh, getStatus, type DailyStatus, type ScanResult } from "@/lib/api"

export function DailyTab({
  status,
  onStatus,
}: {
  status: DailyStatus | null
  onStatus?: (s: DailyStatus) => void
}) {
  const [data, setData] = useState<ScanResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const noToken = status ? status.hasToken === false : false

  async function runScan() {
    setRunning(true)
    setError(null)
    try {
      const res = await scan()
      setData(res)
      toast.success(`${res.count} matching contract${res.count === 1 ? "" : "s"}`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  async function runRefresh() {
    try {
      await refresh()
      toast.info("Refreshing daily data from Upstox…")
      const poll = setInterval(async () => {
        const s = await getStatus()
        onStatus?.(s)
        if (!s.fetching) {
          clearInterval(poll)
          toast.success(`Loaded ${s.loaded} of ${s.total} (${s.skipped} skipped)`)
        }
      }, 1500)
    } catch (e) {
      toast.error(`Refresh failed: ${(e as Error).message}`)
    }
  }

  return (
    <div className="space-y-4">
      {noToken && (
        <Alert>
          <AlertTitle>Upstox token not set</AlertTitle>
          <AlertDescription>
            Set <code className="font-mono">UPSTOX_ANALYTICS_TOKEN</code> on the server to load
            daily futures data.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Daily snapshot</CardTitle>
          <CardDescription>
            {status
              ? `${status.loaded} of ${status.total} stocks screenable${
                  status.skipped ? ` · ${status.skipped} skipped` : ""
                } · on underlying cash`
              : "Screens each stock's underlying cash equity on daily candles."}
          </CardDescription>
          <CardAction className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={runRefresh}
              disabled={status?.fetching || noToken}
            >
              <RefreshCw className={status?.fetching ? "animate-spin" : ""} />
              Refresh data
            </Button>
            <Button size="sm" onClick={runScan} disabled={running || !status?.loaded}>
              <Play />
              Run screen
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <ResultsTable
            rows={data?.results}
            loading={running}
            error={error}
            priceLabel="Close"
            firstColLabel="Stock"
            lastColLabel="As of"
            emptyHint={
              data
                ? "No stocks matched the strategy in the latest daily data."
                : "Click “Run screen” to evaluate the strategy on the cached daily data."
            }
          />
        </CardContent>
      </Card>
    </div>
  )
}
