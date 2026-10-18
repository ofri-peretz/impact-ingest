// Weekly adopter scan: which public GitHub repos actually use our packages.
//
//   npm run adopters               # scan + write
//   npm run adopters -- --dry-run  # scan, print counts, write nothing
//
// Moved here from the agents repo's fetch-adopters.ts, whose launchd job
// (com.ofri.adopters) exited 127 every week because its wrapper binary was
// gone; plugin_adopters had been written exactly once, on 2026-05-31.
//
// For every tracked, non-deprecated package: GitHub code search over
// package.json / eslint.config / .eslintrc, then each matched file is read
// back and VERIFIED (a real dependency key, or the package named as a whole
// word), then repo facts come from /repos. Every verified repo is upserted
// with its fork/archived/owner flags; the COUNTS exclude forks, archived
// repos and ofri-peretz's own.
//
// Writes:
//   plugin_adopters      one row per (package, repo); first_seen is kept from
//                        the first scan that saw it, last_seen moves.
//   plugin_dependents    per package: unique external active repos. Until
//                        2026-10-19 this held code search's total_count,
//                        which counts FILES (secure-coding: 140 files, ~24
//                        repos), so the series steps down here on purpose.
//   metric_snapshots     github-adopters / unique_external_repos, dimension
//                        '' = unique repos across all packages.
//
// Logs carry counts only (the repo is public; repo names stay in the table).
// Any search that fails after a retry fails the run: a count missing a query
// is an undercount, and that package's numbers are not written.

import { supabaseAdmin } from "./_supabase-admin.js";
import {
  SELF_OWNERS,
  declaresDependency,
  isExternalActive,
  mentionsPackage,
  strongerVia,
  type DetectedVia,
  type RepoFacts,
} from "./adopter-match.js";
import { trackedPackages } from "./plugin-catalog.js";

const dryRun = process.argv.includes("--dry-run");
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error("GITHUB_TOKEN is not set (code search needs auth)");

const TARGETS: ReadonlyArray<{ filename: string; via: DetectedVia }> = [
  { filename: "package.json", via: "package.json" },
  { filename: "eslint.config", via: "eslint.config" },
  { filename: ".eslintrc", via: "eslintrc" },
];

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function gh(url: string): Promise<Response> {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${TOKEN}`,
  };
  let r = await fetch(url, { headers });
  if (r.status === 403 || r.status === 429) {
    // Secondary rate limit: wait what GitHub asks (capped), retry once.
    const reset = Number(r.headers.get("x-ratelimit-reset")) * 1000 - Date.now();
    const after = Number(r.headers.get("retry-after")) * 1000;
    await sleep(Math.min(90_000, Math.max(after || 0, reset || 0, 60_000)));
    r = await fetch(url, { headers });
  }
  return r;
}

interface CodeItem {
  path: string;
  repository: { full_name: string };
}

/** Every matched (repo, path) for a query; null when GitHub would not answer. */
async function searchCode(q: string): Promise<CodeItem[] | null> {
  const items: CodeItem[] = [];
  // Code search returns at most 1,000 results (10 pages of 100).
  for (let page = 1; page <= 10; page += 1) {
    await sleep(7_000); // code search: 10 requests/minute
    const r = await gh(
      `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=100&page=${page}`,
    );
    if (!r.ok) {
      console.error(`[adopters] search → ${r.status}`);
      return null;
    }
    const body = (await r.json()) as { items?: CodeItem[] };
    items.push(...(body.items ?? []));
    if ((body.items ?? []).length < 100) break;
  }
  return items;
}

/** The matched file at HEAD. raw.githubusercontent.com costs no API quota. */
async function readFile(fullName: string, path: string): Promise<string | null> {
  const r = await fetch(
    `https://raw.githubusercontent.com/${fullName}/HEAD/${path.split("/").map(encodeURIComponent).join("/")}`,
  );
  return r.ok ? r.text() : null;
}

interface RepoMeta extends RepoFacts {
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  pushed_at: string | null;
}

