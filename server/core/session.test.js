import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sessionStartMs,
  sessionEndMs,
  isSameSession,
  sessionBars,
  anchoredVwap,
  sessionOpen,
  pctFromSessionOpen,
  sessionVolume,
  istMinutes,
  istDateString,
  barTimeMs,
} from "./session.js";

/** Epoch ms for a given IST wall-clock time. IST is UTC+05:30, no DST. */
const ist = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh - 5, mm - 30);

// 2026-09-11 is a Friday.
const FRI_OPEN = ist(2026, 9, 11, 9, 15);

test("istMinutes converts to minutes-from-midnight IST", () => {
  assert.equal(istMinutes(FRI_OPEN), 9 * 60 + 15);
  assert.equal(istMinutes(ist(2026, 9, 11, 15, 30)), 15 * 60 + 30);
});

test("istDateString reports the IST calendar day, not the UTC one", () => {
  // 01:00 IST is still the previous day in UTC — the IST date must win.
  assert.equal(istDateString(ist(2026, 9, 11, 1, 0)), "2026-09-11");
});

test("sessionStartMs anchors to 09:15 IST for a timestamp during the session", () => {
  assert.equal(sessionStartMs(ist(2026, 9, 11, 11, 30)), FRI_OPEN);
  assert.equal(sessionStartMs(FRI_OPEN), FRI_OPEN);
});

test("sessionStartMs after the close still belongs to that day's session", () => {
  assert.equal(sessionStartMs(ist(2026, 9, 11, 20, 0)), FRI_OPEN);
});

test("sessionStartMs before the open rolls back to the previous session", () => {
  // 08:00 IST Friday is before Friday's open -> Thursday's session.
  assert.equal(sessionStartMs(ist(2026, 9, 11, 8, 0)), ist(2026, 9, 10, 9, 15));
});

test("sessionStartMs skips back over the weekend", () => {
  // 08:00 IST Monday -> previous session is Friday, not Sunday.
  assert.equal(sessionStartMs(ist(2026, 9, 14, 8, 0)), FRI_OPEN);
  // Anywhere on Saturday also resolves to Friday's session.
  assert.equal(sessionStartMs(ist(2026, 9, 12, 12, 0)), FRI_OPEN);
});

test("sessionEndMs is 15:30 IST", () => {
  assert.equal(sessionEndMs(FRI_OPEN), ist(2026, 9, 11, 15, 30));
});

test("isSameSession separates adjacent trading days", () => {
  assert.ok(isSameSession(ist(2026, 9, 11, 9, 20), ist(2026, 9, 11, 15, 0)));
  assert.ok(!isSameSession(ist(2026, 9, 11, 11, 0), ist(2026, 9, 10, 11, 0)));
});

// ── Session-scoped aggregates ──────────────────────────────────────────

/** One bar `minsAfterOpen` into Friday's session. */
const bar = (minsAfterOpen, { o, h, l, c, v }) => ({
  time: FRI_OPEN + minsAfterOpen * 60000,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
});

const PREV_DAY_BAR = {
  time: ist(2026, 9, 10, 14, 0),
  open: 50,
  high: 50,
  low: 50,
  close: 50,
  volume: 99999,
};

const BARS = [
  PREV_DAY_BAR, // must be excluded from every session aggregate
  bar(0, { o: 100, h: 102, l: 98, c: 100, v: 1000 }), // typical 100
  bar(3, { o: 100, h: 106, l: 104, c: 105, v: 3000 }), // typical 105
];

const NOW = ist(2026, 9, 11, 11, 0);

test("sessionBars drops bars from the previous session", () => {
  const out = sessionBars(BARS, NOW);
  assert.equal(out.length, 2);
  assert.ok(out.every((b) => b.time >= FRI_OPEN));
});

test("anchoredVwap is volume-weighted and ignores prior sessions", () => {
  // (100*1000 + 105*3000) / 4000 = 103.75
  assert.ok(Math.abs(anchoredVwap(BARS, NOW) - 103.75) < 1e-9);
});

test("anchoredVwap returns null when the session has no volume", () => {
  const zeroVol = [bar(0, { o: 100, h: 102, l: 98, c: 100, v: 0 })];
  assert.equal(anchoredVwap(zeroVol, NOW), null);
  assert.equal(anchoredVwap([], NOW), null);
  // Only prior-session bars carry volume -> still null for this session.
  assert.equal(anchoredVwap([PREV_DAY_BAR], NOW), null);
});

test("sessionOpen takes the first bar of the session", () => {
  assert.equal(sessionOpen(BARS, NOW), 100);
  assert.equal(sessionOpen([], NOW), null);
});

test("pctFromSessionOpen measures open -> latest close", () => {
  assert.ok(Math.abs(pctFromSessionOpen(BARS, NOW) - 5) < 1e-9); // 100 -> 105
  assert.equal(pctFromSessionOpen([], NOW), null);
});

test("sessionVolume excludes prior sessions", () => {
  assert.equal(sessionVolume(BARS, NOW), 4000);
});

// REST candles carry `time` as an ISO string while CandleStore rewrites it to a
// number. A string compared against epoch ms is false for every bar, which
// silently yields an empty session — zero volume, null VWAP, null change —
// instead of an error, so a strategy would just never fire for no visible reason.
test("ISO-string timestamps are accepted, not silently treated as absent", () => {
  const iso = BARS.map((b) => ({ ...b, time: new Date(b.time).toISOString() }));

  assert.equal(sessionBars(iso, NOW).length, 2, "string times must still resolve");
  assert.equal(sessionVolume(iso, NOW), 4000);
  assert.equal(sessionOpen(iso, NOW), 100);
  assert.ok(Math.abs(anchoredVwap(iso, NOW) - 103.75) < 1e-9);
  assert.ok(Math.abs(pctFromSessionOpen(iso, NOW) - 5) < 1e-9);
});

test("barTimeMs normalises both candle timestamp shapes", () => {
  assert.equal(barTimeMs(FRI_OPEN), FRI_OPEN);
  assert.equal(barTimeMs(new Date(FRI_OPEN).toISOString()), FRI_OPEN);
  assert.equal(barTimeMs("2026-09-11T09:15:00+05:30"), FRI_OPEN);
  assert.ok(Number.isNaN(barTimeMs("not a date")));
});

test("a mix of both timestamp shapes still aggregates correctly", () => {
  const mixed = [
    { ...BARS[0] },
    { ...BARS[1], time: new Date(BARS[1].time).toISOString() },
    { ...BARS[2] },
  ];
  assert.equal(sessionVolume(mixed, NOW), 4000);
});
