/**
 * Which npm packages count as "our ecosystem" for metrics.
 *
 * Deny-list, not allow-list — deliberately. The `plugins` table was seeded by
 * hand in two migrations (2026-05-16) and never updated, so by 2026-08-09 it
 * tracked 25 names while 30 plugins existed: **14 live plugins were invisible**
 * to the blog's download totals, and 9 rows pointed at retired packages. An
 * allow-list fails silently in the direction that hurts — forget to add a
 * plugin and it simply never appears, with nothing erroring. A deny-list fails
 * the safe way: forget to add an entry and a dead package shows up, which is
 * visible and harmless.
 *
 * The same failure shipped in the Dockerfile (it installed the retired
 * `eslint-plugin-jwt`/`-pg` for months after the rename, because the list was
 * hardcoded) — see eslint#442.
 */

/**
 * Packages excluded from ecosystem metrics.
 *
 * The bar is "did this ever represent shipped, intended product". Everything
 * here is an abandoned experiment or a superseded generic that we do not want
 * counted in plugin totals, rule counts, or download figures.
 *
 * NOT here, on purpose: `eslint-plugin-jwt` and `eslint-plugin-pg`. Those are
 * renames, not mistakes — they were real products, they still pull ~3.0k and
 * ~2.1k downloads/month respectively (measured 2026-08-09), and that adoption
 * is genuinely ours. Dropping them would erase ~5.2k monthly downloads from
 * the totals to make a catalog look tidy.
 */
export const IGNORED_PACKAGES: readonly string[] = [
  // Superseded generics. The ecosystem moved to vendor-specific plugins
  // (anthropic/openai/gemini/vercel-ai/mcp-sdk-security), which is the
  // taxonomy decision recorded in eslint-plugin-taxonomy-boundaries.
  "eslint-plugin-llm", // 39 d30
  "eslint-plugin-llm-optimized", // 24 d30
  "eslint-plugin-mcp", // 52 d30
  "eslint-plugin-mcp-optimized", // 44 d30

  // Never became a product line.
  "eslint-plugin-code-mode", // 6 d30
  "eslint-plugin-generalist", // 15 d30
  "eslint-plugin-crypto", // 168 d30 — highest of the dead set, still an experiment

  // Workspace-internal, never published as a product.
  "@interlace/eslint-config",
];

const IGNORED = new Set(IGNORED_PACKAGES);

/** Is this package part of the ecosystem we report on? */
export function isTrackedPackage(name: string): boolean {
  return !IGNORED.has(name);
}

/**
 * Filter a list of package names down to the tracked ecosystem.
 *
 * This is the read side. It cannot, on its own, make a newly published plugin
 * appear: filtering the `plugins` table still only ever sees rows somebody
 * inserted. That is why the 13 packages published since June were still
 * missing on 2026-08-09 with the deny-list in place. The write side is
 * fetchCatalog() below — the two together are what makes a new plugin show up
 * on its own.
 */
export function trackedPackages<T extends { name: string }>(rows: T[]): T[] {
  return rows.filter((r) => isTrackedPackage(r.name));
}

// ─── Discovery: who is in the catalog at all ─────────────────────────────
//
// The counted set is derived from npm rather than typed by hand:
//
//   counted = every non-deprecated package we publish
//             ∪ DEPRECATED_INCLUDE
//             ∖ IGNORED_PACKAGES
//
// npm's search endpoint omits deprecated packages, so "all non-deprecated" is
// what a single call returns — no per-package deprecation probe needed.

const NPM_MAINTAINER = "ofriperetz";

const NPM_USER_AGENT =
  "ofri-peretz/agents-ingest (https://github.com/ofri-peretz/agents)";

/**
 * Deprecated packages we still count — the mirror image of IGNORED_PACKAGES.
 * A deprecated package is invisible to discovery, so counting one takes an
 * explicit entry here.
 *
 * `eslint-plugin-jwt` and `eslint-plugin-pg` for the reason given above: they
 * are renames, not mistakes, and still pull ~3.0k and ~2.1k downloads a month.
 * Without this list the rename itself would delete that adoption from the
 * totals the day npm stopped listing the old name.
 */
export const DEPRECATED_INCLUDE = ["eslint-plugin-jwt", "eslint-plugin-pg"];

/**
 * Ofri's 2026-06-22 decision (migration 20260622010000): the North Star counts
 * the Interlace ESLint ecosystem, not every side project. `@forge-js/*` ships
 * from the same npm account and comes back from the same search, so ownership
 * has to be an explicit predicate rather than "whatever the search returned".
 */
