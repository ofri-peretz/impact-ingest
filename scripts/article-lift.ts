#!/usr/bin/env -S tsx
/**
 * Article → npm download lift.
 *
 * For each dev.to article, the mean of daily downloads in the seven days
 * after publish over the seven days before. The series is the plugin the
 * article names in its title, description or tags; when it names none, the
 * ecosystem sum across every plugin. The scope is written beside the number
 * so ecosystem lift is never read as plugin lift.
 *
 * Why the fallback exists: the first version matched only on a tag equal to
 * a plugin slug, and our articles are tagged eslint, security, webdev,
 * javascript and ai. It produced zero rows in three months (read 2026-09-04).
 *
 * Runner:  npx tsx scripts/article-lift.ts --since-days 120
 * Daily:   daily-ingest.ts calls computeArticleLifts() for the 8–38 day window.
 */
import { supabaseAdmin, type Tables } from "./_supabase-admin.js";

export const DAY_MS = 86_400_000;
export const WINDOW_DAYS = 7;

export interface LiftPlugin {
  id: number;
  name: string;
  slug: string;
}
export interface LiftArticle {
  slug: string;
  title: string | null;
  published_at: string | null;
  payload: { description?: string | null; tags?: string[] | null; tag_list?: string[] | null } | null;
}

/** The plugin an article is about, or null → ecosystem. Longest name wins. */
export function matchPlugin(article: LiftArticle, plugins: LiftPlugin[]): LiftPlugin | null {
  const tags = article.payload?.tags ?? article.payload?.tag_list ?? [];
  const hay = [article.title ?? "", article.payload?.description ?? "", ...tags]
    .join(" ")
    .toLowerCase();
  let best: LiftPlugin | null = null;
  for (const p of plugins) {
    const bare = p.name.replace(/^eslint-plugin-/, "").toLowerCase();
    // The full package name, or the bare name as a whole word ("pg", not "pgx").
    const hit =
      hay.includes(p.name.toLowerCase()) ||
      new RegExp(`(^|[^a-z0-9-])${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9-]|$)`).test(hay);
    if (hit && (!best || p.name.length > best.name.length)) best = p;
  }
  return best;
}

/** Mean of the positive values, null when there are none. */
export function meanPositive(xs: Array<number | null | undefined>): number | null {
  const v = xs.map((x) => Number(x ?? 0)).filter((x) => x > 0);
  return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
}

/** Percent change after over before; null when either side is unmeasured. */
export function liftPct(pre: number | null, post: number | null): number | null {
  if (pre == null || post == null || pre === 0) return null;
  return Math.round(((post - pre) / pre) * 100);
}

/** Both windows need this many reported days, or the lift is unmeasured. */
export const MIN_DAYS = 3;

/**
 * Sum d1 across plugins per day → one series, the ecosystem.
 *
 * A day is kept only when at least 80% of the plugins seen in the span
 * passed in reported it — call it per article span, not per backfill window:
 * the catalog grew from 25 to 36 plugins over the summer, so a June day is
 * full at 25 and would fail against September's 36. npm's stats pipeline stalls and the ingest skips the missing
 * days per plugin, so a thin day is a partial sum, not a quiet day: the first
 * backfill read pre=2 post=3153 on one article from exactly this.
 */
export function ecosystemSeries(rows: Array<{ observed_on: string; npm_downloads_d1: number | null }>): Array<{ observed_on: string; npm_downloads_d1: number }> {
  const byDay = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    const d = byDay.get(r.observed_on) ?? { sum: 0, n: 0 };
    d.sum += Number(r.npm_downloads_d1 ?? 0);
    d.n += 1;
    byDay.set(r.observed_on, d);
  }
  const full = Math.max(0, ...[...byDay.values()].map((d) => d.n));
  return [...byDay]
    .filter(([, d]) => d.n >= 0.8 * full)
    .map(([observed_on, d]) => ({ observed_on, npm_downloads_d1: d.sum }));
}

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Write one `article_download_lift_pct` row per article published between
 * `untilDays` and `sinceDays` ago. Returns the rows written.
 */
