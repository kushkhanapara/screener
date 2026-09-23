/** Shared number formatting, so every surface renders values identically. */

export const num = (v: number | null | undefined, d = 2) =>
  v != null && Number.isFinite(v) ? v.toFixed(d) : "—"

export const pct = (v: number | null | undefined, d = 0) =>
  v != null && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : "—"

/** Indian digit grouping, with a true minus sign rather than a hyphen. */
export function rupees(v: number | null | undefined, signed = false) {
  if (v == null || !Number.isFinite(v)) return "—"
  const sign = v < 0 ? "−" : signed ? "+" : ""
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`
}

export const rMultiple = (v: number | null | undefined, d = 2) =>
  v != null && Number.isFinite(v) ? `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(d)}R` : "—"

export const clock = (ms: number | string | null | undefined) =>
  ms == null
    ? "—"
    : new Date(ms).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })

export const hhmm = (ms: number | string | null | undefined) =>
  ms == null
    ? "—"
    : new Date(ms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })

export const shortDate = (ms: number | string) =>
  new Date(ms).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })

/**
 * Class for a signed value. `up`/`down` are palette tokens rather than literal
 * greens and reds, so profit-and-loss colouring is defined in exactly one place
 * and stays consistent between themes.
 */
export function toneClass(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v) || v === 0) return "text-flat"
  return v > 0 ? "text-up" : "text-down"
}

/** Same mapping for a side rather than a number. */
export const sideClass = (side: "long" | "short") => (side === "long" ? "text-up" : "text-down")

export const minutesBetween = (a: number, b: number) => Math.max(0, Math.round((b - a) / 60000))
