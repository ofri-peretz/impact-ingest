/**
 * GitHub repos whose stars get a per-repo daily series.
 *
 * `ofri-peretz/eslint` already has a star count — `creator_daily_metrics`,
 * platform `github-repo` — but that row is a single scalar per creator and
 * feeds the `eng_github_stars` ratchet. It cannot hold a second repo:
 * v_creator_latest keeps one row per (creator, platform), and
 * refresh_storefront_ratchet reads `platform = 'github-repo' LIMIT 1`.
 *
 * So per-repo stars go to `metric_snapshots`, keyed by `dimension = owner/repo`
 * — the same shape `releases_cumulative` already uses. That gives each repo a
 * trend line in v_metric_latest / v_metric_history without touching the
 * ratchet. eslint is listed too, so burgee's series has something to be read
 * against.
 */
export const STARRED_REPOS: readonly string[] = [
  "ofri-peretz/eslint",
  "ofri-peretz/burgee",
];

/**
 * Deliberately NOT `github-repo`. refresh_storefront_ratchet falls back to
 * `metric_snapshots WHERE source = 'github-repo' AND kind = 'stars'` with no
 * dimension filter; a per-repo row under that source would let burgee's count
 * stand in for the ecosystem's on any day the primary read is empty.
 */
export const REPO_STARS_SOURCE = "github-repos";
export const REPO_STARS_KIND = "stars";
