import { Router } from "express";
import { describe } from "../core/strategy.js";
import * as daily from "../services/dailyService.js";
import * as live from "../services/liveService.js";
import { HAS_TOKEN } from "../config.js";

export const api = Router();

// Daily (EOD) snapshot ----------------------------------------------------
api.get("/status", (_req, res) => {
  res.json({ ...daily.status(), hasToken: HAS_TOKEN });
});

api.get("/strategy", (_req, res) => {
  res.json({ conditions: describe() });
});

api.post("/refresh", (_req, res) => {
  daily.refresh(); // fire-and-forget background refresh
  res.json({ fetching: true });
});

api.post("/scan", (_req, res) => {
  res.json(daily.scan());
});

// Live intraday -----------------------------------------------------------
api.get("/live/status", (_req, res) => {
  res.json(live.getStatus());
});
