// Per-day npm download rows derived from a /downloads/range response.
//
// Why this module exists: until 2026-08-26 the ingest asked npm for
// "last-day" and stamped the answer on the RUN date. npm's stats pipeline
// lags 24–48h and sometimes stalls for days; "last-day" then keeps answering
// with the same last-collected day, and the ingest wrote that number onto
// every new observed_on — seven identical daily totals in a row
// (2026-08-10..16), which the /loom weekly rollup rendered as a crash that
// never happened.
//
// The range endpoint reports each day npm has actually collected, keyed by
// its own calendar day. Rows derived here carry npm's day, never the run
// date, so a stalled upstream produces NO row instead of a wrong one.
//
// Pure on purpose: no fetch, no Supabase — daily-ingest.check.ts imports
// this without needing secrets, so the lock runs on fork PRs too.

/** One day of the /downloads/range/ response. */
export interface NpmRangeDay {
  day: string; // YYYY-MM-DD
  downloads: number;
}

export interface NpmDailyRow {
  day: string;
  d1: number;
  d7: number;
  d30: number;
}

const DAY_MS = 86_400_000;
const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

/**
 * Turn a range response into per-day (d1, trailing-7, trailing-30) rows for
 * the most recent `backfillDays` days npm has actually collected.
 *
 * - Rows are keyed by npm's own `day` — never the date the ingest ran.
 * - npm zero-pads days inside the requested window it hasn't collected yet
 *   (today always, yesterday under lag). A trailing run of zeros is therefore
 *   indistinguishable from "not collected yet" and is dropped; a zero with a
 *   collected day after it is a real zero-download day and is kept. A
 *   genuinely-zero tail gets written by a later run, once a collected day
 *   lands beyond it — every run rewrites the whole window, so this
 *   self-heals.
 * - d7/d30 are trailing sums ending at that day; days before the response's
 *   start count as 0 (same contract as the agents repo's backfill-gaps).
 */
export function computeNpmDailyRows(
  days: NpmRangeDay[],
  backfillDays: number,
): NpmDailyRow[] {
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  let end = sorted.length;
  while (end > 0 && sorted[end - 1]!.downloads === 0) end -= 1;
  const collected = sorted.slice(0, end);

  const byDay = new Map(collected.map((d) => [d.day, d.downloads]));
  const win = (day: string, n: number): number => {
    let s = 0;
    const t = new Date(day).getTime();
    for (let k = 0; k < n; k += 1) s += byDay.get(isoDay(t - k * DAY_MS)) ?? 0;
    return s;
  };

  return collected.slice(-backfillDays).map(({ day, downloads }) => ({
    day,
    d1: downloads,
    d7: win(day, 7),
    d30: win(day, 30),
  }));
}

/**
 * Length of the trailing run of identical values (chronological order, most
 * recent last). Fed one fingerprint per observed_on day, this answers "how
 * many consecutive days hold byte-identical per-plugin numbers?" — the exact
 * shape of the carry-forward bug this module replaced.
 */
export function trailingIdenticalDays(fingerprints: string[]): number {
  if (fingerprints.length === 0) return 0;
  let n = 1;
  const last = fingerprints[fingerprints.length - 1]!;
  for (
    let i = fingerprints.length - 2;
    i >= 0 && fingerprints[i] === last;
    i -= 1
  ) {
    n += 1;
  }
  return n;
}
