/**
 * npx tsx scripts/adopters.check.ts   (CI runs it as part of `npm run check`)
 *
 * Locks the adopter scan's verdicts. Code search matches text, so each case
 * pairs a real adopter (positive control) with the look-alike that must not
 * count. Pure functions only — no network, no database, no secrets.
 */
import assert from "node:assert/strict";

import {
  declaresDependency,
  isExternalActive,
  mentionsPackage,
  strongerVia,
} from "./adopter-match.js";

// package.json: a dependency KEY, not a substring.
{
  const dep = JSON.stringify({ devDependencies: { "eslint-plugin-jwt": "^1" } });
  assert.ok(declaresDependency(dep, "eslint-plugin-jwt"));
  const sibling = JSON.stringify({ devDependencies: { "eslint-plugin-jwt-security": "^1" } });
  assert.ok(!declaresDependency(sibling, "eslint-plugin-jwt"), "a sibling package is not ours");
  const ownName = JSON.stringify({ name: "eslint-plugin-node-security-rules" });
  assert.ok(!declaresDependency(ownName, "eslint-plugin-node-security"), "own name is not a dependency");
  assert.ok(!declaresDependency("{not json", "eslint-plugin-jwt"));
  console.log("✓ package.json: dependency key only");
}

// Config files: the package named as a whole word.
{
  assert.ok(mentionsPackage(`import jwt from "eslint-plugin-jwt";`, "eslint-plugin-jwt"));
  assert.ok(mentionsPackage(`require('eslint-plugin-jwt/recommended')`, "eslint-plugin-jwt"));
  assert.ok(!mentionsPackage(`import x from "eslint-plugin-jwt-security";`, "eslint-plugin-jwt"));
  assert.ok(!mentionsPackage(`import x from "@acme/eslint-plugin-jwt";`, "eslint-plugin-jwt"));
  assert.ok(mentionsPackage(`from "@interlace/eslint-devkit"`, "@interlace/eslint-devkit"));
  console.log("✓ config: whole package names only");
}

// Counted adopters: not a fork, not archived, not ours.
{
  const base = { full_name: "acme/app", fork: false, archived: false, owner: { login: "acme", type: "Organization" } };
  assert.ok(isExternalActive(base));
  assert.ok(!isExternalActive({ ...base, fork: true }));
  assert.ok(!isExternalActive({ ...base, archived: true }));
  assert.ok(!isExternalActive({ ...base, owner: { login: "Ofri-Peretz", type: "User" } }));
  assert.equal(strongerVia("package.json", "eslint.config"), "eslint.config");
  assert.equal(strongerVia("eslint.config", "package.json"), "eslint.config");
  console.log("✓ counts exclude forks, archived and self-owned repos");
}
