# Twelve-Factor evidence (Backend sheet row: Twelve-Factor App)

Status: evidence map. It changes no code. The row says "env config + stateless web yes; logs/admin-process
parity partial", and this doc keeps it PARTIAL. Every file named here is checked by
`scripts/test-twelve-factor-evidence.ts`. A file existing proves it is there, not that the factor holds at runtime.

Ratings: Met (repo evidence supports it), Partial (some evidence, a gap named), Not applicable, Unproven
(depends on live setup the repo cannot show). All ratings are owner to confirm.

## I. Codebase: Met

One git repository (`ORM-git/Carrier-hound`) deployed to more than one host: Cloudflare Pages as primary, Netlify as
backup (`docs/incident-log.md`). Netlify Functions live in `netlify/functions`.

## II. Dependencies: Met

`package.json` with a committed `package-lock.json`; CI installs with `npm ci` (`.github/workflows/ci.yml`);
`.node-version` pins the Node version.

## III. Config: Met

Settings come from environment variables; `.env.example` lists them. `scripts/test-env-guards.ts` checks that a
missing required variable fails closed with a message naming it. `docs/config-drift.md` covers drift of the pinned
build and CI files. Secrets live in host and GitHub secret stores (`docs/security/secrets-rotation-runbook.md`).
Gap: the host dashboards hold the live values, which the repo cannot show.

## IV. Backing services: Met

Supabase, Groq and Razorpay are reached through URLs and keys from the environment. Optional services are
env-gated with no-op fallbacks (`src/lib/cache/redis.ts`, `src/lib/cache/edgeKv.ts`).

## V. Build, release, run: Partial

CI type-checks, lints, tests and runs `npm run build` (`.github/workflows/ci.yml`). Releases are not tagged
(`docs/release-versioning.md`), and deploys run through each host's own pipeline, which the repo does not describe
(owner to confirm). Migrations are applied by hand, not by the pipeline (`docs/zero-downtime-migrations.md`).

## VI. Processes: Partial

The web tier keeps durable state in Supabase. Some limiter and cache fallbacks hold per-instance memory while the
shared store is down (`docs/memory-bounds.md`, `docs/concurrency-posture.md`), so statelessness holds on the normal
path only.

## VII. Port binding: Not applicable

The app runs on edge and serverless runtimes, with no self-bound port. `next start` exists in `package.json` for local
use.

## VIII. Concurrency: Partial

Scale-out is the platform's job. Cross-request races are handled with row locks and a counting semaphore
(`docs/concurrency-posture.md`), with the limits stated there. No load proof beyond the k6 run noted in `docs/slo.md`.

## IX. Disposability: Unproven

Instances are short-lived by design. Idempotence of jobs is handled in places (`docs/job-dedupe.md`,
`docs/outbox-queue.md`), but no graceful-shutdown or kill-during-work test exists.

## X. Dev/prod parity: Partial

CI builds the Cloudflare variant; the Netlify backup differs by design. Local development uses a hosted Supabase
project or the owner's own setup (no local stack is defined in the repo). Config drift is guarded for the pinned files
(`docs/config-drift.md`).

## XI. Logs: Partial

A structured JSON logger writes one line per event to stdout or stderr (`docs/structured-logging.md`,
`src/lib/observability/logger.ts`), but adoption is opt-in, so some code still uses plain `console.*`. There is no
central retention or search; collection depends on host dashboards (`docs/log-retention.md`).

## XII. Admin processes: Partial

One-off and scheduled tasks are scripts run with `tsx` from `package.json` and GitHub Actions workflows, using the
same code and environment variable names. Database migrations are applied by hand and then recorded with
`scripts/record-migration.cjs`. Runbooks cover recurring failures (`docs/runbooks.md`). Gap: no single admin-task
runner or audit trail for hand-applied changes beyond that record.

## What stays unproven

- Live host configuration, deploy pipelines, log collection and graceful shutdown behavior.
- This map is a reading of the repo, not a test that the app behaves this way in production.

## Owner steps (for the keeper's Doc)

1. Confirm or correct each rating above.
2. Describe the real deploy pipeline for Cloudflare Pages and Netlify, so factor V can be written down.
3. Decide whether to define a local development stack, and whether to move toward central logs.
