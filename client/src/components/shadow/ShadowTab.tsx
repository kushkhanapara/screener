import { useEffect, useMemo, useState, type ReactNode } from "react"
import { ChevronDown, Eye, Inbox, Moon, TriangleAlert } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { InfoTip } from "@/components/ui/info-tip"
import { Legend } from "@/components/ui/legend"
import { exitRulesInWords } from "@/lib/glossary"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { markToMarket, usePrices } from "@/lib/prices"
import { hhmm, num, pct, rMultiple, rupees, toneClass } from "@/components/paper/format"
import {
  getShadowSnapshot,
  getShadowSummary,
  type ShadowEval,
  type ShadowOutcome,
  type ShadowSnapshot,
  type ShadowSummary,
} from "@/lib/api"
import {
  BAN_STATUS_LABEL,
  REJECTS,
  REJECT_GROUPS,
  SESSIONS_TO_JUDGE,
  TERMS,
  exitLabel,
  rejectLabel,
  sideLabel,
  type RejectGroup,
} from "@/components/shadow/glossary"

/*
 * Shadow logging, explained as it goes.
 *
 * Everything on this tab is the shadow strategy's own book — pretend trades
 * for one slot, with no capital. None of it is combined with paper trading.
 */

const signedPct = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`

const sideTone = (side: "long" | "short" | null | undefined) =>
  side === "long" ? "text-up" : side === "short" ? "text-down" : "text-muted-foreground"

const BAR_MS = 3 * 60 * 1000
const TARGET_R = 3

function readCollapsed(key: string) {
  try {
    return localStorage.getItem(key) === "1"
  } catch {
    return false
  }
}

function writeCollapsed(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? "1" : "0")
  } catch {
    /* storage unavailable — the choice just isn't remembered */
  }
}

// ── Building blocks ────────────────────────────────────────────────────

function Section({
  title,
  tip,
  hint,
  action,
  children,
}: {
  title: string
  tip?: ReactNode
  hint?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[15px] font-semibold tracking-tight">
            {title}
            {tip && <InfoTip label={title}>{tip}</InfoTip>}
          </h2>
          {hint && <p className="text-muted-foreground text-[13px]">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Column header with its explanation one hover (or focus) away. */
function Th({ children, tip, className }: { children: string; tip: ReactNode; className?: string }) {
  return (
    <TableHead className={className}>
      <span className={cn("inline-flex items-center gap-1", className?.includes("text-right") && "justify-end")}>
        {children}
        <InfoTip label={children}>{tip}</InfoTip>
      </span>
    </TableHead>
  )
}

function Tile({ label, value, sub, tone, tip }: { label: string; value: string; sub?: string; tone?: string; tip?: ReactNode }) {
  return (
    <div className="bg-card rounded-xl border px-4 py-3">
      <div className="text-muted-foreground flex items-center gap-1 text-[12px]">
        {label}
        {tip && <InfoTip label={label}>{tip}</InfoTip>}
      </div>
      <div className={cn("font-mono text-xl tabular-nums", tone ?? "text-foreground")}>{value}</div>
      {sub && <div className="text-muted-foreground text-[12px]">{sub}</div>}
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-8 text-center">
      <Inbox className="size-5 opacity-60" />
      <p className="text-sm">{children}</p>
    </div>
  )
}

/** A native disclosure, styled — keyboard and screen-reader friendly for free. */
function Disclosure({ summary, children, defaultOpen }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="group rounded-xl border" open={defaultOpen}>
      <summary className="hover:bg-muted/40 flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 text-[13px] [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">{summary}</span>
        <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t px-4 py-3">{children}</div>
    </details>
  )
}

// ── 1. How it works ────────────────────────────────────────────────────

const HOW_KEY = "shadow.howItWorks.collapsed"

function HowItWorks({ version }: { version: number }) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(HOW_KEY))
  const steps = [
    ["Every 3 minutes", "from 9:30 AM to 3:00 PM, it scans every F&O stock (about 210)."],
    ["Filters", "drop stocks that can't be traded, are too quiet or too wild, aren't moving on their own, or whose move isn't confirmed."],
    ["Ranks the survivors", "by a 0–1 score and picks the top one."],
    ["Test-trades the pick", "with a real stop loss, target and charges. It holds one trade at a time and uses no money — it only records what it would do."],
  ]
  return (
    <div className="bg-muted/30 rounded-xl border">
      <button
        type="button"
        onClick={() => {
          setCollapsed(!collapsed)
          writeCollapsed(HOW_KEY, !collapsed)
        }}
        aria-expanded={!collapsed}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-[14px] font-medium">
          <Eye className="text-muted-foreground size-4" />
          What is Shadow? A test strategy that runs alongside, using no money
          <span className="text-muted-foreground font-normal">· v{version}</span>
        </span>
        <ChevronDown className={cn("text-muted-foreground size-4 transition-transform", !collapsed && "rotate-180")} />
      </button>
      {!collapsed && (
        <ol className="grid gap-3 border-t px-4 py-4 sm:grid-cols-2 xl:grid-cols-4">
          {steps.map(([title, body], i) => (
            <li key={title} className="flex gap-3">
              <span className="bg-primary text-primary-foreground flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[12px]">
                {i + 1}
              </span>
              <p className="text-[13px] leading-snug">
                <span className="font-medium">{title}</span> <span className="text-muted-foreground">{body}</span>
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

// ── 2. Today ───────────────────────────────────────────────────────────

function Today({ snap, trades }: { snap: ShadowSnapshot; trades: TodayTrades }) {
  const { session } = snap
  const slotClosed = trades.closed.filter((t) => t.slotTaken)
  const slotNet = slotClosed.reduce((a, t) => a + t.netPnl, 0)
  const slotOpen = trades.open.filter((p) => p.slotTaken).length
  const total = trades.closed.length + trades.open.length

  const sentence = !session.bars
    ? "No scans logged yet for this session."
    : `Checked the market ${session.bars} times; a stock passed every check ${session.barsWithCandidate} times. ` +
      `It would have taken ${slotClosed.length + slotOpen} trade${slotClosed.length + slotOpen === 1 ? "" : "s"}` +
      (slotClosed.length ? ` (${rupees(slotNet, true)} on the ${slotClosed.length} closed)` : "") +
      ` and skipped ${total - slotClosed.length - slotOpen} while busy.`

  return (
    <Section
      title={session.date ? `Today · ${session.date}` : "Today"}
      hint={sentence}
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Market checks" value={String(session.bars)} sub="one every 3 minutes" />
        <Tile
          label="Checks where a stock passed"
          value={session.bars ? `${session.barsWithCandidate}` : "—"}
          sub={session.bars ? `${Math.round((session.barsWithCandidate / session.bars) * 100)}% of checks` : undefined}
        />
        <Tile
          label="Top picks followed"
          value={String(total)}
          sub={`${slotClosed.length + slotOpen} would take · ${total - slotClosed.length - slotOpen} skipped (busy)`}
          tip={TERMS.slot}
        />
        <Tile
          label="Result of trades it would take"
          value={slotClosed.length ? rupees(slotNet, true) : "—"}
          tone={slotClosed.length ? toneClass(slotNet) : undefined}
          sub={
            slotClosed.length
              ? `${rMultiple(slotClosed.reduce((a, t) => a + t.rMultiple, 0))} on ${slotClosed.length} closed${slotOpen ? ` · ${slotOpen} open` : ""}`
              : slotOpen
                ? `${slotOpen} open`
                : "none yet"
          }
          tip={TERMS.r}
        />
      </div>
    </Section>
  )
}

function Health({ snap }: { snap: ShadowSnapshot }) {
  const items: { label: string; value: string; ok: boolean | null; tip: string }[] = [
    {
      label: "Status",
      value: snap.running ? "Scanning" : snap.marketOpen ? "Starting…" : "Idle (market closed)",
      ok: snap.running ? true : snap.marketOpen ? null : true,
      tip: "Whether the scan is running. It only runs during market hours.",
    },
    {
      label: "Last scan",
      value: snap.last ? hhmm(snap.last.stats.barTime + BAR_MS) : "—",
      ok: snap.last ? true : null,
      tip: "Close time of the most recent 3-minute bar that was scanned.",
    },
    {
      label: "Ban list",
      value: `${BAN_STATUS_LABEL[snap.ban.status] ?? snap.ban.status} · ${snap.ban.symbols.length} stocks`,
      ok: snap.ban.status === "current" ? true : snap.ban.status === "stale" ? null : false,
      tip: `${TERMS.banList}${snap.ban.symbols.length ? ` Today: ${snap.ban.symbols.join(", ")}.` : ""}`,
    },
    {
      label: "Open interest from",
      value: snap.oiBaselineAt ? hhmm(snap.oiBaselineAt) : "not taken yet",
      ok: snap.oiBaselineAt ? true : null,
      tip: TERMS.oiBaseline,
    },
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border px-4 py-2.5 text-[13px]">
      <span className="text-muted-foreground flex items-center gap-1">
        System health <InfoTip label="system health">{TERMS.health}</InfoTip>
      </span>
      {items.map((it) => (
        <Tooltip key={it.label}>
          <TooltipTrigger
            render={<span tabIndex={0} />}
            className="focus-visible:ring-ring/50 inline-flex cursor-help items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2"
          >
            <span
              className={cn(
                "size-2 rounded-full",
                it.ok === true ? "bg-up" : it.ok === false ? "bg-down" : "bg-chart-3"
              )}
              aria-hidden
            />
            <span className="text-muted-foreground">{it.label}</span>
            <span className="font-medium">{it.value}</span>
          </TooltipTrigger>
          <TooltipContent>{it.tip}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

// ── 3. Candidates ──────────────────────────────────────────────────────

function ScoreCell({ r }: { r: ShadowEval }) {
  const c = r.components
  const parts: [string, number | undefined, number][] = [
    ["Own move vs Nifty", c.rs, 40],
    ["Open interest", c.oi, 30],
    ["Volume vs usual", c.volume, 20],
    ["Scans in a row", c.persistence, 10],
  ]
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} />}
        className="focus-visible:ring-ring/50 inline-flex cursor-help items-center gap-2 rounded-sm outline-none focus-visible:ring-2"
      >
        <span className="bg-muted relative h-1.5 w-14 overflow-hidden rounded-full" aria-hidden>
          <span className="bg-primary absolute inset-y-0 left-0 rounded-full" style={{ width: `${(r.score ?? 0) * 100}%` }} />
        </span>
        <span className="font-mono tabular-nums">{num(r.score, 2)}</span>
      </TooltipTrigger>
      <TooltipContent>
        <div className="mb-1.5 font-medium">What makes up {num(r.score, 2)}</div>
        <div className="space-y-1">
          {parts.map(([name, v, w]) => (
            <div key={name} className="flex justify-between gap-4">
              <span>
                {name} <span className="text-muted-foreground">({w}%)</span>
              </span>
              <span className="font-mono tabular-nums">{num((v ?? 0) * w, 1)} / {w}</span>
            </div>
          ))}
        </div>
        <div className="text-muted-foreground mt-2 border-t pt-1.5">
          Spread {r.inputs.spreadPct == null ? "—" : `${num(r.inputs.spreadPct, 3)}%`} · futures turnover rank{" "}
          {r.inputs.futTurnoverRank ?? "—"} of {r.inputs.universeSize ?? "—"}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function Candidates({ snap }: { snap: ShadowSnapshot }) {
  const last = snap.last
  const rows = (last?.evals ?? []).filter((e) => e.passed)
  const sel = last?.stats.meta.selection
  const at = last ? hhmm(last.stats.barTime + BAR_MS) : null

  const hint = !last
    ? "Nothing scanned yet."
    : sel
      ? sel.skipped
        ? `Top pick ${sel.underlying} was already being followed from an earlier check, so nothing new opened.`
        : `Top pick: ${sideLabel(sel.side)} ${sel.underlying} — ${sel.slotTaken ? "it was free, so it would take this trade." : "it was already in a trade, so this one is skipped (still followed)."}`
      : "No stock passed every filter on this scan."

  return (
    <Section title={at ? `Stocks that passed every check · ${at}` : "Stocks that passed every check"} hint={hint}>
      {!rows.length ? (
        <Empty>No stock passed every filter on this scan.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10">Rank</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead>Direction</TableHead>
                <Th tip={TERMS.score}>Score</Th>
                <Th className="text-right" tip={TERMS.residual}>Own move vs Nifty</Th>
                <Th className="text-right" tip={TERMS.oi}>Open interest</Th>
                <Th className="text-right" tip={TERMS.volume}>Volume vs usual</Th>
                <Th className="text-right" tip={TERMS.streak}>Scans in a row</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.underlying} className={cn("hover:bg-transparent", r.rank === 1 && "bg-primary/5")}>
                  <TableCell className="font-mono tabular-nums">{r.rank === 1 ? "1 ★" : r.rank}</TableCell>
                  <TableCell className="font-mono font-medium">{r.underlying}</TableCell>
                  <TableCell className={sideTone(r.side)}>{sideLabel(r.side)}</TableCell>
                  <TableCell>
                    <ScoreCell r={r} />
                  </TableCell>
                  <TableCell className={cn("text-right font-mono tabular-nums", toneClass(r.inputs.residualPct))}>
                    {signedPct(r.inputs.residualPct)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{signedPct(r.inputs.oiChangePct)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {r.inputs.volumeRatio == null ? "—" : `${num(r.inputs.volumeRatio, 1)}×`}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{r.inputs.streak ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  )
}

// ── 4. Pretend trades ──────────────────────────────────────────────────

type TodayTrades = {
  open: ShadowSnapshot["open"]
  closed: ShadowSnapshot["recentTrades"]
}

function SlotBadge({ taken }: { taken: boolean | null }) {
  return (
    <Badge variant="outline" className={cn("font-normal", taken ? "text-primary border-primary/40" : "text-muted-foreground border-dashed")}>
      {taken ? "Would take" : "Skipped (busy)"}
    </Badge>
  )
}

const heldFor = (from: number, to: number) => {
  const min = Math.max(0, Math.round((to - from) / 60000))
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`
}

