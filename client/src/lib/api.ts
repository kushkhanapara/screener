/** Thin fetch wrappers + shared types for the server API. Throw on non-2xx. */

export type Side = "long" | "short"
export type Timeframe = "3m" | "15m"
export type Trend = "bullish" | "bearish" | "neutral"

/** Per-timeframe evaluation for a scrip (from the live feed). */
export type TfState = {
  long?: boolean
  short?: boolean
  dataLimited?: boolean
  close?: number
  rsi14?: number
  rsiSignal?: number
  macd?: number
  macdSignal?: number
  macdHist?: number
  sma34?: number
  sma200?: number | null
}

/** One active futures expiry with its last-traded price. */
export type FuturePrice = {
  /** Instrument key — lets the view pick up the live price for this contract. */
  key?: string
  label: string
  month: string
  expiry: string
  ltp: number | null
}

/** A matched scrip in the live feed (evaluated on the cash chart). */
export type ScripMatch = {
  underlying: string
  cashKey: string
  cashLtp: number | null
  trend: Trend
  longMatch: boolean
  shortMatch: boolean
  conflict: boolean
  tf: Record<Timeframe, TfState>
  futures: FuturePrice[]
}

/** One matched row in the EOD (daily) scan. */
export type DailyRow = {
  contract: string
  underlying: string
  expiry: string
  close: number
  rsi14: number
  rsiSignal?: number
  macdHist: number
  reasons: string[]
  futures: FuturePrice[]
}

export type SideResult = { count: number; results: DailyRow[] }

export type DailyStatus = {
  updatedAt: string | null
  loaded: number
  total: number
  fetched: number
  skipped: number
  fetching: boolean
  error: string | null
  hasToken: boolean
}

export type ScanResult = {
  updatedAt: string | null
  total: number
  loaded: number
  skipped: number
  long: SideResult
  short: SideResult
}

export type LiveStatus = {
  connected: boolean
  marketOpen: boolean
  hasToken: boolean
  lastTickTs: number | null
  subscribed: number
  counts: { long: number; short: number }
  error: string | null
  /** Set when the feed cannot recover on its own — e.g. a rejected token. */
  fatal?: string | null
}

export type LiveUpdate = {
  type: "update"
  ts: string | null
  scrips: ScripMatch[]
  counts: { long: number; short: number }
  entered: { long: string[]; short: string[] }
  exited: { long: string[]; short: string[] }
}

export type StrategyConditions = { long: string[]; short: string[] }

/** Metadata for one tradable strategy, from /api/strategies. */
export type StrategyMeta = {
  id: string
  name: string
  tagline: string
  description: StrategyConditions
  timeframes: { trend: Timeframe; trigger: Timeframe }
  exits: StrategyExits
}

/** How a strategy leaves a trade. Distances are multiples of the 3-minute ATR. */
export type StrategyExits = {
  stopAtr: number
  trailAtr: number
  breakevenAtR: number
  targetR: number
  timeStopBars: number
  squareOffMin: number
  noEntryAfterMin?: number
  proveItBars?: number
  proveItR?: number
}

/** A strategy's rules in everyday words. */
export type PlainRules = { summary: string; buy: string[]; sell: string[] }

export type ExitReason = "stop" | "breakeven" | "trail" | "target" | "time" | "squareoff" | "proveit" | "days" | "roll"

/** An open paper position, marked to the latest futures price. */
export type PaperPosition = {
  id: string
  strategyId: string
  underlying: string
  futKey: string | null
  futLabel: string | null
  side: Side
  reasons: string[]
  entryTime: number
  entryPrice: number
  lots: number
  lotSize: number
  qty: number
  initialStop: number
  currentStop: number
  atrAtEntry: number | null
  riskPerUnit: number
  breakevenMoved: boolean
  barsHeld: number
  ltp: number | null
  unrealisedR: number | null
  unrealisedPnl: number | null
}

/** A closed paper trade. */
export type PaperTrade = {
  id: string
  strategyId: string
  underlying: string
  futLabel: string | null
  side: Side
  reasons: string[]
  entryTime: number
  entryPrice: number
  qty: number
  lotSize: number
  initialStop: number
  riskPerUnit: number
  rupeeRisk: number
  exitTime: number
  exitPrice: number
  exitReason: ExitReason
  grossPnl: number
  costs: number
  netPnl: number
  rMultiple: number
  mae: number | null
  mfe: number | null
  barsHeld: number | null
}

