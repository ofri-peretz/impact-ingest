// Per-day npm downloads for many packages over one window, in as few calls as
// npm allows.
//
// Why this exists: the ingest made one /downloads/range call per package with
// 250ms between them. Through 2026-10 npm began answering 429 after about 20
// calls, so every package after that point dropped out: plugin_daily_metrics
// went from 47 rows a day to 39, then 21 from 2026-10-12, while each run was
// logged as "success" because a lost package was a "non-fatal" warning.
//
// npm's range endpoint takes a comma-separated list of up to 128 UNSCOPED
// names in one call (scoped names are refused in bulk with a 400, so each of
// those still goes alone). 48 packages became 1 bulk call plus one per scoped
// name. Whatever still fails is RETURNED, never only logged, so the caller can
// mark its run partial.
//
// npm caps a bulk range at 365 days; callers keep windows inside that.

import type { NpmRangeDay } from "./npm-daily.js";

const BULK_MAX = 128;

/** Group names into request paths: unscoped in bulk chunks, scoped alone. */
export function planNpmRangeRequests(names: readonly string[]): string[][] {
  const unscoped = names.filter((n) => !n.startsWith("@"));
  const plan: string[][] = [];
  for (let i = 0; i < unscoped.length; i += BULK_MAX) {
    plan.push(unscoped.slice(i, i + BULK_MAX));
  }
  for (const n of names) if (n.startsWith("@")) plan.push([n]);
  return plan;
}

type SingleBody = { package?: string; downloads?: NpmRangeDay[] };

/**
 * Read one range response for the names it was asked about. A one-name
 * request comes back in the single-package shape, a multi-name one keyed by
 * name with `null` for a package npm does not know. Unknown packages map to
 * an empty series (no downloads), not to a failure.
 */
export function parseNpmRangeBody(
  body: unknown,
  names: readonly string[],
): Map<string, NpmRangeDay[]> {
  const out = new Map<string, NpmRangeDay[]>();
  if (names.length === 1) {
    out.set(names[0]!, (body as SingleBody)?.downloads ?? []);
    return out;
  }
  const bulk = (body ?? {}) as Record<string, SingleBody | null>;
  for (const n of names) out.set(n, bulk[n]?.downloads ?? []);
  return out;
}

export interface NpmRangeResult {
  byName: Map<string, NpmRangeDay[]>;
  /** Names npm did not answer for (429/5xx/network after retries). */
  failed: string[];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Fetch [start, end] (YYYY-MM-DD, inclusive) for every name. 404 means npm
 * has no downloads for that package in the window and counts as an answer.
 * 429/5xx/network errors retry with backoff (Retry-After when npm sends it,
 * capped at 30s), three attempts per request.
 */
export async function fetchNpmRanges(
  names: readonly string[],
  start: string,
  end: string,
  userAgent: string,
): Promise<NpmRangeResult> {
  const byName = new Map<string, NpmRangeDay[]>();
  const failed: string[] = [];
  const plan = planNpmRangeRequests(names);
  for (let i = 0; i < plan.length; i += 1) {
    if (i > 0) await sleep(300);
    const group = plan[i]!;
    const url = `https://api.npmjs.org/downloads/range/${start}:${end}/${group
      .map(encodeURIComponent)
      .join(",")}`;
    let answered = false;
    for (let attempt = 0; attempt < 3 && !answered; attempt += 1) {
      let status = 0;
      let retryAfter: string | null = null;
      try {
        const r = await fetch(url, {
          headers: { "User-Agent": userAgent, Accept: "application/json" },
          signal: AbortSignal.timeout(20_000),
        });
        status = r.status;
        retryAfter = r.headers.get("retry-after");
        if (r.ok) {
          for (const [n, days] of parseNpmRangeBody(await r.json(), group)) {
            byName.set(n, days);
          }
          answered = true;
        } else if (r.status === 404) {
          for (const n of group) byName.set(n, []);
          answered = true;
        }
      } catch {
        // network error / timeout: retried below
      }
      if (!answered && attempt < 2) {
        const hinted = Number(retryAfter) * 1000;
        const wait = Math.min(
          30_000,
          Number.isFinite(hinted) && hinted > 0 ? hinted : 5_000 * 2 ** attempt,
        );
        console.error(
          `[npm-range] ${group.length === 1 ? group[0] : `${group.length} packages`} → ${status || "network error"}, retrying in ${wait / 1000}s`,
        );
        await sleep(wait);
      }
    }
    if (!answered) failed.push(...group);
  }
  return { byName, failed };
}
