# NSE Stock-Futures Screener & Paper Trader

A local-first web app for **NSE single-stock futures**: an auto **paper-trading
engine** that runs two strategies side by side on live Upstox data with full
entry/exit lifecycle and measured results, plus a **live intraday** screener and
a **daily snapshot**.

- **Backend:** Node + Express (long-running), one persistent Upstox V3 WebSocket,
  SQLite for trades.
- **Frontend:** React + Vite + Tailwind + shadcn/ui.
- **One service, one URL:** in production Express serves the built React app.

> ⚠️ Paper trading only — it places **no real orders**. Flags technical matches
> against fixed strategies. Not investment advice.

---

## How it works

Three views:

| View | What it is | Source |
|------|-----------|--------|
| **Paper** | Auto paper trading. Two strategies, real entry/exit lifecycle, persisted trades and metrics. | Live ticks + SQLite |
| **Live** | The screener: what matches *right now* (provisional, re-read each minute). | Upstox V3 tick feed |
| **End of day** | A "Run screen" snapshot on daily cash candles. | Upstox Historical |

The universe (~625 contracts across ~210 F&O stocks) is derived from the Upstox
instrument master at startup. Index futures are excluded from the universe, but
NIFTY 50 spot is subscribed separately for relative strength.

### Paper trading

The split that makes the results trustworthy:

- **Entries are decided on CLOSED cash bars.** Evaluating a still-forming bar is
  what makes signals repaint — a 15m bar re-read every minute gives fifteen
  different answers, so a "signal" can vanish before you could act on it.
- **Exits are managed on LIVE futures ticks.** Checking stops only at bar close
  records a mid-bar stop breach at the bar's closing price, which flatters
  results, sometimes enormously.
- **Fills are priced on the near-month future**, because that is the instrument
  actually traded. Basis is recorded on every trade.
- **Costs are always deducted** — brokerage, STT, exchange, SEBI, stamp, GST —
  and R-multiples are computed on *net* P&L. On a ₹5L notional with a 0.5% stop,
  costs eat 6–16% of every R, so ignoring them reports an edge that does not
  survive a broker.

Sizing is **one lot, fixed**, so R is the comparable unit across names and
strategies; rupee P&L is secondary.

### Capital is the binding constraint

Each strategy trades a fixed account (`CAPITAL_PER_STRATEGY`, default
₹2,00,000). A position blocks margin (`FUTURES_MARGIN_PCT`, default 20% of
contract value) until it closes, so the next signal can only be taken if enough
is free — exactly as in a real account.

This matters more than it sounds. Against a ₹2L account the median F&O lot needs
**₹1.32L of margin**, so a typical name allows **one concurrent position**; only
the cheapest (VEDL at ₹60k) allow three, and 9% of the universe can never be
traded at all. Which signal gets taken therefore decides almost the whole
result, so candidates are **ranked by the strategy's score** each pass and the
best one claims the free margin — rather than whichever name happened to sort
first alphabetically.

### Charges come from Upstox, not a table of rates

`paper/charges.js` calibrates each contract against the live
`/v2/charges/brokerage` endpoint and applies the real brokerage, STT, stamp
duty, exchange and GST. This was not cosmetic: the previous hardcoded model put
STT on a ₹7.1L futures sell at ₹88.75 where Upstox actually charges **₹355** —
understating a round trip by roughly **2.7×**. Since costs are deducted before R
is computed, that error flattered every metric derived from it.

One call per contract per side yields the flat fee plus the turnover-proportional
rates, which are then applied locally to every fill, so this costs two API calls
per contract rather than two per trade. If the API is unavailable the estimated
model is used and the trade records `costSource: "estimated"`.

Exits are ATR-based and shared by both strategies, so a comparison isolates the
entry logic: stop at N×ATR, break-even at +1R, ATR trail behind the high-water
mark, a target in R, a time stop for dead trades, and a hard square-off at 15:15
IST.

There is deliberately **no cap on concurrent positions** — the strategy is meant
to be the filter. `signals/day` is a first-class metric so you can check that
claim: a strategy firing dozens of signals on a trending day is not being
selective, and the fix belongs in the strategy.

### Strategies live in `server/strategies/`

Add a file, add one line to `index.js`, and it appears in the UI and the engine.
Each exports its conditions, timeframes, exit parameters and an `evaluate(ctx)`.

- **Momentum Surge** — an intraday port of the `ST_Signal` logic from
  `screener.py`: a >1.2% move from today's open, confirmed by 15m RSI and MACD,
  with a gap guard and a liquidity floor.
- **Trend Momentum** — 15m trend gate (SMA34 vs SMA200, price vs SMA34) with a 3m
  momentum trigger (EMA5 vs SMA34, RSI). Fires on the bar the setup *completes*,
  not while it persists.
- **VWAP Relative Strength** — session-anchored VWAP, plus the stock must outrun
  NIFTY, entered on a pullback-and-reclaim rather than a breakout, with ATR and
  liquidity floors.

#### Porting `screener.py` — what changed and why

The Python screener produced a once-a-day Excel ranking. Four changes were
needed to make it a tradable intraday strategy:

