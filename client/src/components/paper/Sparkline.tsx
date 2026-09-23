import { cn } from "@/lib/utils"

/**
 * Minimal inline SVG equity curve.
 *
 * Deliberately not a charting library: a single line with a zero baseline says
 * everything a cumulative-R curve needs to, and pulling in a chart dependency
 * for it would add weight and visual noise for no gain.
 */
export function Sparkline({
  values,
  className,
  width = 120,
  height = 28,
}: {
  values: number[]
  className?: string
  width?: number
  height?: number
}) {
  if (!values?.length) {
    return <div className={cn("h-7", className)} aria-hidden />
  }

  // Always include zero so the baseline is meaningful and a curve that never
  // goes negative still reads as "above the line".
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const range = max - min || 1

  const x = (i: number) => (values.length === 1 ? width : (i / (values.length - 1)) * width)
  const y = (v: number) => height - ((v - min) / range) * height

  const points = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ")
  const zeroY = y(0)
  const last = values[values.length - 1]
  const positive = last >= 0

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("overflow-visible", className)}
      role="img"
      aria-label={`Equity curve, ending at ${last.toFixed(2)}R`}
    >
      <line
        x1={0}
        x2={width}
        y1={zeroY}
        y2={zeroY}
        className="stroke-border"
        strokeWidth={1}
        strokeDasharray="2 3"
      />
      <polyline
        points={points}
        fill="none"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        className={positive ? "stroke-up" : "stroke-down"}
      />
      {values.length > 1 && (
        <circle
          cx={x(values.length - 1)}
          cy={y(last)}
          r={1.75}
          className={positive ? "fill-up" : "fill-down"}
        />
      )}
    </svg>
  )
}