export function isInterlacePackage(name: string): boolean {
  return name.startsWith("@interlace/") || name.startsWith("eslint-plugin-");
}

/**
 * Mirrors getCategory() in eslint/apps/docs/scripts/sync-plugin-stats.ts.
 * Order matters: react-a11y is react, not security, and `*-security` on a
 * framework name is framework — that is how the seeded rows were bucketed.
 */
export function deriveCategory(name: string): string {
  if (name.includes("react")) return "react";
  if (/express|nestjs|lambda|serverless/.test(name)) return "framework";
  if (/import-next|devkit|architecture/.test(name)) return "architecture";
  if (/security|jwt|crypto|secure-coding|-pg$/.test(name)) return "security";
  return "quality";
}

export function deriveSlug(name: string): string {
  return name.startsWith("@")
    ? name.slice(name.indexOf("/") + 1)
    : name.replace(/^eslint-plugin-/, "");
}

export interface CatalogEntry {
  name: string;
  slug: string;
  category: string;
  description: string | null;
  deprecated: boolean;
}

interface NpmSearchResponse {
  objects: Array<{ package: { name: string; description?: string } }>;
}

/**
 * Every tracked package npm currently lists, plus the include list.
 *
 * Returns null when the search itself failed — callers must read that as "no
 * information", never as "we publish nothing". An empty result is treated the
 * same way: a search that finds none of our packages is a bad response, not an
 * empty ecosystem, and acting on it would look like every plugin was retired
 * at once.
 */
export async function fetchCatalog(): Promise<CatalogEntry[] | null> {
  const r = await fetch(
    `https://registry.npmjs.org/-/v1/search?text=maintainer:${NPM_MAINTAINER}&size=250`,
    { headers: { "User-Agent": NPM_USER_AGENT, Accept: "application/json" } },
  );
  if (!r.ok) {
    console.error(`[catalog] warn: npm search → ${r.status}`);
    return null;
  }
  const { objects } = (await r.json()) as NpmSearchResponse;

  const catalog: CatalogEntry[] = objects
    .map((o) => o.package)
    .filter((p) => isInterlacePackage(p.name) && isTrackedPackage(p.name))
    .map((p) => ({
      name: p.name,
      slug: deriveSlug(p.name),
      category: deriveCategory(p.name),
      // npm descriptions lead with the subject, then an em-dash clause listing
      // what the plugin catches — too long for a package card.
      description: p.description?.split(" — ")[0] ?? null,
      deprecated: false,
    }));

  if (catalog.length === 0) {
    console.error("[catalog] warn: search returned 0 tracked packages");
    return null;
  }

  // Deprecated-but-counted packages never come back from search, so they are
  // asserted from the include list rather than discovered.
  const found = new Set(catalog.map((e) => e.name));
  for (const name of DEPRECATED_INCLUDE) {
    if (found.has(name) || !isTrackedPackage(name)) continue;
    catalog.push({
      name,
      slug: deriveSlug(name),
      category: deriveCategory(name),
      description: null,
      deprecated: true,
    });
  }

  return catalog;
}

// Self-check: `npm run footprint:catalog:dry`. Hits npm only — no Supabase, no
// writes — and fails loudly if discovery stops returning a sane catalog.
if (process.argv[1]?.endsWith("plugin-catalog.ts")) {
  const catalog = await fetchCatalog();
  if (!catalog) throw new Error("discovery returned nothing");

  for (const e of catalog) {
    console.log(
      `${e.deprecated ? "◌" : "✓"} ${e.name.padEnd(38)} ${e.category.padEnd(12)} ${e.slug}`,
    );
  }

  const names = new Set(catalog.map((e) => e.name));
  // The two renames are the whole reason the include list exists; if they drop
  // out, ~5.2k monthly downloads leave the totals with nothing erroring.
  for (const name of DEPRECATED_INCLUDE) {
    if (!names.has(name)) throw new Error(`include list dropped ${name}`);
  }
  // Side projects share the npm account — isInterlacePackage is the only thing
  // keeping them out of the Interlace ecosystem total.
  if ([...names].some((n) => n.startsWith("@forge-js/"))) {
    throw new Error("non-Interlace package leaked into the catalog");
  }
  for (const name of IGNORED_PACKAGES) {
    if (names.has(name)) throw new Error(`ignore list breached by ${name}`);
  }
  if (catalog.length < 20) {
    throw new Error(`only ${catalog.length} packages — search likely degraded`);
  }

  console.log(
    `\n${catalog.length} counted (${catalog.filter((e) => !e.deprecated).length} current + ${
      catalog.filter((e) => e.deprecated).length
    } deprecated-but-included)`,
  );
}
