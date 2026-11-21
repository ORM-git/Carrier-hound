# Canonical Job Dedupe Hash Contract & Transition Specification

**Authoritative Hash Version**: `v2`  
**Algorithm**: `SHA-256` (64 lowercase hex characters)  
**Status**: Contract Active; Cross-Runtime Verified (PostgreSQL SQL, TypeScript Ingest, Python Scraper)

---

## 1. Specification: The Canonical Dedupe Hash Contract

The canonical dedupe hash `dedupe_hash` is computed identically across all three system runtimes:
- **TypeScript**: `computeDedupeHash(company, title, country, location)` in `src/lib/jobs/highVolumeEnrichment.ts`
- **Python**: `compute_dedupe_hash(company, title, country, location)` in `scripts/scraper/enrichment.py`
- **PostgreSQL**: `public.compute_job_dedupe_hash(company, title, country, location)` (delegates to `public.compute_job_similarity_hash_v2`) in `supabase/migrations/20261121a_canonical_job_dedupe_hash.sql`

### Input Fields & Extraction
1. **`company`**: Employer name string.
2. **`title`**: Role title string.
3. **`country`**: Country name or ISO code. If null/undefined, defaults to empty string `""`.
4. **`location`**: Primary territory or city before any comma (`split(',')[0]`). If null/undefined, defaults to empty string `""`.

### Normalization Rules (in strict execution order)
1. **Unicode NFKC & Lowercase**:
   - `NFKC` normalization and case-folding applied to all fields.
   - Non-Latin scripts (Japanese Kanji/Kana, Hindi, Chinese, Cyrillic, etc.) and punctuation are preserved (never stripped).
2. **Parity Replacements**:
   - German sharp s: `ß` (`U+00DF`) -> `ss`
   - Turkish dotted uppercase: `İ` (`U+0130`) and combining dot `i\u0307` -> `i` (`U+0069`)
   - Greek final sigma: `ς` (`U+03C2`) -> small sigma `σ` (`U+03C3`)
   - Next Line control: `U+0085` (`chr(133)`) -> single space `' '`
3. **Legal Entity Suffix Stripping (`company` only)**:
   - Suffixes removed only at Unicode-aware word boundaries:
     `inc`, `llc`, `ltd`, `corp`, `corporation`, `limited`, `pvt`, `private`, `gmbh`, `plc`, `co` (with optional trailing period).
   - Attached suffixes in other scripts (e.g., `Company Inc東京`) are preserved.
4. **Whitespace Normalization**:
   - Matches regex `[ \t\n\r\f\v\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+`.
   - Collapses matches to a single ASCII space `' '`.
   - Strips leading and trailing whitespace.
5. **Length-Framed UTF-8 Serialization**:
   - Prevents delimiter collision (e.g. titles containing `|`, `:`, `/`):
     ```
     v2|c:{c_len}:{company}|t:{t_len}:{title}|co:{co_len}:{country}|loc:{loc_len}:{location}
     ```
   - Length prefixes `{len}` are UTF-8 byte lengths (octets).
6. **Hashing**:
   - Cryptographic `SHA-256` digest over UTF-8 payload, formatted as 64 lowercase hexadecimal characters.

---

## 2. Shared Test Vectors

`scripts/fixtures/job_dedupe_test_vectors.json` holds 25 vectors. Each has `expected_payload`, `expected_hash` (v2) and
`expected_legacy_hash` (the pre-v2 hash exactly as the old TypeScript ingest wrote it; audit-only).

