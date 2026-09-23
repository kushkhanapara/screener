import { cn } from "@/lib/utils"

/**
 * Cumulative-R equity curve as inline SVG.
 *
 * Deliberately not a charting library: a filled line against a zero baseline
 * carries everything this needs to say, and a dependency would add weight and
 * visual noise for no gain. The zero line is always included in the domain, so
 * a curve that never goes negative still reads as sitting above the line.
 */
export function EquityCurve({
  values,
  height = 96,
  className,
  label = "Running total (R)",
}: {
  values: number[]
  height?: number
  className?: string
  label?: string
}) {
  if (!values?.length) {
    return (
      <div
        className={cn(
          "text-muted-foreground/70 flex items-center justify-center rounded-lg border border-dashed text-xs",
          className
        )}
        style={{ height }}
      >
        No closed trades yet. The running total starts with the first one
      </div>
    )
  }

  const W = 600 // viewBox units; the SVG scales to its container
  const H = height
  const PAD = 4

  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const range = max - min || 1

  const x = (i: number) => (values.length === 1 ? W : (i / (values.length - 1)) * W)
  const y = (v: number) => PAD + (1 - (v - min) / range) * (H - PAD * 2)

  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")
  const area = `${x(0)},${y(min)} ${line} ${x(values.length - 1)},${y(min)}`
  const zeroY = y(0)
  const last = values[values.length - 1]
  const positive = last >= 0
  const stroke = positive ? "stroke-up" : "stroke-down"
  const fill = positive ? "fill-up/10" : "fill-down/10"

  return (
    <div className={cn("space-y-1", className)}>
      <div className="text-muted-foreground flex items-baseline justify-between text-[12px]">
        <span>{label}</span>
        <span className="font-mono tabular-nums" title="Highest and lowest point of the running total">
          high {max.toFixed(1)}R · low {min.toFixed(1)}R
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: H }}
        role="img"
        aria-label={`${label}, ending at ${last.toFixed(2)}`}
      >
        <line
          x1={0}
          x2={W}
          y1={zeroY}
          y2={zeroY}
          className="stroke-border"
          strokeWidth={1}
          strokeDasharray="3 4"
          vectorEffect="non-scaling-stroke"
        />
        <polygon points={area} className={fill} />
        <polyline
          points={line}
          fill="none"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          className={stroke}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  )
}

/**
 * Per-day realised P&L as small bars. Answers "is this working lately?", which
 * a cumulative curve hides once the total is dominated by early trades.
 */
export function DailyBars({
  days,
  height = 56,
  className,
}: {
  days: { day: string; totalR: number }[]
  height?: number
  className?: string
}) {
  if (!days?.length) return null

  const W = 600
  const H = height
  const peak = Math.max(1, ...days.map((d) => Math.abs(d.totalR)))
  const mid = H / 2
  const slot = W / days.length
  const barW = Math.max(2, Math.min(18, slot * 0.6))

  return (
    <div className={cn("space-y-1", className)}>
      <div className="text-muted-foreground text-[12px]">
        Result by day (R) <span className="opacity-70">· green bar = profitable day, red = losing day</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: H }}
        role="img"
        aria-label="Realised R per day"
      >
        <line
          x1={0}
          x2={W}
          y1={mid}
          y2={mid}
          className="stroke-border"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {days.map((d, i) => {
          const h = (Math.abs(d.totalR) / peak) * (mid - 4)
          const up = d.totalR >= 0
          return (
            <rect
              key={d.day}
              x={i * slot + (slot - barW) / 2}
              y={up ? mid - h : mid}
              width={barW}
              height={Math.max(1, h)}
              className={up ? "fill-up/70" : "fill-down/70"}
            >
              <title>{`${d.day}: ${d.totalR.toFixed(2)}R`}</title>
            </rect>
          )
        })}
      </svg>
    </div>
  )
}