/** Rupee P&L of an open pretend trade at its latest price, before charges. */
const openPnl = (p: { ltp: number | null; side: "long" | "short"; entryPrice: number; qty: number }) =>
  p.ltp == null ? null : (p.side === "long" ? p.ltp - p.entryPrice : p.entryPrice - p.ltp) * p.qty

function PretendTrades({ trades }: { trades: TodayTrades }) {
  const prices = usePrices()
  // A ticking clock for "held" times on open trades; reading Date.now() during render isn't allowed.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  const open = trades.open.map((p) => markToMarket(p, prices))
  return (
    <Section
      title="Test trades today"
      tip={TERMS.slot}
      hint="Open trades first. “Would take” rows are the strategy's actual trades; “Skipped (busy)” rows show what it gave up by holding one trade at a time."
    >
      {!open.length && !trades.closed.length ? (
        <Empty>No test trades yet today.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Entry</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead>Direction</TableHead>
                <Th tip={TERMS.slot}>Would it trade?</Th>
                <TableHead className="text-right">Price in → out</TableHead>
                <TableHead>Stop / target · how it ended</TableHead>
                <TableHead className="text-right">Held</TableHead>
                <Th className="text-right" tip={TERMS.r}>Result (R)</Th>
                <Th className="text-right" tip={TERMS.netNotional}>Result (₹)</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {open.map((p) => (
                <TableRow key={p.id} className="bg-muted/30 hover:bg-muted/30">
                  <TableCell className="font-mono tabular-nums">{hhmm(p.entryTime)}</TableCell>
                  <TableCell className="font-mono font-medium">{p.underlying}</TableCell>
                  <TableCell className={sideTone(p.side)}>{sideLabel(p.side)}</TableCell>
                  <TableCell>
                    <SlotBadge taken={p.slotTaken} />
                  </TableCell>
                  <TableCell className="text-right font-mono whitespace-nowrap tabular-nums">
                    {num(p.entryPrice)} <span className="text-muted-foreground">→</span> {num(p.ltp)}
                  </TableCell>
                  <TableCell>
                    <span className="text-foreground/80 inline-flex items-center gap-1.5 whitespace-nowrap">
                      <span className="bg-up size-1.5 animate-pulse rounded-full" aria-hidden /> Open · stop {num(p.currentStop)} · target{" "}
                      {num(p.entryPrice + (p.side === "long" ? 1 : -1) * TARGET_R * p.riskPerUnit)}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right font-mono tabular-nums">{heldFor(p.entryTime, now)}</TableCell>
                  <TableCell className={cn("text-right font-mono tabular-nums", toneClass(p.unrealisedR))}>
                    {rMultiple(p.unrealisedR)}
                  </TableCell>
                  <TableCell className={cn("text-right font-mono tabular-nums", toneClass(openPnl(p)))}>
                    {rupees(openPnl(p), true)}
                  </TableCell>
                </TableRow>
              ))}
              {trades.closed.map((t) => {
                const netPct = (t.netPnl / (t.entryPrice * t.qty)) * 100
                return (
                  <TableRow key={t.id} className="hover:bg-transparent">
                    <TableCell className="font-mono tabular-nums">{hhmm(t.entryTime)}</TableCell>
                    <TableCell className="font-mono font-medium">{t.underlying}</TableCell>
                    <TableCell className={sideTone(t.side)}>{sideLabel(t.side)}</TableCell>
                    <TableCell>
                      <SlotBadge taken={t.slotTaken} />
                    </TableCell>
                    <TableCell className="text-right font-mono whitespace-nowrap tabular-nums">
                      {num(t.entryPrice)} <span className="text-muted-foreground">→</span> {num(t.exitPrice)}
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {exitLabel(t.exitReason)} <span className="text-muted-foreground/70">· {hhmm(t.exitTime)}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right font-mono tabular-nums">{heldFor(t.entryTime, t.exitTime)}</TableCell>
                    <TableCell className={cn("text-right font-mono tabular-nums", toneClass(t.rMultiple))}>
                      {rMultiple(t.rMultiple)}
                    </TableCell>
                    <TableCell className={cn("text-right font-mono tabular-nums", toneClass(t.netPnl))}>
                      {rupees(t.netPnl, true)}
                      <div className="text-muted-foreground text-[11px]">
                        {signedPct(netPct, 2)} · ₹{Math.round(t.costs).toLocaleString("en-IN")} charges
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  )
}

// ── 5. Why stocks were filtered out ────────────────────────────────────

function FilteredOut({
  rejects,
  order,
  title,
  hint,
}: {
  rejects: Record<string, number>
  order: string[]
  title: string
  hint: string
}) {
  const groups = REJECT_GROUPS.map((g) => {
    const reasons = order
      .filter((code) => rejects[code] && (REJECTS[code]?.group ?? "unconfirmed") === g.id)
      .map((code) => ({ code, n: rejects[code] }))
    return { ...g, reasons, total: reasons.reduce((a, r) => a + r.n, 0) }
  })
  const grand = Math.max(1, groups.reduce((a, g) => a + g.total, 0))
  const tone: Record<RejectGroup, string> = {
    cantTrade: "bg-muted-foreground/40",
    volatility: "bg-chart-3/70",
    noMove: "bg-chart-2/70",
    unconfirmed: "bg-chart-4/70",
  }

  if (!groups.some((g) => g.total)) return <Section title={title} hint={hint}><Empty>Nothing recorded yet.</Empty></Section>

  return (
    <Section
      title={title}
      hint={hint}
      tip="Each scan checks every stock against the filters in order and records the first one it fails. Counts add up across scans, so a stock rejected on 100 scans counts 100 times."
    >
      <div className="flex h-2.5 w-full overflow-hidden rounded-full" aria-hidden>
        {groups.map((g) => (
          <div key={g.id} className={tone[g.id]} style={{ width: `${(g.total / grand) * 100}%` }} />
        ))}
      </div>
      <div className="grid items-start gap-2 md:grid-cols-2">
        {groups.map((g) => (
          <Disclosure
            key={g.id}
            summary={
              <span className="flex items-center gap-2">
                <span className={cn("size-2.5 shrink-0 rounded-sm", tone[g.id])} aria-hidden />
                <span className="font-medium">{g.label}</span>
                <span className="text-muted-foreground font-mono tabular-nums">
                  {g.total.toLocaleString("en-IN")} · {Math.round((g.total / grand) * 100)}%
                </span>
              </span>
            }
          >
            <p className="text-muted-foreground mb-2 text-[12px]">{g.hint}</p>
            {g.reasons.length ? (
              <ul className="space-y-1.5">
                {g.reasons.map((r) => (
                  <li key={r.code} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="truncate">{rejectLabel(r.code)}</span>
                      <InfoTip label={rejectLabel(r.code)}>{REJECTS[r.code]?.why ?? r.code}</InfoTip>
                    </span>
                    <span className="font-mono tabular-nums">{r.n.toLocaleString("en-IN")}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-[13px]">None.</p>
            )}
          </Disclosure>
        ))}
      </div>
    </Section>
  )
}

function AlmostMadeIt({ rows }: { rows: ShadowEval[] }) {
  return (
    <Disclosure
      summary={
        <span className="flex items-center gap-1.5">
          <span className="font-medium">Almost made it</span>
          <span className="text-muted-foreground">
            · {rows.length} stock{rows.length === 1 ? "" : "s"} on the last scan moved on their own but failed a later check
          </span>
        </span>
      }
    >
      {!rows.length ? (
        <p className="text-muted-foreground text-sm">None on the last scan.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Stock</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>Blocked by</TableHead>
                <Th className="text-right" tip={TERMS.residual}>Own move vs Nifty</Th>
                <Th className="text-right" tip={TERMS.oi}>Open interest</Th>
                <Th className="text-right" tip={TERMS.volume}>Volume vs usual</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.underlying} className="hover:bg-transparent">
                  <TableCell className="font-mono font-medium">{r.underlying}</TableCell>
                  <TableCell className={sideTone(r.side)}>{sideLabel(r.side)}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1">
                      {rejectLabel(r.rejectCode)}
                      {r.rejectCode && REJECTS[r.rejectCode] && (
                        <InfoTip label={rejectLabel(r.rejectCode)}>{REJECTS[r.rejectCode].why}</InfoTip>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className={cn("text-right font-mono tabular-nums", toneClass(r.inputs.residualPct))}>
                    {signedPct(r.inputs.residualPct)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{signedPct(r.inputs.oiChangePct)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {r.inputs.volumeRatio == null ? "—" : `${num(r.inputs.volumeRatio, 1)}×`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Disclosure>
  )
}

// ── 6. Is it working? ──────────────────────────────────────────────────

function OutcomeCard({ title, explain, o, target }: { title: string; explain: string; o: ShadowOutcome; target: number }) {
  const meets = o.avgNetPct != null && o.avgNetPct >= target
  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div>
        <div className="text-[14px] font-medium">{title}</div>
        <p className="text-muted-foreground text-[12px] leading-snug">{explain}</p>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
        <Stat label="Trades" value={String(o.trades)} />
        <Stat label="Won" value={o.winRate == null ? "—" : pct(o.winRate)} />
        <Stat label="Average result" value={rMultiple(o.expectancyR)} tone={toneClass(o.expectancyR)} tip={TERMS.r} />
        <Stat
          label="Net per contract value"
          value={o.avgNetPct == null ? "—" : signedPct(o.avgNetPct, 3)}
          tone={o.avgNetPct == null ? undefined : meets ? "text-up" : o.avgNetPct > 0 ? "text-chart-3" : "text-down"}
          sub={`goal ≥ +${target}%`}
          tip={TERMS.netNotional}
        />
        <Stat label="Net" value={o.trades ? rupees(o.netPnl, true) : "—"} tone={o.trades ? toneClass(o.netPnl) : undefined} />
      </div>
    </div>
  )
}

function Stat({ label, value, tone, sub, tip }: { label: string; value: string; tone?: string; sub?: string; tip?: string }) {
  return (
    <div>
      <div className="text-muted-foreground flex items-center gap-1 text-[12px]">
        {label}
        {tip && <InfoTip label={label}>{tip}</InfoTip>}
      </div>
      <div className={cn("font-mono tabular-nums", tone)}>{value}</div>
      {sub && <div className="text-muted-foreground text-[11px]">{sub}</div>}
    </div>
  )
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="bg-muted inline-flex rounded-md p-0.5" role="group" aria-label="Time window">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded px-3 py-1 text-[12px] transition-colors",
            o.value === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function IsItWorking({
  summary,
  days,
  setDays,
}: {
  summary: ShadowSummary | null
  days: 7 | 30 | "all"
  setDays: (d: 7 | 30 | "all") => void
}) {
  return (
    <Section
      title="Is it working?"
      hint="Results of Shadow's test trades across all logged days. Shadow only — never mixed with paper trading."
      action={
        <Segmented
          value={days}
          options={[
            { value: 7, label: "7 days" },
            { value: 30, label: "30 days" },
            { value: "all", label: "All" },
          ]}
          onChange={setDays}
        />
      }
    >
      {!summary ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : summary.sessions === 0 ? (
        <Empty>No sessions logged in this window yet.</Empty>
      ) : (
        <div className="space-y-3">
          {summary.sessions < SESSIONS_TO_JUDGE && (
            <Alert>
              <TriangleAlert />
              <AlertTitle>
                {summary.sessions} of ~{SESSIONS_TO_JUDGE} sessions logged — too early to judge
              </AlertTitle>
              <AlertDescription>
                One or two market days can make any strategy look great or terrible. Treat these numbers as a progress
                log until about {SESSIONS_TO_JUDGE} sessions, across rising, falling and flat days, are in.
              </AlertDescription>
            </Alert>
          )}
          <div className="grid gap-3 md:grid-cols-3">
            <OutcomeCard
              title="Trades it would take"
              explain="What the strategy would actually have done, holding one trade at a time."
              o={summary.outcomes.slot}
              target={summary.targetNetPct}
            />
            <OutcomeCard
              title="Every top pick"
              explain="As if it could hold any number of trades — shows whether its picks are good in general."
              o={summary.outcomes.all}
              target={summary.targetNetPct}
            />
            <OutcomeCard
              title="Skipped while busy"
              explain="Top picks it had to skip because it was already in a trade — what the one-trade limit costs."
              o={summary.outcomes.missed}
              target={summary.targetNetPct}
            />
          </div>

          <Disclosure
            summary={
              <span className="flex items-center gap-1.5">
                <span className="font-medium">Advanced: choosing a minimum score</span>
                <span className="text-muted-foreground">· {summary.sessions} sessions</span>
              </span>
            }
          >
            <p className="text-muted-foreground mb-3 text-[13px]">
              {TERMS.floor} The aim is a cutoff that gives a trade on roughly 5–8 days a month (highlighted) while the
              average result stays positive.
            </p>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Minimum score</TableHead>
                    <TableHead className="text-right">Days with a trade</TableHead>
                    <TableHead className="text-right">Per month</TableHead>
                    <TableHead className="text-right">Trades</TableHead>
                    <TableHead className="text-right">Won</TableHead>
                    <TableHead className="text-right">Average (R)</TableHead>
                    <TableHead className="text-right">Net per contract value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.floors.map((f) => {
                    const inBand = f.perMonth >= 5 && f.perMonth <= 8
                    return (
                      <TableRow key={f.floor} className={cn("hover:bg-transparent", inBand && "bg-primary/5")}>
                        <TableCell className="font-mono tabular-nums">{num(f.floor, 2)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{f.daysWithCandidate}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{num(f.perMonth, 1)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{f.trades}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{f.winRate == null ? "—" : pct(f.winRate)}</TableCell>
                        <TableCell className={cn("text-right font-mono tabular-nums", toneClass(f.expectancyR))}>
                          {rMultiple(f.expectancyR)}
                        </TableCell>
                        <TableCell className={cn("text-right font-mono tabular-nums", toneClass(f.avgNetPct))}>
                          {f.avgNetPct == null ? "—" : signedPct(f.avgNetPct, 3)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </Disclosure>

          <FilteredOut
            title="Why stocks were filtered out, across sessions"
            hint="Which filters do the most work over time."
            rejects={summary.rejectTotals}
            order={summary.rejectOrder}
          />
        </div>
      )}
    </Section>
  )
}

// ── Key and rules ──────────────────────────────────────────────────────

function ShadowKey() {
  return (
    <div className="rounded-xl border px-4 py-2.5">
      <Legend
        title="Key"
        items={[
          { swatch: "bg-up", label: "Green", meaning: "profit / Buy" },
          { swatch: "bg-down", label: "Red", meaning: "loss / Sell" },
          { swatch: "bg-chart-3", label: "Amber", meaning: "positive but below goal, or needs attention" },
          {
            mark: <Badge variant="outline" className="text-primary border-primary/40 h-4 px-1.5 text-[10px] font-normal">Would take</Badge>,
            label: "",
            meaning: "a trade it would actually make",
          },
          {
            mark: <Badge variant="outline" className="text-muted-foreground h-4 border-dashed px-1.5 text-[10px] font-normal">Skipped (busy)</Badge>,
            label: "",
            meaning: "already in a trade, so skipped (still followed)",
          },
          { mark: <span className="text-[11px]">1 ★</span>, label: "", meaning: "top pick of that check" },
          {
            mark: <span className="font-mono text-[11px]">R</span>,
            label: "",
            meaning: "result in risk units (1R = loss at the stop)",
          },
        ]}
      />
    </div>
  )
}

const hm = (min: number) => {
  const h = Math.floor(min / 60)
  return `${h > 12 ? h - 12 : h}:${String(min % 60).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`
}

function ShadowRules({ snap }: { snap: ShadowSnapshot }) {
  const c = snap.config
  const checks = [
    `Stock price is at least ₹${c.minPrice ?? 100} and one lot's margin fits in ₹${((c.capital ?? 200000) / 100000).toFixed(0)} lakh`,
    "Not in NSE's F&O ban list today",
    `Today's price swing is normal for this stock (between its ${c.atrPercentile?.min ?? 30}th and ${c.atrPercentile?.max ?? 85}th percentile)`,
    `The stop loss would be at least ${c.minStopPct ?? 0.3}% away, so the move can beat charges`,
    `The stock moved at least ${c.minResidualPct ?? 0.3}% on its own, after removing what Nifty did`,
    "It isn't fighting the market (no buys while Nifty is below its opening range, no sells above it)",
    "Futures open interest is rising and agrees with the price direction",
    `This bar's volume is at least ${c.minVolumeRatio ?? 1}× the usual for this time of day (based on ${c.minNormSessions ?? 5}+ earlier days)`,
    `It passed on ${c.persistenceBars} checks in a row`,
  ]
  const exits = exitRulesInWords(c.exits)
  return (
    <Disclosure
      summary={
        <span className="flex items-center gap-1.5">
          <span className="font-medium">The rules Shadow follows</span>
          <span className="text-muted-foreground">· what a stock must pass, and how trades close</span>
        </span>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <div className="text-[13px] font-medium">A stock must pass all of these (in this order)</div>
          <ol className="text-foreground/85 list-decimal space-y-0.5 pl-5 text-[13px]">
            {checks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ol>
          <p className="text-muted-foreground text-[12px]">
            Checks start at {hm(c.entryStartMin ?? 570)}, after the first 15 minutes set the opening range. The highest
            score wins; strength vs Nifty counts 40%, open interest 30%, volume 20%, checks in a row 10%.
          </p>
        </div>
        <div className="space-y-1.5">
          <div className="text-[13px] font-medium">How a trade closes</div>
          <ol className="text-foreground/85 list-decimal space-y-0.5 pl-5 text-[13px]">
            {exits.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ol>
          <p className="text-muted-foreground text-[12px]">
            One lot per trade, one trade at a time, real Upstox charges included. No money is used.
          </p>
        </div>
      </div>
    </Disclosure>
  )
}

// ── The tab ────────────────────────────────────────────────────────────

export function ShadowTab() {
  const [snap, setSnap] = useState<ShadowSnapshot | null>(null)
  const [summary, setSummary] = useState<ShadowSummary | null>(null)
  const [days, setDays] = useState<7 | 30 | "all">(30)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = () =>
      getShadowSnapshot()
        .then((s) => {
          if (!active) return
          setSnap(s)
          setError(null)
        })
        .catch((e) => active && setError((e as Error).message))
    load()
    const id = setInterval(load, 15_000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [])

  useEffect(() => {
    let active = true
    const load = () => getShadowSummary(days).then((s) => active && setSummary(s)).catch(() => {})
    load()
    const id = setInterval(load, 60_000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [days])

  const today = useMemo<TodayTrades>(() => {
    if (!snap) return { open: [], closed: [] }
    const date = snap.session.date
    const onDate = (ms: number) => !date || new Date(ms + 19_800_000).toISOString().slice(0, 10) === date
    return {
      open: snap.open,
      closed: snap.recentTrades.filter((t) => onDate(t.entryTime)),
    }
  }, [snap])

  if (error && !snap) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>Couldn't load shadow logging</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }
  if (!snap) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-14 w-full rounded-xl" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  const misses = (snap.last?.evals ?? []).filter((e) => !e.passed).slice(0, 12)

  return (
    <div className="mx-auto max-w-[1400px] space-y-7">
      <HowItWorks version={snap.config.version} />

      {!snap.marketOpen && (
        <Alert>
          <Moon />
          <AlertTitle>Market closed</AlertTitle>
          <AlertDescription>Scanning runs from 9:30 AM to 3:00 PM IST. Below is the latest session.</AlertDescription>
        </Alert>
      )}
      {snap.config.dataVersion != null && snap.config.dataVersion !== snap.config.version && (
        <Alert>
          <Eye />
          <AlertTitle>Showing the last session logged under v{snap.config.dataVersion}</AlertTitle>
          <AlertDescription>
            The strategy is now v{snap.config.version} (usual volume is measured over ~10 earlier sessions instead of
            3–4). Its own numbers start at the next session and are kept separate from v{snap.config.dataVersion}.
          </AlertDescription>
        </Alert>
      )}
      {snap.error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Logging problem</AlertTitle>
          <AlertDescription>{snap.error}</AlertDescription>
        </Alert>
      )}

      <Today snap={snap} trades={today} />
      <ShadowKey />
      <Health snap={snap} />
      <Candidates snap={snap} />
      <PretendTrades trades={today} />

      <div className="space-y-3">
        <FilteredOut
          title="Why stocks were filtered out today"
          hint="Every scan, each stock is stopped at the first filter it fails."
          rejects={snap.session.rejects}
          order={snap.rejectOrder}
        />
        <AlmostMadeIt rows={misses} />
      </div>

      <ShadowRules snap={snap} />

      <IsItWorking summary={summary} days={days} setDays={setDays} />
    </div>
  )
}
