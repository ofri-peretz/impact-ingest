/**
 * npx tsx scripts/plugin-catalog.check.ts   (CI runs it as `npm run check`)
 *
 * Locks the ecosystem/plugin split introduced 2026-09-07.
 *
 * Until then `total_packages` and `total_plugins` were the same expression,
 * `plugins.length`, which was only correct while every package we published
 * was an ESLint plugin. `burgee` — an agent-native CLI framework — broke that
 * premise: its downloads are genuinely ours and belong in the North Star, but
 * counting it as a plugin publishes a plugin that does not exist. That is the
 * same class of defect as the hand-seeded catalog that reported 25 names while
 * 30 plugins existed, pointing the other way.
 *
 * Contract under test, both directions — a filter that excludes everything
 * would satisfy half of this, so every exclusion has a positive control:
 *   1. burgee is IN the ecosystem (counted for downloads);
 *   2. burgee is NOT a plugin, while real plugins still are;
 *   3. burgee's category comes from the map, not the plugin heuristics —
 *      it would otherwise fall through to "quality";
 *   4. side projects on the same npm account stay out entirely;
 *   5. the two totals actually diverge, by exactly the non-plugin count.
 *
 * Pure functions only — no network, no database, no secrets.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isInterlacePackage,
  isPluginPackage,
  deriveCategory,
  NON_PLUGIN_PACKAGES,
} from "./plugin-catalog.js";

// 1. In the ecosystem — this is what puts its downloads in the totals.
assert.equal(isInterlacePackage("burgee"), true, "burgee must be counted");
// Positive control: the predicate still admits what it always did.
assert.equal(isInterlacePackage("eslint-plugin-anthropic"), true);
assert.equal(isInterlacePackage("@interlace/devkit"), true);

// 2. Not a plugin — but the predicate must not just answer false to everything.
assert.equal(isPluginPackage("burgee"), false, "burgee is not a plugin");
assert.equal(isPluginPackage("eslint-plugin-anthropic"), true);
assert.equal(isPluginPackage("@interlace/devkit"), true);

// 3. Category from the map. "quality" is the fallthrough it must NOT get.
assert.equal(deriveCategory("burgee"), "cli");
assert.notEqual(deriveCategory("burgee"), "quality");
// Positive control: the plugin heuristics are untouched.
assert.equal(deriveCategory("eslint-plugin-react-a11y"), "react");
assert.equal(deriveCategory("eslint-plugin-nestjs-security"), "framework");

// 4. Side projects share the npm account and must stay out on both counts.
for (const side of ["@forge-js/core", "some-random-package"]) {
  assert.equal(isInterlacePackage(side), false, `${side} leaked in`);
}

// 5. The totals diverge by exactly the non-plugin count — this is the number
//    that reaches the control room's "Plugins" tile and the blog.
const counted = [
  "eslint-plugin-anthropic",
  "eslint-plugin-react-a11y",
  "@interlace/devkit",
  "burgee",
];
const totalPackages = counted.length;
const totalPlugins = counted.filter(isPluginPackage).length;
assert.equal(totalPackages, 4);
assert.equal(totalPlugins, 3, "burgee must not inflate the plugin count");
assert.equal(
  totalPackages - totalPlugins,
  Object.keys(NON_PLUGIN_PACKAGES).length,
);

console.log("✓ plugin-catalog: ecosystem/plugin split holds");

// 6. Every category deriveCategory can emit must satisfy plugins_category_check
//
// Case 4 above already pins deriveCategory("burgee") === "cli". It passed, and
// the nightly ingest still died: the assertion proved the code did what its
// author meant, and never asked whether the database would accept it.
// impact-ingest#11 shipped 'cli' into a CHECK that knew five categories, so the
// catalog insert was rejected and the whole run wrote zero rows.
//
// This is the same defect as ingest_runs.status = 'degraded' one day earlier.
// A new enum value in application code is a schema change; this case is what
// makes the schema say so before the cron does.
{
  // Mirrors plugins_category_check (migration 20260908000000_plugins_category_cli).
  // Changing one without the other is the bug this case exists to catch.
  const ALLOWED = new Set([
    "security",
    "quality",
    "framework",
    "react",
    "architecture",
    "cli",
  ]);

  // a. Every hand-mapped non-plugin category.
  for (const [pkg, category] of Object.entries(NON_PLUGIN_PACKAGES))
    assert.ok(
      ALLOWED.has(category),
      `NON_PLUGIN_PACKAGES["${pkg}"] = "${category}", which plugins_category_check rejects`,
    );

  // b. Every literal deriveCategory can return, read from the source so a new
  //    branch cannot be added without either passing here or failing loudly.
  const here = dirname(fileURLToPath(import.meta.url));
  const catalog = readFileSync(join(here, "plugin-catalog.ts"), "utf-8");
  const anchor = "export function deriveCategory(";
  assert.equal(
    catalog.split(anchor).length - 1,
    1,
    "the anchor must identify exactly one deriveCategory",
  );
  const fn = catalog.slice(catalog.indexOf(anchor));
  const returns = [
    ...fn.slice(0, fn.indexOf("\n}")).matchAll(/return "([a-z_]+)"/g),
  ].map((m) => m[1]!);

  // Positive control: the literals are really being read. Without it, an
  // anchor that silently matched an empty body would pass this case entirely.
  assert.ok(
    returns.length >= 4,
    `expected deriveCategory's return literals, found ${returns.length}`,
  );

  for (const category of returns)
    assert.ok(
      ALLOWED.has(category),
      `deriveCategory can return "${category}", which plugins_category_check rejects`,
    );

  console.log("✓ plugin-catalog: every category satisfies plugins_category_check");
}
