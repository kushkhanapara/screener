import { test } from "node:test";
import assert from "node:assert/strict";
import { indicators, dailySignal } from "./dailyStrategies.js";

const day = (n) => new Date(Date.UTC(2024, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);

test("daily momentum surge fires on the first strong day only", () => {
  // Gentle downtrend (RSI low, room to run), then two strong green days.
  const c = Array.from({ length: 60 }, (_, i) => {
    const p = 100 - i * 0.2 + (i % 2 ? 0.3 : -0.3);
    return { time: day(i), open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 100_000 };
  });
  const last = c[c.length - 1].close;
  c.push({ time: day(60), open: last, high: last * 1.03, low: last * 0.998, close: last * 1.025, volume: 100_000 });
  const p2 = c[60].close;
  c.push({ time: day(61), open: p2, high: p2 * 1.03, low: p2 * 0.998, close: p2 * 1.025, volume: 100_000 });
  const ind = indicators(c);
  const nifty = () => 0;
  const first = dailySignal("momentum-surge", c, ind, 60, nifty);
  if (ind.hist[60] > 0) assert.equal(first?.side, "long");
  assert.equal(dailySignal("momentum-surge", c, ind, 61, nifty), null, "not again the next day");
});
