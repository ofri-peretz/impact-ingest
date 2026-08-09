// Daily ingest — single source of truth for the North Star ratchet.
//
// Pulls daily numbers from NPM + GitHub + dev.to, upserts the typed
// daily-metrics tables (plugin_daily_metrics, creator_daily_metrics,
// ecosystem_daily_metrics), records an audit row in ingest_runs, then
// calls refresh_storefront_ratchet() so the North Star advances.
//
// All consumer apps (apps/blog, apps/interlace-landing, apps/playground-stack
// and the downstream eslint-repo docs site) read from the v_* views —
// only this workflow writes. The control-room boundary lives here.
//
// Runs from .github/workflows/daily-impact-ingest.yml at 05:00 UTC.

import { supabaseAdmin, type Tables } from "./_supabase-admin.js";
import {
  trackedPackages,
  fetchCatalog,
  IGNORED_PACKAGES,
} from "./plugin-catalog.js";

const GITHUB_REPO_OWNER = "ofri-peretz";
const GITHUB_REPO_NAME = "eslint";
const CREATOR = "ofri-peretz";

const GHA_RUN_URL =
  process.env.GITHUB_SERVER_URL &&
  process.env.GITHUB_REPOSITORY &&
  process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;

type PluginRow = Pick<Tables["plugins"]["Row"], "id" | "name" | "slug">;
type Period = "last-week" | "last-month" | "last-day";

interface NpmDownloadsPoint {
  downloads: number;
  start: string;
  end: string;
  package: string;
}

interface DevtoArticle {
  id: number;
  slug: string;
  published?: boolean;
  title?: string;
  description?: string;
  url?: string;
  canonical_url?: string;
  published_at?: string;
  positive_reactions_count?: number;
  comments_count?: number;
  page_views_count?: number;
  user?: { username?: string };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// Single-attempt wrapper. The 2026-05-23 quota pass removed the retry budget
// (it burned runner-seconds without outlasting npm/GitHub cool-downs) but left
// these call sites referencing withRetry — a ReferenceError that broke every
// run after 2026-05-18. Restored as a no-retry pass-through that SWALLOWS
// failures: a single flaky API call must not abort the whole ingest, because
// refresh_storefront_ratchet() runs last and has to be reached.
// ponytail: single attempt by design; per-call retry budget intentionally gone.
async function withRetry<T>(
  fn: () => Promise<T | null>,
  label: string,
  _attempts = 1,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[retry] ${label} → ${(err as Error).message} (skipped)`);
    return null;
  }
}

// No in-script retry wrapper. Removed 2026-05-23 as part of the
// Actions-quota hygiene pass. Rationale:
//   - The cron runs daily. A transient 429 today is recovered by tomorrow's
//     run; the ratchet is monotonic, so we lose at most a one-day data
//     point (cosmetic), not the cumulative total.
//   - The previous 8-attempt budget (1+2+4+8+16+30+60+60 = 181s) often
//     failed to outlast npm's per-IP cool-down anyway, so it burned
//     runner-seconds without changing the outcome (see PR #36 commit).
//   - The user's quota-hygiene policy: fail fast, notify, retry tomorrow.
// The 250ms inter-plugin pacing in the npm loop stays — that's preventive,
// not reactive, and helps the no-retry policy succeed on the first attempt.

// npm rate-limits anonymous calls (no User-Agent) far more aggressively
// than identified ones. Set a real UA to stay on the lower-friction tier.
const NPM_USER_AGENT =
  "ofri-peretz/agents-ingest (https://github.com/ofri-peretz/agents)";

async function fetchNpm(pkg: string, period: Period): Promise<number | null> {
  const r = await fetch(
    `https://api.npmjs.org/downloads/point/${period}/${pkg}`,
    {
      headers: { "User-Agent": NPM_USER_AGENT, Accept: "application/json" },
    },
  );
  if (!r.ok) {
    // Non-fatal by design: a single package's download metric is cosmetic and
    // the ratchet is monotonic, so skipping it costs at most a one-day data
    // point. Throwing here used to abort the WHOLE ingest — including the
    // final refresh_storefront_ratchet() — so one 429 froze the scorecard for
    // a month. Per the no-retry quota policy we don't retry; we just skip.
    console.error(
      `[ingest] warn: npm downloads ${pkg} ${period} → ${r.status} (skipped, non-fatal)`,
    );
    return null;
  }
  const data = (await r.json()) as NpmDownloadsPoint;
  return data.downloads;
}

// Downloads for many packages in as few requests as possible.
//
// npm's point endpoint accepts a comma-joined list and answers with an object
// keyed by package name (entries can be null for a package with no data).
// Scoped names are rejected from bulk lookups, so they're fetched one at a
// time — there are only four, and they're the low-traffic ones.
//
// A missing key means "npm didn't say", which callers store as null rather
// than 0: a zero would be indistinguishable from a real zero-download day and
// would drag the ratchet's daily delta down with fabricated data.
const NPM_BULK_LIMIT = 100;

async function fetchNpmMany(
  packages: string[],
  period: Period,
): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  const scoped = packages.filter((n) => n.startsWith("@"));
  const bulk = packages.filter((n) => !n.startsWith("@"));

  for (let i = 0; i < bulk.length; i += NPM_BULK_LIMIT) {
    const chunk = bulk.slice(i, i + NPM_BULK_LIMIT);
    if (i > 0) await sleep(250);
    const r = await fetch(
      `https://api.npmjs.org/downloads/point/${period}/${chunk.join(",")}`,
      { headers: { "User-Agent": NPM_USER_AGENT, Accept: "application/json" } },
    );
    if (!r.ok) {
      // Same non-fatal contract as fetchNpm: the ratchet is monotonic and the
      // cron runs daily, so a lost period costs one cosmetic data point.
      console.error(
        `[ingest] warn: npm bulk ${period} ×${chunk.length} → ${r.status} (skipped, non-fatal)`,
      );
      continue;
    }
    // A single-package chunk answers with the bare point object, not a map —
    // the one shape difference in this endpoint, and the reason a chunk of one
    // would otherwise silently record nothing.
    const json = (await r.json()) as
      | NpmDownloadsPoint
      | Record<string, NpmDownloadsPoint | null>;
    if (chunk.length === 1) {
      out[chunk[0]!] = (json as NpmDownloadsPoint).downloads ?? null;
      continue;
    }
    for (const [name, point] of Object.entries(
      json as Record<string, NpmDownloadsPoint | null>,
    )) {
      out[name] = point?.downloads ?? null;
    }
  }

  for (const name of scoped) {
    await sleep(250);
    out[name] = await fetchNpm(name, period);
  }

  return out;
}

async function ghHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN)
    h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

// GitHub Search count for a query (e.g. PRs authored by Ofri on others' repos).
async function fetchGitHubSearchCount(q: string): Promise<number | null> {
  const r = await fetch(
    `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=1`,
    { headers: await ghHeaders() },
  );
  if (!r.ok) {
    console.error(`[github-search] "${q}" → ${r.status}`);
    return null;
  }
  const d = (await r.json()) as { total_count?: number };
  return d.total_count ?? 0;
}

