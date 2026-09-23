import type { ReactNode } from "react"
import { Info } from "lucide-react"

import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * A small ⓘ that explains the thing next to it. It is a real button, so it can
 * be reached with the keyboard and opens on focus as well as hover.
 */
export function InfoTip({
  label,
  children,
  className,
  side = "top",
}: {
  /** What the tip explains — read by screen readers as the button's name. */
  label: string
  children: ReactNode
  className?: string
  side?: "top" | "bottom" | "left" | "right"
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={`About ${label}`}
        className={cn(
          "text-muted-foreground/70 hover:text-foreground focus-visible:ring-ring/50 inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded-full align-middle outline-none focus-visible:ring-2",
          className
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <Info className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent side={side}>{children}</TooltipContent>
    </Tooltip>
  )
}

/** Inline term with a dotted underline that explains itself on hover or focus. */
export function Term({ children, tip, className }: { children: ReactNode; tip: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} />}
        className={cn(
          "decoration-muted-foreground/50 cursor-help underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-sm",
          className
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}
