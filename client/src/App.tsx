import { useEffect, useState } from "react"
import { LineChart } from "lucide-react"
import { Toaster } from "@/components/ui/sonner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { StatusBar } from "@/components/StatusBar"
import { Disclaimer } from "@/components/Disclaimer"
import { DailyTab } from "@/components/daily/DailyTab"
import { LiveTab } from "@/components/live/LiveTab"
import { PaperTab } from "@/components/paper/PaperTab"
import { ShadowTab } from "@/components/shadow/ShadowTab"
import { useLiveSocket } from "@/hooks/useLiveSocket"
import { PricesContext } from "@/lib/prices"
import { TooltipProvider } from "@/components/ui/tooltip"
import { getStatus, getLiveStatus, type DailyStatus, type LiveStatus } from "@/lib/api"

export default function App() {
  const [dailyStatus, setDailyStatus] = useState<DailyStatus | null>(null)
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null)
  // One socket for the whole app — it carries both the screener feed and the
  // paper-trading snapshot.
  const live = useLiveSocket()

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
        // A 1s poll re-rendered the whole app once a second during a refresh,
        // on top of the socket pushes. 3s still shows progress moving.
        schedule(s.fetching ? 3000 : 8000)
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

  // Polled here rather than inside LiveTab: the StatusBar sits in this header
  // and must keep reporting feed health even when the Live tab isn't mounted.
  useEffect(() => {
    let active = true
    const tick = () =>
      getLiveStatus()
        .then((s) => active && setLiveStatus(s))
        .catch(() => {})
    tick()
    const id = setInterval(tick, 5000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [])

  return (
    <PricesContext.Provider value={live.prices}>
    <TooltipProvider>
    <div className="bg-background min-h-screen">
      <Toaster position="bottom-right" />

      {/* Full-bleed terminal chrome: the header is a fixed bar and the content
          uses the whole viewport width, because this is a monitoring screen —
          a centred column wastes the space the tables need. */}
      <Tabs defaultValue="paper" className="w-full gap-0">
        {/* Opaque, not translucent: a blurred sticky bar has to re-composite
            the content scrolling beneath it on every repaint, and this page
            repaints constantly. */}
        <header className="bg-card sticky top-0 z-30 border-b">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 sm:px-6">
            <div className="flex items-center gap-2.5">
              <div className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md">
                <LineChart className="size-4" />
              </div>
              <h1 className="text-[15px] leading-none font-semibold tracking-tight">
                NSE Futures Terminal
              </h1>
            </div>

            <TabsList className="h-8 p-0.5">
              <TabsTrigger value="paper" className="px-4 text-[13px] font-medium">
                Paper
              </TabsTrigger>
              <TabsTrigger value="shadow" className="px-4 text-[13px] font-medium">
                Shadow
              </TabsTrigger>
              <TabsTrigger value="live" className="px-4 text-[13px] font-medium">
                Live
              </TabsTrigger>
              <TabsTrigger value="daily" className="px-4 text-[13px] font-medium">
                End of day
              </TabsTrigger>
            </TabsList>

            <div className="ml-auto">
              <StatusBar dailyStatus={dailyStatus} live={liveStatus} />
            </div>
          </div>
        </header>

        <div className="w-full px-4 py-4 sm:px-6">
          <TabsContent value="paper" className="mt-0">
            <PaperTab snapshot={live.paper} />
          </TabsContent>
          <TabsContent value="shadow" className="mt-0">
            <ShadowTab />
          </TabsContent>
          <TabsContent value="live" className="mt-0">
            <LiveTab live={live} status={liveStatus} />
          </TabsContent>
          <TabsContent value="daily" className="mt-0">
            <DailyTab status={dailyStatus} onStatus={setDailyStatus} />
          </TabsContent>

          <footer className="mt-8 border-t pt-4">
            <Disclaimer />
          </footer>
        </div>
      </Tabs>
    </div>
    </TooltipProvider>
    </PricesContext.Provider>
  )
}
