# Contributor setup (Backend sheet rows: Onboarding Docs, Owner Handoff Docs)

Status: written from the repo files named below, not from a fresh-machine run. Nobody has followed these steps on
a clean machine to confirm them (owner to confirm). The rows stay PARTIAL. For account access and backup-operator
steps, see `docs/maintainer-handoff.md`.

## 1. Get the code running

1. Install the Node version in `.node-version` (CI reads the same file, `.github/workflows/ci.yml`).
2. `npm ci` (the lockfile is committed).
3. Copy `.env.example` to `.env.local` and fill only what your task needs. Public pages and offline tests do not
   need real keys. Never commit `.env.local` or paste keys into issues, PRs or chat. Rotation steps:
   `docs/security/secrets-rotation-runbook.md`.
4. `npm run dev` starts the app on `http://localhost:3000`.

The repo defines no local database stack (`supabase/` holds migrations, `schema.sql` and `seed.sql`, with no local
config). Anything that needs a database needs a Supabase project you own. Do not point tests at production.

## 2. Checks to run before a PR

| Check | Command | Notes |
| --- | --- | --- |
| Types | `npm run type-check` | `tsc --noEmit`; `scripts/` is excluded from `tsconfig.json`, so run scripts with `npx tsx` |
| Lint | `npm run lint` | `scripts/run-lint.cjs`, warning ceiling kept in `.eslint-baseline.json` |
| Unit tests | `npm run test:unit` | `vitest run` |
| Script suite | `npx tsx scripts/suite-runner.ts` | Runs every entry in `scripts/suite-runner.ts` |
| Everything | `npm run test:all` | Suite runner, then vitest |
| One script | `npx tsx scripts/test-<name>.ts` | Exit 0 passes |

Suite entries are classified (`offline`, `db-read`, `db-write`, `db-anon-write-attempt`). Offline entries need no
credentials. The database-capable entries are guarded by `scripts/lib/test-guard.cjs` and an allowlist of test
projects in `scripts/suite-runner.ts`; leave them to CI or to a project you own. One offline entry,
`scripts/test-url-state-assertions.ts`, needs a browser and fails without one.

A pre-commit hook runs `lint-staged` (`.husky/pre-commit`).

## 3. What CI runs

The gate is the job "Build, Lint & Test Suite" in `.github/workflows/ci.yml`. In order it runs several policy checks
(error budget, log retention doc, account deletion, tail latency, sourcemaps, sub-processor inventory, API
versioning, release versioning, config drift, suite-runner integrity), the type check, lint, `npm run build`, the
performance and bundle budgets, `npm run test:all`, and coverage thresholds. Read the workflow file for the exact
order and for which steps need a network or browser.

## 4. Adding a test

1. Write `scripts/test-<name>.ts` that prints one PASS or FAIL line per check and exits non-zero on failure.
2. Register it in `scripts/suite-runner.ts` as an `offline` entry. Add the entry after the last existing entry and
   keep every entry that is already there; `scripts/test-suite-runner-integrity.ts` guards the file.
3. Run the script with `npx tsx`, then the full suite.

## 5. Database changes

- Add a new file under `supabase/migrations/`; never edit a merged migration.
- Every migration needs a commented `ROLLBACK` section with an undo line, or an explicit `-- NOTE:` that rollback is
  manual (`scripts/test-migration-rollback-policy.ts`). Safe-change rules: `docs/zero-downtime-migrations.md`.
- A new table also needs rows in `docs/schema-drift-baseline.md` and `docs/data-classification.md`.
- Migrations are applied by the owner in the Supabase SQL Editor and then recorded with
  `node scripts/record-migration.cjs <file>` (see the "Apply and record" section of
  `docs/zero-downtime-migrations.md`). A PR does not apply anything.

## 6. Review and ownership

`.github/CODEOWNERS` assigns migrations and Netlify functions to `@ORM-git`. Pull requests go through the CI gate
above. Branch protection settings are not visible from the repo (owner to confirm).

## 7. Where things live

| Area | Path |
| --- | --- |
| API routes | `src/app/api/` (OpenAPI notes: `docs/openapi.yaml`) |
| Server libraries | `src/lib/` (`billing`, `ai`, `admin`, `security`, `observability`, ...) |
| Edge or Netlify functions | `netlify/functions/` |
| Scheduled jobs | `.github/workflows/*-cron.yml`, scripts in `scripts/` |
| Runbooks and policies | `docs/runbooks.md`, `docs/slo.md`, `docs/incident-log.md`, `docs/retention-policy.md` |

## What stays unproven

- The commands above were read from `package.json`, the workflow and the scripts, not re-run on a clean machine.
- Local development against a database is not described because the repo defines no local stack.

## Owner steps (for the keeper's Doc)

1. Have a new contributor follow this file on a clean machine and report what breaks.
2. Decide whether to publish a local Supabase setup and, if so, add a `supabase/config.toml` in a separate PR.
3. Confirm branch protection settings.
