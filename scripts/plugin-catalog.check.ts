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
