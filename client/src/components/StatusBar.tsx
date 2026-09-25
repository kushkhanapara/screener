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

function Dot({ tone }: { tone: "on" | "warn" | "err" | "off" }) {
  return (
    <span
      className={cn(
        "inline-block size-1.5 rounded-full",
        tone === "on"
          ? "bg-up"
          : tone === "warn"
            ? "bg-chart-3"
            : tone === "err"
              ? "bg-down"
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
  const fatal = live?.fatal

  // A feed that cannot recover must not keep saying "connecting…" — that reads
  // as progress when nothing is happening.
  const stale = live?.stale
  const liveLabel = fatal
    ? "needs attention"
    : stale
      ? "stalled — prices frozen, reconnecting"
      : live?.repairing
        ? "checking bars against Upstox — no new trades for a few minutes"
        : connected
      ? "connected"
      : marketOpen
        ? "connecting…"
        : "offline"

  return (
    <div className="space-y-1.5">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px]">
        <span className="inline-flex items-center gap-1.5">
          <Dot tone={dailyStatus?.updatedAt ? "on" : "off"} />
          Daily prices{" "}
          <span className="text-foreground/80">
            {dailyStatus?.fetching
              ? `refreshing… ${dailyStatus.fetched}/${dailyStatus.total || "…"}`
              : dailyStatus?.updatedAt ? `updated ${timeFmt(dailyStatus.updatedAt)}` : "not loaded"}
          </span>
        </span>
        <span className="text-border">·</span>
        <span className="inline-flex items-center gap-1.5">
          <Dot tone={fatal || stale ? "err" : connected ? "on" : marketOpen ? "warn" : "off"} />
          Live prices <span className="text-foreground/80">{liveLabel === "offline" ? "off (market closed)" : liveLabel}</span>
        </span>
      </div>
      {fatal && <p className="text-[12px] text-down">{fatal}</p>}
      {!fatal && stale && live?.error && <p className="text-[12px] text-down">{live.error} — no new paper trades until data returns.</p>}
    </div>
  )
}
