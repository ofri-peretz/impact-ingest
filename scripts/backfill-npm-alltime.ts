// One-shot: measure TRUE all-time npm downloads per plugin (npm /downloads/range
// in ≤365-day windows, since npm caps a single range call at ~18 months), upsert
// into npm_alltime_downloads (one row per plugin), then refresh the ratchet so
// eng_downloads_cumulative reflects the all-time total. Idempotent (upsert by
// plugin_id); safe to re-run. Requires migration 20260621000000 applied first.
//
//   node --env-file=.env --import tsx scripts/backfill-npm-alltime.ts
import { supabaseAdmin } from "./_supabase-admin.js";
import { fetchNpmRanges } from "./npm-range.js";

const UA =
  "ofri-peretz/agents-backfill (https://github.com/ofri-peretz/agents)";
const iso = (d: Date): string => d.toISOString().slice(0, 10);

interface AlltimeResult {
  total: number;
  /**
   * First day this package recorded a non-zero download, or null if it never
   * has. This is what lets a surface say "all-time" and be able to back it:
   * the window travels with the number instead of each site hardcoding a date
   * and drifting from the others.
   */
  firstDownloadOn: string | null;
}

/**
 * All-time totals for every name, one bulk range call per 365-day window
 * (npm's bulk cap) instead of one call per package per window — the per-
 * package walk took long enough under npm 429s that the job hit its timeout
 * and was cancelled (2026-10-14..18).
 *
 * A package with ANY window unread is returned in `failed` and has no total:
 * a sum missing a window is an undercount, and upserting it would lower a
 * published all-time number.
 */
async function alltimeAll(
  names: readonly string[],
): Promise<{ results: Map<string, AlltimeResult>; failed: Set<string> }> {
  const end = new Date(iso(new Date()));
  const results = new Map<string, AlltimeResult>(
    names.map((n) => [n, { total: 0, firstDownloadOn: null }]),
  );
  const failed = new Set<string>();
  // All packages first published Nov/Dec 2025.
  let cursor = new Date("2025-01-01");
  while (cursor <= end) {
    const we = new Date(cursor);
    we.setFullYear(we.getFullYear() + 1);
    we.setDate(we.getDate() - 1);
    const sliceEnd = we > end ? end : we;
    const window = await fetchNpmRanges(names, iso(cursor), iso(sliceEnd), UA);
    for (const n of window.failed) failed.add(n);
    // Windows are walked oldest-first and each is scanned in order, so the
    // first non-zero day seen is the earliest one overall.
    for (const [n, days] of window.byName) {
      const r = results.get(n)!;
      r.total += days.reduce((x, d) => x + d.downloads, 0);
      r.firstDownloadOn ??= days.find((d) => d.downloads > 0)?.day ?? null;
    }
    cursor = new Date(sliceEnd.getTime() + 86_400_000);
  }
  for (const n of failed) results.delete(n);
  return { results, failed };
}

async function main(): Promise<void> {
  const { data: plugins, error } = await supabaseAdmin
    .from("plugins")
    .select("id,name");
  if (error || !plugins) throw new Error(`plugins: ${error?.message}`);

  const { results, failed } = await alltimeAll(plugins.map((p) => p.name));

  let eco = 0;
  let ecoSince: string | null = null;
  for (const p of plugins) {
    const r = results.get(p.name);
    if (!r) continue; // unread window: keep yesterday's total, fail below
    const { total: t, firstDownloadOn } = r;
    eco += t;
    if (firstDownloadOn && (!ecoSince || firstDownloadOn < ecoSince))
      ecoSince = firstDownloadOn;
    console.log(
      `[alltime] ${p.name} = ${t.toLocaleString()} (since ${firstDownloadOn ?? "never"})`,
    );
    const { error: upErr } = await supabaseAdmin
      .from("npm_alltime_downloads")
      .upsert(
        {
          plugin_id: p.id,
          measured_on: iso(new Date()),
          alltime_total: t,
          first_download_on: firstDownloadOn,
        },
        { onConflict: "plugin_id" },
      );
    if (upErr) throw new Error(`upsert ${p.name}: ${upErr.message}`);
  }
  // The ecosystem sum below would be short by every unread package. Fail the
  // step (the workflow's failure notice fires) instead of publishing it.
  if (failed.size > 0) {
    throw new Error(
      `npm did not answer for ${failed.size} of ${plugins.length} packages (${[...failed].join(", ")}); their totals and the ecosystem total were left as they were`,
    );
  }
  console.log(
    `[alltime] ecosystem total = ${eco.toLocaleString()} since ${ecoSince ?? "unknown"}`,
  );

  // The ecosystem row's cumulative column FOLLOWS this number instead of
  // keeping its own running sum.
  //
  // It used to be `previous row + today's delta`, seeded from zero on our
  // first observation — so it silently omitted every download that happened
  // before we started watching, plus every day we missed. On 2026-09-04 it
  // read 458,508 against this table's 480,515: 22,007 adrift, 4.6% low, and
  // plausible enough that nothing flagged it. Every consumer that wanted the
  // real figure had to know to override it, which engage does in a comment
  // longer than this one.
  //
  // Two numbers answering one question is the bug. This script already
  // computes `eco` and already logs it, so it is the writer — and being the
  // only writer is the point. Merge-duplicates touches just this column, so
  // the ingest's own fields on today's row are left alone.
  const { error: ecoErr } = await supabaseAdmin
    .from("ecosystem_daily_metrics")
    .upsert(
      { observed_on: iso(new Date()), total_npm_downloads: eco },
      { onConflict: "observed_on" },
    );
  if (ecoErr) throw new Error(`ecosystem total: ${ecoErr.message}`);
  console.log(`[alltime] ecosystem_daily_metrics.total_npm_downloads = ${eco}`);

  const { error: rpc } = await supabaseAdmin.rpc("refresh_storefront_ratchet");
  if (rpc) throw new Error(`refresh: ${rpc.message}`);
  console.log("[ratchet] refreshed");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
