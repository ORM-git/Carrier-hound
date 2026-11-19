# PR #643 repair and rehearsal: 10M schema step 1 on populated post-#645 schemas

**Merge: GO** (after review). The repaired migration passes every rehearsal on PGlite and on real
PostgreSQL 17, including the original #643 failures used as a control.
**Production apply: HOLD.** The migration is not zero-downtime. Running it needs a planned window, or a staged
plan (below), plus a comparison against a real production schema snapshot. Python10M stays OFF.
Nothing here was run against production.

## What changed in `20261116b` (the minimal repair)

| # | Change | Why (proven failure) |
|---|---|---|
| 1 | `jobs.source_id` stays **`text`** (the live board key, e.g. `greenhouse:stripe`) instead of `uuid REFERENCES ingestion_sources` | **Production order:** #645 already made it `text`, so the uuid FK was silently skipped. **Filename order:** it became `uuid` and the same data failed (`column "source_id" is of type uuid but expression is of type text`). |
| 2 | New nullable **`jobs.source_registry_id uuid REFERENCES internal_ingestion.ingestion_sources(id) ON DELETE SET NULL`**, plus a partial FK index | A separate, nullable registry link. **Mapping:** `ingestion_sources.slug = jobs.source_id` (slug is `UNIQUE NOT NULL`). Not backfilled by the migration. |
| 3 | `idx_jobs_active_dedupe_hash_uniq` is **not created** | #645 drops it as destructive. On populated data: `could not create unique index`, aborting the migration. On data without pairs it would reject legitimate cross-source rows at ingest. |
| 4 | `job_postings` dedupe index is **non-unique** (`idx_job_postings_active_dedupe_hash`). Identity is explicit: **one row per `(source_id → ingestion_sources.id, external_id)`**, enforced by the existing unique index | Two boards posting the same job got `duplicate key value violates unique constraint "idx_job_postings_active_dedupe_hash_uniq"`. |
| 5 | `saved_jobs.job_posting_id` and `job_descriptions.posting_id`: `ON DELETE SET NULL` instead of `CASCADE` | Deleting a posting would have silently deleted users' saved-job rows and job descriptions, even though they still reference a live legacy job. |
| 6 | **Lock prelude:** `LOCK TABLE` saved_jobs → job_descriptions → jobs → companies up front (`ACCESS EXCLUSIVE`, missing tables skipped) | Real PostgreSQL reproduced **deadlocks** for two writer patterns: an INSERT into `jobs` followed by a FK check on `companies`, and a `saved_jobs` write followed by a read of `jobs`. The old statement order locked those tables the other way round. With the prelude, both probed patterns only wait. **Other lock orders are not proven.** `lock_timeout` and a maintenance window remain required. |
| 7 | **Provenance record + tested rollback** replace the old hand-written rollback notes (see "Rollback" below) | The old notes would have destroyed data: they dropped tables and columns that may hold data. They were not provenance-aware: they dropped `companies_category_check`, which #645 D owns on a full-D database. They were also dependency-broken without CASCADE: `job_postings` was dropped while `saved_jobs` still referenced it, and `ingestion_sources` while `jobs.source_registry_id` did. |
| 8 | Guarded FK re-creation for `jobs.source_registry_id`, `saved_jobs.job_posting_id` and `job_descriptions.posting_id` | Re-applying after a disable would otherwise silently leave these FKs out, because `ADD COLUMN IF NOT EXISTS … REFERENCES` skips when the column exists. |
| 9 | Header rewritten to the current contract | Removed stale claims: "safe in either order with #642", "#642 owns a merge trigger on jobs", and the implied uuid `source_id`. Added the not-zero-downtime warning and the `lock_timeout` / maintenance-window requirement. |

Untouched:

- #645's `20261116d`, `e` and `f`;
- `merge_job_by_dedupe_priority`, which is never recreated;
- canonical `UNIQUE (source_id, source_job_id)`, kept;
- UI, billing, workflows, flags, ingestion, and the TS pipeline.

