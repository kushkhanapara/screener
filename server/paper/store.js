import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SQLite persistence for paper trading.
 *
 * Every call to `node:sqlite` lives in this file. That module is still flagged
 * experimental, so confining it here means swapping to `better-sqlite3` (whose
 * synchronous API is near-identical) would be a contained change rather than a
 * rewrite.
 *
 * The reason this is a database and not a directory of JSON files: an open
 * position mutates on every tick, and rewriting a JSON file is a
 * read-modify-write that corrupts if the process dies mid-write. Closing a
 * position must delete the open row and insert the trade atomically or the books
 * are wrong.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

export const LIVE_RUN_ID = "live";

let db = null;

/**
 * Open (and migrate) the database. Safe to call repeatedly.
 * PAPER_DB_PATH points this elsewhere — useful for a scratch database when
 * demoing or testing, so real accumulated results are never touched.
 */
export function init(
  dbPath = process.env.PAPER_DB_PATH || path.resolve(__dirname, "../../data/screener.db")
) {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;"); // survives an abrupt kill mid-session
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  migrate();
  return db;
}

/**
 * Additive column migrations.
 *
 * schema.sql uses CREATE TABLE IF NOT EXISTS, so a database created by an
 * earlier version keeps its original columns and silently lacks new ones. Each
 * entry is applied only when missing, so an existing store upgrades in place
 * instead of having to be deleted.
 */
