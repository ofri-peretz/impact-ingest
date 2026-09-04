#!/usr/bin/env -S tsx
/**
 * dev.to attention — what the platform's staff publish, whom they feature,
 * where they comment, who stars our repos, and the days something outside
 * dev.to sent readers. Intent 2026-09-04-engage-attention (blog docs/sdlc).
 *
 * Four collectors and one derivation, all daily upserts keyed on natural ids.
 * Promotion events are derived, never fetched: a referrer domain's daily
 * delta above its 28-day mean plus two sigma, or a day with more than three
 * stars on a repo.
 *
 *   npx tsx scripts/devto-attention.ts            # all collectors, today
 *   npx tsx scripts/devto-attention.ts --stars     # one collector
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./_supabase-admin.js";

const API = "https://dev.to/api";
const KEY = process.env.DEVTO_API_KEY || process.env.DEV_TO_API_KEY || "";
const GH = process.env.GITHUB_TOKEN || "";
const PACE_MS = 250;
const db = supabaseAdmin as unknown as SupabaseClient<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The asserted staff list (lib/people.ts, verified: true). Edit there and here together. */
export const STAFF = ["ben", "jess", "peter", "michaeltharrington", "thepracticaldev", "vivjair"];
/** Repos whose stars are ours to count. */
export const REPOS = ["ofri-peretz/eslint", "ofri-peretz/serverless", "ofri-peretz/eslint-benchmark-suite"];
/** A referrer from one of these means a person shared us somewhere. */
export const PROMOTION_DOMAINS = ["t.co", "linkedin.com", "linkedin.android", "forem.com", "echojs.com", "tsecurity.de", "chatgpt.com", "news.ycombinator.com", "reddit.com", "bsky.app"];
export const STAR_BURST = 3;

/**
 * Authenticated by default: anonymous reads are rate-limited far harder
 * (429 after a few dozen calls on 2026-09-04). A 429 waits and retries
 * three times before giving up on that path.
 */
