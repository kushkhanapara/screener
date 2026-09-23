import { barTimeMs, istMinutes, istDateString } from "../core/session.js";

/**
 * Average volume of the same time-of-day bar over previous sessions.
 *
 * A raw rolling average makes every 9:30 bar look significant; comparing a bar
 * only with the same slot on earlier days removes the intraday volume curve.
 * Only prior sessions are used — today's bars are tick-built, and tick volume
 * under-reports against the REST candles the history was seeded from.
 */
export function timeOfDayNorm(bars, slotMin, sessionDate, { minSessions = 3, maxSessions = 20 } = {}) {
  const byDate = new Map();
  for (const b of bars ?? []) {
    const t = barTimeMs(b.time);
    if (!Number.isFinite(t) || istMinutes(t) !== slotMin) continue;
    const day = istDateString(t);
    if (day >= sessionDate) continue;
    const v = Number(b.volume);
    if (!(v > 0)) continue;
    byDate.set(day, v);
  }

  const vols = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-maxSessions)
    .map((e) => e[1]);

  if (vols.length < minSessions) return { avg: null, sessions: vols.length };
  return { avg: vols.reduce((x, y) => x + y, 0) / vols.length, sessions: vols.length };
}
