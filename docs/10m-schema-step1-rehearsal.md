# PR #643 rehearsal: 10M schema step 1 on a populated post-#645 schema

**Verdict: HOLD.** One blocker was proven and repaired in this PR. A second blocker, the `jobs.source_id`
type conflict between #643 and #645, needs an owner decision and is **not** repaired here. Python10M stays
OFF. No production SQL was run; nothing here authorizes applying 20261116b.

## What was rehearsed

| Item | Value |
|---|---|
| PR under test | #643, head `f8280087cfeebe0c665459246d73c408647b0511` |
| Rehearsal branch | `rehearsal/643-schema-step1` = #643 head + merge of `main` @ `44503a70` |
| Database | PostgreSQL 18.6 (PGlite 0.5.16, WASM, in-process, disposable). No network DB, no credentials. |
| Base schema | `supabase/schema.sql` + all 86 other repo migrations incl. #645 D/E/F, applied in production order |
| Fixture | `scripts/fixtures/10m-schema-step1-populated.sql`: 240 jobs (198 active), 12 companies, 120 job_descriptions, 9 saved_jobs, 3 synthetic users |
| Migration md5 (repaired) | `e8f382ec0327c4a55d202b045dc14264` |

The fixture is synthetic and deterministic. It contains Unicode titles and company names, the same external
id on 4 vendors (60 cross-vendor ids), active and inactive rows, NULL salary/country/category, fixed
historical `last_seen_at` values, text `source_id` values (the post-#645 type), and **16 cross-source active
pairs sharing one `dedupe_hash`**, which #645 explicitly allows (the same posting seen on two vendors).
It holds no customer data.

## Commands

```sh
npm ci
npx tsx scripts/test-10m-schema-step1-fixtures.ts                      # toy-schema fixtures, exit 0
npx tsx scripts/test-10m-schema-step1-fixtures.ts --negative-control   # must exit 1
npm run test:10m-rehearsal                                             # = npx tsx scripts/test-10m-schema-step1-rehearsal.ts
npx tsx scripts/test-10m-schema-step1-rehearsal.ts --negative-control  # must exit 1
npx tsx scripts/test-10m-schema-step1-rehearsal.ts --migration=<file>  # rehearse another 16b, e.g. the #643 original
npx tsx scripts/test-10m-schema-step1-rehearsal.ts --probe-chain       # only check that the base chain loads
```

The rehearsal exits **1** while blocker 2 is open. That is intended: it reports the real state.

## Scenarios

- **A. Production order.** Load the base chain (everything except 16b), populate, snapshot, apply 16b, compare, run behavior checks, apply 16b a second time and compare again.
- **B. Filename order.** Apply 16b in its sorted slot, before #645 D/E/F, then the rest. Load the same fixture and compare the final schema with A.
- **C. Failure and retry.** On a fresh populated DB, apply 16b with `SELECT 1/0` injected before its `COMMIT`. Check the DB is byte-for-byte unchanged, then retry.
- **D. Negative control** (`--negative-control`). After A, tamper (rewrite one `last_seen_at`, grant anon USAGE on `internal_ingestion`, disable RLS on `saved_jobs`). The checks must catch every tamper, and the run exits 1.

Snapshots compare:

- row counts, and checksums over each table's original columns;
- every `jobs.last_seen_at`;
- column order and types of every public relation;
- every pre-existing index definition and `indisvalid`;
- triggers on `public.jobs`;
- five app query results;
- owner, ACL and RLS of every relation and function in `public` and `internal_ingestion`.

## Results

| Check group | 16b original (`f8280087`) | 16b repaired (this PR) |
|---|---|---|
| A. applies on populated post-#645 schema | **FAIL**: `could not create unique index "idx_jobs_active_dedupe_hash_uniq"` | PASS (424 ms) |
| A. row counts / checksums / `last_seen_at` / column order+types / index defs / app queries / grants+RLS unchanged | not reached | PASS (all) |
| A. every index valid (incl. #645 canonical `idx_jobs_source_id_source_job_id_uniq`) | not reached | PASS |
| A. no new triggers on `public.jobs` (no automatic merge/expiry) | not reached | PASS |
| A. #645 containment kept, cross-source duplicate inserts, nothing merged | not reached | PASS (2 -> 3 active rows) |
| A. same-vendor duplicate external id rejected; cross-vendor ids coexist | not reached | PASS (60 ids) |
| A. `internal_ingestion` isolated (anon/authenticated denied, service_role allowed) | not reached | PASS |
| A. raw `job_postings` denied to anon/authenticated; `job_postings_public` masks company/salary/apply url | not reached | PASS |
| A. `saved_jobs` RLS (own rows only; anon none) | not reached | PASS |
| A. `jobs.source_id` is the uuid FK #643 declares | not reached | **FAIL**: `text`, no FK |
| A. second run succeeds and changes nothing | not reached | PASS (51 ms, identical snapshot) |
| B. filename order applies (chain + 16b + #645 D/E/F) | PASS | PASS |
| B. same fixture loads in filename order | **FAIL**: `source_id` is uuid | **FAIL**: `source_id` is uuid |
| B. both orders converge to one schema | **FAIL**: 9 tables, 44 indexes differ | **FAIL**: 1 table (`jobs.source_id`), 0 indexes |
| C. injected failure aborts; DB unchanged; no partial objects; retry matches first run | PASS (failure was the unique index) | PASS (failure was the injection) |
| D. negative control | n/a | exit 1; 5 checks caught all 3 tampers |
| **Total** | **5 passed, 3 failed** | **91 passed, 3 failed** |

The fixture test (`scripts/test-10m-schema-step1-fixtures.ts`, extended here) gives the following results:

- **Repaired migration:** exits 0, including the new TEST 8 (#645 containment).
- **`--negative-control`:** exits 1. Its sabotage grants anon SELECT on `internal_ingestion`, and the existing TEST 3 isolation assertion catches it.
- **Original 16b:** exits 1 at TEST 8, so the test guards the repair.

## Blocker 1 (repaired): 16b re-creates the destructive dedupe index #645 removed

#645 `20261116d` drops `idx_jobs_active_dedupe_hash_uniq` as a destructive index. After #645, `dedupe_hash`
is an advisory similarity hash (`compute_job_dedupe_hash` delegates to `compute_job_similarity_hash_v2`), so the
same posting can be active from two sources. 16b recreates it as `UNIQUE (dedupe_hash) WHERE is_active`.

On populated data that contains such pairs, the index build fails and the whole 16b transaction aborts.
On data without pairs it would succeed and then reject legitimate cross-source rows at ingest time, the same
class of failure as the ingest shard incident fixed in #676.

**Repair:** that one `CREATE UNIQUE INDEX` is removed from 16b and replaced by a comment explaining why. It is
the only change to the migration. `idx_jobs_source_id_source_job_id_uniq` (#645's canonical identity) and the
other indexes are untouched.

## Blocker 2 (NOT repaired, needs a decision): `jobs.source_id` type depends on migration order

- **#645 (`20261116d`)** adds `jobs.source_id text`, and production already has it.
- **16b** declares `ADD COLUMN IF NOT EXISTS source_id uuid REFERENCES internal_ingestion.ingestion_sources(id)`.

What that produces depends on the order:

- **Production order** (16b after #645): the line is a silent no-op. `source_id` stays `text` and the FK #643's design relies on does not exist.
- **Filename order** (fresh environments, CI): 16b creates `source_id uuid` with the FK first, and #645's `ADD COLUMN IF NOT EXISTS` is then skipped. The same data then fails with `column "source_id" is of type uuid but expression is of type text`.

Fresh databases and production would therefore have different identity schemas.

Choosing the canonical type (text vendor key, or uuid FK to `internal_ingestion.ingestion_sources`, with a
migration path for existing text values) is a design decision for the #642/#643/#645 owners. It is out of
scope for a rehearsal repair, so it is reported here and left open.

## Non-blocking findings

- **Redundant unique index.** After 16b, `public.jobs` has two unique structures on `(source, source_job_id)`: the existing `jobs_source_source_job_id_key` and the new `idx_jobs_source_vendor_source_job_id_uniq`. That means two index updates on every job write. Suggest dropping the new one from 16b.
- **`job_postings` dedupe index.** `idx_job_postings_active_dedupe_hash_uniq` puts the same UNIQUE-on-`dedupe_hash` semantics on the new, empty `job_postings` table. It cannot fail at apply time, but once ingestion writes there it would reject cross-source duplicates for the same reason as blocker 1.
- **`idx_companies_category`.** In production order 16b's partial definition is skipped by `IF NOT EXISTS`, so #645's non-partial `(category)` index stays. The two orders converge (0 index differences after the repair). The brief describes a *partial* `companies(category)` index in production; the repo's #645 expects a non-partial one. Which one production really has is UNVERIFIED.

## Runtime and locks (small fixture only)

| Measurement | Value |
|---|---|
| Base chain + fixture setup | about 6.0 s |
| 16b first run (repaired) | 424 ms |
| 16b second run | 51 ms |
| Locks held until COMMIT | `AccessExclusiveLock` on `jobs`, `companies`, `job_descriptions`, `saved_jobs` (from `ALTER TABLE … ADD COLUMN/CONSTRAINT`), plus `ShareLock` and `ShareRowExclusiveLock` (plain `CREATE INDEX`, FK and constraint DDL) |

16b runs as **one transaction** with plain `CREATE INDEX` (not `CONCURRENTLY`). The `AccessExclusiveLock`s
block **reads and writes** on `jobs`, `companies`, `job_descriptions` and `saved_jobs` until COMMIT, so the
live feed, saved jobs and ingestion wait for the whole migration. **This is not zero-downtime.**

At production scale, the production-order transaction builds 7 new indexes on `public.jobs`. These are 5 partial b-trees, the `top_keywords` GIN index and the vendor-key unique index. Three other `jobs` indexes already exist from #645 and are skipped by `IF NOT EXISTS`.
Its duration was **not measured**: 240 rows says nothing about a 10M-row build time.

## Platform stubs and drift shim (UNVERIFIED against production)

**Supabase stubs.** The rehearsal provides:

- the roles `anon`, `authenticated`, `service_role` (BYPASSRLS), `authenticator` and `supabase_admin`;
- `auth.users`, `auth.uid()`, `auth.role()` and `auth.jwt()`;
- the storage schema with a `resumes` bucket and `storage.foldername()`;
- Supabase's default privileges on `public`.

**Extensions.** `pg_trgm`, `pgcrypto` and `unaccent` are real (PGlite contrib). `pg_cron` and `pg_stat_statements` cannot load in WASM. Only their `CREATE EXTENSION` lines are skipped (`20261105c`, `20261108a`), and `cron.schedule` is a recording stub. Cron behavior is unverified.

**Drift shim.** No repo migration creates `jobs.category`, `jobs.country` or the `jobs_public` view before the migrations that use them. Production has them, created outside the migration history. The shim adds exactly those three objects (the view as a prefix-compatible placeholder that `20261010` replaces). There is **no production-shaped schema snapshot in the repo**, so differences between this rebuilt schema and production are unverified.

**PGlite is single-connection.** Lock modes are observed in the migrating session's own `pg_locks` before COMMIT. Concurrent-session blocking and lock-wait timeouts were not exercised.

## Stop conditions (do not apply 20261116b to production while any holds)

1. Blocker 2 is open: `jobs.source_id` type and FK not decided and not consistent across migration orders.
2. The populated-data rehearsal exits non-zero.
3. A production schema snapshot has not been compared against this rebuilt base (drift shim unverified).
4. There is no measured runtime and lock-hold window at production row counts, and no maintenance window or `CONCURRENTLY` plan for the index builds.
5. Any check in scenarios A, C or D regresses (data, `last_seen_at`, grants, RLS, isolation, masking).

## Unresolved gaps

- The blocker 2 decision.
- Index build time and lock duration at 10M rows (unmeasured).
- Production schema snapshot comparison.
- Behavior with real `pg_cron` and `pg_stat_statements`.
- Concurrent-session blocking.
- The redundant `(source, source_job_id)` unique index.
- The `job_postings` dedupe unique index semantics.

None of these were exercised against production.
