-- Paper-trading store.
--
-- `run_id` is what keeps live results and backtest runs in one database without
-- ever contaminating each other: live paper trading writes under a 'live' run,
-- every backtest under its own generated id, and each query filters by it.

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,            -- 'live' | 'backtest'
  strategy_id  TEXT,                     -- null when a run spans all strategies
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  params       TEXT,                     -- JSON: date range, exit + cost config
  notes        TEXT
);

-- OPEN positions only. A close deletes the row here and inserts into `trades`
-- inside one transaction, so a crash can never leave a position both open and
-- recorded as closed.
CREATE TABLE IF NOT EXISTS positions (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  strategy_id      TEXT NOT NULL,
  underlying       TEXT NOT NULL,
  fut_key          TEXT,
  fut_label        TEXT,
  side             TEXT NOT NULL,        -- 'long' | 'short'

  signal_bar_time  INTEGER,
  signal_tf        TEXT,
  reasons          TEXT,                 -- JSON array

  entry_time       INTEGER NOT NULL,
  entry_price      REAL NOT NULL,
  lots             INTEGER NOT NULL,
  lot_size         INTEGER NOT NULL,
  qty              INTEGER NOT NULL,

  initial_stop     REAL NOT NULL,
  current_stop     REAL NOT NULL,
  atr_at_entry     REAL,
  risk_per_unit    REAL NOT NULL,        -- price distance equal to 1R

  high_water       REAL NOT NULL,        -- drives the trail and MFE/MAE
  low_water        REAL NOT NULL,
  breakeven_moved  INTEGER NOT NULL DEFAULT 0,
  bars_held        INTEGER NOT NULL DEFAULT 0,

  cash_price_at_signal REAL,
  basis_at_entry       REAL,
  state            TEXT NOT NULL DEFAULT 'open'
);

CREATE INDEX IF NOT EXISTS idx_positions_run ON positions(run_id, strategy_id);

-- One row per CLOSED trade.
CREATE TABLE IF NOT EXISTS trades (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  strategy_id      TEXT NOT NULL,
  underlying       TEXT NOT NULL,
  fut_key          TEXT,
  fut_label        TEXT,
  side             TEXT NOT NULL,

  signal_bar_time  INTEGER,
  signal_tf        TEXT,
  reasons          TEXT,

  entry_time       INTEGER NOT NULL,
  entry_price      REAL NOT NULL,
  lots             INTEGER NOT NULL,
  lot_size         INTEGER NOT NULL,
  qty              INTEGER NOT NULL,

  initial_stop     REAL NOT NULL,
  atr_at_entry     REAL,
  risk_per_unit    REAL NOT NULL,
  rupee_risk       REAL NOT NULL,

  exit_time        INTEGER NOT NULL,
  exit_price       REAL NOT NULL,
  exit_reason      TEXT NOT NULL,        -- stop|breakeven|trail|target|time|squareoff

  gross_pnl        REAL NOT NULL,
  costs            REAL NOT NULL,
  net_pnl          REAL NOT NULL,
  r_multiple       REAL NOT NULL,

  mae              REAL,                 -- max adverse excursion, in R
  mfe              REAL,                 -- max favourable excursion, in R
  bars_held        INTEGER,
  cash_price_at_signal REAL,
  basis_at_entry       REAL
);

CREATE INDEX IF NOT EXISTS idx_trades_run_strategy ON trades(run_id, strategy_id);
CREATE INDEX IF NOT EXISTS idx_trades_entry_time   ON trades(entry_time);
CREATE INDEX IF NOT EXISTS idx_trades_exit_time    ON trades(exit_time);

-- Signals that fired but were not taken (already in a position, no price, etc).
-- Kept because "how selective is this strategy?" is answered by signal count,
-- not trade count, and without a cap the two should be nearly equal.
CREATE TABLE IF NOT EXISTS signals (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  strategy_id  TEXT NOT NULL,
  underlying   TEXT NOT NULL,
  side         TEXT NOT NULL,
  bar_time     INTEGER NOT NULL,
  taken        INTEGER NOT NULL DEFAULT 0,
  skip_reason  TEXT,
  score        REAL
);

CREATE INDEX IF NOT EXISTS idx_signals_run ON signals(run_id, strategy_id, bar_time);

-- Shadow logging: one summary row per evaluated bar, with rejection counts per
-- gate across the whole universe.
CREATE TABLE IF NOT EXISTS shadow_bars (
  config_id      TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  session_date   TEXT NOT NULL,
  bar_time       INTEGER NOT NULL,
  eligible       INTEGER NOT NULL,
  passed         INTEGER NOT NULL,
  top_score      REAL,
  top_underlying TEXT,
  rejects        TEXT,          -- JSON {rejectCode: count}
  meta           TEXT,          -- JSON: ban list status, OI baseline, volume checks
  PRIMARY KEY (config_id, bar_time)
);

CREATE INDEX IF NOT EXISTS idx_shadow_bars_day ON shadow_bars(config_id, session_date);

-- Per-name detail for every name that cleared the relative-strength gate: the
-- ones that passed everything, and the near misses that decide which filters
-- actually change outcomes.
CREATE TABLE IF NOT EXISTS shadow_evals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id      TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  session_date   TEXT NOT NULL,
  bar_time       INTEGER NOT NULL,
  underlying     TEXT NOT NULL,
  side           TEXT,
  passed         INTEGER NOT NULL,
  reject_code    TEXT,
  rank           INTEGER,
  score          REAL,
  gates          TEXT,
  components     TEXT,
  inputs         TEXT
);

CREATE INDEX IF NOT EXISTS idx_shadow_evals_bar ON shadow_evals(config_id, bar_time);
CREATE INDEX IF NOT EXISTS idx_shadow_evals_name ON shadow_evals(underlying, session_date);
