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

import { collectPaginated, parseRuleCounts } from "./paginate.js";
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

// ── 6. A partial page-walk is not a count ───────────────────────────────────
//
// The shape this replaces returned `total > 0 ? total : null`, so it failed
// safe ONLY when page one failed. A failure on page two or later produced a
// confident undercount that landed in a daily series, indistinguishable from
// a real dip — the more data there was, the more likely a hiccup lied.
//
// Positive control first: a walk that completes must still return the items,
// or every assertion below passes for the wrong reason.
{
  const pages = (...batches: number[][]) => {
    const calls: number[] = [];
    return {
      calls,
      fetchPage: async (page: number) => {
        calls.push(page);
        return batches[page - 1] ?? [];
      },
    };
  };

  // 1. Completes: two full pages then a short one.
  {
    const full = Array.from({ length: 3 }, (_, i) => i);
    const { fetchPage } = pages(full, full, [9]);
    const out = await collectPaginated(fetchPage, { perPage: 3, maxPages: 10 });
    assert.equal(out?.length, 7, "a completed walk returns every item");
  }

  // 2. A failed page yields null, NOT the pages already read.
  {
    const full = [1, 2, 3];
    const out = await collectPaginated(
      async (page) => (page === 2 ? null : full),
      { perPage: 3, maxPages: 10 },
    );
    assert.equal(out, null, "a failure mid-walk is unknown, not a partial sum");
  }

  // 3. Failing on page ONE is the case the old code got right; it must stay
  //    right, so the fix is not just moving the bug.
  {
    const out = await collectPaginated(async () => null, {
      perPage: 3,
      maxPages: 10,
    });
    assert.equal(out, null, "a failure on the first page is unknown");
  }

  // 4. Budget exhausted with a full final page: there is more we did not read,
  //    so the count is unknown. The old loop returned the truncated total.
  {
    const out = await collectPaginated(async () => [1, 2, 3], {
      perPage: 3,
      maxPages: 3,
    });
    assert.equal(out, null, "an exhausted page budget is unknown, not a total");
  }

  // 5. A genuine zero survives as zero. `total > 0 ? total : null` turned an
  //    empty first page into "unknown", which is the same class of error in
  //    the other direction — a real value reported as absent.
  {
    const out = await collectPaginated(async () => [], {
      perPage: 100,
      maxPages: 5,
    });
    assert.deepEqual(out, [], "an empty first page is a complete walk of zero");
  }

  // 6. It stops at the short page rather than paging forever.
  {
    const { calls, fetchPage } = pages([1, 2, 3], [4]);
    await collectPaginated(fetchPage, { perPage: 3, maxPages: 50 });
    assert.deepEqual(calls, [1, 2], "stops on the first short page");
  }

  console.log("✓ collectPaginated: a partial walk reports unknown, not a total");
}

// ── 7. A headline that disagrees with its own rows is not a source of truth ──
//
// `total_rules` was null for 175 days and `rule_count` for every plugin on
// every day, while the control room rendered both. Filling them from the
// published plugin-stats document is only an improvement if the document is
// checked — a number taken on faith while its own detail contradicts it is
// how a wrong figure survives review.
{
  const doc = (totalRules: number, plugins: unknown[]) => ({
    totalRules,
    plugins,
  });

  // Positive control first: a consistent document parses, and the map is
  // keyed the way the caller looks it up.
  {
    const out = parseRuleCounts(
      doc(46, [
        { name: "eslint-plugin-browser-security", rules: 40 },
        { name: "eslint-plugin-jwt", rules: 6 },
      ]),
    );
    assert.equal(out?.totalRules, 46);
    assert.equal(out?.byPlugin.get("eslint-plugin-browser-security"), 40);
    assert.equal(out?.byPlugin.size, 2);
  }

  // The guard that earns its place: the headline disagrees with the sum.
  {
    const out = parseRuleCounts(
      doc(999, [{ name: "eslint-plugin-jwt", rules: 6 }]),
    );
    assert.equal(out, null, "a self-contradicting document is unusable");
  }

  // A row that is not countable would silently shrink the sum, so a document
  // with any unusable row is rejected rather than partially believed — the
  // same rule as the page walk above.
  {
    const out = parseRuleCounts(
      doc(6, [{ name: "eslint-plugin-jwt", rules: 6 }, { name: 42 }]),
    );
    assert.equal(out, null, "an uncountable row invalidates the document");
  }

  // Shape failures.
  for (const bad of [null, {}, { totalRules: 5 }, { plugins: [] }, { totalRules: "5", plugins: [] }]) {
    assert.equal(parseRuleCounts(bad), null, `rejects ${JSON.stringify(bad)}`);
  }

  // An empty ecosystem is a legitimate zero, not a failure.
  assert.deepEqual(parseRuleCounts(doc(0, []))?.totalRules, 0);

  console.log("✓ parseRuleCounts: a headline must agree with its own rows");
}