Coverage: ASCII roles with legal suffixes; empty country/location; Japanese, Hindi, Chinese, Greek, Hungarian; Turkish
`İ`, German `ß`, Greek `ς`; full-width NFKC input; `/` vs `-` vs `:` title punctuation (incident #642).

`scripts/test-canonical-dedupe-hash.ts` (also run by `npm run test:identity` and the suite runner) checks every vector
for v2 **and** legacy in TypeScript, Python and SQL (PGlite). `scripts/scraper/test_identity_contract.py` also loads
the fixture. The TS unit test `highVolumeEnrichment.test.ts` does not; the runner above is the TS parity check.

## 3. Database Locale Requirement

The SQL hash uses `lower()`, which follows the database's ctype. Measured on real PostgreSQL 17.12:

| Database locale | v2 vectors | legacy vectors |
| --- | --- | --- |
| ICU `und` | 25/25 | 25/25 |
| libc `en-US` (Windows) | 25/25 | 25/25 |
| `C` (ASCII-only `lower()`) | 22/25 | 25/25 |

The migration preflight therefore refuses to apply when `lower()` does not fold non-ASCII. glibc `en_US.UTF-8` (the
usual Supabase locale) could not be tested on the development machine; the read-only precheck in section 7 confirms
it on the target before anything is applied. Legacy SQL expands `İ` before `lower()` so libc simple case mapping and
ICU/JS/Python full case mapping give the same legacy hash.

## 4. Advisory Invariant

`dedupe_hash` is advisory only:
- Write identity is `(source_id, source_job_id)` (unique indexes); nothing upserts on `dedupe_hash`.
- No unique constraint on `jobs.dedupe_hash`; no trigger or function merges, deletes or expires rows by hash.
- Two boards with the same hash coexist.

## 5. Backfill Procedure

`CALL public.backfill_canonical_job_dedupe_hashes(500);` (service_role / owner only; `anon`/`authenticated` have no
EXECUTE and no access to the progress table).

- Walks `jobs` in primary-key windows of `p_batch_size`, COMMITs after each window and stores the cursor
  (`last_id`) in `public.canonical_dedupe_hash_backfill_progress`. Work per window is bounded; a cancelled or failed
  run resumes from the last committed window.
- Updates only ACTIVE rows whose hash differs. A second pass rewrites nothing.
- `careermonke.skip_touch_last_seen` and `lock_timeout = 2s` are transaction-local, re-set per window: nothing leaks
  into a pooled session after an error, and `last_seen_at` never moves.
- No `SKIP LOCKED`: a row held by a writer makes the window wait up to 2s, then the CALL fails loudly; re-run it.
- Concurrent CALLs are serialized window by window by a transaction-scoped advisory lock.
- Must be its own top-level statement (it commits per window; inside `BEGIN ... COMMIT` PostgreSQL refuses it).
- A `statement_timeout` on the session cuts the CALL but keeps committed windows; re-run until `completed_at` is set.

Local evidence (disposable PostgreSQL 17.12, full migration chain replayed, ICU locale, 6,000 seeded rows):
27/27 checks pass: privileges, refusal inside a transaction block, cancel mid-run and resume, idempotent re-run (no row
versions rewritten), unchanged row count / `last_seen_at` / `is_active` / `status` / all other columns, inactive
rows and `companies` untouched, held row not skipped, two concurrent runs, statement_timeout, no setting leak.
Full-pass timing on the dev machine: 10k rows 2.7s, 40k rows 9.9s (the previous rescanning design: 7.2s, 70.1s).
These are laptop figures, not production capacity.

## 6. Python Ingestion CLIs (production ingestion stays OFF)

Both `python -m scripts.scraper.run_ingestion` and `python -m scripts.scraper.engine`:
- Default to DRY-RUN when no mode flag is given (announced on stderr). `--dry-run` is explicit and optional.
- Write only with `--write-to-database`, which is mutually exclusive with `--dry-run`.
- In write mode, credentials are checked before any network call: an `https` Supabase URL and a well-formed service
  key, or the run exits 2 with a message that never contains the values.
- Dry-run never constructs the Supabase writer: no company/job upserts, expiry, cleanup or write RPCs.
- `--source greenhouse:stripe` schedules exactly that one board (case/space-insensitive); bare words such as
  `greenhouse` still mean "all greenhouse boards", so use the exact `ats:slug` id for single-board runs.

Covered by `scripts/scraper/test_cli_safety.py` (fake credentials present, mocked transport, real seeds file).

## 7. Rollout (owner-run; nothing below has been executed)

| Stage | State |
| --- | --- |
| Code ready (this PR) | yes |
| SQL applied in production | **no** |
| One-board dry run completed | **no** |
| Python production ingestion enabled | **no** (stays OFF) |

### 7.1 Read-only prechecks (NOT APPLIED)
```sql
-- a) database lower() folds non-ASCII (must be true; the migration refuses otherwise)
SELECT lower(chr(931) || chr(196)) = chr(963) || chr(228) AS unicode_lower_ok,
       (SELECT datctype FROM pg_database WHERE datname = current_database()) AS ctype;
-- b) prerequisites from 20261116d are live
SELECT to_regprocedure('public.compute_job_similarity_hash_v2(text,text,text,text)') IS NOT NULL AS has_v2,
       pg_get_functiondef('public.compute_job_dedupe_hash(text,text,text,text)'::regprocedure) LIKE '%similarity_hash_v2%' AS dedupe_is_v2,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'jobs_touch_last_seen' AND tgrelid = 'public.jobs'::regclass) AS has_freshness_trigger;
-- c) not already applied / no leftover objects
SELECT to_regclass('public.canonical_dedupe_hash_backfill_progress') AS progress_table,
       to_regprocedure('public.backfill_canonical_job_dedupe_hashes(integer)') AS backfill_proc;
SELECT * FROM public.schema_migrations WHERE filename LIKE '20261121a_canonical%';
-- d) size of the work (bounded per window; this full count may itself be slow on a large table)
SELECT count(*) FILTER (WHERE is_active) AS active_rows, count(*) AS all_rows FROM public.jobs;
```

### 7.2 Application order (NOT APPLIED)
1. Deploy the TypeScript change (new rows get v2); independent of SQL.
2. Run `supabase/migrations/20261121a_canonical_job_dedupe_hash.sql` as one SQL-editor run.
3. Record it: `node scripts/record-migration.cjs 20261121a_canonical_job_dedupe_hash`.
4. `CALL public.backfill_canonical_job_dedupe_hashes(500);` as its own statement; repeat until 7.3 b shows `completed_at`.

### 7.3 Verification (NOT APPLIED)
```sql
-- a) shared vector spot-check (vec_01)
SELECT public.compute_job_dedupe_hash('Google Inc.', 'Staff Software Engineer', 'US', 'Mountain View, CA')
     = '14c69420611ec43c96858f7f83a496f656388c4b698b3bac6d19a8559996939a' AS v2_ok;
-- b) progress
SELECT phase, last_id, batches, total_rows_updated, passes_completed, completed_at FROM public.canonical_dedupe_hash_backfill_progress;
-- c) remaining active rows with a non-canonical hash (expect 0; full scan)
SELECT count(*) FROM public.jobs
WHERE is_active AND dedupe_hash IS DISTINCT FROM public.compute_job_dedupe_hash(company, title, COALESCE(country_code, country), location);
-- d) no anon/authenticated access
SELECT has_function_privilege('anon', 'public.backfill_canonical_job_dedupe_hashes(integer)', 'EXECUTE') AS anon_exec,
       has_table_privilege('authenticated', 'public.canonical_dedupe_hash_backfill_progress', 'SELECT') AS auth_read;
```

### 7.4 Rollback notes (NOT APPLIED)
- The backfill only rewrites advisory `dedupe_hash` on active rows; nothing reads it for identity, so there is no data
  to restore. Old legacy values can be recomputed with `public.compute_legacy_job_dedupe_hash`.
- To stop: cancel the CALL; committed windows stay, nothing else changes.
- To remove the new objects: `DROP PROCEDURE IF EXISTS public.backfill_canonical_job_dedupe_hashes(integer);`
  `DROP TABLE IF EXISTS public.canonical_dedupe_hash_backfill_progress;`
  `DROP FUNCTION IF EXISTS public.compute_legacy_job_dedupe_hash(text,text,text,text);`
- Do not point `compute_job_dedupe_hash` back to legacy while the TS/Python writers produce v2.

### 7.5 One-board dry run (for a later, separately approved run)
```
python -m scripts.scraper.run_ingestion --dry-run --source greenhouse:stripe
```
`greenhouse:stripe` is a real board id from `scripts/scraper/company_seeds.json`. It fetches one public board, writes
nothing, and needs no credentials.

## 8. Source-Specific Keys Still Required

Names only; values live in the deployment's secret store and are never committed:
- `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`: Layer 3 Adzuna only; without them that source returns no jobs (skipped).
- `NEXT_PUBLIC_SUPABASE_URL` (or `SUPABASE_URL`) and `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SERVICE_KEY`): only
  for `--write-to-database`; not needed for dry runs.
- Greenhouse, Lever, Ashby, SmartRecruiters, Workday CXS, Amazon, Microsoft, Arbeitnow, JobSpy: public, no key.
