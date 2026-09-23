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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DailyResultsTable } from "@/components/DailyResultsTable"
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
      const total = res.long.count + res.short.count
      toast.success(`${res.long.count} long · ${res.short.count} short (${total} total)`)
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

  const emptyHint = data ? undefined : 'Click "Run screen" to evaluate the strategy on the cached daily data.'

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
          <CardTitle>End-of-day screen</CardTitle>
          <CardDescription>
            {status
              ? `${status.loaded} of ${status.total} stocks screenable${
                  status.skipped ? ` · ${status.skipped} skipped` : ""
                } · using daily candles`
              : "Checks each stock's daily chart against the screener rules."}
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
          <Tabs defaultValue="long">
            <TabsList>
              <TabsTrigger value="long">Buy setups{data ? ` · ${data.long.count}` : ""}</TabsTrigger>
              <TabsTrigger value="short">Sell setups{data ? ` · ${data.short.count}` : ""}</TabsTrigger>
            </TabsList>
            <TabsContent value="long" className="mt-4">
              <DailyResultsTable
                rows={data?.long.results}
                loading={running}
                error={error}
                emptyHint={emptyHint ?? "No stocks matched the buy rules in the latest daily data."}
              />
            </TabsContent>
            <TabsContent value="short" className="mt-4">
              <DailyResultsTable
                rows={data?.short.results}
                loading={running}
                error={error}
                emptyHint={emptyHint ?? "No stocks matched the sell rules in the latest daily data."}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
