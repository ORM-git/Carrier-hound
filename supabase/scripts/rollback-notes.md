# Database Migration Rollback & Recovery Guide
**Project:** CareerMonke (`Carrier-hound`)  
**Status:** DRAFT / REVIEW PENDING — OPERATIONAL RUNBOOK  
**Applicable Scripts:** `phase-a-schema.sql`, `phase-b-backfill.sql`, `phase-c-indexes.sql`

---

## 1. Safety Prerequisites Before Any Migration Phase
1. **Database Snapshot / Export:**
   - Confirm a full database snapshot exists in the Supabase Dashboard (`Backups` tab).
   - Alternatively, capture a pg_dump schema+data export before Phase A.
2. **Review Preflight Report:**
   - Ensure `supabase/scripts/preflight-readonly.sql` was executed and all checks passed without any STOP conditions.

---

## 2. Phase A Rollback: Schema DDL & Tables

### What Can Be Cleanly Reversed:
All Phase A operations are DDL modifications that can be dropped or reversed with exact SQL commands.

```sql
-- 1. Drop new feature tables (if created and no production data needs preservation)
DROP TABLE IF EXISTS public.ai_usage_quotas CASCADE;
DROP TABLE IF EXISTS public.tailored_resumes CASCADE;

-- 2. Drop CHECK constraints on public.jobs
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_period_check;
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_seniority_check;
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_remote_eligibility_check;

-- 3. (Optional) Drop newly added columns on public.jobs
-- Note: Leaving nullable columns in place is usually harmless. If full reversal is required:
ALTER TABLE public.jobs
  DROP COLUMN IF EXISTS discovered_at,
  DROP COLUMN IF EXISTS expires_at,
  DROP COLUMN IF EXISTS salary_min,
  DROP COLUMN IF EXISTS salary_max,
  DROP COLUMN IF EXISTS currency,
  DROP COLUMN IF EXISTS period,
  DROP COLUMN IF EXISTS seniority,
  DROP COLUMN IF EXISTS remote_eligibility,
  DROP COLUMN IF EXISTS eligible_countries,
  DROP COLUMN IF EXISTS country_code,
  DROP COLUMN IF EXISTS categories,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS source_job_id;

-- 4. Permissions & Extensions:
-- Extensions (pg_trgm, unaccent) should NOT be dropped if other functions depend on them.
-- RLS lock on raw public.jobs SHOULD REMAIN (re-opening raw jobs to anon violates paid-data lock).
```

### What Cannot Be Undone:
* If live users create records in `tailored_resumes` or `ai_usage_quotas` before rollback, dropping those tables will permanently destroy those user records unless exported first via `COPY public.tailored_resumes TO ...`.

---

## 3. Phase B Rollback: Data Backfills

### Critical Warning:
Data updates modify existing table cells in place (`NULL` -> populated values). Once an `UPDATE` commits, PostgreSQL does not maintain an in-place undo log.

### What CANNOT Be Automatically Undone:
* **Cell-level prior state:** The exact prior NULL vs populated distribution cannot be magically separated without a pre-migration snapshot or audit log.
* Specifically:
  - If a row previously had `country_code IS NULL` and received `'US'`, there is no flag marking that it was updated by the backfill vs an external ingest.
  - If `remote_eligibility` was backfilled to `'country_restricted'` or `'worldwide'`, rolling back by setting all rows to `'unknown'` would overwrite any legitimate ingest values.

### Rollback Strategies for Phase B:
1. **Best Practice (Full Restore):** Restore from the pre-migration snapshot taken prior to Phase B.
2. **Targeted Reset (If Snapshot Restore is Undesirable):**
   ```sql
   -- Reset column default for discovered_at
   ALTER TABLE public.jobs ALTER COLUMN discovered_at DROP DEFAULT;

   -- (Optional) If columns were newly added in Phase A, simply dropping the columns
   -- (as shown in Phase A rollback) instantly discards all backfilled data.
   ```

---

## 4. Phase C Rollback: Indexes & Search Vector

### What Can Be Cleanly Reversed:
All index additions can be rolled back online with zero downtime using `DROP INDEX CONCURRENTLY`.

```sql
-- 1. Drop Query Performance Indexes (Online / Zero-Downtime)
DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_first_seen_id;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_remote_scope_first_seen;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_country_first_seen;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_category_first_seen;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_salary_min_first_seen;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_posted_first_seen;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_title_trgm;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_company_trgm;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_location_trgm;

-- 2. Drop Filter & Taxonomy Indexes
DROP INDEX CONCURRENTLY IF EXISTS public.jobs_active_discovered_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.jobs_categories_gin_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.jobs_salary_min_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.jobs_seniority_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.jobs_country_code_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.jobs_remote_scope_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.jobs_source_source_job_id_unique;
DROP INDEX CONCURRENTLY IF EXISTS public.jobs_search_vector_idx;

-- 3. Drop New Table Indexes
DROP INDEX CONCURRENTLY IF EXISTS public.tailored_resumes_user_job_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.tailored_resumes_user_updated_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.ai_usage_quotas_user_date_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.ai_usage_quotas_user_idx;

-- 4. Rollback Search Vector Trigger / Column (If installed)
DROP TRIGGER IF EXISTS trg_jobs_search_vector_update ON public.jobs;
DROP FUNCTION IF EXISTS public.jobs_search_vector_update();
ALTER TABLE public.jobs DROP COLUMN IF EXISTS search_vector;
```

### What Cannot Be Undone:
* Disk I/O and CPU spent building the indexes cannot be recovered.
* Any temporary queries that relied on the indexes will revert to sequential scans.