export async function computeArticleLifts(opts: { today: string; runId: string | null; sinceDays: number; untilDays?: number }): Promise<number> {
  const untilDays = opts.untilDays ?? WINDOW_DAYS + 1;
  const now = Date.now();
  const windowStart = isoDay(now - opts.sinceDays * DAY_MS);
  const windowEnd = isoDay(now - untilDays * DAY_MS);

  const { data: plugins, error: pErr } = await supabaseAdmin.from("plugins").select("id,name,slug").eq("deprecated", false);
  if (pErr) throw new Error(`plugins: ${pErr.message}`);
  const { data: articles, error: aErr } = await supabaseAdmin
    .from("external_articles")
    .select("slug,title,published_at,payload")
    .eq("source", "devto")
    .gte("published_at", windowStart)
    .lte("published_at", windowEnd);
  if (aErr) throw new Error(`external_articles: ${aErr.message}`);

  // One pull of the series, sliced per article in memory: the daily window
  // is small and the backfill would otherwise issue two queries per article.
  // PostgREST caps a response at 1,000 rows whatever `.limit()` asks; the
  // first version asked for 50,000, got the oldest 1,000, and silently wrote
  // lifts for June only. Page until a short page.
  const daily: Array<{ plugin_id: number; observed_on: string; npm_downloads_d1: number | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error: dErr } = await supabaseAdmin
      .from("plugin_daily_metrics")
      .select("plugin_id,observed_on,npm_downloads_d1")
      .gte("observed_on", isoDay(Date.parse(windowStart) - WINDOW_DAYS * DAY_MS))
      .lte("observed_on", isoDay(Date.parse(windowEnd) + WINDOW_DAYS * DAY_MS))
      .order("observed_on", { ascending: true })
      .order("plugin_id", { ascending: true })
      .range(from, from + 999);
    if (dErr) throw new Error(`plugin_daily_metrics: ${dErr.message}`);
    daily.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  let written = 0;
  for (const a of (articles ?? []) as LiftArticle[]) {
    const pubDate = a.published_at?.slice(0, 10);
    if (!pubDate) continue;
    const plugin = matchPlugin(a, (plugins ?? []) as LiftPlugin[]);
    const t = Date.parse(pubDate);
    const preStart = isoDay(t - WINDOW_DAYS * DAY_MS);
    const postEnd = isoDay(t + WINDOW_DAYS * DAY_MS);
    const span = daily.filter((r) => r.observed_on >= preStart && r.observed_on <= postEnd);
    const series = plugin ? span.filter((r) => r.plugin_id === plugin.id) : ecosystemSeries(span);
    const before = series.filter((r) => r.observed_on >= preStart && r.observed_on < pubDate).map((r) => r.npm_downloads_d1);
    const after = series.filter((r) => r.observed_on > pubDate && r.observed_on <= postEnd).map((r) => r.npm_downloads_d1);
    const pre = meanPositive(before);
    const post = meanPositive(after);
    const lift = before.length >= MIN_DAYS && after.length >= MIN_DAYS ? liftPct(pre, post) : null;
    if (lift == null) continue;
    const scope = plugin?.name ?? "ecosystem";
    const { error } = await supabaseAdmin.from("metric_snapshots").upsert(
      {
        source: "computed",
        kind: "article_download_lift_pct",
        dimension: a.slug,
        observed_on: opts.today,
        value: lift,
        payload: { scope, pre, post, days: [before.length, after.length], published_on: pubDate },
        ingest_run_id: opts.runId,
      } as Tables["metric_snapshots"]["Insert"],
      { onConflict: "source,kind,dimension,observed_on" },
    );
    if (error) console.error(`[article-lift] ${a.slug}: ${error.message}`);
    else {
      written += 1;
      console.log(`[article-lift] ${a.slug} → ${scope}: pre=${pre} post=${post} lift=${lift}%`);
    }
  }
  return written;
}

if (process.argv[1]?.endsWith("article-lift.ts")) {
  const i = process.argv.indexOf("--since-days");
  const sinceDays = i > 0 ? Number(process.argv[i + 1]) : 38;
  computeArticleLifts({ today: isoDay(Date.now()), runId: null, sinceDays })
    .then((n) => console.log(`[article-lift] ✓ ${n} rows`))
    .catch((e) => { console.error(e); process.exit(1); });
}