// Cumulative release count across a repo (paginates until exhausted).
async function fetchGitHubReleaseCount(
  owner: string,
  repo: string,
): Promise<number | null> {
  let total = 0;
  for (let page = 1; page <= 20; page += 1) {
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100&page=${page}`,
      { headers: await ghHeaders() },
    );
    if (!r.ok) {
      console.error(
        `[github-releases] ${owner}/${repo} page ${page} → ${r.status}`,
      );
      return total > 0 ? total : null;
    }
    const arr = (await r.json()) as unknown[];
    total += arr.length;
    if (arr.length < 100) break;
  }
  return total;
}

// Outbound reciprocity counter.
//
// In the private control-room repo this counted entries in the local dev.to
// engagement audit file. That file records who we commented on and the text of
// every comment, which is not something to publish, so this repo takes the
// count alone — via the DEVTO_COMMENTS_LEFT repository variable.
//
// Unset is a first-class answer: null means "not measured", which the ratchet
// stores as a gap rather than writing a zero that would read as "commented on
// nobody".
async function fetchDevtoCommentsLeft(): Promise<number | null> {
  const raw = process.env.DEVTO_COMMENTS_LEFT;
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`[devto-engaged] DEVTO_COMMENTS_LEFT="${raw}" is not a count`);
    return null;
  }
  return n;
}

async function fetchGitHubRepoStars(): Promise<number | null> {
  const r = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`,
    { headers: await ghHeaders() },
  );
  if (!r.ok) {
    console.error(`[github-repo] → ${r.status}`);
    return null;
  }
  const data = (await r.json()) as { stargazers_count: number };
  return data.stargazers_count;
}

// GitHub Dependents count — how many repos depend on a given npm package name.
// Uses the GitHub search API with topic/dependency search as a proxy.
// Not perfectly precise (GitHub's dependency graph is opt-in for private repos),
// but reliable for public repos and directionally useful as a weekly trend.
async function fetchGitHubDependents(
  packageName: string,
): Promise<number | null> {
  return withRetry(
    async () => {
      // GitHub's dependency graph search: count repos that have the package
      // in their package.json dependencies via the code search API.
      const q = `"${packageName}" filename:package.json`;
      const r = await fetch(
        `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=1`,
        { headers: await ghHeaders() },
      );
      if (!r.ok) {
        if (r.status === 422 || r.status === 403) return null; // rate-limit or validation
        throw new Error(`github-dependents ${packageName} → ${r.status}`);
      }
      const d = (await r.json()) as { total_count?: number };
      return d.total_count ?? null;
    },
    `github-dependents ${packageName}`,
    3,
  );
}

// Reddit mention tracker — searches r/javascript, r/node, r/webdev for our
// package/author name. Uses the public Reddit JSON API (no auth needed).
async function fetchRedditMentions(): Promise<number | null> {
  const queries = ["eslint-plugin-interlace", "ofri-peretz eslint"];
  const subreddits = ["javascript", "node", "webdev"];
  let total = 0;
  for (const sub of subreddits) {
    for (const q of queries) {
      try {
        const r = await fetch(
          `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(q)}&restrict_sr=1&limit=1`,
          { headers: { "User-Agent": "ofri-peretz/agents-ingest/1.0" } },
        );
        if (!r.ok) continue;
        const d = (await r.json()) as { data?: { dist?: number } };
        total += d.data?.dist ?? 0;
        await new Promise((res) => setTimeout(res, 200)); // Reddit rate-limit is strict
      } catch {
        /* non-fatal */
      }
    }
  }
  console.log(`[reddit] mentions=${total}`);
  return total;
}

// npm version download distribution — what % of d30 downloads are on the
// latest version? High latest-version share = healthy upgrade cadence.
// Returns { latestVersion, latestVersionShare } or null on failure.
async function fetchNpmVersionShare(
  packageName: string,
  totalD30: number,
): Promise<{ latestVersion: string; latestVersionShare: number } | null> {
  if (totalD30 <= 0) return null;
  try {
    // Get latest version from registry
    const reg = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      {
        headers: { "User-Agent": NPM_USER_AGENT },
      },
    );
    if (!reg.ok) return null;
    const meta = (await reg.json()) as { version?: string };
    const latest = meta.version;
    if (!latest) return null;
    // Downloads for the latest version over the last month
    const dl = await fetchNpm(`${packageName}/${latest}`, "last-month");
    if (dl === null) return null;
    const share = Math.round((dl / totalD30) * 100);
    return { latestVersion: latest, latestVersionShare: share };
  } catch {
    return null;
  }
}

// PostHog referrer breakdown — top UTM sources by session count for yesterday.
// Returns array of { source, sessions } or empty array on failure.
async function fetchPostHogReferrers(): Promise<
  Array<{ source: string; sessions: number }>
> {
  const apiKey = process.env.POSTHOG_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const host = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";
  if (!apiKey || !projectId) return [];
  try {
    const r = await fetch(`${host}/api/projects/${projectId}/query/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": NPM_USER_AGENT,
      },
      body: JSON.stringify({
        query: {
          kind: "HogQLQuery",
          query: `
            SELECT
              coalesce(properties.$utm_source, properties.$referrer, 'direct') AS source,
              count(distinct properties.$session_id) AS sessions
            FROM events
            WHERE event = '$pageview'
              AND timestamp >= now() - INTERVAL 1 DAY
            GROUP BY source
            ORDER BY sessions DESC
            LIMIT 10
          `,
        },
      }),
    });
    if (!r.ok) return [];
    const d = (await r.json()) as { results?: Array<[string, number]> };
    return (d.results ?? []).map(([source, sessions]) => ({
      source,
      sessions,
    }));
  } catch {
    return [];
  }
}

async function fetchGitHubUser(): Promise<{ followers: number } | null> {
  const r = await fetch(`https://api.github.com/users/${GITHUB_REPO_OWNER}`, {
    headers: await ghHeaders(),
  });
  if (!r.ok) return null;
  return (await r.json()) as { followers: number };
}

// GitHub GraphQL — year-to-date commit contributions. contributionsCollection
// defaults to the current year; pass `from` to widen to all-time if needed.
// The REST /stats/contributors endpoint exists but requires a repo-level token
// and only covers that repo; GraphQL contributionsCollection covers ALL repos
// and is what shows on the GitHub profile heatmap — the same number users see.
async function fetchGitHubCommits(): Promise<number | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log("[github-commits] skipping — GITHUB_TOKEN not set");
    return null;
  }
  return withRetry(async () => {
    const r = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        query: `query {
          user(login: "${GITHUB_REPO_OWNER}") {
            contributionsCollection {
              totalCommitContributions
              restrictedContributionsCount
            }
          }
        }`,
      }),
    });
    if (!r.ok) {
      console.error(`[github-commits] GraphQL → ${r.status}`);
      return null;
    }
    const data = (await r.json()) as {
      data?: {
        user?: {
          contributionsCollection?: {
            totalCommitContributions?: number;
            restrictedContributionsCount?: number;
          };
        };
      };
    };
    const col = data.data?.user?.contributionsCollection;
    if (!col) return null;
    // Sum public + private contributions (the profile heatmap shows both
    // when "Include private contributions" is on — we want the same number).
    return (
      (col.totalCommitContributions ?? 0) +
      (col.restrictedContributionsCount ?? 0)
    );
  }, "github commits");
}

