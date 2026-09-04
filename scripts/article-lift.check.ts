/**
 * npx tsx scripts/article-lift.check.ts   (CI runs it as `npm run check`)
 *
 * Locks the matcher and the arithmetic behind article_download_lift_pct.
 * The bug this guards: a matcher that needs a tag equal to a plugin slug
 * wrote zero rows for three months. Pure functions, no network.
 */
import assert from "node:assert/strict";
import { ecosystemSeries, liftPct, matchPlugin, meanPositive } from "./article-lift.js";

const plugins = [
  { id: 1, name: "eslint-plugin-pg", slug: "pg" },
  { id: 2, name: "eslint-plugin-secure-coding", slug: "secure-coding" },
  { id: 3, name: "eslint-plugin-browser-security", slug: "browser-security" },
];
const art = (title: string, tags: string[] = ["eslint", "security"], description = "") => ({ slug: "s", title, published_at: "2026-08-01", payload: { description, tags } });

// Positive control: the full package name in the title.
assert.equal(matchPlugin(art("Why eslint-plugin-secure-coding flags this"), plugins)?.name, "eslint-plugin-secure-coding");
// Bare name as a whole word in the description.
assert.equal(matchPlugin(art("Five doors", ["webdev"], "the pg client and its query"), plugins)?.name, "eslint-plugin-pg");
// "pgx" is not "pg"; generic tags match nothing → ecosystem.
assert.equal(matchPlugin(art("pgx internals", ["eslint", "security", "webdev", "javascript"]), plugins), null);
// A tag equal to a slug still matches (the old contract survives).
assert.equal(matchPlugin(art("Untitled", ["browser-security"]), plugins)?.name, "eslint-plugin-browser-security");
// Longest name wins when two match.
assert.equal(matchPlugin(art("secure-coding vs pg"), [...plugins])?.name, "eslint-plugin-secure-coding");

assert.equal(meanPositive([10, 0, 20, null]), 15);
assert.equal(meanPositive([0, null]), null);
assert.equal(liftPct(100, 120), 20);
assert.equal(liftPct(100, 80), -20);
assert.equal(liftPct(null, 80), null);
assert.equal(liftPct(0, 80), null);

// Full days sum; a day where only one of five plugins reported is a partial
// sum and is dropped, not read as a crash.
const five = (day: string, v: number) => Array.from({ length: 5 }, (_, i) => ({ observed_on: day, npm_downloads_d1: v + i }));
const eco = ecosystemSeries([...five("2026-08-01", 10), ...five("2026-08-02", 20), { observed_on: "2026-08-03", npm_downloads_d1: 999 }]);
assert.deepEqual(eco, [{ observed_on: "2026-08-01", npm_downloads_d1: 60 }, { observed_on: "2026-08-02", npm_downloads_d1: 110 }]);
// Four of five reported is still a day.
assert.equal(ecosystemSeries([...five("2026-08-01", 1), ...five("2026-08-02", 1).slice(0, 4)]).length, 2);

console.log("article-lift.check ✓");
