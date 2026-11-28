# Fresh-database migration replay: diagnostic findings

Status: diagnostic only. No migration, product code or production DDL was changed, and nothing was applied anywhere.
Production's applied migration state, and whether its `jobs_public` view exists or what it contains, are unknown;
nothing here reads production, and no statement below is a claim about it.
Evidence comes from repo files on main `286e2e42` and from `scripts/diagnose-migration-replay.ts`, which replays into an
in-memory PGlite (Postgres 17 in WASM), not a Supabase project.

## Reproduce (offline, no credentials, no network)

```
npx tsx scripts/diagnose-migration-replay.ts --platform-stubs                 # documented DR path: migrations only
npx tsx scripts/diagnose-migration-replay.ts --baseline --platform-stubs      # schema.sql baseline, then migrations
npx tsx scripts/diagnose-migration-replay.ts --baseline --platform-stubs --assume=jobs_public            # psql-style, rest of chain
npx tsx scripts/diagnose-migration-replay.ts --baseline --platform-stubs --assume=jobs_public --whole-file  # SQL-Editor-style
npx tsx scripts/test-diagnose-migration-replay.ts                             # 22 checks (not in the required suite)
```

The order is sorted filenames, the same as `scripts/lib/schema-dump.ts:41-43` and `docs/dr-runbook.md:123`
(`ls -1 supabase/migrations/*.sql | sort`). Locally, JS sort, `LC_ALL=C sort` and `en_US.UTF-8 sort` give the same list of 98 files.
Statements are sent one at a time, as `psql -f` sends a file. `--whole-file` sends each file as one request instead.
The first undeclared error stops the run with exit 1. A run that used any skip, no-op or assumption reports `STATUS: PARTIAL`.

The statement splitter is not a general PostgreSQL parser. It handles only the subset these files use:
- `'...'` with `''` (standard_conforming_strings on);
- `E'...'` with backslash escapes;
- `"..."` identifiers;
- `$$`/`$tag$` bodies;
- `--` comments and nested block comments.

Every file is split before any statement runs. An unterminated quote, comment or dollar body, or a psql meta-command,
is rejected with its line number rather than guessed. Not handled: `U&'...' UESCAPE`, psql variables, `COPY ... FROM stdin`.
All 99 files (with `--baseline`) split without rejection.

## Results

| Run | Result |
|---|---|
| no stubs | STOPPED `20261001_filter_upgrades.sql:7` [0A000] extension "pg_trgm" is not available (PGlite needs its contrib module) |
| migrations only, platform stubs (documented DR path) | STOPPED `20261001_filter_upgrades.sql:11` [42P01] relation "public.jobs" does not exist |
| schema.sql + migrations, platform stubs | STOPPED `20261001_filter_upgrades.sql:211` [42P01] relation "public.jobs_public" does not exist: `GRANT SELECT ON public.jobs_public TO anon, authenticated, service_role` |
| same + `--assume=jobs_public` | PARTIAL: 98/99 files, 1257 statements; only the declared items below were used |
| same + `--whole-file` | STOPPED `20261116e_repair_642_concurrent_indexes.sql` [25001] DROP INDEX CONCURRENTLY cannot run inside a transaction block (81/99 files) |

## The three kinds of gap

### 1. Genuine ordering or dependency gaps (repo)

**a. `jobs_public` is used before any migration creates it.**
- First executable use: `supabase/migrations/20261001_filter_upgrades.sql:211`, `GRANT SELECT ON public.jobs_public ...`.
  The mentions at `:209` and in `20261001_ingestion_pipeline.sql:56-57` and `supabase/schema.sql:85-86` are the *policy* `"jobs_public_read"`, not the view.
- First creation: `supabase/migrations/20261010_lock_paid_jobs_data.sql:9`, `CREATE OR REPLACE VIEW public.jobs_public AS SELECT id, title, location, ...`, with its GRANT at `:41`.
- Later redefinition: `20261116d_repair_642_identity_and_similarity_safety.sql:314` (CREATE OR REPLACE), GRANT at `:349`.
- `supabase/schema.sql` never creates the view, and no other migration does either.
- History:
  - `20261001_filter_upgrades.sql` was added in `5ae7fb61` (2026-10-03).
  - `20261010_lock_paid_jobs_data.sql` was added in `c123107c` (2026-10-11).
  - The GRANT at `:211` arrived later, in `a8985c61` (2026-10-14, "docs: supabase migration phases, preflight and rollback notes"), which rewrote the already-merged 20261001 file. Whether, when and in what form that edited file was applied anywhere is not recorded in the repo and is unknown.
  - A fresh replay reaches the GRANT in the first file; the view is created in the tenth (8 files in between).
  - This conflicts with `docs/contributor-setup.md:54` ("never edit a merged migration").

**b. No migration creates `public.jobs`.**
- Only `supabase/schema.sql:28` does. The first migration alters `public.jobs` at `20261001_filter_upgrades.sql:11`.
- `docs/schema-drift-baseline.md:3-6` calls `schema.sql` the hand-run baseline.
- But the DR fresh-project procedure says to replay only the migrations: `docs/dr-runbook.md:118-128`, and `docs/rpo-rto-targets.md:47` Scenario 4 step 3.
- Following those documents as written stops at `:11`. This is a documentation gap in the DR path, not a migration-order defect.

