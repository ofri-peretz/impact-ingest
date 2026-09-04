/**
 * Paginated collection, with one rule: an incomplete walk has no answer.
 *
 * Pure — no network, no database, no secrets — so `daily-ingest.check.ts` can
 * exercise it directly. That matters more than it sounds: the bug this module
 * exists to prevent was only ever reachable through a live HTTP failure, which
 * is exactly the path a check never takes.
 */
/**
 * Walk a paginated endpoint to exhaustion.
 *
 * Returns `null` when the walk does NOT complete — a page that failed, or a
 * page budget spent with more data still to come.
 *
 * **A partial result is not a smaller result.** Once a truncated count is
 * written to a daily series it is indistinguishable from a real value, it
 * always errs downward, and it is permanent. Worse, the old shape
 * (`return total > 0 ? total : null`) failed safe only when page ONE failed:
 * a failure on page two or later returned a confident undercount, so the more
 * data there was, the more likely a hiccup lied. A missing day is honest and
 * recoverable; a wrong day is neither.
 *
 * `fetchPage` returns `null` for a failed page and an array otherwise. A first
 * page shorter than `perPage` — including an empty one — is a COMPLETE walk,
 * so a genuine zero comes back as `[]` rather than as "unknown".
 */
export async function collectPaginated<T>(
  fetchPage: (page: number) => Promise<T[] | null>,
  opts: { perPage: number; maxPages: number; between?: () => Promise<void> },
): Promise<T[] | null> {
  const all: T[] = [];
  for (let page = 1; page <= opts.maxPages; page += 1) {
    const batch = await fetchPage(page);
    if (batch === null) return null;
    all.push(...batch);
    if (batch.length < opts.perPage) return all;
    if (opts.between) await opts.between();
  }
  // Budget spent without a short page: there is more we did not read.
  return null;
}
