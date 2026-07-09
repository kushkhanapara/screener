import { cn } from "@/lib/utils"
import type { DailyStatus, LiveStatus } from "@/lib/api"

const timeFmt = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—"

function Dot({ tone }: { tone: "on" | "warn" | "off" }) {
  return (
    <span
      className={cn(
        "inline-block size-1.5 rounded-full",
        tone === "on"
          ? "bg-emerald-500"
          : tone === "warn"
            ? "bg-amber-500"
            : "bg-muted-foreground/40"
      )}
    />
  )
}

/** Quiet one-line status: daily freshness + live connection. */
export function StatusBar({
  dailyStatus,
  live,
}: {
  dailyStatus: DailyStatus | null
  live: LiveStatus | null
}) {
  const connected = live?.connected
  const marketOpen = live?.marketOpen
  const liveLabel = connected ? "connected" : marketOpen ? "connecting…" : "offline"

  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px]">
      <span className="inline-flex items-center gap-1.5">
        <Dot tone={dailyStatus?.updatedAt ? "on" : "off"} />
        Daily data{" "}
        <span className="text-foreground/80">
          {dailyStatus?.fetching ? "refreshing…" : timeFmt(dailyStatus?.updatedAt)}
        </span>
      </span>
      <span className="text-border">·</span>
      <span className="inline-flex items-center gap-1.5">
        <Dot tone={connected ? "on" : marketOpen ? "warn" : "off"} />
        Live feed <span className="text-foreground/80">{liveLabel}</span>
      </span>
    </div>
  )
}
