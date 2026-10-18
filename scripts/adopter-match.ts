// Pure verdicts for the adopter scan (adopters.ts). No fetch, no Supabase, so
// adopters.check.ts runs without secrets.
//
// GitHub code search matches TEXT, and a quoted "eslint-plugin-jwt" also
// matches "eslint-plugin-jwt-security" and a package whose own name merely
// starts with ours. These decide whether a matched file really uses the
// package.

/** Owners whose repos are ours, not adopters. */
export const SELF_OWNERS: ReadonlySet<string> = new Set(["ofri-peretz"]);

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** Is `pkg` a dependency KEY of this package.json? Unparseable → no. */
export function declaresDependency(packageJson: string, pkg: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const p = parsed as Record<string, unknown>;
  return DEP_SECTIONS.some((s) => {
    const deps = p[s];
    return (
      !!deps &&
      typeof deps === "object" &&
      Object.prototype.hasOwnProperty.call(deps, pkg)
    );
  });
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does this config text name `pkg` as a whole package name? `-` and word
 * characters on either side mean a different package (jwt vs jwt-security);
 * a `/` after it is a subpath import of the same package and still counts.
 */
export function mentionsPackage(text: string, pkg: string): boolean {
  return new RegExp(`(^|[^\\w@/-])${escape(pkg)}(?![\\w-])`).test(text);
}

export interface RepoFacts {
  full_name: string;
  fork: boolean;
  archived: boolean;
  owner: { login: string; type: string };
}

/** Counted as an adopter: not a fork, not archived, not ours. */
export function isExternalActive(r: RepoFacts): boolean {
  return !r.fork && !r.archived && !SELF_OWNERS.has(r.owner.login.toLowerCase());
}

export type DetectedVia = "package.json" | "eslint.config" | "eslintrc";

/** A config file is a stronger signal than a dependency line. */
export function strongerVia(a: DetectedVia, b: DetectedVia): DetectedVia {
  return a === "package.json" ? b : a;
}
