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
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const schedule = (ms: number) => {
      timer = setTimeout(tick, ms)
    }
    async function tick() {
      try {
        const s = await getStatus()
        if (!active) return
        setDailyStatus(s)
        schedule(s.fetching ? 1000 : 5000) // poll faster while refreshing so the count moves
      } catch {
        if (active) schedule(5000)
      }
    }
    tick()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [])

  return (
    <div className="min-h-screen">
      <Toaster position="bottom-right" />
      <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
        <header className="space-y-5">
          <div className="flex items-center gap-3">
            <div className="bg-primary text-primary-foreground flex size-10 items-center justify-center rounded-xl">
              <LineChart className="size-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">NSE Stock-Futures Screener</h1>
              <p className="text-muted-foreground text-sm">
                Long &amp; Short technical screen on the equity chart — live 3m/15m &amp; daily.
              </p>
            </div>
          </div>
          <StatusBar dailyStatus={dailyStatus} live={liveStatus} />
        </header>

        <Separator className="my-8" />

        <StrategySection />

        <div className="mt-8">
          <Tabs defaultValue="live" className="w-full">
            <TabsList className="mx-auto h-10! p-1">
              <TabsTrigger value="live" className="px-6 font-medium">
                Live
              </TabsTrigger>
              <TabsTrigger value="daily" className="px-6 font-medium">
                End of day
              </TabsTrigger>
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