const repoCache = new Map<string, RepoMeta | null>();
async function repoMeta(fullName: string): Promise<RepoMeta | null> {
  if (!repoCache.has(fullName)) {
    const r = await gh(`https://api.github.com/repos/${fullName}`);
    repoCache.set(fullName, r.ok ? ((await r.json()) as RepoMeta) : null);
  }
  return repoCache.get(fullName)!;
}

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: rows, error } = await supabaseAdmin
    .from("plugins")
    .select("id,name,slug,deprecated");
  if (error || !rows) throw new Error(`plugins: ${error?.message}`);
  const packages = trackedPackages(rows).filter((p) => !p.deprecated);

  const { data: known, error: knownErr } = await supabaseAdmin
    .from("plugin_adopters")
    .select("plugin_name,repo_full_name,first_seen");
  if (knownErr) throw new Error(`plugin_adopters: ${knownErr.message}`);
  const firstSeen = new Map(
    (known ?? []).map((k) => [`${k.plugin_name}|${k.repo_full_name}`, k.first_seen]),
  );

  const failed: string[] = [];
  const external = new Set<string>();
  console.log(`[adopters] scanning ${packages.length} packages`);

  for (const p of packages) {
    const found = new Map<string, DetectedVia>();
    let complete = true;
    for (const t of TARGETS) {
      const items = await searchCode(`"${p.name}" filename:${t.filename}`);
      if (items === null) {
        complete = false;
        continue;
      }
      for (const it of items) {
        const repo = it.repository.full_name;
        // Our own monorepos hold hundreds of matching files; never adopters.
        if (SELF_OWNERS.has(repo.split("/")[0]!.toLowerCase())) continue;
        if (found.get(repo) === t.via) continue; // already verified this way
        const text = await readFile(repo, it.path);
        if (text === null) continue;
        const real =
          t.via === "package.json"
            ? declaresDependency(text, p.name)
            : mentionsPackage(text, p.name);
        if (!real) continue;
        const prev = found.get(repo);
        found.set(repo, prev ? strongerVia(prev, t.via) : t.via);
      }
    }

    const upserts = [];
    let count = 0;
    for (const [repo, via] of found) {
      const m = await repoMeta(repo);
      if (!m) continue;
      upserts.push({
        plugin_name: p.name,
        repo_full_name: m.full_name,
        repo_url: m.html_url,
        stars: m.stargazers_count,
        forks: m.forks_count,
        is_fork: m.fork,
        is_archived: m.archived,
        last_pushed_at: m.pushed_at,
        detected_via: via,
        owner_type: m.owner.type,
        owner_login: m.owner.login,
        first_seen: firstSeen.get(`${p.name}|${m.full_name}`) ?? today,
        last_seen: today,
      });
      if (isExternalActive(m)) {
        count += 1;
        external.add(m.full_name);
      }
    }
    console.log(
      `[adopters] ${p.name}: ${found.size} verified, ${count} external active${complete ? "" : " (INCOMPLETE)"}`,
    );
    if (!complete) failed.push(p.name);
    if (dryRun) continue;

    if (upserts.length > 0) {
      const { error: upErr } = await supabaseAdmin
        .from("plugin_adopters")
        .upsert(upserts, { onConflict: "plugin_name,repo_full_name" });
      if (upErr) throw new Error(`plugin_adopters ${p.name}: ${upErr.message}`);
    }
    if (complete) {
      const { error: depErr } = await supabaseAdmin
        .from("plugin_dependents")
        .upsert(
          { plugin_id: p.id, observed_on: today, dependent_count: count },
          { onConflict: "plugin_id,observed_on" },
        );
      if (depErr) throw new Error(`plugin_dependents ${p.name}: ${depErr.message}`);
    }
  }

  console.log(`[adopters] unique external active repos: ${external.size}`);
  if (failed.length > 0) {
    throw new Error(
      `code search failed for ${failed.length} package(s): ${failed.join(", ")}; their counts and the ecosystem total were not written`,
    );
  }
  if (dryRun) return;
  const { error: snapErr } = await supabaseAdmin.from("metric_snapshots").upsert(
    {
      source: "github-adopters",
      kind: "unique_external_repos",
      dimension: "",
      observed_on: today,
      value: external.size,
    },
    { onConflict: "source,kind,dimension,observed_on" },
  );
  if (snapErr) throw new Error(`metric_snapshots: ${snapErr.message}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
