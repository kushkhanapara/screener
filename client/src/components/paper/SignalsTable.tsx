import { Check, Inbox, MinusCircle } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { hhmm, num, shortDate } from "@/components/paper/format"
import type { PaperSignal } from "@/lib/api"
import { InfoTip } from "@/components/ui/info-tip"
import { TERMS, sideWord, skipWord } from "@/lib/glossary"

/**
 * The stocks a strategy picked.
 *
 * Skipped signals are shown alongside taken ones deliberately: a strategy whose
 * selections are mostly unactionable is not the strategy you think you are
 * running, and that only shows up if the misses are visible.
 */
export function SignalsTable({ signals }: { signals: PaperSignal[] }) {
  if (!signals?.length) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-14">
        <Inbox className="size-6 opacity-60" />
        <p className="text-sm">No setups seen yet.</p>
        <p className="text-xs opacity-70">
          Every time a stock meets this strategy's rules it shows up here, whether it was traded or not.
        </p>
      </div>
    )
  }

  const taken = signals.filter((s) => s.taken).length

  return (
    <div className="space-y-2">
      <div className="text-muted-foreground text-[13px]">
        <span className="text-foreground/80">{signals.length}</span> setups seen ·{" "}
        <span className="text-foreground/80">{taken}</span> traded · {signals.length - taken} skipped. A setup that
        stays valid is listed once per 3-minute bar.
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Stock</TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1">
                  Direction <InfoTip label="Direction">{TERMS.buySell}</InfoTip>
                </span>
              </TableHead>
              <TableHead className="text-right">
                <span className="inline-flex items-center justify-end gap-1">
                  Score <InfoTip label="Score">{TERMS.score}</InfoTip>
                </span>
              </TableHead>
              <TableHead>What happened</TableHead>
              <TableHead className="text-right">When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {signals.map((s) => (
              <TableRow key={s.id} className="hover:bg-transparent">
                <TableCell className="font-mono text-[13px] font-medium">
                  {s.underlying}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={cn("font-normal", s.side === "long" ? "text-up" : "text-down")}
                  >
                    {sideWord(s.side)}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground text-right font-mono text-[13px] tabular-nums">
                  {num(s.score, 1)}
                </TableCell>
                <TableCell>
                  {s.taken ? (
                    <span className="inline-flex items-center gap-1 text-[12px] text-up">
                      <Check className="size-3.5" /> Traded
                    </span>
                  ) : (
                    <span
                      className="text-muted-foreground inline-flex items-center gap-1 text-[12px]"
                      title={skipWord(s.skipReason)}
                    >
                      <MinusCircle className="size-3.5" />
                      <span className="max-w-[22rem] truncate">{skipWord(s.skipReason)}</span>
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-right font-mono text-[12px] tabular-nums">
                  {hhmm(s.barTime)}
                  <span className="ml-1.5 opacity-60">{shortDate(s.barTime)}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
