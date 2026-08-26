/**
 * npx tsx scripts/daily-ingest.check.ts   (CI runs it as `npm run check`)
 *
 * Locks the npm per-day contract that replaced the carry-forward bug of
 * 2026-08-10..19: the ingest used to ask point/last-day — which answers with
 * the last day npm COLLECTED, not the last calendar day — and stamped that
 * number on the run date. When npm's stats pipeline stalled for a week, seven
 * consecutive observed_on dates got byte-identical values and the /loom
 * weekly rollup showed a 19,403-vs-45,927 crash that never happened.
 *
 * Contract under test, both directions (a quiet probe proves nothing without
 * a positive control):
 *   1. rows DO come out, keyed by npm's own day — positive control first;
 *   2. no row is ever emitted for a day npm did not report (the stall case —
 *      the old code fabricated exactly these rows);
 *   3. npm's zero-padding of not-yet-collected trailing days is dropped,
 *      while a real mid-series zero survives;
 *   4. d7/d30 are trailing sums ending at each row's own day;
 *   5. the tripwire counts identical trailing days, and a single changed
 *      value resets it.
 *
 * Pure functions only — no network, no database, no secrets.
 */
import assert from "node:assert/strict";

import {
  computeNpmDailyRows,
  trailingIdenticalDays,
  type NpmRangeDay,
} from "./npm-daily.js";

const DAY_MS = 86_400_000;
const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** `count` consecutive days ending at `end` (inclusive), fixed values. */
function series(
  end: string,
  count: number,
  value: (i: number) => number,
): NpmRangeDay[] {
  const endT = new Date(end).getTime();
  return Array.from({ length: count }, (_, i) => ({
    day: isoDay(endT - (count - 1 - i) * DAY_MS),
    downloads: value(i),
  }));
}

// ── 1. Positive control: rows come out keyed by npm's day ────────────────────
{
  const input = series("2026-08-25", 60, (i) => 100 + i);
  const rows = computeNpmDailyRows(input, 30);
  assert.equal(rows.length, 30, "backfillDays trims to the trailing 30");
  assert.equal(rows[rows.length - 1]!.day, "2026-08-25", "last row = last npm day");
  assert.equal(rows[rows.length - 1]!.d1, 159, "d1 is that day's own count");
  assert.equal(rows[0]!.day, "2026-07-27", "oldest kept day is 30 days back");
}

// ── 2. The stall: npm's last collected day is 5 days old ─────────────────────
// The old code would have stamped day-155's value onto 2026-08-25 (the run
// date). The contract: every emitted day exists in the input, and nothing
// newer than npm's last collected day is ever fabricated.
{
  const input = series("2026-08-20", 40, (i) => 100 + i);
  const rows = computeNpmDailyRows(input, 30);
  const inputDays = new Set(input.map((d) => d.day));
  for (const r of rows) {
    assert.ok(inputDays.has(r.day), `fabricated day ${r.day} not in npm data`);
  }
  assert.equal(
    rows[rows.length - 1]!.day,
    "2026-08-20",
    "nothing newer than npm's last collected day",
  );
}

// ── 3. Zero-padding dropped; real mid-series zero kept ───────────────────────
{
  const padded = [
    ...series("2026-08-23", 40, () => 10),
    { day: "2026-08-24", downloads: 0 },
    { day: "2026-08-25", downloads: 0 },
  ];
  const rows = computeNpmDailyRows(padded, 30);
  assert.equal(
    rows[rows.length - 1]!.day,
    "2026-08-23",
    "trailing zero-pad is not written",
  );

  const midZero = series("2026-08-25", 40, (i) => (i === 35 ? 0 : 10));
  const zeroDay = midZero[35]!.day;
  const rows2 = computeNpmDailyRows(midZero, 30);
  const hit = rows2.find((r) => r.day === zeroDay);
  assert.ok(hit, "a zero-download day followed by collected days survives");
  assert.equal(hit.d1, 0);
}

// ── 4. d7/d30 arithmetic ends at each row's own day ──────────────────────────
{
  const input = series("2026-08-25", 60, () => 10);
  const rows = computeNpmDailyRows(input, 30);
  const last = rows[rows.length - 1]!;
  assert.equal(last.d7, 70, "d7 = trailing 7 × 10");
  assert.equal(last.d30, 300, "d30 = trailing 30 × 10");
  const first = rows[0]!;
  assert.equal(first.d30, 300, "oldest kept day still has a full d30 window");

  // Days before the response's start count as 0 (young package).
  const young = series("2026-08-25", 3, () => 10);
  const youngRows = computeNpmDailyRows(young, 30);
  assert.equal(youngRows.length, 3);
  assert.equal(youngRows[2]!.d7, 30, "missing history counts 0, not garbage");
}

// ── 5. Tripwire: identical trailing days, and one change resets it ───────────
{
  assert.equal(trailingIdenticalDays([]), 0);
  assert.equal(trailingIdenticalDays(["a", "b", "c", "c", "c"]), 3);
  assert.equal(
    trailingIdenticalDays(["a", "b", "c", "c", "d"]),
    1,
    "one changed value resets the streak",
  );
  assert.equal(trailingIdenticalDays(["x", "x"]), 2);
}

console.log("daily-ingest.check ✓ npm per-day contract holds");