export type SideStats = {
  trades: number
  winRate: number
  expectancyR: number
  totalR: number
}

export type PaperMetrics = {
  trades: number
  wins: number
  losses: number
  winRate: number
  /** Average R per trade — the number that answers "does this make money?" */
  expectancyR: number
  totalR: number
  avgWinR: number
  avgLossR: number
  netPnl: number
  grossPnl: number
  totalCosts: number
  profitFactor: number
  maxDrawdownR: number
  maxDrawdownRupees: number
  sharpe: number
  avgHoldMinutes: number
  avgBarsHeld: number
  avgMae: number
  avgMfe: number
  bySide: { long: SideStats; short: SideStats }
  byExitReason: Partial<Record<ExitReason, number>>
  equityCurveR: number[]
  tradingDays: number
  tradesPerDay: number
  /** Selectivity check: there is no position cap, so the strategy must filter. */
  signalsPerDay: number
  peakSignalsInADay: number
  signalDays: { day: string; signals: number; taken: number }[]
}

/** A stock the strategy selected — taken, or skipped with a reason. */
export type PaperSignal = {
  id: string
  strategyId: string
  underlying: string
  side: Side
  barTime: number
  taken: boolean
  skipReason: string | null
  score: number | null
}

export type DailyPnl = {
  day: string
  trades: number
  netPnl: number
  totalR: number
  wins: number
}

/** One entry or exit, for the live activity stream. */
export type PaperEvent = {
  /** Stable across pushes, so rows are not re-mounted as the list shifts. */
  id: string
  kind: "open" | "close"
  ts: number
  strategyId: string
  underlying: string
  side: Side
  price: number
  detail?: string
  exitReason?: ExitReason
  rMultiple?: number
  netPnl?: number
}

export type PaperTotals = {
  openPositions: number
  openR: number
  openPnl: number
  closedTrades: number
  netPnl: number
  totalR: number
  winRate: number
  todayNetPnl: number
  todayTrades: number
  todayR: number
  totalCosts?: number
  todayWins?: number
  todayCosts?: number
}

/** Today's market day type so far, from Nifty's bars. */
export type DayTypeState = {
  bars: number
  movePct: number | null
  efficiency: number | null
  direction: "up" | "down" | null
  type: "trend-up" | "trend-down" | "flat" | "unclear" | "early"
}

/** Trades closed today for one strategy. */
export type TodayStats = { trades: number; wins: number; netPnl: number; totalR: number; costs: number }

/** Margin committed vs available for one strategy. */
export type CapitalState = {
  capital: number
  deployed: number
  free: number
  utilisation: number
  positions: number
}

export type PaperStrategyState = {
  id: string
  name: string
  tagline: string
  /** An original and its Selective version share a family. */
  family?: string
  plain?: PlainRules | null
  exits?: StrategyExits
  /** Skips buys when Nifty is falling and sells when it is rising. */
  regimeFilter?: boolean
  /** Which kinds of day it trades on; absent means any day. */
  dayTypes?: ("trend" | "flat")[] | null
  today?: TodayStats
  open: PaperPosition[]
  capital: CapitalState
  metrics: PaperMetrics
  dailyPnl: DailyPnl[]
  recentSignals: PaperSignal[]
  /** Present only on Selective variants: the quality bar and today's counts. */
  selection?: PaperSelectionState | null
}

export type PaperSelectionState = {
  version: number
  /** Minimum strength vs Nifty, in % from the open, toward the trade. */
  minAlignedRsPct: number
  /** Trades opened this session. */
  taken: number
  /** Signals turned away by the quality bar this session (counted per bar). */
  skippedForQuality: number
}

export type PaperSnapshot = {
  type: "paper"
  ts: string
  /** Changes only when a position opens or closes — used to skip re-renders. */
  revision: number
  capitalPerStrategy?: number
  dayType?: DayTypeState | null
  running: boolean
  marketOpen: boolean
  hasToken: boolean
  lastEvalTs: number | null
  error: string | null
  totals: PaperTotals
  activity: PaperEvent[]
  strategies: PaperStrategyState[]
}