async function get<T>(path: string, auth = true): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${API}${path}`, { headers: { "User-Agent": "impact-ingest devto-attention", ...(auth && KEY ? { "api-key": KEY } : {}) } });
    if (r.status === 404) return null;
    if (r.status === 429 && attempt < 3) { await sleep(3_000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`dev.to ${path} → ${r.status}`);
    return (await r.json()) as T;
  }
}

/* ── pure ─────────────────────────────────────────────────────────────────── */

export function programOf(title: string): "top7" | "gems" | "digest" | null {
  const t = title.toLowerCase();
  if (/top 7/.test(t)) return "top7";
  if (/community gems/.test(t)) return "gems";
  if (/digest|weekly wins|roundup|top posts/.test(t)) return "digest";
  return null;
}

const RESERVED = new Set(["settings", "t", "tags", "p", "search", "notifications", "dashboard", "readinglist", "listings", "enter", "new"]);

/** The posts a feature post names: liquid embeds and markdown links to dev.to/<user>/<slug>. */
export function parseFeatures(body: string): { username: string; slug: string }[] {
  const seen = new Set<string>();
  const out: { username: string; slug: string }[] = [];
  for (const m of body.matchAll(/https?:\/\/dev\.to\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)/g)) {
    const [, username, slug] = m;
    if (RESERVED.has(username) || !/\d/.test(slug.slice(-6))) continue; // article slugs end in a short id
    const k = `${username}/${slug}`;
    if (!seen.has(k)) { seen.add(k); out.push({ username, slug }); }
  }
  return out;
}

export interface Comment { id_code: string; created_at: string; user?: { username?: string }; children?: Comment[] }
/** Flatten a comment tree to the comments left by staff. */
export function staffIn(tree: Comment[], staff: Set<string>): { id: string; staff: string; at: string }[] {
  const out: { id: string; staff: string; at: string }[] = [];
  const walk = (c: Comment) => {
    const u = c.user?.username ?? "";
    if (staff.has(u)) out.push({ id: c.id_code, staff: u, at: c.created_at });
    for (const k of c.children ?? []) walk(k);
  };
  for (const c of tree) walk(c);
  return out;
}

export interface Event { observed_on: string; kind: "referrer" | "stars"; source: string; value: number; baseline: number | null }

/**
 * Referrer events from cumulative rows: a day's delta over the previous row
 * that is at least 3 and above the mean plus two sigma of the 28 deltas
 * before it (sigma floored at 1, so a flat baseline still needs a real jump).
 */
export function referrerEvents(rows: { observed_on: string; domain: string; views: number }[]): Event[] {
  const out: Event[] = [];
  const byDomain = new Map<string, { observed_on: string; views: number }[]>();
  for (const r of rows) {
    if (!PROMOTION_DOMAINS.includes(r.domain)) continue;
    const list = byDomain.get(r.domain) ?? [];
    list.push(r);
    byDomain.set(r.domain, list);
  }
  for (const [domain, list] of byDomain) {
    list.sort((a, b) => a.observed_on.localeCompare(b.observed_on));
    const deltas = list.slice(1).map((r, i) => ({ observed_on: r.observed_on, d: r.views - list[i].views }));
    deltas.forEach((x, i) => {
      const prior = deltas.slice(Math.max(0, i - 28), i).map((p) => p.d);
      const mean = prior.length ? prior.reduce((s, v) => s + v, 0) / prior.length : 0;
      const sd = Math.max(1, Math.sqrt(prior.length ? prior.reduce((s, v) => s + (v - mean) ** 2, 0) / prior.length : 0));
      if (x.d >= 3 && x.d > mean + 2 * sd) out.push({ observed_on: x.observed_on, kind: "referrer", source: domain, value: x.d, baseline: Math.round(mean * 100) / 100 });
    });
  }
  return out;
}

/** A day with more than STAR_BURST stars on one repo. */
export function starEvents(stars: { repo: string; starred_at: string }[]): Event[] {
  const byDay = new Map<string, number>();
  for (const s of stars) { const k = `${s.repo}|${s.starred_at.slice(0, 10)}`; byDay.set(k, (byDay.get(k) ?? 0) + 1); }
  return [...byDay].filter(([, n]) => n > STAR_BURST).map(([k, n]) => { const [repo, day] = k.split("|"); return { observed_on: day, kind: "stars", source: repo, value: n, baseline: STAR_BURST }; });
}

/* ── collectors ───────────────────────────────────────────────────────────── */

interface Article { id: number; title: string; tag_list: string[] | string; published_at: string; positive_reactions_count?: number; public_reactions_count?: number; comments_count?: number; user?: { username?: string }; body_markdown?: string }
const tags = (a: Article) => (Array.isArray(a.tag_list) ? a.tag_list : String(a.tag_list ?? "").split(",").map((t) => t.trim()).filter(Boolean));

export async function ingestStaffPosts(today: string, runId: string | null): Promise<number> {
  let n = 0;
  for (const u of STAFF) {
    const posts = (await get<Article[]>(`/articles?username=${u}&per_page=30`)) ?? [];
    await sleep(PACE_MS);
    if (!posts.length) continue;
    const rows = posts.map((a) => ({
      article_id: a.id, author: u, title: a.title, tags: tags(a), published_at: a.published_at,
      reactions: a.positive_reactions_count ?? a.public_reactions_count ?? 0, comments: a.comments_count ?? 0,
      program: programOf(a.title), observed_on: today, ingest_run_id: runId,
    }));
    const { error } = await db.from("devto_staff_posts").upsert(rows, { onConflict: "article_id" });
    if (error) throw new Error(`devto_staff_posts: ${error.message}`);
    n += rows.length;
    // Feature posts name people; read the body and resolve each named post.
    for (const a of posts.filter((p) => programOf(p.title))) {
      const full = await get<Article>(`/articles/${a.id}`);
      await sleep(PACE_MS);
      const named = parseFeatures(full?.body_markdown ?? "");
      if (named.length === 0) { console.log(`[attention] ${a.id} ${programOf(a.title)}: no named posts (format change?)`); continue; }
      for (const f of named) {
        const art = await get<Article>(`/articles/${f.username}/${f.slug}`).catch(() => null);
        await sleep(PACE_MS);
        const { error: fe } = await db.from("devto_features").upsert({
          program: programOf(a.title), article_id: a.id, featured_username: f.username, featured_slug: f.slug,
          featured_article_id: art?.id ?? null, published_at: a.published_at, ingest_run_id: runId,
        }, { onConflict: "article_id,featured_username,featured_slug" });
        if (fe) throw new Error(`devto_features: ${fe.message}`);
        n += 1;
      }
    }
  }
  console.log(`[attention] staff posts + features: ${n} rows`);
  return n;
}

/** Staff comments on the month's top articles: whom the founders engage. */
export async function ingestStaffComments(today: string, runId: string | null, pages = 1): Promise<number> {
  const staff = new Set(STAFF);
  let n = 0;
  for (let page = 1; page <= pages; page++) {
    const top = (await get<Article[]>(`/articles?top=30&per_page=100&page=${page}`)) ?? [];
    await sleep(PACE_MS);
    for (const a of top) {
      if ((a.comments_count ?? 0) === 0) continue;
      const tree = (await get<Comment[]>(`/comments?a_id=${a.id}`)) ?? [];
      await sleep(PACE_MS);
      const hits = staffIn(tree, staff);
      if (!hits.length) continue;
      const { error } = await db.from("devto_staff_comments").upsert(hits.map((h) => ({
        comment_id: h.id, staff: h.staff, article_id: a.id, article_author: a.user?.username ?? "", created_at: h.at, first_seen: today, ingest_run_id: runId,
      })), { onConflict: "comment_id" });
      if (error) throw new Error(`devto_staff_comments: ${error.message}`);
      n += hits.length;
    }
  }
  console.log(`[attention] staff comments: ${n} rows`);
  return n;
}

export async function ingestStars(runId: string | null): Promise<number> {
  if (!GH) { console.log("[attention] no GITHUB_TOKEN, skipping stars"); return 0; }
  let n = 0;
  for (const repo of REPOS) {
    for (let page = 1; page <= 30; page++) {
      const r = await fetch(`https://api.github.com/repos/${repo}/stargazers?per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${GH}`, Accept: "application/vnd.github.star+json", "User-Agent": "impact-ingest" },
      });
      if (!r.ok) { console.error(`[attention] stars ${repo} p${page} → ${r.status}`); break; }
      const batch = (await r.json()) as { starred_at: string; user: { login: string } }[];
      if (!batch.length) break;
      const { error } = await db.from("github_stargazers").upsert(batch.map((s) => ({ repo, login: s.user.login, starred_at: s.starred_at, ingest_run_id: runId })), { onConflict: "repo,login" });
      if (error) throw new Error(`github_stargazers: ${error.message}`);
      n += batch.length;
      if (batch.length < 100) break;
    }
  }
  console.log(`[attention] stars: ${n} rows`);
  return n;
}