| Python | Here | Why |
|---|---|---|
| RSI/MACD on **daily** candles | **15m** candles | Daily indicators barely move during a session, so intraday they act as a constant and only `pct` varies. The Python's own notes anticipated this switch. |
| `pct` from **previous close** (`net_change`) | from **today's open** | The original includes the overnight gap, so a stock that gapped +2% then drifted sideways reads as a +2% "surge". |
| — | **gap guard** | Follows from the above: the move must be something the session produced. |
| `Strong` and `Bias` tiers | **`Strong` only** | The `Bias` tier drops the RSI guard, which is the only rule preventing entry at the top of an extended move. |

Two things in the original worth knowing about, left as-is but documented:

- **`ST_Score` is close to a raw volume ranking.** Its `(volume/1e6)*2` term
  dwarfs the rest: a 1.5% move on 15m shares scores ~38, a 3% move on 0.3m
  shares ~12. It is used here for display ordering only, never as a gate.
- **The RSI is a *ceiling* for longs** (`< 68`, avoid overbought), which is close
  to the opposite of Trend Momentum's `>= 60` (demand strength). Both are
  defensible; they are different bets. Running them side by side is the point.

`ctx` carries `rows` per timeframe, `atr`, `vwap`, `relStrength`, `sessionVolume`
and more. `ma200` may be `null` when history is short — guard for it.

#### VWAP + Volume Profile (paper trading, own exit engine)

Everything for this strategy lives in `server/strategies/vwapvp/`. It is in the
live registry, so paper trading runs it beside the others, on any day type. Its
exits go through its own engine (`vwapvp/engine.js`), which sits on top of the
shared paper engine without changing it; the paper service picks it up from
`strategy.engine`. Its levels are read off the cash chart and moved onto the
futures contract at entry, and are saved with the position so a restart
mid-trade keeps them. Its trend-only and rotation-only books run in the replay
only (`--vwapvp`).

