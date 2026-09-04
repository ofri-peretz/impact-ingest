/** npx tsx scripts/devto-attention.check.ts — feature parser, program names, staff flattening, event rules. Pure. */
import assert from "node:assert/strict";
import { parseFeatures, programOf, referrerEvents, staffIn, starEvents } from "./devto-attention.js";

assert.equal(programOf("Top 7 Featured DEV Posts of the Week"), "top7");
assert.equal(programOf("💎 Community Gems: this week's picks"), "gems");
assert.equal(programOf("Meme Monday"), null);

// A saved Top 7 shape: liquid embeds, a markdown link, and a settings link that is not a post.
const body = `{% embed https://dev.to/scastiel/seven-hours-zero-internet-4ab0 %}
Read [this one](https://dev.to/nfrankel/thoughts-on-object-creation-1cgi) and
{% embed https://dev.to/scastiel/seven-hours-zero-internet-4ab0 %}
manage it at https://dev.to/settings/notifications or https://dev.to/t/webdev`;
assert.deepEqual(parseFeatures(body), [
  { username: "scastiel", slug: "seven-hours-zero-internet-4ab0" },
  { username: "nfrankel", slug: "thoughts-on-object-creation-1cgi" },
]);
assert.deepEqual(parseFeatures("no links here"), []);

const tree: any[] = [
  { id_code: "a", created_at: "2026-09-01T11:00:00Z", user: { username: "x" }, children: [{ id_code: "b", created_at: "2026-09-02T09:00:00Z", user: { username: "jess" } }] },
  { id_code: "c", created_at: "2026-09-01T12:00:00Z", user: { username: "ben" } },
];
assert.deepEqual(staffIn(tree, new Set(["ben", "jess"])), [{ id: "b", staff: "jess", at: "2026-09-02T09:00:00Z" }, { id: "c", staff: "ben", at: "2026-09-01T12:00:00Z" }]);

// Cumulative rows: flat, flat, then a jump of 12 on a domain that counts; google does not.
const refs = [
  ...[0, 1, 2, 3, 4].map((i) => ({ observed_on: `2026-09-0${i + 1}`, domain: "t.co", views: 50 + i })),
  { observed_on: "2026-09-06", domain: "t.co", views: 66 },
  { observed_on: "2026-09-05", domain: "google.com", views: 100 },
  { observed_on: "2026-09-06", domain: "google.com", views: 900 },
];
const ev = referrerEvents(refs);
assert.deepEqual(ev.map((e) => [e.observed_on, e.source, e.value]), [["2026-09-06", "t.co", 12]]);
assert.equal(ev[0].baseline, 1);
// A delta of 2 is never an event, however flat the baseline.
assert.equal(referrerEvents([{ observed_on: "2026-09-01", domain: "t.co", views: 0 }, { observed_on: "2026-09-02", domain: "t.co", views: 2 }]).length, 0);

const stars = [1, 2, 3, 4].map((i) => ({ repo: "r", starred_at: `2026-09-03T0${i}:00:00Z` }));
assert.deepEqual(starEvents(stars).map((e) => [e.observed_on, e.source, e.value]), [["2026-09-03", "r", 4]]);
assert.equal(starEvents(stars.slice(0, 3)).length, 0, "three stars is not a burst");
console.log("devto-attention.check: ok");
