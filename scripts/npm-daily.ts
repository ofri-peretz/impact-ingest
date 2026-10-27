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
  /** null on an npm gap day (see npmGapDays): missing data, not zero. */
  d1: number | null;
  /** Raw sums over the window's days WITH data; null when every day is missing. */
  d7: number | null;
  d30: number | null;
  /** Gap days inside each window, so a reader can tell a dip from a hole. */
  missing_d7: number;
  missing_d30: number;
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
 * - A day in `gaps` is npm's outage, not ours: d1 is null, it adds nothing to
 *   d7/d30 and is counted in missing_d7/missing_d30. Never extrapolated.
 */
export function computeNpmDailyRows(
  days: NpmRangeDay[],
  backfillDays: number,
  collectedThrough?: string | null,
  gaps: ReadonlySet<string> = new Set(),
): NpmDailyRow[] {
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  let end = sorted.length;
  if (collectedThrough === undefined) {
    while (end > 0 && sorted[end - 1]!.downloads === 0) end -= 1;
  } else {
    while (
      end > 0 &&
      (collectedThrough === null || sorted[end - 1]!.day > collectedThrough)
    ) {
      end -= 1;
    }
  }
  const collected = sorted.slice(0, end);

  const byDay = new Map(collected.map((d) => [d.day, d.downloads]));
  const win = (day: string, n: number): [number | null, number] => {
    let s = 0;
    let missing = 0;
    const t = new Date(day).getTime();
    for (let k = 0; k < n; k += 1) {
      const d = isoDay(t - k * DAY_MS);
      if (gaps.has(d)) missing += 1;
      else s += byDay.get(d) ?? 0;
    }
    return [missing === n ? null : s, missing];
  };

  return collected.slice(-backfillDays).map(({ day, downloads }) => {
    const [d7, missing_d7] = win(day, 7);
    const [d30, missing_d30] = win(day, 30);
    return {
      day,
      d1: gaps.has(day) ? null : downloads,
      d7,
      d30,
      missing_d7,
      missing_d30,
    };
  });
}

/**
 * Days npm reported nothing at all: every tracked package AND `reference`
 * (a package far too popular to have a real zero day — the ingest uses
 * `eslint`) read 0. One package's 0 is that package's quiet day; ours all 0
 * while the reference has downloads is our quiet day. Only days up to
 * `collectedThrough` qualify — npm's zero-padded tail is "not collected yet",
 * which computeNpmDailyRows already drops.
 */
export function npmGapDays(
  series: Iterable<NpmRangeDay[]>,
  reference: NpmRangeDay[],
  collectedThrough: string | null,
): Set<string> {
  const gaps = new Set<string>();
  if (collectedThrough === null) return gaps;
  for (const d of reference) {
    if (d.downloads === 0 && d.day <= collectedThrough) gaps.add(d.day);
  }
  for (const days of series) {
    for (const d of days) if (d.downloads > 0) gaps.delete(d.day);
  }
  return gaps;
}

/**
 * The last day npm has collected, judged across every package: npm collects
 * a day for all packages at once, so a day ANY package has downloads on is a
 * collected day for all of them. Passed to computeNpmDailyRows, it keeps a
 * quiet package's real zero days instead of dropping them as "maybe not
 * collected" — the per-package trim left 43–47 rows a day where 48 exist.
 */
export function latestCollectedDay(
  series: Iterable<NpmRangeDay[]>,
): string | null {
  let latest: string | null = null;
  for (const days of series) {
    for (const d of days) {
      if (d.downloads > 0 && (latest === null || d.day > latest)) latest = d.day;
    }
  }
  return latest;
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