// HN mention tracker — Algolia's public HN search API, no auth required.
// Counts stories (not comments) mentioning our package or author handle so we
// can see whether articles/releases are generating HN traction.
async function fetchHNMentions(): Promise<number | null> {
  const queries = ["eslint-plugin-interlace", "ofri-peretz eslint"];
  let total = 0;
  for (const q of queries) {
    try {
      const r = await fetch(
        `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=1`,
      );
      if (!r.ok) {
        console.error(`[hn] "${q}" → ${r.status}`);
        continue;
      }
      const data = (await r.json()) as { nbHits?: number };
      total += data.nbHits ?? 0;
    } catch (err) {
      console.error(`[hn] "${q}" fetch error: ${(err as Error).message}`);
    }
  }
  console.log(`[hn] mentions=${total}`);
  return total;
}

// ─── PostHog page-views collector ────────────────────────────────────
//
// The `eng_page_views_cumulative` ratchet sums `metric_snapshots.value`
// where `source = 'posthog'` and `kind = 'page_views'` (per the
// corresponding migration in this PR). The blog publishes `$pageview`
// events via `posthog-js` initialized in
// `apps/blog/src/components/posthog-provider.tsx`.
//
// Defensive: returns `null` on missing env or HTTP error. Ingest skips
// the row write and the scorecard's page-views card stays hidden via
// the null/zero filter.
//
// Required env (server-side):
//   POSTHOG_API_KEY      — personal API key, starts `phx_...`
//                          Settings → Personal API Keys → read scope is enough
//   POSTHOG_PROJECT_ID   — `428927` for ofriperetz.dev (literal, public identifier)
//   POSTHOG_HOST         — defaults to https://us.i.posthog.com
const POSTHOG_HOST_DEFAULT = "https://us.i.posthog.com";

async function fetchPostHogPageviews(): Promise<number | null> {
  const apiKey = process.env.POSTHOG_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const host = process.env.POSTHOG_HOST ?? POSTHOG_HOST_DEFAULT;
  if (!apiKey || !projectId) {
    console.log(
      "[posthog] skipping — POSTHOG_API_KEY / POSTHOG_PROJECT_ID not set",
    );
    return null;
  }

  const r = await fetch(`${host}/api/projects/${projectId}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": NPM_USER_AGENT,
    },
    body: JSON.stringify({
      query: {
        kind: "HogQLQuery",
        // PER-DAY count for the past 24h. The SQL refresh function
        // SUMS all metric_snapshots rows for this kind, so each
        // daily ingest must write ONE row containing THAT DAY's
        // pageviews (not a running total — that would double-count).
        // Daily upsert constraint is (source, kind, dimension, observed_on)
        // so two runs in the same day overwrite, not duplicate.
        query:
          "SELECT count(*) FROM events WHERE event = '$pageview' AND timestamp >= now() - INTERVAL 1 DAY",
      },
    }),
  });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403 || r.status === 404) {
      console.log(
        `[posthog] non-fatal ${r.status} — check POSTHOG_API_KEY scope + project id`,
      );
      return null;
    }
    throw new Error(`posthog query → ${r.status}`);
  }
  const data = (await r.json()) as { results?: Array<Array<number>> };
  const total = data.results?.[0]?.[0];
  return typeof total === "number" ? total : null;
}

interface CodecovComponent {
  component_id: string;
  name: string;
  coverage: number;
}

interface CodecovTotals {
  coverage?: number;
  files?: number;
  lines?: number;
  hits?: number;
  misses?: number;
  partials?: number;
}

interface CodecovRepo {
  totals?: CodecovTotals;
}

interface CodecovReport {
  totals?: CodecovTotals;
}

// Codecov public-repo API requires no auth. Returns per-component (per-plugin)
// coverage % and repo-level totals.
async function fetchCodecovComponents(): Promise<CodecovComponent[]> {
  const r = await fetch(
    `https://codecov.io/api/v2/github/${GITHUB_REPO_OWNER}/repos/${GITHUB_REPO_NAME}/components/`,
  );
  if (!r.ok) {
    console.error(`[codecov] components → ${r.status}`);
    return [];
  }
  return (await r.json()) as CodecovComponent[];
}

async function fetchCodecovRepoTotals(): Promise<CodecovTotals | null> {
  const r = await fetch(
    `https://codecov.io/api/v2/github/${GITHUB_REPO_OWNER}/repos/${GITHUB_REPO_NAME}/`,
  );
  if (!r.ok) {
    console.error(`[codecov] repo → ${r.status}`);
    return null;
  }
  const data = (await r.json()) as CodecovRepo;
  return data.totals ?? null;
}

// Per-plugin line counts. Codecov's /report/?path= returns folder-rolled-up
// totals (files, lines, hits, misses, partials) for a specific subtree.
async function fetchCodecovPathTotals(
  path: string,
): Promise<CodecovTotals | null> {
  const r = await fetch(
    `https://codecov.io/api/v2/github/${GITHUB_REPO_OWNER}/repos/${GITHUB_REPO_NAME}/report/?path=${encodeURIComponent(path)}`,
  );
  if (!r.ok) {
    if (r.status === 404) return null;
    console.error(`[codecov] path ${path} → ${r.status}`);
    return null;
  }
  const data = (await r.json()) as CodecovReport;
  return data.totals ?? null;
}

// Map a plugin row to its filesystem subdirectory.
//   eslint-plugin-jwt          → packages/eslint-plugin-jwt
//   @interlace/eslint-devkit   → packages/eslint-devkit
function pluginToPackagePath(plugin: { name: string }): string {
  const bare = plugin.name.startsWith("@")
    ? (plugin.name.split("/")[1] ?? plugin.name)
    : plugin.name;
  return `packages/${bare}`;
}

// Codecov names plugin components without the `@interlace/` scope, so we
// match by the bare slug-equivalent. e.g. "eslint-devkit" → "@interlace/eslint-devkit".
function matchPluginByCodecovName(
  codecovName: string,
  plugins: Array<{ id: number; name: string; slug: string }>,
): { id: number; name: string } | undefined {
  const direct = plugins.find((p) => p.name === codecovName);
  if (direct) return direct;
  return plugins.find(
    (p) => p.name.endsWith(`/${codecovName}`) || p.slug === codecovName,
  );
}