export type ReportRow = {
  bucket: string
  trades: number
  wins: number
  winRate: number
  expectancyR: number
  totalR: number
  netPnl: number
}

export type ReportBreakdown = {
  key: string
  label: string
  covered: number
  rows: ReportRow[]
}

export type ReportFinding = {
  severity: "warn" | "good" | "info"
  title: string
  detail: string
  n: number
  dimension?: string
  bucket?: string
  impactR: number
}

/** Trade review: outcomes grouped by the conditions they were entered under. */
export type TradeReport = {
  generatedAt: number
  window: { days: number | null; from: number | null; to: number; label: string }
  strategyId: string | null
  counts: {
    total: number
    real: number
    excludedJunk: number
    junkCosts: number
    withFeatures: number
  }
  summary: {
    trades: number
    wins: number
    winRate: number
    expectancyR: number
    totalR: number
    netPnl: number
    /** null when there are no losses (JSON cannot carry Infinity) */
    profitFactor: number | null
    maxDrawdownR: number
    avgMae: number
    avgMfe: number
    grossPnl: number
    totalCosts: number
  }
  strategies: (ReportRow & { strategyId: string })[]
  breakdowns: ReportBreakdown[]
  findings: ReportFinding[]
  minSample: number
}

export type ShadowComponents = Partial<Record<"rs" | "oi" | "volume" | "persistence", number>>

/** One name's evaluation on one bar. */
export type ShadowEval = {
  underlying: string
  side: Side | null
  passed: boolean
  rejectCode: string | null
  rank: number | null
  score: number | null
  gates: Record<string, boolean | null>
  components: ShadowComponents
  inputs: {
    ltp?: number
    lotSize?: number
    notional?: number
    margin?: number
    residualPct?: number | null
    pctFromOpen?: number | null
    indexPctFromOpen?: number | null
    beta?: number | null
    betaFallback?: boolean
    atrPct3m?: number | null
    atrPercentile?: number | null
    oiChangePct?: number | null
    futPriceChangePct?: number | null
    spreadPct?: number | null
    futTurnoverRank?: number
    cashTurnoverRank?: number
    universeSize?: number
    volume?: number | null
    volumeRatio?: number | null
    normSessions?: number | null
    streak?: number | null
  }
}

export type ShadowBarStats = {
  configId: string
  configVersion: number
  sessionDate: string
  barTime: number
  eligible: number
  passed: number
  topScore: number | null
  topUnderlying: string | null
  rejects: Record<string, number>
  meta: {
    banStatus?: string
    banTradeDate?: string | null
    bannedCount?: number
    oiBaselineAt?: number | null
    preVolumeCandidates?: number
    volumeChecked?: number
    volumeCapHit?: boolean
    openingRange?: { high: number; low: number } | null
    selection?: { underlying: string; side?: Side; slotTaken?: boolean; skipped?: string } | null
  }
}

export type ShadowOutcome = {
  trades: number
  winRate: number | null
  expectancyR: number | null
  avgNetPct: number | null
  netPnl: number
  costPctOfGrossWins: number | null
}

export type ShadowPosition = {
  id: string
  underlying: string
  futKey: string | null
  riskPerUnit: number
  side: Side
  entryTime: number
  entryPrice: number
  currentStop: number
  qty: number
  ltp: number | null
  unrealisedR: number | null
  slotTaken: boolean | null
  features?: { score?: number } | null
}

export type ShadowTrade = PaperTrade & {
  slotTaken: boolean | null
  features?: { score?: number } | null
}

