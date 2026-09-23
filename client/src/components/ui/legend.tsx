import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

export type LegendItem = {
  /** A swatch (Tailwind classes for a small coloured shape) or any small element. */
  swatch?: string
  mark?: ReactNode
  label: ReactNode
  /** Optional one-line meaning, shown after the label. */
  meaning?: ReactNode
}

/** "What do the colours and symbols mean?" — a compact, wrapping key. */
export function Legend({ items, title = "Key", className }: { items: LegendItem[]; title?: string; className?: string }) {
  return (
    <div
      className={cn("text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]", className)}
      role="list"
      aria-label={title}
    >
      <span className="text-foreground/70 font-medium">{title}</span>
      {items.map((it, i) => (
        <span key={i} role="listitem" className="inline-flex items-center gap-1.5">
          {it.mark ?? <span className={cn("inline-block size-2.5 shrink-0 rounded-sm", it.swatch)} aria-hidden />}
          <span className="text-foreground/85">{it.label}</span>
          {it.meaning && <span>{it.meaning}</span>}
        </span>
      ))}
    </div>
  )
}
