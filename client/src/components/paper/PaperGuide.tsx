import { useState } from "react"
import { BookOpen, ChevronDown, TrendingDown, TrendingUp } from "lucide-react"
import { Legend } from "@/components/ui/legend"
import { InfoTip } from "@/components/ui/info-tip"
import { cn } from "@/lib/utils"
import { rupees } from "@/components/paper/format"
import { TERMS } from "@/lib/glossary"

const KEY = "paper.guide.collapsed"

function readCollapsed() {
  try {
    return localStorage.getItem(KEY) === "1"
  } catch {
    return false
  }
}

/** What this page is, in four lines, plus the colour and word key used everywhere below. */
export function PaperGuide({ capital }: { capital: number }) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    try {
      localStorage.setItem(KEY, next ? "1" : "0")
    } catch {
      /* not remembered — fine */
    }
  }

  const points = [
    ["Pretend money, real market", `Each strategy trades its own ${rupees(capital)} of pretend money on live prices. No real orders are placed.`],
    ["Real costs", "Every trade pays real Upstox charges (brokerage, STT, fees, GST) and is one futures lot."],
    ["Automatic", "Strategies enter when their rules are met and exit by stop loss, target, time or the 3:15 PM close."],
    ["Trend days only", "The three strategies trade only when Nifty is clearly trending (0.4%+ from its open, moving steadily), in that direction. On flat or unclear days they sit out. New rules are tested in the replay first, never straight on live."],
  ]

  return (
    <div className="bg-muted/30 rounded-xl border">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-[14px] font-medium">
          <BookOpen className="text-muted-foreground size-4" />
          How paper trading works
        </span>
        <ChevronDown className={cn("text-muted-foreground size-4 transition-transform", !collapsed && "rotate-180")} />
      </button>
      {!collapsed && (
        <div className="space-y-3 border-t px-4 py-4">
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {points.map(([title, body]) => (
              <li key={title} className="text-[13px] leading-snug">
                <div className="font-medium">{title}</div>
                <div className="text-muted-foreground">{body}</div>
              </li>
            ))}
          </ul>
          <Legend
            items={[
              { swatch: "bg-up", label: "Green", meaning: "profit" },
              { swatch: "bg-down", label: "Red", meaning: "loss" },
              {
                mark: <TrendingUp className="text-up size-3.5" aria-hidden />,
                label: "Buy",
                meaning: "earns if price rises",
              },
              {
                mark: <TrendingDown className="text-down size-3.5" aria-hidden />,
                label: "Sell",
                meaning: "earns if price falls",
              },
              {
                mark: <span className="font-mono text-[11px] text-foreground/80">R</span>,
                label: "Risk units",
                meaning: (
                  <span className="inline-flex items-center gap-1">
                    1R = what a trade loses at its stop loss <InfoTip label="R">{TERMS.r}</InfoTip>
                  </span>
                ),
              },
            ]}
          />
        </div>
      )}
    </div>
  )
}