There are no forward `DROP`, `TRUNCATE`, `UPDATE` or data `DELETE` statements. The one `DELETE` clears the migration's own rollback-state marker in its provenance table on re-apply.

## Baselines (all labelled; none is a live snapshot)

- **`recon-incomplete`: the owner-reported post-#645 state, reconstructed.**
  - Repo chain without D/E/F, plus a 3-object drift shim (`jobs.category`, `jobs.country`, a `jobs_public` placeholder that no migration creates early enough).
  - Live `jobs.source_id text` and `companies.category`.
  - **Scoped D:** the exact D statements for `touch_job_last_seen` (function and trigger), `compute_job_similarity_hash_v2`, and the `similarity_hash_v2` column.
  - **E:** the canonical identity index, built exactly as `20261116e` builds it.
  - **Indexes:** a valid **partial** `idx_companies_category … WHERE category IS NOT NULL`.
  - **F:** installed (progress table and procedure). F's phase 3 was run on active rows, so active jobs missing a hash = **0**, but progress is recorded **only for the hash phase**. Full F completion is not assumed.
- **`recon-complete`:** same, with all three F phases recorded and every row hashed.
- **`full`** (extra): every repo migration including D/E/F in full. `dedupe_hash` = similarity hash, as `compute_job_dedupe_hash` produces after D.
- **`filename`:** a fresh database with 16b in its sorted slot, before D/E/F.

**Small fixture** (`scripts/fixtures/10m-schema-step1-populated.sql`, synthetic, deterministic):

- 240 jobs (198 active), 12 companies, 120 descriptions, 9 saved jobs and 3 synthetic users;
- Unicode titles and names, the same external IDs on 4 vendors, NULLs, fixed `last_seen_at` values, and text board keys;
- **16 cross-source active pairs**: same company, title, country and location, so they get the same `compute_job_similarity_hash_v2`.

## Commands

```sh
npm ci
npx tsx scripts/test-10m-schema-step1-fixtures.ts                       # toy-schema fixtures
npx tsx scripts/test-10m-schema-step1-fixtures.ts --negative-control    # must exit 1
npm run test:10m-rehearsal                                              # PGlite, all baselines + both orders
npm run test:10m-rehearsal -- --negative-control                        # must exit 1
npm run test:10m-rehearsal -- --migration=<original 16b>                # control: must reproduce the old failure
# Real PostgreSQL (local disposable cluster only; refuses URLs, foreign servers and non-empty databases):
npm install --no-save pg@8                                              # client only, package.json untouched
PG_BIN=<dir with initdb/pg_ctl/postgres> npm run test:10m-postgres      # default --jobs=200000
PG_BIN=... npm run test:10m-postgres -- --negative-control              # must exit 1
PG_BIN=... npm run test:10m-postgres -- --jobs=20000 --migration=<original 16b>
# Rollback procedure (production: Level 1 first; Level 2 only if every created table is empty):
psql -v ON_ERROR_STOP=1 -f supabase/scripts/rollback-20261116b-disable.sql
psql -v ON_ERROR_STOP=1 -f supabase/scripts/rollback-20261116b-remove-if-empty.sql
```

The real-PG runner refuses to start without binaries or `pg` (exit 2). It ignores `DATABASE_URL`/`PG*`, and it
verifies the connected server's `data_directory` is the temp cluster it created on `127.0.0.1` before every use.

## Results

Committed machine output: [`docs/evidence/10m-schema-step1/`](evidence/10m-schema-step1/README.md).

| Run | Engine | Result |
|---|---|---|
| `test:10m-rehearsal` (repaired) | PGlite (PostgreSQL 18.6 WASM) | **213 passed, 0 failed** (exit 0) |
| `test:10m-rehearsal -- --negative-control` | PGlite | exit 1, 8 checks caught the tampering |
| `test:10m-rehearsal -- --migration=<#643 original f8280087>` | PGlite | exit 1, 81 passed, 23 failed (old failures reproduced) |
| `test:10m-postgres` (repaired, 200,000 jobs) | **PostgreSQL 17.12**, real server | **225 passed, 0 failed** (exit 0) |
| `test:10m-postgres -- --negative-control` | PostgreSQL 17.12 | exit 1, the same 8 checks caught it |
| `test:10m-postgres -- --migration=<original>` (20,000 jobs) | PostgreSQL 17.12 | exit 1, 90 passed, 26 failed. Lock-order probes: **deadlock detected** (both); no provenance, so no safe rollback |
| `test-10m-schema-step1-fixtures.ts` / `--negative-control` | PGlite | exit 0 / exit 1 |

