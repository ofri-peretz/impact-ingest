/**
 * dev.to warehouse — everything the owner analytics API exposes, once a day.
 *
 * Intent: blog docs/sdlc/intents/2026-09-03-engage-own-the-data. Tables from
 * agents migration 20260903000000_devto_warehouse. Called from daily-ingest
 * main() after the article sweep; also a CLI for the one-time back-fill:
 *
 *   tsx scripts/devto-warehouse.ts --since 2026-02-23        # analytics history
 *   tsx scripts/devto-warehouse.ts --followers-all           # every follower, with account age
 *   tsx scripts/devto-warehouse.ts --dry-run                 # print, write nothing
 *
 * Idempotent: every upsert uses the table's natural key. Non-fatal: the
 * caller wraps it, so a dev.to hiccup never costs the rest of the ingest.
 *
 * WHY followers carry `onboarding`: measured 2026-09-03, follows exceeded
 * page views two days running (91 on 186, 88 on 66) and the eight newest
 * followers all created their dev.to account the day they followed. That is
 * the platform's "suggested authors" onboarding, not a reader. Storing the
 * account age is what lets the profile scorecard print the follower count
 * with the share that ever read anything.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./_supabase-admin.js";

const ME = "ofri-peretz";
const API = "https://dev.to/api";
const KEY = process.env.DEVTO_API_KEY || process.env.DEV_TO_API_KEY || "";
const PACE_MS = 250;

// The generated Database type predates these tables; regenerate with
// `supabase gen types` and drop this cast when convenient.
const db = supabaseAdmin as unknown as SupabaseClient<any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get<T>(path: string, auth = true): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    headers: { "User-Agent": "impact-ingest devto-warehouse", ...(auth && KEY ? { "api-key": KEY } : {}) },
  });
  if (!r.ok) throw new Error(`dev.to ${path} → ${r.status}`);
  return (await r.json()) as T;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/* ── 1. platform-wide daily analytics ─────────────────────────────────────── */

interface HistDay {
  comments: { total: number };
  follows: { total: number };
  reactions: { total: number; like: number; readinglist: number; unicorn: number; unique_reactors?: number; [k: string]: number | undefined };
  page_views: { total: number; average_read_time_in_seconds: number; total_read_time_in_seconds: number };
}

export async function ingestDevtoAnalytics(since: string, until: string, runId: string | null, dry = false): Promise<number> {
  if (!KEY) { console.log("[devto-warehouse] no API key, skipping analytics"); return 0; }
  const hist = await get<Record<string, HistDay>>(`/analytics/historical?start=${since}&end=${until}`);
  const rows = Object.entries(hist).map(([observed_on, v]) => {
    const rx = v.reactions;
    const known = (rx.like ?? 0) + (rx.readinglist ?? 0) + (rx.unicorn ?? 0);
    return {
      observed_on,
      views: v.page_views.total,
      read_time_avg_s: v.page_views.average_read_time_in_seconds,
      read_time_total_s: v.page_views.total_read_time_in_seconds,
      reactions_total: rx.total,
      reactions_like: rx.like ?? 0,
      reactions_readinglist: rx.readinglist ?? 0,
      reactions_unicorn: rx.unicorn ?? 0,
      reactions_other: Math.max(0, rx.total - known),
      unique_reactors: rx.unique_reactors ?? null,
      comments: v.comments.total,
      follows: v.follows.total,
      ingest_run_id: runId,
    };
  });
  console.log(`[devto-warehouse] analytics ${since}..${until}: ${rows.length} day(s)`);
  if (dry || rows.length === 0) return 0;
  const { error } = await db.from("devto_daily_analytics").upsert(rows, { onConflict: "observed_on" });
  if (error) throw new Error(`devto_daily_analytics upsert: ${error.message}`);
  return rows.length;
}

/* ── 2. referrers (cumulative as of today; the daily delta is a view's job) ── */

export async function ingestDevtoReferrers(today: string, runId: string | null, dry = false): Promise<number> {
  if (!KEY) return 0;
  const { domains } = await get<{ domains: { domain: string | null; count: number }[] }>(`/analytics/referrers`);
  const rows = domains.map((d) => ({ observed_on: today, domain: d.domain ?? "", views: d.count, ingest_run_id: runId }));
  console.log(`[devto-warehouse] referrers: ${rows.length} domain(s) as of ${today}`);
  if (dry || rows.length === 0) return 0;
  const { error } = await db.from("devto_referrers_daily").upsert(rows, { onConflict: "observed_on,domain" });
  if (error) throw new Error(`devto_referrers_daily upsert: ${error.message}`);
  return rows.length;
}

/* ── 3. followers, with account age ───────────────────────────────────────── */

interface Follower { id: number; created_at: string; user_id: number; name: string | null; username: string }

