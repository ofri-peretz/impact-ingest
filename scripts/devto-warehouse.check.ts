/** Runnable check for devto-warehouse.ts pure parts — `npm run check` (env stubs set there; ESM imports hoist, so they cannot be set here). */
import assert from "node:assert/strict";
import { parseJoined, isOnboarding, ourReplyIn } from "./devto-warehouse.js";

assert.equal(parseJoined("Sep  3, 2026"), "2026-09-03", "dev.to's double-spaced display date parses");
assert.equal(parseJoined("Dec 31, 2025"), "2025-12-31");
assert.equal(parseJoined(undefined), null);
assert.equal(isOnboarding("2026-09-03T21:37:00Z", "2026-09-03"), true, "same day = onboarding");
assert.equal(isOnboarding("2026-09-04T01:00:00Z", "2026-09-03"), true, "one day of timezone slack");
assert.equal(isOnboarding("2026-09-20T01:00:00Z", "2026-09-03"), false, "a reader who followed later");
assert.equal(isOnboarding("2026-09-03T00:00:00Z", null), null, "unknown account age is unknown, not false");
const me = "ofri-peretz";
const tree: any[] = [{ id_code: "a", created_at: "2026-09-01T11:00:00Z", user: { username: "x" }, children: [{ id_code: "b", created_at: "2026-09-02T09:00:00Z", user: { username: me } }] }, { id_code: "c", created_at: "2026-09-01T12:00:00Z", user: { username: me } }];
assert.deepEqual(ourReplyIn(tree), { id: "c", at: "2026-09-01T12:00:00Z" }, "earliest of our replies anywhere below");
assert.equal(ourReplyIn([]), null);
console.log("devto-warehouse.check: ok");