### 2. Supabase platform objects absent locally (not repo defects)

These are declared stand-ins in `PLATFORM_STUBS`, applied only with `--platform-stubs`:
- roles `anon`, `authenticated`, `service_role`, `authenticator`;
- `auth.users`, `auth.uid()`, `auth.role()`, `auth.jwt()`;
- `storage.buckets`, `storage.objects`, `storage.foldername()`;
- the project's default privileges (ALL on new `public` tables, functions and sequences to the API roles).

Evidence for the last one: `20261119_onboarding_resume_profiles.sql:89` grants only SELECT/INSERT/UPDATE/DELETE to `service_role`, yet its post-check at `:185` requires TRUNCATE. That only holds with Supabase's default grants. Without the stand-in, `:149` fails with "post-check: service_role lacks TRUNCATE".

### 3. Unsupported PGlite extensions and concurrent-index statements (local tool limits)

- `pg_trgm` and `pgcrypto`: loaded from PGlite contrib.
- `unaccent`: `20261001_filter_upgrades.sql:8`. The `CREATE EXTENSION` is a declared no-op, with stand-in `public.unaccent(text)` = identity.
- `pg_stat_statements`: `20261105c_database_safety.sql:74`. The `CREATE EXTENSION` is a declared no-op, and the rest of that file replays.
- `pg_cron`: the whole of `20261108a_pg_cron_scheduled_jobs.sql` is skipped. With only the extension no-op'd, `:44` `select cron.schedule(...)` fails: schema "cron" does not exist.
- `CONCURRENTLY` (`20261116e`): works when statements run one at a time (psql). It fails when the file is sent as one request (`--whole-file`, the way the SQL Editor sends a script). The file's own header says to run it outside a transaction block (`20261116e...sql:4,9`). `docs/dr-runbook.md:125` says "psql or Supabase SQL Editor" without that caveat.

## Affected fresh-install path

The procedure is `docs/dr-runbook.md` Path B (Disaster Recovery Replay into a Fresh Project), steps 4-6, which is also `docs/rpo-rto-targets.md` Scenario 4.
- As written (migrations only), the replay stops at the first file (gap 1b).
- With the `schema.sql` baseline added, it stops at the same file's GRANT (gap 1a).
- Without `jobs_public`, these read paths have no view:
  - `/api/health/ready` (`src/app/api/health/ready/route.ts:24`), which is the runbook's own verification step;
  - the anonymous jobs search and recommended routes (`src/app/api/jobs/search/route.ts:146`, `recommended/route.ts:134`);
  - `suggest` (`:103`), `top10` (`:361`) and `radar` (`src/app/api/radar/route.ts:42`).

Nothing here says whether the production project is or is not affected; its applied state is unknown.

`supabase/scripts/apply-pending.sql` (DR step 5) does not supply the missing prerequisites:
- Its header (`:2`) says "DO NOT APPLY / REVIEW PENDING".
- It never creates `public.jobs` or `public.jobs_public`. Its only `CREATE TABLE`s are `tailored_resumes` (`:236`) and `ai_usage_quotas` (`:277`), and it has no `CREATE VIEW`.
- It needs both of them itself: `ALTER TABLE public.jobs` at `:44` and `GRANT SELECT ON public.jobs_public` at `:228`.
- It runs after step 4, the replay that already failed.

## Repair options (unreviewed; NOT implemented, NOT approved)

1. **DR runbook (docs only).** In `docs/dr-runbook.md` Path B step 4, and in `docs/rpo-rto-targets.md` Scenario 4:
   - add "apply `supabase/schema.sql` first";
   - say that `20261116e_repair_642_concurrent_indexes.sql` must run statement by statement outside a transaction (psql), not as one SQL Editor script.
2. **Unreviewed option, not a recommended or safe production repair:** a guarded block in `supabase/schema.sql` that creates a placeholder `jobs_public` before 20261001 runs:
   ```sql
   do $$ begin
     if to_regclass('public.jobs_public') is null then
       execute 'create view public.jobs_public as select id from public.jobs';
     end if;
   end $$;
   ```
   - Locally it lets the chain replay, the same as `--assume=jobs_public`: `20261010:9` and `20261116d:314` then `CREATE OR REPLACE` it with the real columns, which start with `id`.
   - Not shown, and needing owner review:
     - what it does to any existing database, including production, whose state is unknown;
     - whether a placeholder grant is acceptable;
     - whether the view should instead get 20261010's full column list.
   - Not considered here: reordering or renaming migrations, editing 20261001, or a new migration that sorts before it. Any of these would run wherever migrations are applied, so the owner should weigh them against the actual applied state, which nobody here knows.
3. **Verification after review.** Rerun:
   ```
   npx tsx scripts/diagnose-migration-replay.ts --baseline --platform-stubs
   ```
   - Any option should then finish PARTIAL with no `--assume`, leaving only the declared platform and extension items.
   - The real proof is the DR-05 drill (`docs/dr-runbook.md:221`) in a throwaway Supabase project, which needs the owner.

## Not established here

- Production's applied migrations, or whether its `jobs_public` view and grants exist.
- Real Supabase SQL Editor transaction behavior (`--whole-file` models it as one multi-statement request).
- Any Postgres version difference between PGlite 17 and the project.