// Fetches every article (paginated) so external_articles stays in sync —
// new posts since the last run land in Supabase automatically.
async function fetchAllDevtoArticles(): Promise<DevtoArticle[]> {
  const apiKey = process.env.DEVTO_API_KEY || process.env.DEV_TO_API_KEY;
  if (!apiKey) {
    console.log("[devto] no API key, skipping");
    return [];
  }
  // /articles/me/all (not /me) so the view total matches the dev.to dashboard's
  // "Total post views", which counts unpublished drafts too (they retain the
  // views they got while briefly live). Published-only loops below still filter
  // on published_at, so drafts contribute to the totals but not to the article
  // list, count, or per-article snapshots.
  const all: DevtoArticle[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const r = await fetch(
      `https://dev.to/api/articles/me/all?per_page=100&page=${page}`,
      { headers: { "api-key": apiKey } },
    );
    if (!r.ok) {
      console.error(`[devto] page ${page} → ${r.status}`);
      break;
    }
    const batch = (await r.json()) as DevtoArticle[];
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

function summarizeDevto(arts: DevtoArticle[]): {
  posts: number;
  total_views: number;
  total_reactions: number;
  total_comments: number;
} {
  return {
    // Count currently-published only (drafts are in `arts` for the view total
    // but aren't "posts"); `published` (not published_at) excludes
    // published-then-unpublished posts, matching the dashboard's count.
    posts: arts.filter((a) => a.published === true).length,
    total_views: arts.reduce((s, a) => s + (a.page_views_count ?? 0), 0),
    total_reactions: arts.reduce(
      (s, a) => s + (a.positive_reactions_count ?? 0),
      0,
    ),
    total_comments: arts.reduce((s, a) => s + (a.comments_count ?? 0), 0),
  };
}

// Dev.to user profile — the `/api/users/me` endpoint returns the
// authenticated user including `followers_count`. We use that to feed
// the `eng_devto_followers` ratchet. Defensive: returns null on any
// failure so the ingest doesn't abort if the API shape shifts.
async function fetchDevtoFollowers(): Promise<number | null> {
  const apiKey = process.env.DEVTO_API_KEY || process.env.DEV_TO_API_KEY;
  if (!apiKey) return null;
  return withRetry(async () => {
    // /api/users/me does NOT include followers_count (verified 2026-05-25 —
    // returns username, name, twitter/github_username, summary, location,
    // joined_at, profile_image only). The count comes from /api/followers/users,
    // which returns the follower list; per_page caps at 1000, so a single page
    // silently truncates the count to exactly 1000 once we pass that (the bug
    // that pinned this metric at 1000). Page through until a short page.
    const PER_PAGE = 1000;
    let total = 0;
    for (let page = 1; page <= 100; page += 1) {
      const r = await fetch(
        `https://dev.to/api/followers/users?per_page=${PER_PAGE}&page=${page}`,
        { headers: { "api-key": apiKey } },
      );
      if (!r.ok) {
        console.error(`[devto] /followers/users page ${page} → ${r.status}`);
        return total > 0 ? total : null;
      }
      const data = (await r.json()) as unknown[];
      if (!Array.isArray(data)) return total > 0 ? total : null;
      total += data.length;
      if (data.length < PER_PAGE) break;
      await sleep(300);
    }
    return total;
  }, "devto user followers");
}

async function startRun(): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("ingest_runs")
    .insert({
      workflow: "daily-impact-ingest",
      status: "running",
      gha_run_url: GHA_RUN_URL,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`ingest_runs insert: ${error?.message}`);
  return data.id;
}

async function endRun(
  runId: string,
  rowsWritten: number,
  errorMessage: string | null,
): Promise<void> {
  await supabaseAdmin
    .from("ingest_runs")
    .update({
      finished_at: new Date().toISOString(),
      rows_written: rowsWritten,
      status: errorMessage ? "error" : "success",
      error_message: errorMessage,
    })
    .eq("id", runId);
}

// ─── Plugin catalog, write side ──────────────────────────────────────────
// The deny-list decides which rows we report on; this decides which rows
// exist. Without it the table only ever holds what someone remembered to
// insert, which is how 13 published packages stayed invisible for two months.
//
// Insert-only for membership. Rows are never deleted here: a bad search
// response must not be able to cascade away a package's download history
// (plugin_daily_metrics is FK'd to plugins.id ON DELETE CASCADE). Retiring a
// package is a human decision — an IGNORED_PACKAGES entry, or a migration.
// The one field this does update is `deprecated`, which is derived, not
// decided: npm is the authority on whether a package is deprecated, and a
// wrong value there only mislabels a card.
async function syncPluginCatalog(): Promise<void> {
  const catalog = await fetchCatalog();
  // Non-fatal: yesterday's catalog is still right for everything already
  // published, so only a package published today waits a day.
  if (!catalog) return;

  const { data: existing, error: exErr } = await supabaseAdmin
    .from("plugins")
    .select("name,deprecated");
  if (exErr) throw new Error(`plugins select (catalog): ${exErr.message}`);
  const known = new Map((existing ?? []).map((p) => [p.name, p.deprecated]));

  const added = catalog.filter((e) => !known.has(e.name));
  if (added.length > 0) {
    const { error } = await supabaseAdmin.from("plugins").insert(added);
    if (error) throw new Error(`plugins insert (catalog): ${error.message}`);
    console.log(
      `[catalog] added ${added.length}: ${added.map((e) => e.name).join(", ")}`,
    );
  }

  // Re-derive `deprecated` for rows we already had. A package that dropped off
  // npm's listing since yesterday was deprecated in the meantime; one that
  // reappeared was un-deprecated. Both are facts about npm, not opinions.
  const listed = new Set(
    catalog.filter((e) => !e.deprecated).map((e) => e.name),
  );
  for (const [name, wasDeprecated] of known) {
    if (!isTrackedName(name)) continue;
    const isDeprecated = !listed.has(name);
    if (isDeprecated === wasDeprecated) continue;
    const { error } = await supabaseAdmin
      .from("plugins")
      .update({ deprecated: isDeprecated })
      .eq("name", name);
    if (error) throw new Error(`plugins update ${name}: ${error.message}`);
    console.log(`[catalog] ${name} → deprecated=${isDeprecated}`);
  }

  console.log(`[catalog] ${catalog.length} packages in the counted set`);
}

// Rows on the ignore list are outside the catalog's remit entirely — their
// `deprecated` value is never read, so don't churn it.
function isTrackedName(name: string): boolean {
  return !IGNORED_PACKAGES.includes(name);
}

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const runId = await startRun();
  let rowsWritten = 0;
  let errorMessage: string | null = null;

  try {
    // Discover first: a package published today is counted today.
    await syncPluginCatalog();

    const { data: allPluginRows, error: pluginsErr } = await supabaseAdmin
      .from("plugins")
      .select("id,name,slug");
    if (pluginsErr) throw new Error(`plugins select: ${pluginsErr.message}`);

    // Deny-list, not allow-list. This table was hand-seeded in two migrations
    // (2026-05-16) and never updated: by 2026-08-09 it held 25 rows while 30
    // plugins existed, so 14 live plugins — anthropic/openai/gemini/knex/
    // mysql/prisma/sequelize/sqlite/typeorm-security, jwt-security,
    // postgresql-security, mcp-sdk-security, drizzle-security, react-a11y —
    // never reached the blog's download totals at all. Nothing errored; they
    // were simply absent.
    //
    // Filtering here rather than deleting rows keeps the retired packages'
    // history intact (plugin_daily_metrics rows are foreign-keyed to
    // plugins.id) while removing them from what we report going forward.
    const plugins = trackedPackages(allPluginRows as PluginRow[]);
    const skipped = (allPluginRows as PluginRow[]).length - plugins.length;
    if (skipped > 0) {
      console.log(
        `[ingest] tracking ${plugins.length} plugin(s); skipping ${skipped} on the ignore list (${IGNORED_PACKAGES.join(", ")})`,
      );
    }

    // NPM downloads → plugin_daily_metrics, three periods per package.
    //
    // Pacing alone never solved this. The serial 250ms-spaced loop it replaces
    // still lost 32 of 72 calls to 429s at 24 packages (run 31297231307), and
    // 66 of 108 at 36 — 21 packages recorded nothing at all. Slowing down
    // further only widens the window npm counts requests in.
    //
    // The fix is to ask fewer times: the point endpoint takes a comma-joined
    // list, so all unscoped packages come back in ONE call per period. That's
    // 108 requests → 3 bulk + 12 scoped. Scoped names can't ride along
    // ("scoped packages are not currently supported in bulk lookups"), so the
    // four @interlace/* ones stay individual, still paced.
    const names = (plugins as PluginRow[]).map((p) => p.name);
    const [d1By, d7By, d30By] = [
      await fetchNpmMany(names, "last-day"),
      await fetchNpmMany(names, "last-week"),
      await fetchNpmMany(names, "last-month"),
    ];

    let dailySum = 0;
    for (const p of plugins as PluginRow[]) {
      const d1 = d1By[p.name] ?? null;
      const d7 = d7By[p.name] ?? null;
      const d30 = d30By[p.name] ?? null;
      console.log(`[npm] ${p.name}  d1=${d1} d7=${d7} d30=${d30}`);
      dailySum += d1 ?? 0;
      const { error: upErr } = await supabaseAdmin
        .from("plugin_daily_metrics")
        .upsert(
          {
            plugin_id: p.id,
            observed_on: today,
            npm_downloads_d1: d1,
            npm_downloads_d7: d7,
            npm_downloads_d30: d30,
            ingest_run_id: runId,
          },
          { onConflict: "plugin_id,observed_on" },
        );
      if (upErr) throw new Error(`upsert ${p.name}: ${upErr.message}`);
      rowsWritten += 1;
    }

    // Creator: github-repo (stars), github (followers + commits), devto (totals)
    const repoStars = await fetchGitHubRepoStars();
    const ghUser = await fetchGitHubUser();
    const ghCommits = await fetchGitHubCommits();
    const devtoArticles = await fetchAllDevtoArticles();
    const devtoFollowers = await fetchDevtoFollowers();
    const devto =
      devtoArticles.length > 0
        ? {
            ...summarizeDevto(devtoArticles),
            ...(devtoFollowers !== null ? { followers: devtoFollowers } : {}),
          }
        : null;

    // Sync external_articles with every fetched dev.to article so the
    // canonical article list lives in Supabase, not in any static file.
    if (devtoArticles.length > 0) {
      const articleRows: Tables["external_articles"]["Insert"][] = devtoArticles
        .filter((a) => a.published === true)
        .map((a) => ({
          source: "devto",
          external_id: a.slug,
          slug: a.slug,
          title: a.title ?? null,
          description: a.description ?? null,
          author: a.user?.username ?? CREATOR,
          url: a.url ?? a.canonical_url ?? null,
          published_at: a.published_at ?? null,
          payload:
            a as unknown as Tables["external_articles"]["Insert"]["payload"],
        }));
      const { error: artErr } = await supabaseAdmin
        .from("external_articles")
        .upsert(articleRows, { onConflict: "source,external_id" });
      if (artErr)
        throw new Error(`external_articles upsert: ${artErr.message}`);
      console.log(`[devto] synced ${articleRows.length} articles`);
      rowsWritten += articleRows.length;

      // Article daily snapshots — time-series per article (views/reactions/comments).
      // Lets us answer "is the no-cycle article still growing or plateauing?"
      const snapshotRows = devtoArticles
        .filter((a) => a.published === true && a.slug)
        .map((a) => ({
          external_id: a.slug!,
          source: "devto",
          observed_on: today,
          views: a.page_views_count ?? null,
          reactions: a.positive_reactions_count ?? null,
          comments: a.comments_count ?? null,
          ingest_run_id: runId,
        }));
      if (snapshotRows.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: snapErr } = await (supabaseAdmin as any)
          .from("article_daily_snapshots")
          .upsert(snapshotRows, {
            onConflict: "external_id,source,observed_on",
          });
        if (snapErr)
          console.error(`[devto] article_daily_snapshots: ${snapErr.message}`);
        else {
          rowsWritten += snapshotRows.length;
          console.log(
            `[devto] ${snapshotRows.length} article snapshots written`,
          );
        }
      }
    }

    const creatorRows: Tables["creator_daily_metrics"]["Insert"][] = [];
    if (repoStars !== null) {
      creatorRows.push({
        creator: CREATOR,
        platform: "github-repo",
        observed_on: today,
        followers: repoStars,
        ingest_run_id: runId,
      });
    }
    if (ghUser) {
      creatorRows.push({
        creator: CREATOR,
        platform: "github",
        observed_on: today,
        followers: ghUser.followers,
        ...(ghCommits !== null ? { total_commits: ghCommits } : {}),
        ingest_run_id: runId,
      });
      if (ghCommits !== null) console.log(`[github] commits=${ghCommits}`);
    }
    if (devto) {
      creatorRows.push({
        creator: CREATOR,
        platform: "devto",
        observed_on: today,
        ...devto,
        followers: devtoFollowers,
        ingest_run_id: runId,
      });
      if (devtoFollowers !== null) {
        console.log(`[devto] followers=${devtoFollowers}`);
      }
    }
    if (creatorRows.length > 0) {
      const { error: cErr } = await supabaseAdmin
        .from("creator_daily_metrics")
        .upsert(creatorRows, { onConflict: "creator,platform,observed_on" });
      if (cErr) throw new Error(`creator upsert: ${cErr.message}`);
      rowsWritten += creatorRows.length;
    }

    // Reciprocity / citizenship metrics → metric_snapshots EAV.
    // Each is a scalar that grows over time; refresh_storefront_ratchet
    // pulls them via v_metric_latest.
    const reciprocityRows: Tables["metric_snapshots"]["Insert"][] = [];

    const commentsLeft = await fetchDevtoCommentsLeft();
    if (commentsLeft !== null) {
      reciprocityRows.push({
        source: "devto-engagement",
        kind: "comments_left",
        dimension: "",
        observed_on: today,
        value: commentsLeft,
        ingest_run_id: runId,
      });
      console.log(`[devto-engaged] comments_left=${commentsLeft}`);
    }

    const externalPRs = await fetchGitHubSearchCount(
      `is:pr is:merged author:${GITHUB_REPO_OWNER} -user:${GITHUB_REPO_OWNER}`,
    );
    if (externalPRs !== null) {
      reciprocityRows.push({
        source: "github-contributions",
        kind: "external_prs_merged",
        dimension: "",
        observed_on: today,
        value: externalPRs,
        ingest_run_id: runId,
      });
      console.log(`[github] external_prs_merged=${externalPRs}`);
    }

    const externalIssues = await fetchGitHubSearchCount(
      `is:issue author:${GITHUB_REPO_OWNER} -user:${GITHUB_REPO_OWNER}`,
    );
    if (externalIssues !== null) {
      reciprocityRows.push({
        source: "github-contributions",
        kind: "external_issues_opened",
        dimension: "",
        observed_on: today,
        value: externalIssues,
        ingest_run_id: runId,
      });
      console.log(`[github] external_issues_opened=${externalIssues}`);
    }

    const allPRs = await fetchGitHubSearchCount(
      `is:pr is:merged author:${GITHUB_REPO_OWNER}`,
    );
    if (allPRs !== null) {
      reciprocityRows.push({
        source: "github-contributions",
        kind: "prs_merged_total",
        dimension: "",
        observed_on: today,
        value: allPRs,
        ingest_run_id: runId,
      });
      console.log(`[github] prs_merged_total=${allPRs}`);
    }

    const releases = await fetchGitHubReleaseCount(
      GITHUB_REPO_OWNER,
      GITHUB_REPO_NAME,
    );
    if (releases !== null) {
      reciprocityRows.push({
        source: "github-releases",
        kind: "releases_cumulative",
        dimension: `${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`,
        observed_on: today,
        value: releases,
        ingest_run_id: runId,
      });
      console.log(`[github] releases_cumulative=${releases}`);
    }

    const pageviews = await fetchPostHogPageviews();
    if (pageviews !== null) {
      reciprocityRows.push({
        source: "posthog",
        kind: "page_views",
        dimension: "",
        observed_on: today,
        value: pageviews,
        ingest_run_id: runId,
      });
      console.log(`[posthog] page_views=${pageviews}`);
    }

    // HN mentions — stories on Hacker News referencing our package / author.
    const hnMentions = await fetchHNMentions();
    if (hnMentions !== null) {
      reciprocityRows.push({
        source: "hn",
        kind: "story_mentions",
        dimension: "",
        observed_on: today,
        value: hnMentions,
        ingest_run_id: runId,
      });
    }

    // Reddit mentions — r/javascript + r/node + r/webdev.
    const redditMentions = await fetchRedditMentions();
    if (redditMentions !== null) {
      reciprocityRows.push({
        source: "reddit",
        kind: "story_mentions",
        dimension: "",
        observed_on: today,
        value: redditMentions,
        ingest_run_id: runId,
      });
    }

    // PostHog referrer breakdown — top UTM/referrer sources by session count.
    const referrers = await fetchPostHogReferrers();
    for (const { source, sessions } of referrers) {
      reciprocityRows.push({
        source: "posthog_referrers",
        kind: "sessions_by_source",
        dimension: source,
        observed_on: today,
        value: sessions,
        ingest_run_id: runId,
      });
    }
    if (referrers.length > 0) {
      console.log(
        `[posthog] referrers: ${referrers.map((r) => `${r.source}=${r.sessions}`).join(", ")}`,
      );
    }

    if (reciprocityRows.length > 0) {
      const { error: rErr } = await supabaseAdmin
        .from("metric_snapshots")
        .upsert(reciprocityRows, {
          onConflict: "source,kind,dimension,observed_on",
        });
      if (rErr) throw new Error(`reciprocity upsert: ${rErr.message}`);
      rowsWritten += reciprocityRows.length;
    }

    // Codecov: per-component coverage + per-plugin line counts →
    // coverage_snapshots. Repo totals → ecosystem_daily_metrics.
    //
    // No retry here — matches the file's no-in-script-retry policy (see
    // withRetry above): a transient Codecov failure is recovered by
    // tomorrow's run. What WAS missing is visibility: a whole-fetch failure
    // used to skip the block silently (ingest_runs still says "success"),
    // and a repoTotals failure used to overwrite today's ecosystem row with
    // explicit nulls, corrupting the coverage trend for that day instead of
    // just leaving it stale. Both are now recorded as codecov-health metrics
    // and repoTotals falls back to yesterday's values instead of nulling.
    const components = await fetchCodecovComponents();
    const repoTotals = await fetchCodecovRepoTotals();
    if (components.length === 0) {
      console.error(
        "[codecov] ⚠ components fetch failed — no per-plugin coverage today",
      );
      await supabaseAdmin.from("metric_snapshots").upsert(
        {
          source: "codecov-health",
          kind: "components_fetch_failed",
          dimension: "",
          observed_on: today,
          value: 1,
          ingest_run_id: runId,
        },
        { onConflict: "source,kind,dimension,observed_on" },
      );
    }
    if (repoTotals === null) {
      console.error(
        "[codecov] ⚠ repo totals fetch failed — carrying forward yesterday's ecosystem coverage",
      );
      await supabaseAdmin.from("metric_snapshots").upsert(
        {
          source: "codecov-health",
          kind: "repo_totals_fetch_failed",
          dimension: "",
          observed_on: today,
          value: 1,
          ingest_run_id: runId,
        },
        { onConflict: "source,kind,dimension,observed_on" },
      );
    }
    if (components.length > 0) {
      const coverageRows: Tables["coverage_snapshots"]["Insert"][] = [];
      for (const c of components) {
        const plugin = matchPluginByCodecovName(c.name, plugins as PluginRow[]);
        if (!plugin) {
          console.log(`[codecov]   no plugin match for "${c.name}" — skipping`);
          continue;
        }
        // Fetch per-plugin line counts via /report/?path=packages/<dir>
        const pkgPath = pluginToPackagePath(plugin);
        const totals = await fetchCodecovPathTotals(pkgPath);
        coverageRows.push({
          plugin_id: plugin.id,
          observed_on: today,
          coverage_pct: c.coverage,
          total_lines: totals?.lines ?? null,
          covered_lines: totals?.hits ?? null,
          status:
            c.coverage >= 80
              ? "production"
              : c.coverage >= 60
                ? "beta"
                : "alpha",
          ingest_run_id: runId,
        });
      }
      if (coverageRows.length > 0) {
        const { error: covErr } = await supabaseAdmin
          .from("coverage_snapshots")
          .upsert(coverageRows, { onConflict: "plugin_id,observed_on" });
        if (covErr)
          throw new Error(`coverage_snapshots upsert: ${covErr.message}`);
        rowsWritten += coverageRows.length;
        const above80 = coverageRows.filter(
          (r) => (r.coverage_pct ?? 0) >= 80,
        ).length;
        const totalLines = coverageRows.reduce(
          (s, r) => s + (r.total_lines ?? 0),
          0,
        );
        const coveredLines = coverageRows.reduce(
          (s, r) => s + (r.covered_lines ?? 0),
          0,
        );
        console.log(
          `[codecov] ${coverageRows.length} plugins (${above80} ≥80%) — ${coveredLines}/${totalLines} lines covered`,
        );

        // Health check: every plugin in the manifest should have a coverage row.
        // A gap means matchPluginByCodecovName silently dropped it. We write a
        // metric so the dashboard can show a warning, and log at error level so
        // the ingest stdout is searchable.
        const matchedPluginIds = new Set(coverageRows.map((r) => r.plugin_id));
        const unmatched = (plugins as PluginRow[]).filter(
          (p) => !matchedPluginIds.has(p.id),
        );
        if (unmatched.length > 0) {
          const names = unmatched.map((p) => p.name).join(", ");
          console.error(
            `[codecov] ⚠ ${unmatched.length} plugin(s) have no Codecov coverage row today: ${names}`,
          );
          // Record as a metric so it's auditable in Supabase.
          await supabaseAdmin.from("metric_snapshots").upsert(
            {
              source: "codecov-health",
              kind: "unmatched_plugin_count",
              dimension: names,
              observed_on: today,
              value: unmatched.length,
              ingest_run_id: runId,
            },
            { onConflict: "source,kind,dimension,observed_on" },
          );
        }
      }
    }

    // Ecosystem daily rollup
    const { data: prevEco } = await supabaseAdmin
      .from("ecosystem_daily_metrics")
      .select("total_npm_downloads")
      .order("observed_on", { ascending: false })
      .limit(1);
    const prevTotal = Number(prevEco?.[0]?.total_npm_downloads ?? 0);
    const newTotal = prevTotal + dailySum;

    const { error: eErr } = await supabaseAdmin
      .from("ecosystem_daily_metrics")
      .upsert(
        {
          observed_on: today,
          total_packages: plugins?.length ?? null,
          total_plugins: plugins?.length ?? null,
          total_npm_downloads: newTotal,
          daily_npm_downloads: dailySum,
          test_coverage: repoTotals?.coverage ?? null,
          total_lines: repoTotals?.lines ?? null,
          covered_lines: repoTotals?.hits ?? null,
          missed_lines: repoTotals?.misses ?? null,
          partial_lines: repoTotals?.partials ?? null,
          ingest_run_id: runId,
        },
        { onConflict: "observed_on" },
      );
    if (eErr) throw new Error(`ecosystem upsert: ${eErr.message}`);
    rowsWritten += 1;

    // Download-to-star ratio — written after newTotal is known.
    // The "headline metric" from GROWTH_PHILOSOPHY: lower = more visible community.
    if (repoStars !== null && repoStars > 0 && newTotal > 0) {
      const ratio = Math.round(newTotal / repoStars);
      const { error: ratioErr } = await supabaseAdmin
        .from("metric_snapshots")
        .upsert(
          {
            source: "computed",
            kind: "downloads_per_star",
            dimension: "",
            observed_on: today,
            value: ratio,
            ingest_run_id: runId,
          },
          { onConflict: "source,kind,dimension,observed_on" },
        );
      if (ratioErr)
        console.error(`[computed] ratio upsert: ${ratioErr.message}`);
      console.log(
        `[computed] downloads_per_star=${ratio} (${newTotal} downloads / ${repoStars} stars)`,
      );
    }

    // GitHub dependents — how many repos depend on our packages.
    // Rate-limited: only sample the 5 flagship plugins to stay within budget.
    const flagshipPlugins = (plugins as PluginRow[]).filter((p) =>
      [
        "eslint-plugin-secure-coding",
        "eslint-plugin-node-security",
        "eslint-plugin-jwt",
        "eslint-plugin-import-next",
        "eslint-plugin-maintainability",
      ].includes(p.name),
    );
    for (const p of flagshipPlugins) {
      await sleep(500); // GitHub search has strict secondary rate limits
      const count = await fetchGitHubDependents(p.name);
      if (count !== null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: depErr } = await (supabaseAdmin as any)
          .from("plugin_dependents")
          .upsert(
            {
              plugin_id: p.id,
              observed_on: today,
              dependent_count: count,
              ingest_run_id: runId,
            },
            { onConflict: "plugin_id,observed_on" },
          );
        if (depErr) console.error(`[dependents] ${p.name}: ${depErr.message}`);
        else {
          rowsWritten += 1;
          console.log(`[dependents] ${p.name}=${count}`);
        }
      }
    }

    // npm version share — latest-version % of d30 for top plugins.
    // Measures upgrade cadence. Only runs for the ecosystem total + top plugin.
    if (newTotal > 0) {
      const secPlugin = (plugins as PluginRow[]).find(
        (p) => p.name === "eslint-plugin-secure-coding",
      );
      if (secPlugin) {
        const d30Row = await supabaseAdmin
          .from("plugin_daily_metrics")
          .select("npm_downloads_d30")
          .eq("plugin_id", secPlugin.id)
          .eq("observed_on", today)
          .single();
        const d30 = d30Row.data?.npm_downloads_d30 ?? 0;
        if (d30 > 0) {
          const vs = await fetchNpmVersionShare(secPlugin.name, d30);
          if (vs) {
            await supabaseAdmin.from("metric_snapshots").upsert(
              {
                source: "npm",
                kind: "version_share",
                dimension: `${secPlugin.name}@${vs.latestVersion}`,
                observed_on: today,
                value: vs.latestVersionShare,
                ingest_run_id: runId,
              },
              { onConflict: "source,kind,dimension,observed_on" },
            );
            console.log(
              `[npm] version_share ${secPlugin.name}@${vs.latestVersion}=${vs.latestVersionShare}%`,
            );
          }
        }
      }
    }

    // ── Velocity + attribution metrics ────────────────────────────────────────
    //
    // All four write to metric_snapshots; no schema changes needed.
    // They run after downloads/stars are written for today so the WoW
    // calculations can compare today's row against the row from 7 days ago.

    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000)
      .toISOString()
      .slice(0, 10);

    // 1. Download velocity — week-over-week % change per plugin.
    // Answers: "is the May surge still growing or decaying?"
    {
      const { data: current7 } = await supabaseAdmin
        .from("plugin_daily_metrics")
        .select("plugin_id, npm_downloads_d7")
        .eq("observed_on", today);
      const { data: prior7 } = await supabaseAdmin
        .from("plugin_daily_metrics")
        .select("plugin_id, npm_downloads_d7")
        .eq("observed_on", sevenDaysAgo);

      const priorMap = new Map(
        (prior7 ?? []).map((r) => [r.plugin_id, r.npm_downloads_d7 ?? 0]),
      );
      const velocityRows: Tables["metric_snapshots"]["Insert"][] = [];
      for (const row of current7 ?? []) {
        const prior = priorMap.get(row.plugin_id) ?? 0;
        const current = row.npm_downloads_d7 ?? 0;
        if (prior <= 0) continue; // no baseline yet
        const wow = Math.round(((current - prior) / prior) * 100);
        const plugin = (plugins as PluginRow[]).find(
          (p) => p.id === row.plugin_id,
        );
        if (!plugin) continue;
        velocityRows.push({
          source: "computed",
          kind: "downloads_wow_pct",
          dimension: plugin.name,
          observed_on: today,
          value: wow,
          ingest_run_id: runId,
        });
      }
      if (velocityRows.length > 0) {
        const { error: velErr } = await supabaseAdmin
          .from("metric_snapshots")
          .upsert(velocityRows, {
            onConflict: "source,kind,dimension,observed_on",
          });
        if (velErr)
          console.error(`[velocity] downloads upsert: ${velErr.message}`);
        else {
          const gainers = velocityRows.filter((r) => (r.value ?? 0) > 0).length;
          const top = velocityRows
            .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
            .slice(0, 3)
            .map(
              (r) => `${r.dimension?.split("eslint-plugin-")[1]}=${r.value}%`,
            )
            .join(", ");
          console.log(
            `[velocity] ${gainers}/${velocityRows.length} plugins growing WoW. Top: ${top}`,
          );
          rowsWritten += velocityRows.length;
        }
      }
    }

    // 2. Star velocity — absolute weekly star gain.
    // Answers: "is distribution actually moving the needle?"
    {
      const { data: priorStarRow } = await supabaseAdmin
        .from("creator_daily_metrics")
        .select("followers")
        .eq("creator", CREATOR)
        .eq("platform", "github-repo")
        .eq("observed_on", sevenDaysAgo)
        .single();
      const todayStarRow = creatorRows.find(
        (r) => r.platform === "github-repo",
      );
      const todayStars = (todayStarRow?.followers as number | null) ?? null;
      const priorStars = priorStarRow?.followers ?? null;
      if (todayStars !== null && priorStars !== null) {
        const gain = todayStars - priorStars;
        const { error: svErr } = await supabaseAdmin
          .from("metric_snapshots")
          .upsert(
            {
              source: "computed",
              kind: "stars_wow_gain",
              dimension: "",
              observed_on: today,
              value: gain,
              ingest_run_id: runId,
            },
            { onConflict: "source,kind,dimension,observed_on" },
          );
        if (svErr) console.error(`[velocity] stars upsert: ${svErr.message}`);
        else
          console.log(
            `[velocity] stars_wow_gain=${gain} (${priorStars}→${todayStars})`,
          );
      }
    }

    // 3. GitHub ESLint config mentions — how many repos actually have our
    // plugins wired in an ESLint config (flat or legacy). Distinct from
    // dependents (package.json) — this is real usage config files.
    // Rate-limited to flagship plugins; 500ms gap between searches.
    {
      const CONFIG_QUERIES = [
        { filename: "eslint.config", label: "flat" },
        { filename: ".eslintrc", label: "legacy" },
      ];
      const configPlugins = (plugins as PluginRow[]).filter((p) =>
        [
          "eslint-plugin-secure-coding",
          "eslint-plugin-node-security",
          "eslint-plugin-import-next",
          "eslint-plugin-jwt",
        ].includes(p.name),
      );
      for (const p of configPlugins) {
        let total = 0;
        for (const q of CONFIG_QUERIES) {
          await sleep(600);
          const count = await fetchGitHubSearchCount(
            `"${p.name}" filename:${q.filename}`,
          );
          total += count ?? 0;
        }
        const { error: cfgErr } = await supabaseAdmin
          .from("metric_snapshots")
          .upsert(
            {
              source: "github-config",
              kind: "eslintrc_mentions",
              dimension: p.name,
              observed_on: today,
              value: total,
              ingest_run_id: runId,
            },
            { onConflict: "source,kind,dimension,observed_on" },
          );
        if (cfgErr)
          console.error(`[config-mentions] ${p.name}: ${cfgErr.message}`);
        else {
          console.log(`[config-mentions] ${p.name}=${total}`);
          rowsWritten += 1;
        }
      }
    }

    // 4. Article-to-download correlation — for each article published 8–38
    // days ago, compare average d7 downloads in the 7 days before vs after
    // publish. Writes the delta so we can see if content drives installs.
    // Only runs for articles with a matching plugin tag.
    {
      const tagToPlugin: Record<string, string> = {
        "secure-coding": "eslint-plugin-secure-coding",
        "node-security": "eslint-plugin-node-security",
        "import-next": "eslint-plugin-import-next",
        jwt: "eslint-plugin-jwt",
        "lambda-security": "eslint-plugin-lambda-security",
        "express-security": "eslint-plugin-express-security",
        pg: "eslint-plugin-pg",
      };

      // Articles published 8–38 days ago (need 7-day pre and post windows)
      const windowStart = new Date(Date.now() - 38 * 86400000)
        .toISOString()
        .slice(0, 10);
      const windowEnd = new Date(Date.now() - 8 * 86400000)
        .toISOString()
        .slice(0, 10);
      const { data: articles } = await supabaseAdmin
        .from("external_articles")
        .select("slug, title, published_at, payload")
        .eq("source", "devto")
        .gte("published_at", windowStart)
        .lte("published_at", windowEnd);

      for (const article of articles ?? []) {
        const pubDate = article.published_at?.slice(0, 10);
        if (!pubDate) continue;
        // external_articles.slug is nullable, and it's the `dimension` this
        // loop keys its metric_snapshots row on — a null would write a row
        // nothing can ever look up again.
        if (!article.slug) continue;

        // Infer which plugin this article is about from its tags
        const tags: string[] = (
          (article.payload as { tag_list?: string[] })?.tag_list ?? []
        ).map((t: string) => t.toLowerCase());
        const matchedPluginName = Object.entries(tagToPlugin).find(([tag]) =>
          tags.some((t) => t.includes(tag)),
        )?.[1];
        if (!matchedPluginName) continue;

        const plugin = (plugins as PluginRow[]).find(
          (p) => p.name === matchedPluginName,
        );
        if (!plugin) continue;

        // 7-day window before publish
        const prePubStart = new Date(new Date(pubDate).getTime() - 7 * 86400000)
          .toISOString()
          .slice(0, 10);
        const postPubEnd = new Date(new Date(pubDate).getTime() + 7 * 86400000)
          .toISOString()
          .slice(0, 10);

        const { data: preRows } = await supabaseAdmin
          .from("plugin_daily_metrics")
          .select("npm_downloads_d1")
          .eq("plugin_id", plugin.id)
          .gte("observed_on", prePubStart)
          .lt("observed_on", pubDate);

        const { data: postRows } = await supabaseAdmin
          .from("plugin_daily_metrics")
          .select("npm_downloads_d1")
          .eq("plugin_id", plugin.id)
          .gt("observed_on", pubDate)
          .lte("observed_on", postPubEnd);

        const avg = (rows: typeof preRows) => {
          const vals = (rows ?? [])
            .map((r) => r.npm_downloads_d1 ?? 0)
            .filter((v) => v > 0);
          return vals.length > 0
            ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length)
            : null;
        };

        const preAvg = avg(preRows);
        const postAvg = avg(postRows);
        if (preAvg === null || postAvg === null || preAvg === 0) continue;

        const lift = Math.round(((postAvg - preAvg) / preAvg) * 100);
        const { error: liftErr } = await supabaseAdmin
          .from("metric_snapshots")
          .upsert(
            {
              source: "computed",
              kind: "article_download_lift_pct",
              dimension: article.slug,
              observed_on: today,
              value: lift,
              ingest_run_id: runId,
            },
            { onConflict: "source,kind,dimension,observed_on" },
          );
        if (liftErr)
          console.error(`[article-lift] ${article.slug}: ${liftErr.message}`);
        else
          console.log(
            `[article-lift] ${article.slug} → ${matchedPluginName.replace("eslint-plugin-", "")}: pre=${preAvg} post=${postAvg} lift=${lift}%`,
          );
      }
    }

    const { error: rpcErr } = await supabaseAdmin.rpc(
      "refresh_storefront_ratchet",
    );
    if (rpcErr)
      throw new Error(`refresh_storefront_ratchet: ${rpcErr.message}`);
    console.log("[ratchet] refreshed");
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[ingest] error:", errorMessage);
  }

  await endRun(runId, rowsWritten, errorMessage);
  if (errorMessage) process.exit(1);
  console.log(`[ingest] ✓ ${rowsWritten} rows written`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