export type ShadowSnapshot = {
  config: {
    id: string
    version: number
    /** Version whose data is shown — older than `version` right after a bump. */
    dataVersion?: number
    name: string
    weights: Record<string, number>
    persistenceBars: number
    volumeCheckCap: number
    capital?: number
    minPrice?: number
    atrPercentile?: { min: number; max: number }
    minStopPct?: number
    minResidualPct?: number
    minVolumeRatio?: number
    minNormSessions?: number
    entryStartMin?: number
    exits?: StrategyExits
  }
  running: boolean
  marketOpen: boolean
  hasToken: boolean
  ban: {
    status: "current" | "stale" | "unavailable"
    tradeDate: string | null
    symbols: string[]
    fetchError: string | null
  }
  oiBaselineAt: number | null
  last: { stats: ShadowBarStats; evals: ShadowEval[] } | null
  session: {
    date: string | null
    bars: number
    barsWithCandidate: number
    rejects: Record<string, number>
  }
  open: ShadowPosition[]
  recentTrades: ShadowTrade[]
  rejectOrder: string[]
  error: string | null
}

export type ShadowSummary = {
  version?: number
  window: { days: number | null; from: number | null; label: string }
  sessions: number
  bars: number
  daily: { day: string; bars: number; barsWithCandidate: number; maxScore: number | null }[]
  floors: ({ floor: number; daysWithCandidate: number; perMonth: number } & ShadowOutcome)[]
  rejectTotals: Record<string, number>
  rejectOrder: string[]
  outcomes: { all: ShadowOutcome; slot: ShadowOutcome; missed: ShadowOutcome }
  targetNetPct: number
}

export type PaperStatus = {
  running: boolean
  marketOpen: boolean
  hasToken: boolean
  openPositions: number
  futuresTracked: number
  signals: number
  tradesClosed: number
  lastEvalTs: number | null
  error: string | null
}

async function jsonFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const getStatus = () => jsonFetch<DailyStatus>("/api/status")
export const getStrategy = () => jsonFetch<StrategyConditions>("/api/strategy")
export const getLiveStatus = () => jsonFetch<LiveStatus>("/api/live/status")
export const refresh = () => jsonFetch<{ fetching: boolean }>("/api/refresh", { method: "POST" })
export const scan = () => jsonFetch<ScanResult>("/api/scan", { method: "POST" })

export const getStrategies = () =>
  jsonFetch<{ strategies: StrategyMeta[] }>("/api/strategies").then((r) => r.strategies)
/** One stock on today's multi-day buy list. */
export type SwingCandidate = {
  underlying: string
  signalDate: string
  score: number
  rsi: number | null
  status: "waiting" | "opening" | "taken" | "skipped" | "done"
  skipReason: string | null
}

/** The multi-day paper book — its own money and totals, never added to intraday. */
export type SwingSnapshot = {
  book: {
    id: string
    name: string
    capital: number
    maxOpen: number
    maxDays: number
    plain: { summary: string; buy: string[]; exits: string[] }
  }
  capital: { capital: number; deployed: number; free: number; utilisation: number; positions: number }
  positions: PaperPosition[]
  trades: PaperTrade[]
  metrics: PaperMetrics
  openPnl: number
  plan: {
    date: string
    builtAt: number
    signalDate: string
    niftyUp: boolean
    niftyClose: number
    niftyAvg50: number
    candidates: SwingCandidate[]
  } | null
  lastEodDate: string | null
  error: string | null
}

export const getSwingSnapshot = () => jsonFetch<SwingSnapshot>("/api/swing/snapshot")
export const getPaperSnapshot = () => jsonFetch<PaperSnapshot>("/api/paper/snapshot")
export const getPaperStatus = () => jsonFetch<PaperStatus>("/api/paper/status")
export const getShadowSnapshot = () => jsonFetch<ShadowSnapshot>("/api/shadow/snapshot")
export const getShadowSummary = (days: number | "all") =>
  jsonFetch<ShadowSummary>(`/api/shadow/summary?days=${days}`)
export const getPaperReport = (days: number | "all", strategy?: string | null) =>
  jsonFetch<TradeReport>(
    `/api/paper/report?days=${days}${strategy ? `&strategy=${encodeURIComponent(strategy)}` : ""}`
  )
export const getPaperTrades = (strategy?: string, limit = 100) =>
  jsonFetch<{ trades: PaperTrade[] }>(
    `/api/paper/trades?limit=${limit}${strategy ? `&strategy=${encodeURIComponent(strategy)}` : ""}`
  ).then((r) => r.trades)

/** Build the /ws/live URL from the current origin (works in dev via proxy). */
export function liveSocketUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws"
  return `${proto}://${window.location.host}/ws/live`
}
