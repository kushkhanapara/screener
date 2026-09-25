import { Router } from "express";
import { describe } from "../core/strategy.js";
import { describeAll } from "../strategies/index.js";
import * as daily from "../services/dailyService.js";
import * as live from "../services/liveService.js";
import * as paper from "../services/paperService.js";
import * as shadow from "../services/shadowService.js";
import * as swing from "../services/swingService.js";
import { upstoxLimiter } from "../data/rateLimiter.js";
import { tokenStatus } from "../data/upstox.js";
import * as candleCache from "../data/candleCache.js";
import { runDataCheck } from "../services/dataCheck.js";
import { HAS_TOKEN } from "../config.js";

export const api = Router();

// Daily (EOD) snapshot ----------------------------------------------------
api.get("/status", (_req, res) => {
  res.json({ ...daily.status(), hasToken: HAS_TOKEN });
});

// The screener's own (standing-state) conditions. Distinct from the traded
// strategies below: this answers "what is matching right now", not "what would
// have been entered".
api.get("/strategy", (_req, res) => {
  res.json({ long: describe("long"), short: describe("short") });
});

// Strategies the paper engine trades, with their entry conditions and exit
// parameters.
api.get("/strategies", (_req, res) => {
  res.json({ strategies: describeAll() });
});

api.post("/refresh", (_req, res) => {
  daily.refresh(); // fire-and-forget background refresh
  res.json({ fetching: true });
});

api.post("/scan", async (_req, res) => {
  try {
    res.json(await daily.scan());
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Live intraday -----------------------------------------------------------
api.get("/live/status", (_req, res) => {
  res.json(live.getStatus());
});

/**
 * Upstream health. Cloudflare's 1015 is invisible from the outside — requests
 * just get slow — so surfacing the limiter's penalty count is the difference
 * between "seeding is working" and "seeding is silently retrying forever".
 */
api.get("/diagnostics", (_req, res) => {
  res.json({
    token: tokenStatus(),
    rateLimiter: upstoxLimiter.stats(),
    candleCache: candleCache.stats(),
  });
});

/**
 * Compare today's in-memory bars and live prices with Upstox's own, for a
 * sample of names. Read-only; costs ~2 REST calls per name.
 * ?n=10 (max 40) or ?symbols=RELIANCE,TCS
 */
api.get("/diagnostics/data-check", async (req, res) => {
  try {
    const n = Math.min(Number(req.query.n) || 10, 40);
    const symbols = req.query.symbols ? String(req.query.symbols).split(",") : null;
    res.json(await runDataCheck({ n, symbols }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

api.get("/diagnostics/feed-raw", (req, res) => {
  res.json(live.debugFeed(String(req.query.key || "")));
});

// Paper trading -----------------------------------------------------------
api.get("/paper/status", (_req, res) => {
  res.json(paper.getStatus());
});

/** Full snapshot: open positions + metrics for every strategy. */
api.get("/paper/snapshot", (_req, res) => {
  res.json(paper.getSnapshot());
});

api.get("/paper/positions", (req, res) => {
  res.json({ positions: paper.getOpenPositions(req.query.strategy || null) });
});

api.get("/paper/trades", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json({
    trades: paper.getTrades({ strategyId: req.query.strategy || null, limit, offset }),
  });
});

api.get("/paper/metrics", (req, res) => {
  res.json({ metrics: paper.getMetrics(req.query.strategy || null) });
});

/** Stocks a strategy selected, including ones it could not act on. */
api.get("/paper/signals", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json({ signals: paper.getSignals(req.query.strategy || null, limit) });
});

api.get("/paper/activity", (req, res) => {
  res.json({ activity: paper.getActivity(Math.min(Number(req.query.limit) || 40, 200)) });
});

/** Trade review. ?days=7 (default), ?days=all, ?strategy=<id> */
api.get("/paper/report", (req, res) => {
  const raw = req.query.days;
  const days = raw === "all" ? null : Math.min(Math.max(Number(raw) || 7, 1), 365);
  res.json(paper.getReport({ days, strategyId: req.query.strategy || null }));
});

api.get("/paper/daily", (req, res) => {
  res.json({ daily: paper.getDailyPnl(req.query.strategy || null) });
});

// Multi-day paper book (kept separate from the intraday totals) -------------
api.get("/swing/snapshot", (_req, res) => {
  res.json(swing.getSnapshot());
});

// Shadow logging (single-slot strategy, phase B) ---------------------------
api.get("/shadow/snapshot", (_req, res) => {
  res.json(shadow.getSnapshot());
});

/** ?days=30 (default), ?days=all */
api.get("/shadow/summary", (req, res) => {
  const raw = req.query.days;
  const days = raw === "all" ? null : Math.min(Math.max(Number(raw) || 30, 1), 365);
  res.json(shadow.getSummary({ days }));
});
