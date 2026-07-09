# NSE Stock-Futures Screener

A local-first web app that screens **NSE single-stock futures** against ONE fixed
technical strategy — with a **live intraday** scoreboard (per-minute) and a
**daily snapshot** — all powered by Upstox.

- **Backend:** Node + Express (long-running), one persistent Upstox V3 WebSocket,
  in-memory caches.
- **Frontend:** React + Vite + Tailwind + shadcn/ui.
- **One service, one URL:** in production Express serves the built React app.

> ⚠️ Flags **technical matches only** against a fixed strategy. Not investment
> advice; places no trades.

---

## How it works

Two views, same indicators + strategy — only the candle size and data source differ:

| View | Candle | Source | Notes |
|------|--------|--------|-------|
| **Live** (intraday) | 1-minute | Upstox V3 tick feed (ltpc) | Re-evaluated every minute; count moves up/down as the market moves. |
| **End of day** (daily) | 1-day | Upstox Historical | A "Run screen" snapshot. Single-stock futures are short-lived, so many contracts are **skipped** for `<60` daily bars — this is expected and shown in the UI. |

The universe (~625 contracts across ~210 F&O stocks, all active monthly expiries)
is derived from the Upstox instrument master at startup. Index futures are excluded.

### The strategy lives in ONE file

Edit **`server/core/strategy.js`** — the `checks[]` array is the single source of
truth for the daily screen, the live matching set, and the description shown in
the UI. Nothing else changes when you tweak it. The placeholder (LONG setup):

1. RSI(14) crosses above 30 from below
2. MACD crosses above its signal line
3. Price above the 50-period MA

Row fields available to a check: `close, rsi14, macd, macdSignal, macdHist,
ma20, ma50, ma200, ema9, ema21`. Note `ma200` may be `null` when history is
short — guard for it (`l.ma200 != null && l.close > l.ma200`).

---

## Run locally

Requires **Node 20+**.

```bash
# 1. Install everything (root server deps + client deps)
npm run install:all

# 2. Configure the token
cp .env.example .env
#   then edit .env and set UPSTOX_ANALYTICS_TOKEN=... (see below)

# 3a. Dev mode (Express API + Vite with hot reload)
npm run dev
#   -> open http://localhost:5173  (Vite proxies /api + /ws to the server)

# 3b. Production-style (single URL)
npm run build      # builds client/dist
npm start          # Express serves the app + API on http://localhost:8080
```

Without a token the app still runs — it shows a clear "token not set" state and
the daily/live data stays empty until you add one.

### Verify the internals (no token needed)

```bash
npm run verify:core       # deterministic indicator + strategy math
npm run verify:universe   # fetches the public instrument master, prints the universe
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

---

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Daily cache: `{ updatedAt, loaded, total, skipped, fetching, hasToken }` |
| GET | `/api/strategy` | `{ conditions: [...] }` from the checks list |
| POST | `/api/refresh` | Background refresh of the daily cache |
| POST | `/api/scan` | Contracts passing the strategy (from cache) |
| GET | `/api/live/status` | `{ connected, marketOpen, hasToken, lastTickTs, subscribed, count }` |
| WS | `/ws/live` | Per-minute `{ type:"update", count, matching, entered, exited, ts }` |

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
  core/        indicators.js, strategy.js (EDIT HERE), rows.js   ← shared by both views
  data/        instruments.js (universe), upstox.js (REST candles)
  live/        candleStore.js, seed.js, upstoxFeed.js            ← live pipeline
  services/    dailyService.js, liveService.js
  routes/      api.js
  ws/          liveSocket.js
  scripts/     verifyCore.js, verifyUniverse.js
  index.js     Express entry (serves client/dist in prod)
client/
  src/components/ui/     shadcn primitives
  src/components/        StatusBar, StrategyCard, ResultsTable, daily/, live/
  src/hooks/useLiveSocket.js
```