**Original #643 as control.** The populated full-migration baseline gives `could not create unique index
"idx_jobs_active_dedupe_hash_uniq"`, and filename order gives `source_id is of type uuid`. On the reconstructed
baseline it *applies*, because `dedupe_hash` does not exist yet there, but then:

- it recreates the destructive index;
- it rejects two boards with the same hash in `job_postings`;
- it lacks the registry FK;
- it deadlocks in both probed writer patterns;
- it has no provenance, so the rollback cannot be done safely.

**Repaired, each populated baseline.**

- **Unchanged by 16b:** row counts, checksums over original columns, every `last_seen_at`, F progress and similarity hashes, column order and types, existing index definitions (incl. E and the partial `idx_companies_category`), triggers, app queries (feed, categories, `saved_jobs` join, descriptions join, cross-vendor ids), and owners/grants/RLS of every pre-existing schema, relation and function.
- **Identity:** canonical `(source_id, source_job_id)` unique and valid. A duplicate canonical key and a same-vendor duplicate are rejected; the same posting from another board inserts with nothing merged or expired.
- **`job_postings`:** boards with the same hash coexist, a duplicate canonical key is rejected, the `ON CONFLICT` upsert is idempotent, and nothing expires. Deleting a posting keeps the saved job and the description.
- **Registry link:** the `slug = source_id` mapping maps exactly that board's jobs, deleting the source clears only the link, and an unknown uuid is rejected by the FK.
- **Isolation, masking and RLS:** `internal_ingestion` is isolated (anon/authenticated denied, service_role allowed), raw `job_postings` is denied, `job_postings_public` masks company, salary, apply URL and raw payload as anon, and `saved_jobs` RLS limits users to their own rows (anon sees none).
- **Re-runs:** the second apply is safe and changes nothing. An injected failure rolls back atomically with no partial objects, and the retry succeeds.

**Both orders (16b contract, 203 columns and constraints).**

| Comparison | Result |
|---|---|
| `recon-incomplete` vs `filename` | **identical types, constraints and FKs** (0 differences, 0 missing) |
| `recon-incomplete` vs `recon-complete` | identical |
| `recon-incomplete` vs `full` (extra) | 1 difference: `jobs.is_remote` default `false` vs `NULL`. Full D creates the column first without a default, so 16b's `IF NOT EXISTS … DEFAULT false` is skipped. Reported, not repaired: D is out of scope. |

Three CHECKs (`role_category`, `company_category`, `source_priority`) differ only in their text,
`(x IS NULL OR <check>)` versus `<check>`. These are the same constraint, because a CHECK that evaluates to NULL
passes, and the comparison normalizes them. `jobs_source_type_check` differs between scoped and full D. 16b does
not touch it, so it is outside 16b's contract.

## Rollback (documented procedure, executed by the tests)

The migration records its own provenance in `internal_ingestion.schema_migration_provenance` (metadata only).
Before creating anything it snapshots the catalog (schemas, enum types, relations, columns, constraints, policies,
non-extension functions, and the ACL and RLS flags of tables). Just before COMMIT it records what it **created**,
and the **prior** ACL and RLS of pre-existing tables it **changed**. Re-applies keep the first-apply rows.

| Script | What it does | Never does |
|---|---|---|
| `supabase/scripts/rollback-20261116b-disable.sql` (Level 1) | Refuses without provenance. Uses the same lock order as the migration. Drops only the policies, constraints and non-constraint indexes the migration created on **pre-existing** tables. Restores their exact prior grants and RLS flags. Revokes PUBLIC/anon/authenticated access to relations the migration created. Marks the state `disabled`. Idempotent. | DROP TABLE, DROP COLUMN, CASCADE, touching pre-existing or #645 objects |
| `supabase/scripts/rollback-20261116b-remove-if-empty.sql` (Level 2) | Refuses unless disabled, every created table is empty, and no added column still references a created table. Then drops created views, created tables leaves-first (refuses on outside references instead of cascading) and unused created enum types. | Dropping added columns, `jobs.source_id`, the `internal_ingestion` schema or the provenance record |

Both scripts run in one transaction with `lock_timeout = 3s`, so a refusal or a timeout changes nothing.
**Re-enable** by re-applying the migration. It recreates the dropped indexes, constraints and policies, and its
guarded block recreates the FKs that `ADD COLUMN IF NOT EXISTS … REFERENCES` would otherwise skip.

**Tested** (`R:recon-incomplete`, `R:full`) on PGlite and real PostgreSQL 17, executing the exact files. The
`saved_jobs` grants and RLS were first set to differ from what 16b sets, so the restore path is exercised.

1. **Apply 16b, then check provenance.** It must list exactly the relations 16b created (11). It recorded 33 columns added to pre-existing tables and 2 prior grant/RLS states.
2. **Write new data:** a registered source, linked jobs, postings, a saved job linked to a posting, and a consent row.
3. **Remove before disable:** refused.
4. **Disable.**
   - Original data is unchanged: counts, checksums, `last_seen_at`, #645 F state and app queries.
   - New data is preserved.
   - Every pre-existing table's indexes, constraints, policies, effective privileges per role, RLS and triggers equal the pre-16b state: 1,549 attributes compared (1,556 on full D). On full D this includes #645 D's `companies_category_check` and E's indexes, which the old notes would have dropped.
   - There is no API access to created relations, and added columns are kept.
   - A sensitivity check confirms the same comparison saw 22 (16 on full D) attributes 16b had changed.
5. **Disable again:** a no-op.
6. **Remove with data present:** refused, naming the blocking tables and columns; nothing changed.
7. **Operator clears the new data, then remove succeeds.** Only the provenance table remains of the created relations. Original data and pre-existing objects equal the pre-16b state.
8. **Re-apply:** 16b is re-enabled, with the registry FK recreated and the rollback state cleared.

Disable took 72–82 ms on the 200k-row real-PG cluster's small-fixture databases.

## Real PostgreSQL: scale and concurrency (measured)

**Hardware and settings.** 13th Gen Intel Core i5-13420H, 12 logical cores, 16 GB RAM, Windows 11. PostgreSQL
17.12 with defaults (`shared_buffers` 128 MB, `maintenance_work_mem` 64 MB, `fsync` on, `synchronous_commit`
on), on a local SSD temp directory. **Fixture:** 200,000 jobs (160,000 active, 505 MB with indexes), 2,000
companies, 100,000 descriptions and 5,000 saved jobs, populated in 285 s. Full timelines are in
[`evidence/10m-schema-step1/README.md`](evidence/10m-schema-step1/README.md).

The sessions are independent connections: the migration, a held reader, a live writer (INSERT every 25 ms), a
feed reader (`jobs_public`, every 25 ms) and a lock observer (`pg_locks` + `pg_stat_activity` every 50 ms).

| Phase | Measured |
|---|---|
| a. A reader holds `ACCESS SHARE` on `jobs`; 16b runs with `lock_timeout = 3s` | 16b waited 2,940 ms, then aborted (`canceling statement due to lock timeout`). **The writer and feed reader queued behind 16b's pending `ACCESS EXCLUSIVE` request for 2,566 ms** (worst write 2,723 ms, worst read 2,683 ms). Afterwards data, schema, grants and #645 state were unchanged, with no partial objects. |
| b. `statement_timeout = 250ms` fires mid-migration (injected 1 s statement before COMMIT) | Aborted (`canceling statement due to statement timeout`) in 852 ms; everything unchanged. |
| c. Retry under live writes and reads (`lock_timeout = 3s`) | Committed in **6,790 ms**. The lock prelude waited 942 ms for in-flight statements, then `ACCESS EXCLUSIVE` on jobs, companies, job_descriptions and saved_jobs was held for **~5.7 s** and all traffic queued. Steady state: write p50 5 ms, read p50 1 ms. During the migration: **worst write 6,812 ms, worst read 6,783 ms**, no errors. Counts, checksums, `last_seen_at`, #645 state and app queries were unchanged at scale. |
| d. Second apply | No-op in 136 ms, but it **still takes `ACCESS EXCLUSIVE` on all four tables**. |
| Lock-order probes | **Only these two writer patterns are proven.** A writer holding `jobs` (INSERT) then FK-checking `companies`, or holding `saved_jobs` (UPDATE) then reading `jobs`: no deadlock; the writer committed first and 16b followed 1.2–1.4 s later. **Original 16b: `deadlock detected` in both.** Other lock orders, such as unprobed triggers or multi-table application transactions, are not claimed. |

### What this means for production (honest limits)

- **Not zero-downtime.** One transaction holds `ACCESS EXCLUSIVE` on `jobs`, `companies`, `job_descriptions` and `saved_jobs` while building 7 or more indexes on `jobs` with plain `CREATE INDEX`. At 200k rows on this laptop that blocked the feed, saved jobs and ingestion for about 6.8 s. **Duration at production size is unmeasured**; it grows with rows and indexes, and these numbers support no 10M capacity claim.
- **Keep `lock_timeout` set for any apply (3 s used here) and use a maintenance window.** While 16b *waits* for its locks, every new reader and writer queues behind it.
- A second apply also locks everything.

**Suggested staged plan for production** (not implemented here):

1. **Phase 1, short transaction, `lock_timeout` 3 s, retry:** the lock prelude, provenance, enums, `internal_ingestion`, new tables and views, `ADD COLUMN`s (catalog-only on PG 11+), `NOT VALID` constraints, grants and RLS. No index builds on existing big tables.
2. **Phase 2, outside a transaction, one statement at a time:** `CREATE INDEX CONCURRENTLY` for each `jobs` / `companies` / `job_descriptions` / `saved_jobs` index, then check `indisvalid` (#645 E's pattern).
3. **Phase 3, optional:** `VALIDATE CONSTRAINT` (`SHARE UPDATE EXCLUSIVE`, which doesn't block reads or writes).

## Platform stubs (UNVERIFIED against production)

- **Supabase:** roles anon, authenticated, service_role (BYPASSRLS), authenticator and supabase_admin, with migrations running as `postgres`; `auth.users` and `auth.uid()`/`role()`/`jwt()`; the storage schema with a `resumes` bucket and `foldername()`; and Supabase's default privileges on `public`.
- **`pg_cron`:** not installed on either engine. The `CREATE EXTENSION` line is skipped and `cron.schedule` is recorded only.
- **`pg_stat_statements`:** created on real PG and skipped on PGlite.
- **No production schema snapshot is in the repo.** The reconstruction follows the owner's description and has not been checked against the live schema.

## Stop conditions (do not apply to production while any holds)

1. Any rehearsal or real-PG check fails, or a negative control exits 0.
2. No comparison with a real production schema snapshot (e.g. `pg_dump --schema-only`) against the reconstruction.
3. No maintenance window sized from a measurement on production-size data, or the staged plan is not adopted.
4. `lock_timeout` is not set for the apply, or no retry policy exists for a lock-timeout abort.
5. Anything writes `jobs.source_registry_id` without the `slug = source_id` mapping.
6. The rollback has not been rehearsed against a snapshot of the target database, or the provenance record is missing after the apply.

## Known gaps

- Production-scale lock duration (unmeasured).
- Behavior under real `pg_cron`.
- The reconstruction versus the live schema.
- The redundant `idx_jobs_source_vendor_source_job_id_uniq` (duplicates `jobs_source_source_job_id_key`), kept to keep the diff minimal.
- `jobs.is_remote` default divergence in the full-D baseline only.
- `job_postings.company_id ON DELETE CASCADE` (new table only) left as designed.
- No backfill of `source_registry_id`.
