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

/**
 * Validate the published plugin-stats document.
 *
 * Pure, so the contract can be checked without the network — which is the
 * whole point, because the interesting branch is the one where the document
 * is internally inconsistent, and that is not a branch a live fetch of a
 * healthy file will ever take.
 *
 * Returns null on anything unusable. The last guard is the one that earns its
 * place: a `totalRules` that disagrees with the sum of its own rows is not a
 * source of truth, and taking a headline number on faith while its own detail
 * contradicts it is exactly how a wrong figure survives review.
 */
export function parseRuleCounts(doc: unknown): {
  totalRules: number;
  byPlugin: Map<string, number>;
} | null {
  const d = doc as {
    totalRules?: unknown;
    plugins?: { name?: unknown; rules?: unknown }[];
  } | null;
  if (!d || typeof d.totalRules !== "number" || !Array.isArray(d.plugins)) {
    return null;
  }
  const byPlugin = new Map<string, number>();
  for (const entry of d.plugins) {
    if (typeof entry?.name === "string" && typeof entry?.rules === "number") {
      byPlugin.set(entry.name, entry.rules);
    }
  }
  if (byPlugin.size !== d.plugins.length) return null;
  const summed = [...byPlugin.values()].reduce((a, b) => a + b, 0);
  if (summed !== d.totalRules) return null;
  return { totalRules: d.totalRules, byPlugin };
}