/** "Sep  3, 2026" → "2026-09-03". dev.to prints joined_at as a display string. */
export function parseJoined(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = Date.parse(s.replace(/\s+/g, " "));
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Followed within a day of creating the account = onboarding suggestion, not a reader. */
export function isOnboarding(followedAt: string, joinedOn: string | null): boolean | null {
  if (!joinedOn) return null;
  const diff = (Date.parse(followedAt.slice(0, 10)) - Date.parse(joinedOn)) / 86_400_000;
  return diff >= -1 && diff <= 1;
}

export async function ingestDevtoFollowers(runId: string | null, opts: { all?: boolean; dry?: boolean; lookupLimit?: number } = {}): Promise<number> {
  if (!KEY) return 0;
  // Newest first; stop at the first user we already hold unless --followers-all.
  const known = new Set<number>();
  if (!opts.all) {
    const { data } = await db.from("devto_followers").select("user_id").order("followed_at", { ascending: false }).limit(5000);
    for (const r of data ?? []) known.add(Number(r.user_id));
  }
  const fresh: Follower[] = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await get<Follower[]>(`/followers/users?per_page=1000&page=${page}&sort=-created_at`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    let stop = false;
    for (const f of batch) {
      if (known.has(f.user_id)) { stop = true; break; }
      fresh.push(f);
    }
    if (stop || batch.length < 1000) break;
    await sleep(PACE_MS);
  }
  console.log(`[devto-warehouse] followers: ${fresh.length} new (known ${known.size})`);
  const limit = opts.lookupLimit ?? (opts.dry ? 5 : 3000);
  const rows: any[] = [];
  let looked = 0;
  for (const f of fresh) {
    let joined: string | null = null;
    if (looked < limit) {
      try {
        const u = await get<{ joined_at?: string }>(`/users/${f.user_id}`, false);
        joined = parseJoined(u.joined_at);
      } catch { /* profile gone or throttled: leave joined_on null, onboarding null */ }
      looked++;
      await sleep(PACE_MS);
    }
    rows.push({
      user_id: f.user_id, username: f.username, name: f.name, followed_at: f.created_at,
      joined_on: joined, onboarding: isOnboarding(f.created_at, joined), last_seen: day(new Date()), ingest_run_id: runId,
    });
  }
  if (rows.length) {
    const onb = rows.filter((r) => r.onboarding === true).length;
    console.log(`[devto-warehouse] followers: ${onb}/${rows.length} onboarding (same-day accounts)`);
  }
  if (opts.dry || rows.length === 0) return 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("devto_followers").upsert(rows.slice(i, i + 500), { onConflict: "user_id" });
    if (error) throw new Error(`devto_followers upsert: ${error.message}`);
  }
  return rows.length;
}

/* ── 4. inbound comments on our articles, with our reply if any ───────────── */

interface Node { id_code: string; created_at: string; body_html?: string; user?: { username?: string }; children?: Node[] }
const strip = (s = "") => s.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);

export function ourReplyIn(children: Node[] = []): { id: string; at: string } | null {
  let best: { id: string; at: string } | null = null;
  for (const c of children) {
    if (c.user?.username === ME && (!best || c.created_at < best.at)) best = { id: c.id_code, at: c.created_at };
    const deeper = ourReplyIn(c.children);
    if (deeper && (!best || deeper.at < best.at)) best = deeper;
  }
  return best;
}

export async function ingestDevtoInboundComments(
  articles: { id: number; comments_count?: number }[],
  runId: string | null,
  dry = false,
): Promise<number> {
  const rows: any[] = [];
  let trees = 0;
  for (const a of articles) {
    if (!a.comments_count) continue;
    let tree: Node[];
    try { tree = await get<Node[]>(`/comments?a_id=${a.id}`, false); trees++; } catch { continue; }
    const walk = (nodes: Node[], parent: string | null) => {
      for (const n of nodes) {
        if (n.user?.username && n.user.username !== ME) {
          const reply = ourReplyIn(n.children);
          rows.push({
            comment_id: n.id_code, article_id: a.id, article_author: ME, author: n.user.username, direction: "in",
            parent_id: parent, created_at: n.created_at, body_excerpt: strip(n.body_html),
            our_reply_id: reply?.id ?? null, our_reply_at: reply?.at ?? null, ingest_run_id: runId,
          });
        }
        walk(n.children ?? [], n.id_code);
      }
    };
    walk(tree, null);
    await sleep(PACE_MS);
  }
  console.log(`[devto-warehouse] inbound comments: ${rows.length} across ${trees} article(s)`);
  if (dry || rows.length === 0) return 0;
  const { error } = await db.from("devto_comments").upsert(rows, { onConflict: "comment_id" });
  if (error) throw new Error(`devto_comments upsert: ${error.message}`);
  return rows.length;
}

/* ── the daily step ───────────────────────────────────────────────────────── */

export async function ingestDevtoWarehouse(opts: {
  today: string;
  runId: string | null;
  articles: { id: number; comments_count?: number }[];
  since?: string;
  followersAll?: boolean;
  dry?: boolean;
}): Promise<number> {
  const since = opts.since ?? day(new Date(Date.now() - 7 * 86_400_000)); // re-upsert a week: dev.to revises recent days
  let n = 0;
  n += await ingestDevtoAnalytics(since, opts.today, opts.runId, opts.dry);
  n += await ingestDevtoReferrers(opts.today, opts.runId, opts.dry);
  n += await ingestDevtoFollowers(opts.runId, { all: opts.followersAll, dry: opts.dry });
  n += await ingestDevtoInboundComments(opts.articles, opts.runId, opts.dry);
  return n;
}

// CLI: back-fill and dry runs.
if (process.argv[1] && /devto-warehouse\.ts$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const val = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  (async () => {
    const today = day(new Date());
    const articles = await get<{ id: number; comments_count?: number }[]>(`/articles/me/all?per_page=100&page=1`).catch(() => []);
    const n = await ingestDevtoWarehouse({
      today, runId: null, articles,
      since: val("--since"), followersAll: args.includes("--followers-all"), dry: args.includes("--dry-run"),
    });
    console.log(`[devto-warehouse] done: ${n} row(s)${args.includes("--dry-run") ? " (dry run)" : ""}`);
  })().catch((e) => { console.error(e); process.exit(1); });
}
