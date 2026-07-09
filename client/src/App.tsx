import { useEffect, useState } from "react"
import { LineChart } from "lucide-react"
import { Toaster } from "@/components/ui/sonner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import { StatusBar } from "@/components/StatusBar"
import { StrategySection } from "@/components/StrategyCard"
import { Disclaimer } from "@/components/Disclaimer"
import { DailyTab } from "@/components/daily/DailyTab"
import { LiveTab } from "@/components/live/LiveTab"
import { getStatus, type DailyStatus, type LiveStatus } from "@/lib/api"

export default function App() {
  const [dailyStatus, setDailyStatus] = useState<DailyStatus | null>(null)
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null)

  useEffect(() => {
    const tick = () => getStatus().then(setDailyStatus).catch(() => {})
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="min-h-screen">
      <Toaster position="bottom-right" />
      <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14">
        <header className="space-y-5">
          <div className="flex items-center gap-3">
            <div className="bg-primary text-primary-foreground flex size-10 items-center justify-center rounded-xl">
              <LineChart className="size-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">NSE Stock-Futures Screener</h1>
              <p className="text-muted-foreground text-sm">
                One fixed technical strategy across single-stock futures — live intraday &amp; daily.
              </p>
            </div>
          </div>
          <StatusBar dailyStatus={dailyStatus} live={liveStatus} />
        </header>

        <Separator className="my-8" />

        <StrategySection />

        <div className="mt-8">
          <Tabs defaultValue="live">
            <TabsList>
              <TabsTrigger value="live">Live</TabsTrigger>
              <TabsTrigger value="daily">End of day</TabsTrigger>
            </TabsList>
            <TabsContent value="live" className="mt-6">
              <LiveTab onLiveStatus={setLiveStatus} />
            </TabsContent>
            <TabsContent value="daily" className="mt-6">
              <DailyTab status={dailyStatus} onStatus={setDailyStatus} />
            </TabsContent>
          </Tabs>
        </div>

        <footer className="mt-12">
          <Disclaimer />
        </footer>
      </div>
    </div>
  )
}