function migrate() {
  const additions = [
    ["positions", "margin_blocked", "REAL"],
    ["trades", "margin_blocked", "REAL"],
    ["positions", "features", "TEXT"],
    ["trades", "features", "TEXT"],
    ["positions", "slot_taken", "INTEGER"],
    ["trades", "slot_taken", "INTEGER"],
  ];
  for (const [table, column, type] of additions) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  // One open slot per strategy per run, enforced by the database. An in-memory
  // flag lets two handlers in the same tick both read "free" and both enter.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_one_slot
       ON positions(run_id, strategy_id) WHERE slot_taken = 1`
  );
}

/** In-memory database for tests — same schema, nothing touches disk. */
export function initMemory() {
  db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  migrate();
  return db;
}

export function close() {
  db?.close();
  db = null;
}

function handle() {
  if (!db) throw new Error("paper store not initialised — call init() first");
  return db;
}

/** Run `fn` inside a transaction, rolling back if it throws. */
export function transaction(fn) {
  const d = handle();
  d.exec("BEGIN");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

// ── Runs ───────────────────────────────────────────────────────────────

/**
 * Create a run, or refresh an existing one's metadata. `started_at` is kept on
 * conflict: the live and shadow runs are re-registered on every boot, and
 * INSERT OR REPLACE used to reset their start to the latest restart.
 */
export function createRun({ id, kind, strategyId = null, params = null, notes = null }) {
  handle()
    .prepare(
      `INSERT INTO runs (id, kind, strategy_id, started_at, params, notes)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, strategy_id = excluded.strategy_id,
         params = excluded.params, notes = excluded.notes`
    )
    .run(id, kind, strategyId, Date.now(), params ? JSON.stringify(params) : null, notes);
  return id;
}

export function finishRun(id, at = Date.now()) {
  handle().prepare(`UPDATE runs SET finished_at = ? WHERE id = ?`).run(at, id);
}

export function getRun(id) {
  return handle().prepare(`SELECT * FROM runs WHERE id = ?`).get(id);
}

export function listRuns(kind = null) {
  const d = handle();
  return kind
    ? d.prepare(`SELECT * FROM runs WHERE kind = ? ORDER BY started_at DESC`).all(kind)
    : d.prepare(`SELECT * FROM runs ORDER BY started_at DESC`).all();
}

// ── Positions ──────────────────────────────────────────────────────────

const POSITION_COLUMNS = [
  "id", "run_id", "strategy_id", "underlying", "fut_key", "fut_label", "side",
  "signal_bar_time", "signal_tf", "reasons",
  "entry_time", "entry_price", "lots", "lot_size", "qty",
  "initial_stop", "current_stop", "atr_at_entry", "risk_per_unit",
  "high_water", "low_water", "breakeven_moved", "bars_held",
  "cash_price_at_signal", "basis_at_entry", "margin_blocked", "features", "slot_taken", "state",
];

/** camelCase position object -> snake_case row. */
function toRow(p) {
  return {
    id: p.id,
    run_id: p.runId,
    strategy_id: p.strategyId,
    underlying: p.underlying,
    fut_key: p.futKey ?? null,
    fut_label: p.futLabel ?? null,
    side: p.side,
    signal_bar_time: p.signalBarTime ?? null,
    signal_tf: p.signalTf ?? null,
    reasons: JSON.stringify(p.reasons ?? []),
    entry_time: p.entryTime,
    entry_price: p.entryPrice,
    lots: p.lots,
    lot_size: p.lotSize,
    qty: p.qty,
    initial_stop: p.initialStop,
    current_stop: p.currentStop,
    atr_at_entry: p.atrAtEntry ?? null,
    risk_per_unit: p.riskPerUnit,
    high_water: p.highWater,
    low_water: p.lowWater,
    breakeven_moved: p.breakevenMoved ? 1 : 0,
    bars_held: p.barsHeld ?? 0,
    cash_price_at_signal: p.cashPriceAtSignal ?? null,
    basis_at_entry: p.basisAtEntry ?? null,
    margin_blocked: p.marginBlocked ?? null,
    features: p.features ? JSON.stringify(p.features) : null,
    slot_taken: p.slotTaken == null ? null : p.slotTaken ? 1 : 0,
    state: p.state ?? "open",
  };
}

/** snake_case row -> camelCase position object. */
export function fromRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    runId: r.run_id,
    strategyId: r.strategy_id,
    underlying: r.underlying,
    futKey: r.fut_key,
    futLabel: r.fut_label,
    side: r.side,
    signalBarTime: r.signal_bar_time,
    signalTf: r.signal_tf,
    reasons: safeParse(r.reasons),
    entryTime: r.entry_time,
    entryPrice: r.entry_price,
    lots: r.lots,
    lotSize: r.lot_size,
    qty: r.qty,
    initialStop: r.initial_stop,
    currentStop: r.current_stop,
    atrAtEntry: r.atr_at_entry,
    riskPerUnit: r.risk_per_unit,
    highWater: r.high_water,
    lowWater: r.low_water,
    breakevenMoved: Boolean(r.breakeven_moved),
    barsHeld: r.bars_held,
    cashPriceAtSignal: r.cash_price_at_signal,
    basisAtEntry: r.basis_at_entry,
    marginBlocked: r.margin_blocked,
    features: parseObject(r.features),
    slotTaken: r.slot_taken == null ? null : Boolean(r.slot_taken),
    state: r.state,
  };
}

function safeParse(json) {
  try {
    return JSON.parse(json ?? "[]");
  } catch {
    return [];
  }
}

function parseObject(json) {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

export function insertPosition(position) {
  const row = toRow(position);
  const cols = POSITION_COLUMNS.join(", ");
  const placeholders = POSITION_COLUMNS.map(() => "?").join(", ");
  handle()
    .prepare(`INSERT INTO positions (${cols}) VALUES (${placeholders})`)
    .run(...POSITION_COLUMNS.map((c) => row[c]));
  return position;
}

/**
 * Insert a position, taking the strategy's single slot if it is free. The unique
 * index decides, so concurrent callers cannot both win; the loser is recorded
 * with slotTaken=false (what the strategy would have missed).
 */
export function insertPositionClaimingSlot(position) {
  try {
    const claimed = { ...position, slotTaken: true };
    insertPosition(claimed);
    return claimed;
  } catch (e) {
    if (!/UNIQUE/i.test(String(e?.message))) throw e;
    const missed = { ...position, slotTaken: false };
    insertPosition(missed);
    return missed;
  }
}

// ── Shadow logging ─────────────────────────────────────────────────────

/** Record one evaluated bar and its per-name detail atomically, replacing any earlier record of the same bar. */
export function recordShadowBar(stats, rows = []) {
  return transaction(() => {
    const d = handle();
    d.prepare(`DELETE FROM shadow_evals WHERE config_id = ? AND bar_time = ?`).run(stats.configId, stats.barTime);
    d.prepare(
      `INSERT OR REPLACE INTO shadow_bars
         (config_id, config_version, session_date, bar_time, eligible, passed, top_score, top_underlying, rejects, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      stats.configId,
      stats.configVersion,
      stats.sessionDate,
      stats.barTime,
      stats.eligible,
      stats.passed,
      stats.topScore ?? null,
      stats.topUnderlying ?? null,
      JSON.stringify(stats.rejects ?? {}),
      JSON.stringify(stats.meta ?? {})
    );
    const ins = d.prepare(
      `INSERT INTO shadow_evals
         (config_id, config_version, session_date, bar_time, underlying, side, passed, reject_code, rank, score, gates, components, inputs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of rows) {
      ins.run(
        stats.configId,
        stats.configVersion,
        stats.sessionDate,
        stats.barTime,
        r.underlying,
        r.side ?? null,
        r.passed ? 1 : 0,
        r.rejectCode ?? null,
        r.rank ?? null,
        Number.isFinite(r.score) ? r.score : null,
        JSON.stringify(r.gates ?? {}),
        JSON.stringify(r.components ?? {}),
        JSON.stringify(r.inputs ?? {})
      );
    }
  });
}

function shadowBarFromRow(r) {
  if (!r) return null;
  return {
    configId: r.config_id,
    configVersion: r.config_version,
    sessionDate: r.session_date,
    barTime: r.bar_time,
    eligible: r.eligible,
    passed: r.passed,
    topScore: r.top_score,
    topUnderlying: r.top_underlying,
    rejects: parseObject(r.rejects) ?? {},
    meta: parseObject(r.meta) ?? {},
  };
}

/**
 * Recorded shadow bars, oldest first. Pass `version` to keep one config
 * version's evidence apart from another's — a threshold change makes the
 * earlier bars answer a different question.
 */
export function shadowBars({ configId, version = null, from = null } = {}) {
  const where = ["config_id = ?"];
  const args = [configId];
  if (version != null) {
    where.push("config_version = ?");
    args.push(version);
  }
  if (from != null) {
    where.push("bar_time >= ?");
    args.push(from);
  }
  return handle()
    .prepare(`SELECT * FROM shadow_bars WHERE ${where.join(" AND ")} ORDER BY bar_time ASC`)
    .all(...args)
    .map(shadowBarFromRow);
}

export function latestShadowBar(configId, version = null) {
  const row =
    version == null
      ? handle()
          .prepare(`SELECT * FROM shadow_bars WHERE config_id = ? ORDER BY bar_time DESC LIMIT 1`)
          .get(configId)
      : handle()
          .prepare(
            `SELECT * FROM shadow_bars WHERE config_id = ? AND config_version = ? ORDER BY bar_time DESC LIMIT 1`
          )
          .get(configId, version);
  return shadowBarFromRow(row);
}

export function shadowEvals({ configId, barTime }) {
  return handle()
    .prepare(`SELECT * FROM shadow_evals WHERE config_id = ? AND bar_time = ? ORDER BY passed DESC, rank ASC, score DESC`)
    .all(configId, barTime)
    .map((r) => ({
      underlying: r.underlying,
      side: r.side,
      passed: Boolean(r.passed),
      rejectCode: r.reject_code,
      rank: r.rank,
      score: r.score,
      gates: parseObject(r.gates) ?? {},
      components: parseObject(r.components) ?? {},
      inputs: parseObject(r.inputs) ?? {},
    }));
}

/** Persist the mutable fields the exit machine changes as price moves. */
export function updatePosition(position) {
  handle()
    .prepare(
      `UPDATE positions
          SET current_stop = ?, high_water = ?, low_water = ?,
              breakeven_moved = ?, bars_held = ?, state = ?
        WHERE id = ?`
    )
    .run(
      position.currentStop,
      position.highWater,
      position.lowWater,
      position.breakevenMoved ? 1 : 0,
      position.barsHeld ?? 0,
      position.state ?? "open",
      position.id
    );
  return position;
}

export function getPosition(id) {
  return fromRow(handle().prepare(`SELECT * FROM positions WHERE id = ?`).get(id));
}

export function openPositions(runId = LIVE_RUN_ID, strategyId = null) {
  const d = handle();
  const rows = strategyId
    ? d.prepare(`SELECT * FROM positions WHERE run_id = ? AND strategy_id = ?`).all(runId, strategyId)
    : d.prepare(`SELECT * FROM positions WHERE run_id = ?`).all(runId);
  return rows.map(fromRow);
}

/** Is this strategy already in this name? Prevents stacking duplicate entries. */
export function hasOpenPosition(runId, strategyId, underlying) {
  const row = handle()
    .prepare(
      `SELECT 1 FROM positions WHERE run_id = ? AND strategy_id = ? AND underlying = ? LIMIT 1`
    )
    .get(runId, strategyId, underlying);
  return Boolean(row);
}

// ── Trades ─────────────────────────────────────────────────────────────

const TRADE_COLUMNS = [
  "id", "run_id", "strategy_id", "underlying", "fut_key", "fut_label", "side",
  "signal_bar_time", "signal_tf", "reasons",
  "entry_time", "entry_price", "lots", "lot_size", "qty",
  "initial_stop", "atr_at_entry", "risk_per_unit", "rupee_risk",
  "exit_time", "exit_price", "exit_reason",
  "gross_pnl", "costs", "net_pnl", "r_multiple",
  "mae", "mfe", "bars_held", "cash_price_at_signal", "basis_at_entry", "margin_blocked",
  "features", "slot_taken",
];

function tradeToRow(t) {
  return {
    id: t.id,
    run_id: t.runId,
    strategy_id: t.strategyId,
    underlying: t.underlying,
    fut_key: t.futKey ?? null,
    fut_label: t.futLabel ?? null,
    side: t.side,
    signal_bar_time: t.signalBarTime ?? null,
    signal_tf: t.signalTf ?? null,
    reasons: JSON.stringify(t.reasons ?? []),
    entry_time: t.entryTime,
    entry_price: t.entryPrice,
    lots: t.lots,
    lot_size: t.lotSize,
    qty: t.qty,
    initial_stop: t.initialStop,
    atr_at_entry: t.atrAtEntry ?? null,
    risk_per_unit: t.riskPerUnit,
    rupee_risk: t.rupeeRisk,
    exit_time: t.exitTime,
    exit_price: t.exitPrice,
    exit_reason: t.exitReason,
    gross_pnl: t.grossPnl,
    costs: t.costs,
    net_pnl: t.netPnl,
    r_multiple: t.rMultiple,
    mae: t.mae ?? null,
    mfe: t.mfe ?? null,
    bars_held: t.barsHeld ?? null,
    cash_price_at_signal: t.cashPriceAtSignal ?? null,
    basis_at_entry: t.basisAtEntry ?? null,
    margin_blocked: t.marginBlocked ?? null,
    features: t.features ? JSON.stringify(t.features) : null,
    slot_taken: t.slotTaken == null ? null : t.slotTaken ? 1 : 0,
  };
}

export function tradeFromRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    runId: r.run_id,
    strategyId: r.strategy_id,
    underlying: r.underlying,
    futKey: r.fut_key,
    futLabel: r.fut_label,
    side: r.side,
    signalBarTime: r.signal_bar_time,
    signalTf: r.signal_tf,
    reasons: safeParse(r.reasons),
    entryTime: r.entry_time,
    entryPrice: r.entry_price,
    lots: r.lots,
    lotSize: r.lot_size,
    qty: r.qty,
    initialStop: r.initial_stop,
    atrAtEntry: r.atr_at_entry,
    riskPerUnit: r.risk_per_unit,
    rupeeRisk: r.rupee_risk,
    exitTime: r.exit_time,
    exitPrice: r.exit_price,
    exitReason: r.exit_reason,
    grossPnl: r.gross_pnl,
    costs: r.costs,
    netPnl: r.net_pnl,
    rMultiple: r.r_multiple,
    mae: r.mae,
    mfe: r.mfe,
    barsHeld: r.bars_held,
    cashPriceAtSignal: r.cash_price_at_signal,
    basisAtEntry: r.basis_at_entry,
    marginBlocked: r.margin_blocked,
    features: parseObject(r.features),
    slotTaken: r.slot_taken == null ? null : Boolean(r.slot_taken),
  };
}

/**
 * Close a position: remove the open row and record the trade in ONE
 * transaction. Either both happen or neither does — a half-applied close would
 * leave a phantom position or a lost trade.
 */
export function commitClose(positionId, trade) {
  return transaction(() => {
    const row = tradeToRow(trade);
    const cols = TRADE_COLUMNS.join(", ");
    const placeholders = TRADE_COLUMNS.map(() => "?").join(", ");
    handle()
      .prepare(`INSERT INTO trades (${cols}) VALUES (${placeholders})`)
      .run(...TRADE_COLUMNS.map((c) => row[c]));
    handle().prepare(`DELETE FROM positions WHERE id = ?`).run(positionId);
    return trade;
  });
}

export function trades({ runId = LIVE_RUN_ID, strategyId = null, limit = 500, offset = 0 } = {}) {
  const d = handle();
  const rows = strategyId
    ? d
        .prepare(
          `SELECT * FROM trades WHERE run_id = ? AND strategy_id = ?
            ORDER BY exit_time DESC LIMIT ? OFFSET ?`
        )
        .all(runId, strategyId, limit, offset)
    : d
        .prepare(
          `SELECT * FROM trades WHERE run_id = ? ORDER BY exit_time DESC LIMIT ? OFFSET ?`
        )
        .all(runId, limit, offset);
  return rows.map(tradeFromRow);
}

/** Oldest-first, for equity curves and drawdown, which need chronological order. */
export function tradesChronological({ runId = LIVE_RUN_ID, strategyId = null } = {}) {
  const d = handle();
  const rows = strategyId
    ? d
        .prepare(`SELECT * FROM trades WHERE run_id = ? AND strategy_id = ? ORDER BY exit_time ASC`)
        .all(runId, strategyId)
    : d.prepare(`SELECT * FROM trades WHERE run_id = ? ORDER BY exit_time ASC`).all(runId);
  return rows.map(tradeFromRow);
}

export function countTrades({ runId = LIVE_RUN_ID, strategyId = null } = {}) {
  const d = handle();
  const row = strategyId
    ? d
        .prepare(`SELECT COUNT(*) AS n FROM trades WHERE run_id = ? AND strategy_id = ?`)
        .get(runId, strategyId)
    : d.prepare(`SELECT COUNT(*) AS n FROM trades WHERE run_id = ?`).get(runId);
  return row?.n ?? 0;
}

// ── Signals ────────────────────────────────────────────────────────────

export function recordSignal({ id, runId, strategyId, underlying, side, barTime, taken, skipReason = null, score = null }) {
  handle()
    .prepare(
      `INSERT OR REPLACE INTO signals (id, run_id, strategy_id, underlying, side, bar_time, taken, skip_reason, score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, runId, strategyId, underlying, side, barTime, taken ? 1 : 0, skipReason, score);
}

/**
 * Recent signals — the stocks a strategy actually selected, including the ones
 * it could not act on and why. Skipped signals matter as much as taken ones:
 * a strategy whose picks are mostly unactionable is not the strategy you think
 * you are running.
 */
export function signals({ runId = LIVE_RUN_ID, strategyId = null, limit = 200 } = {}) {
  const d = handle();
  const rows = strategyId
    ? d
        .prepare(
          `SELECT * FROM signals WHERE run_id = ? AND strategy_id = ?
            ORDER BY bar_time DESC LIMIT ?`
        )
        .all(runId, strategyId, limit)
    : d
        .prepare(`SELECT * FROM signals WHERE run_id = ? ORDER BY bar_time DESC LIMIT ?`)
        .all(runId, limit);

  return rows.map((r) => ({
    id: r.id,
    strategyId: r.strategy_id,
    underlying: r.underlying,
    side: r.side,
    barTime: r.bar_time,
    taken: Boolean(r.taken),
    skipReason: r.skip_reason,
    score: r.score,
  }));
}

/**
 * Skipped-signal counts per strategy since `since`, for skip reasons starting
 * with any of `prefixes` — how the Selective variants restore their "skipped
 * for quality" count after a restart.
 */
export function skipCountsSince({ runId = LIVE_RUN_ID, since, prefixes = [] } = {}) {
  if (!prefixes.length) return [];
  const like = prefixes.map(() => "skip_reason LIKE ?").join(" OR ");
  return handle()
    .prepare(
      `SELECT strategy_id AS strategyId, COUNT(*) AS n FROM signals
        WHERE run_id = ? AND bar_time >= ? AND taken = 0 AND (${like})
        GROUP BY strategy_id`
    )
    .all(runId, since, ...prefixes.map((p) => `${p}%`))
    .map((r) => ({ strategyId: r.strategyId, n: Number(r.n) }));
}

/**
 * Realised P&L grouped by IST calendar day — the "is this working?" series.
 * Grouped in SQL because it is a pure aggregation; the shape-sensitive metrics
 * (drawdown, expectancy) stay in metrics.js where live and backtest share them.
 */
export function dailyPnl({ runId = LIVE_RUN_ID, strategyId = null } = {}) {
  const d = handle();
  const sql = `
    SELECT date(datetime((exit_time + 19800000) / 1000, 'unixepoch')) AS day,
           COUNT(*)          AS trades,
           SUM(net_pnl)      AS netPnl,
           SUM(r_multiple)   AS totalR,
           SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) AS wins
      FROM trades
     WHERE run_id = ? ${strategyId ? "AND strategy_id = ?" : ""}
     GROUP BY day ORDER BY day ASC`;
  return strategyId ? d.prepare(sql).all(runId, strategyId) : d.prepare(sql).all(runId);
}

/**
 * Signal counts grouped by IST calendar day. This is the measure of whether a
 * strategy is actually selective — the reason there is no artificial position
 * cap is that the strategy itself is supposed to be the filter, and this is how
 * that claim gets checked.
 */
export function signalsPerDay({ runId = LIVE_RUN_ID, strategyId = null } = {}) {
  const d = handle();
  const sql = `
    SELECT date(datetime((bar_time + 19800000) / 1000, 'unixepoch')) AS day,
           COUNT(*) AS signals,
           SUM(taken) AS taken
      FROM signals
     WHERE run_id = ? ${strategyId ? "AND strategy_id = ?" : ""}
     GROUP BY day ORDER BY day ASC`;
  return strategyId ? d.prepare(sql).all(runId, strategyId) : d.prepare(sql).all(runId);
}
