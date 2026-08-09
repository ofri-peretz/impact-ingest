# impact-ingest

The job behind the public numbers on [ofriperetz.dev](https://ofriperetz.dev/npm),
[eslint.interlace.tools](https://eslint.interlace.tools/stats) and the Interlace docs sites.
Once a day it asks npm, GitHub and dev.to how the ecosystem is doing, writes the answers to
Supabase, and advances a monotonic ratchet that every consumer reads from.

It is open because the numbers are: if a site claims *N downloads* or *M plugins*, this is the
code that produced N and M, and the schema it produced them into. Nothing here is a secret —
the credentials live in repository secrets and never reach the source or the logs.

## What it measures

| source | into | what |
| --- | --- | --- |
| npm registry | `plugin_daily_metrics`, `npm_alltime_downloads` | downloads per package, three windows + lifetime |
| npm search | `plugins` | which packages exist at all — see *The catalog* below |
| GitHub | `creator_daily_metrics` | stars, forks, commits, merged PRs, releases, followers |
| dev.to | `external_articles`, `creator_daily_metrics` | per-article views/reactions/comments, follower count |
| PostHog | `metric_snapshots` | page views (optional; skipped when unconfigured) |

`storefront_ratchet` holds the published figures. It is **monotonic** — a trigger refuses any
update that would lower a cumulative value, so a bad API day cannot walk a public number
backwards. Consumers read the `v_*` views, never the tables.

## The catalog

Which packages count is derived, not typed by hand:

```
counted = every non-deprecated package we publish
          ∪ DEPRECATED_INCLUDE      renames that still earn downloads
          ∖ IGNORED_PACKAGES        abandoned experiments
```

npm's search endpoint omits deprecated packages, so "all non-deprecated" costs one call.
Both lists live in [`scripts/plugin-catalog.ts`](scripts/plugin-catalog.ts) with the reasoning
next to each entry.

This matters more than it sounds. The table was hand-seeded for three months and nobody noticed
it had fallen 13 packages behind — they were simply absent from every published total, with
nothing erroring. An allow-list fails silently in the direction that hurts.

See what it resolves to right now, with no database access:

```bash
npm install && npm run catalog:dry
```

## Running it

The schedule and manual dispatch are the only triggers, and GitHub restricts both to accounts
with write access — so the secrets are reachable only by maintainers. There is no
`pull_request_target` here and there never should be: a fork PR must not be able to read them.

| secret | required | notes |
| --- | --- | --- |
| `SUPABASE_URL` | yes | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | full-access JWT; server-side only |
| `DEVTO_API_KEY` | no | dev.to metrics skip gracefully when absent |
| `POSTHOG_API_KEY` | no | page-view collector skips when absent |

| variable | notes |
| --- | --- |
| `DEVTO_COMMENTS_LEFT` | outbound-comment count. Unset means "not measured" and is stored as a gap, never as a zero. |

`GITHUB_TOKEN` is provided by Actions automatically.

## Failure behaviour

Every collector is non-fatal on its own. A 429 from npm or a dead dev.to key skips that metric
and the run continues, because `refresh_storefront_ratchet()` runs last and has to be reached —
one flaky API must not freeze every published number for a day.

The cost of that design is that a green run can still be a bad run. So: **read the values a run
wrote, not its exit status.** A per-package loop once lost 66 of 108 npm calls to rate limits and
reported success; the fix was asking fewer times (one bulk call per period), not retrying harder.

An unattended failure opens a `ci-failure` issue rather than dying quietly.

## Layout

```
scripts/daily-ingest.ts          the job — collectors, upserts, ratchet refresh
scripts/plugin-catalog.ts        which packages count, and why (runnable on its own)
scripts/backfill-npm-alltime.ts  lifetime downloads per package
scripts/_supabase-admin.ts       service-role client; refuses to load in a Vercel runtime
scripts/supabase-types.ts        generated database types
supabase/migrations/             the schema, in order
```
