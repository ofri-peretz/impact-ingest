// One-shot: measure TRUE all-time npm downloads per plugin (npm /downloads/range
// in ≤365-day windows, since npm caps a single range call at ~18 months), upsert
// into npm_alltime_downloads (one row per plugin), then refresh the ratchet so
// eng_downloads_cumulative reflects the all-time total. Idempotent (upsert by
// plugin_id); safe to re-run. Requires migration 20260621000000 applied first.
//
//   node --env-file=.env --import tsx scripts/backfill-npm-alltime.ts
import { supabaseAdmin } from "./_supabase-admin.js";

const UA =
  "ofri-peretz/agents-backfill (https://github.com/ofri-peretz/agents)";
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
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

async function alltime(pkg: string): Promise<AlltimeResult> {
  const enc = encodeURIComponent(pkg);
  const end = new Date(iso(new Date()));
  let cursor = new Date("2025-01-01"); // all packages first published Nov/Dec 2025; npm range cap is 18mo
  let total = 0;
  let firstDownloadOn: string | null = null;
  while (cursor <= end) {
    const we = new Date(cursor);
    we.setFullYear(we.getFullYear() + 1);
    we.setDate(we.getDate() - 1);
    const sliceEnd = we > end ? end : we;
    const s = iso(cursor);
    const e = iso(sliceEnd);
    let ok = false;
    for (let a = 0; a < 8 && !ok; a += 1) {
      try {
        const r = await fetch(
          `https://api.npmjs.org/downloads/range/${s}:${e}/${enc}`,
          {
            headers: { "User-Agent": UA, Accept: "application/json" },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (r.ok) {
          const b = (await r.json()) as {
            downloads?: Array<{ downloads: number; day: string }>;
          };
          const days = b.downloads ?? [];
          total += days.reduce((x, d) => x + d.downloads, 0);
          // Windows are walked oldest-first and each is scanned in order, so
          // the first non-zero day seen is the earliest one overall. Recorded
          // once and never overwritten.
          if (firstDownloadOn === null) {
            firstDownloadOn = days.find((d) => d.downloads > 0)?.day ?? null;
          }
          ok = true;
        } else if (r.status === 404) {
          ok = true; // package didn't exist in this window
        } else {
          await sleep(1000 * 2 ** a); // backoff on 429/5xx
        }
      } catch {
        await sleep(1000 * 2 ** a); // network error (ETIMEDOUT / abort) → retry, don't crash
      }
    }
    if (!ok)
      console.error(
        `[alltime] ${pkg} window ${s}:${e} failed after retries — skipped`,
      );
    cursor = new Date(sliceEnd.getTime() + 86_400_000);
    await sleep(300);
  }
  return { total, firstDownloadOn };
}

async function main(): Promise<void> {
  const { data: plugins, error } = await supabaseAdmin
    .from("plugins")
    .select("id,name");
  if (error || !plugins) throw new Error(`plugins: ${error?.message}`);

  let eco = 0;
  let ecoSince: string | null = null;
  for (let i = 0; i < plugins.length; i += 1) {
    if (i > 0) await sleep(300);
    const p = plugins[i]!;
    const { total: t, firstDownloadOn } = await alltime(p.name);
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
  console.log(
    `[alltime] ecosystem total = ${eco.toLocaleString()} since ${ecoSince ?? "unknown"}`,
  );

  const { error: rpc } = await supabaseAdmin.rpc("refresh_storefront_ratchet");
  if (rpc) throw new Error(`refresh: ${rpc.message}`);
  console.log("[ratchet] refreshed");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