The strategy trades Trader Dale's two setups on 3m cash bars: a pullback into
VWAP (or the 1σ band) when the session VWAP slopes, and a band-to-VWAP rotation
when it is flat. A touch alone never trades: the level needs at least two of
*close near it*, *a dual POC there* (the consolidation box's and the trend
leg's volume profiles agree), and *a prior swing high/low*. Stops sit 1 ATR
behind that zone, a bar *closing* beyond the zone ends the trade
(`invalidated`), rotation targets VWAP, and trend trades move to break-even at
the prior swing and then trail 1.5 ATR.

```bash
npm run replay -- --vwapvp     # cached sessions, beside VWAP Snap-back
npm run replay:vwapvp          # 12 months
```

---

## Run locally

Requires **Node 22.5+** (the SQLite store uses `node:sqlite`).

```bash
# 1. Install everything (root server deps + client deps)
npm run install:all

# 2. First-run setup: token, folders, your own database, and a check that
#    Upstox answers. Asks for the token, or take it from the command line.
npm run setup
#   npm run setup -- --token=...   non-interactive
#   npm run setup -- --warm        also caches today's daily candles (~1 min)
#   npm run setup -- --db=data/my.db   database somewhere else

# 3a. Dev mode (Express API + Vite with hot reload)
npm run dev
#   -> open http://localhost:5173  (Vite proxies /api + /ws to the server)

# 3b. Production-style (single URL)
npm run build      # builds client/dist
npm start          # Express serves the app + API on http://localhost:8080
```

Without a token the app still runs — it shows a clear "token not set" state and
the daily/live data stays empty until you add one.

### Nothing personal is in this repository

Each person who clones it gets their own token and their own results:

- **The token** lives in `.env`, which git ignores. `npm run setup` writes it
  there; `.env.example` only documents the variable names.
- **The database** (`data/screener.db`) is created empty on first run, by
  `npm run setup` or by the server itself. Paper trades, positions and metrics
  accumulate locally. **Back that one file up yourself** — it is not in git and
  cannot be rebuilt.
- **`data/` as a whole is ignored**, including `data/cache` (downloaded candles,
  which re-download on demand and can grow to gigabytes) and `data/logs`.

### Verify the internals (no token needed)

```bash
npm test                  # full suite: indicators, session, strategies,
                          # exit state machine, costs, SQLite store, metrics
npm run verify:universe   # fetches the public instrument master, prints the universe
```

To exercise the Paper UI without waiting for a market session, seed a scratch
database with synthetic trades (it refuses to touch the real one):

```bash
PAPER_DB_PATH=data/demo.db node server/scripts/seedDemoTrades.js
```

---

## Getting the Upstox Analytics Token

The **Analytics Token** is a 1-year, read-only token that needs no daily OAuth
refresh — ideal for a long-running screener.

1. Go to the **Upstox Developer Apps** page and open the **Analytics** tab.
2. Generate the token (1-year validity, read-only; only one active per account —
   regenerating revokes the previous one).
3. Put it in `.env`:
   ```
   UPSTOX_ANALYTICS_TOKEN=your_token_here
   ```

It authorizes the market-data WebSocket **and** the Historical/Intraday candle
APIs. It stays server-side and is **never** sent to the browser.

---

## Configuration (`.env`)

| Var | Default | Purpose |
|-----|---------|---------|
| `UPSTOX_ANALYTICS_TOKEN` | — | Required for daily + live data. |
| `PORT` | `8080` | Express port (also serves the built app in prod). |
| `EXPIRY_POLICY` | `all` | `all` active expiries, or `near-next` (two nearest per underlying). |
| `EXCLUDE_UNDERLYINGS` | index list | Comma-separated underlyings to exclude (index futures). |
| `DAILY_LOOKBACK_DAYS` | `400` | Daily history window per contract. |
| `MIN_BARS` | `60` | Minimum bars before indicators are computed. |
| `UPSTOX_RPS` | `5` | Requests/second ceiling — see the rate-limit note below. |
| `UPSTOX_RPM` | `180` | Requests/minute ceiling. |
| `CANDLE_CACHE` | `1` | On-disk historical candle cache; `0` disables. |
| `PAPER_DB_PATH` | `data/screener.db` | SQLite file holding paper trades. |

### A note on candle endpoints

Upstox has **two** candle endpoints and you need both:

- `/historical-candle/…/{to}/{from}` returns **completed trading days only**. A
  range ending *today* still stops at yesterday's close.
- `/historical-candle/intraday/…` returns **today's** bars, 09:15 to now.

Seeding from the historical endpoint alone leaves the current session empty —
no session VWAP, no session volume, and "move from the open" measured against a
bar that isn't today's open. Strategies gated on any of those simply never fire,
silently. `live/seed.js` fetches both and merges them; because its historical
range ends *yesterday*, that half is immutable and cached permanently, so only
the small intraday call repeats on restart.

### A note on rate limits

Upstox **documents** 50 req/s, but the API sits behind Cloudflare, which enforces
a much stricter *sustained-rate* rule and answers `429 / error code: 1015`. Once
tripped it keeps rejecting for several minutes even after all traffic stops.
Seeding ~420 candle requests at boot trips it at the documented rates.

So the defaults here are deliberately far below what the docs allow (~180/min,
measured safe), a global circuit breaker pauses **all** traffic on a 1015 rather
than letting each request retry into the same wall, and historical candles are
cached on disk so restarts don't re-fetch immutable data. A cold start still
takes a couple of minutes to seed; subsequent restarts are near-instant.

---

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Daily cache: `{ updatedAt, loaded, total, skipped, fetching, hasToken }` |
| GET | `/api/strategy` | The screener's own standing-state conditions |
| GET | `/api/strategies` | Tradable strategies: conditions, timeframes, exit params |
| POST | `/api/refresh` | Background refresh of the daily cache |
| POST | `/api/scan` | Contracts passing the screen (from cache) |
| GET | `/api/live/status` | `{ connected, marketOpen, hasToken, lastTickTs, subscribed, counts }` |
| GET | `/api/paper/status` | Engine health: open positions, signals, trades closed |
| GET | `/api/paper/snapshot` | Open positions + metrics for every strategy |
| GET | `/api/paper/positions` | Open positions (`?strategy=`) |
| GET | `/api/paper/trades` | Closed trades (`?strategy=&limit=&offset=`) |
| GET | `/api/paper/metrics` | Metrics for one strategy (`?strategy=`) |
| WS | `/ws/live` | Two frame types on one socket: `{type:"update"}` (screener) and `{type:"paper"}` (engine) |

---

## Hosting (later)

Any single long-running Node host (Render / Railway / Fly.io):
build `npm run build`, start `npm start`, set `UPSTOX_ANALYTICS_TOKEN`, and add a
weekday post-close cron hitting `POST /api/refresh`. Serverless won't work — the
app needs the persistent cache and the persistent Upstox socket.

---

## Project layout

```
server/
  core/        indicators.js (+atr), rows.js, session.js (VWAP, boundaries),
               strategy.js  ← the screener's own conditions
  strategies/  index.js (registry), context.js, trendMomentum.js,
               vwapRelativeStrength.js        ← EDIT/ADD STRATEGIES HERE
  paper/       engine.js (exit state machine), costs.js, metrics.js,
               store.js (SQLite), schema.sql
  data/        instruments.js, upstox.js, candleCache.js, rateLimiter.js
  live/        candleStore.js, seed.js, upstoxFeed.js
  services/    dailyService.js, liveService.js, paperService.js
  routes/      api.js
  ws/          liveSocket.js
  scripts/     verifyUniverse.js, seedDemoTrades.js
  **/*.test.js node:test suites (npm test)
  index.js     Express entry (serves client/dist in prod)
client/
  src/components/ui/     shadcn primitives
  src/components/        StatusBar, StrategyCard, ResultsTable, daily/, live/,
                         paper/ (PaperTab, StrategyPanel, PositionsTable,
                                 TradesTable, Sparkline)
  src/hooks/useLiveSocket.ts   one socket, both frame types
```

Only ONE Upstox WebSocket may be open (the free tier 403s a second one), so
`liveService` owns it and `paperService` registers its keys and tick handler
through `registerKeys()` / `onTick()`.