export async function deriveEvents(runId: string | null): Promise<number> {
  const since = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
  const { data: refs, error: re } = await db.from("devto_referrers_daily").select("observed_on,domain,views").gte("observed_on", since).limit(20000);
  if (re) throw new Error(`devto_referrers_daily: ${re.message}`);
  const { data: stars, error: se } = await db.from("github_stargazers").select("repo,starred_at").gte("starred_at", since).limit(20000);
  if (se) throw new Error(`github_stargazers: ${se.message}`);
  const events = [...referrerEvents(refs ?? []), ...starEvents(stars ?? [])];
  if (events.length) {
    const { error } = await db.from("devto_attention_events").upsert(events.map((e) => ({ ...e, ingest_run_id: runId })), { onConflict: "observed_on,kind,source" });
    if (error) throw new Error(`devto_attention_events: ${error.message}`);
  }
  console.log(`[attention] events: ${events.length}`);
  return events.length;
}

export async function ingestAttention(opts: { today: string; runId: string | null }): Promise<number> {
  let n = 0;
  for (const step of [() => ingestStaffPosts(opts.today, opts.runId), () => ingestStaffComments(opts.today, opts.runId), () => ingestStars(opts.runId), () => deriveEvents(opts.runId)]) {
    try { n += await step(); } catch (e) { console.error(`[attention] ${e instanceof Error ? e.message : String(e)}`); }
  }
  return n;
}

if (process.argv[1]?.endsWith("devto-attention.ts")) {
  const today = new Date().toISOString().slice(0, 10);
  const only = process.argv.find((a) => a.startsWith("--"))?.slice(2);
  const run = only === "stars" ? ingestStars(null) : only === "comments" ? ingestStaffComments(today, null) : only === "events" ? deriveEvents(null) : only === "posts" ? ingestStaffPosts(today, null) : ingestAttention({ today, runId: null });
  run.then((n) => console.log(`[attention] ✓ ${n} rows`)).catch((e) => { console.error(e); process.exit(1); });
}
