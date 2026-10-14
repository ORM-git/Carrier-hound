-- ==============================================================================
-- DO NOT APPLY / REVIEW PENDING — PHASE C: RECONCILED CONCURRENT INDEXES
-- CareerMonke (Carrier-hound) — Database Migration Staged Deployment: Phase C
-- File: supabase/scripts/phase-c-indexes.sql
-- Status: UNDER REVIEW — DO NOT RUN ON LIVE PRODUCTION DATABASE
--
-- RECONCILIATION SUMMARY (BASED ON LIVE SUPABASE VERIFIED FACTS):
-- 1. Existing Indexes on public.jobs (DO NOT RE-ADD):
--    - jobs_pkey, jobs_apply_url_unique, jobs_company_idx, jobs_company_id_idx,
--      jobs_first_seen_idx, jobs_status_idx, jobs_verified_status_idx,
--      jobs_active_verified_idx.
--    - jobs_source_source_job_id_unique is ALREADY PRESENT on live DB! (Omitted).
-- 2. Schema Qualification for pg_trgm:
--    - pg_trgm is installed in schema 'extensions'.
--    - Trigram GIN indexes explicitly qualify 'extensions.gin_trgm_ops' so they succeed
--      regardless of session search_path.
-- 3. Operational Rules:
--    - NO BEGIN / COMMIT transaction blocks.
--    - Run each statement independently in Supabase SQL Editor.
-- ==============================================================================


-- ==============================================================================
-- PART 1: SPECIAL HANDLING — search_vector TSVECTOR COLUMN
-- ==============================================================================
--
-- [ACCESS EXCLUSIVE RISK WARNING]:
-- Adding 'search_vector' as GENERATED ALWAYS AS (...) STORED requires an ACCESS EXCLUSIVE
-- lock and rewrites all 17,426 rows on disk, blocking all reads and writes during generation.
--
-- [RECOMMENDED ZERO-DOWNTIME ALTERNATIVE]:
-- Step 1: Add regular nullable column (instant metadata-only lock):
--   ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS search_vector tsvector;
-- Step 2: Batched backfill via cursor loop:
--   UPDATE public.jobs SET search_vector = (
--     setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
--     setweight(to_tsvector('english', coalesce(company, '')), 'B') ||
--     setweight(to_tsvector('english', coalesce(description, '')), 'C')
--   ) WHERE id > v_last_id AND id <= v_max_id AND search_vector IS NULL;
-- Step 3: Trigger to maintain search_vector automatically on new writes:
--   CREATE OR REPLACE FUNCTION public.jobs_search_vector_update() RETURNS trigger AS $$
--   BEGIN
--     NEW.search_vector :=
--       setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
--       setweight(to_tsvector('english', coalesce(NEW.company, '')), 'B') ||
--       setweight(to_tsvector('english', coalesce(NEW.description, '')), 'C');
--     RETURN NEW;
--   END
--   $$ LANGUAGE plpgsql;
--   CREATE TRIGGER trg_jobs_search_vector_update
--     BEFORE INSERT OR UPDATE OF title, company, description ON public.jobs
--     FOR EACH ROW EXECUTE FUNCTION public.jobs_search_vector_update();
-- Step 4: Build GIN index concurrently (Statement 2.7 below).
-- ==============================================================================


-- ==============================================================================
-- PART 2: TRULY MISSING AUXILIARY INDEXES ON public.jobs (RUN ONE AT A TIME)
-- ==============================================================================
--
-- [QUERY PLANNER PREDICATE ANALYSIS & DRAFT PROPOSAL]:
-- Live facts on query predicates:
-- 1. View 'jobs_public' has: WHERE is_active = true OR status = 'active'
-- 2. Service queries ('service.ts'): WHERE is_active = true AND status = 'active'
-- 3. API queries ('api/jobs.ts'): WHERE status = 'active'
--
-- PLANNER BEHAVIOR:
-- - A query with 'WHERE is_active = true AND status = active' CAN use indexes with:
--     (A) WHERE is_active = true AND status = 'active' (exact match)
--     (B) WHERE status = 'active' (implied: condition is a superset)
-- - A query with 'WHERE status = active' (like api/jobs.ts) CANNOT use indexes with
--   'WHERE is_active = true AND status = active' because the query does not filter on is_active!
-- - A query on bare 'jobs_public' view without additional filters CANNOT use either partial index.
--
-- DRAFT PROPOSAL:
-- Option 1 (Recommended if api/jobs.ts is updated): Standardize ALL partial indexes to:
--   WHERE is_active = true AND status = 'active'
-- Option 2 (Safe for current code): Keep auxiliary filter indexes with:
--   WHERE status = 'active' (so both service.ts and api/jobs.ts can use them).
-- ==============================================================================

-- Statement 2.1: Discovered date partial sort index
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_active_discovered_idx
  ON public.jobs (discovered_at DESC, id DESC)
  WHERE is_active = true AND status = 'active';

-- Statement 2.2: Categories array GIN index
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_categories_gin_idx
  ON public.jobs USING GIN (categories);

-- Statement 2.3: Salary numeric partial index
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_salary_min_idx
  ON public.jobs (salary_min)
  WHERE status = 'active';

-- Statement 2.4: Seniority partial index
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_seniority_idx
  ON public.jobs (seniority)
  WHERE status = 'active';

-- Statement 2.5: Country code partial index
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_country_code_idx
  ON public.jobs (country_code)
  WHERE status = 'active';

-- Statement 2.6: Remote scope partial index
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_remote_scope_idx
  ON public.jobs (remote_scope)
  WHERE status = 'active';

-- Statement 2.7: Search vector GIN index (Run after Step 1 of search_vector)
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_search_vector_idx
  ON public.jobs USING GIN (search_vector);


-- ==============================================================================
-- PART 3: NEW TABLES INDEXES (RUN ONE AT A TIME)
-- ==============================================================================

-- Statement 3.1: tailored_resumes (user_id, job_id)
CREATE INDEX CONCURRENTLY IF NOT EXISTS tailored_resumes_user_job_idx
  ON public.tailored_resumes (user_id, job_id);

-- Statement 3.2: tailored_resumes (user_id, updated_at DESC)
CREATE INDEX CONCURRENTLY IF NOT EXISTS tailored_resumes_user_updated_idx
  ON public.tailored_resumes (user_id, updated_at DESC);

-- Statement 3.3: ai_usage_quotas (user_id, period_date)
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_usage_quotas_user_date_idx
  ON public.ai_usage_quotas (user_id, period_date);

-- Statement 3.4: ai_usage_quotas (user_id)
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_usage_quotas_user_idx
  ON public.ai_usage_quotas (user_id);


-- ==============================================================================
-- PART 4: RECOMMENDED PERFORMANCE INDEXES (RUN ONE AT A TIME)
-- ==============================================================================

-- Statement 4.1: Default active feed & pagination (Q1, Q9a, Q9b, Q10)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_active_first_seen_id
  ON public.jobs (first_seen_at DESC, id DESC)
  WHERE is_active = true AND status = 'active';

-- Statement 4.2: Remote filter + default sort (Q2)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_active_remote_scope_first_seen
  ON public.jobs (remote_scope, first_seen_at DESC, id DESC)
  WHERE is_active = true AND status = 'active';

-- Statement 4.3: Country filter + default sort (Q3)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_active_country_first_seen
  ON public.jobs (country, first_seen_at DESC, id DESC)
  WHERE is_active = true AND status = 'active';

-- Statement 4.4: Category filter + default sort (Q5)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_active_category_first_seen
  ON public.jobs (category, first_seen_at DESC, id DESC)
  WHERE is_active = true AND status = 'active';

-- Statement 4.5: Salary numeric filter + default sort (Q4)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_active_salary_min_first_seen
  ON public.jobs (salary_min, first_seen_at DESC, id DESC)
  WHERE is_active = true AND status = 'active' AND salary_min IS NOT NULL;

-- Statement 4.6: Posted date sort + recency cutoff (Q8)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_active_posted_first_seen
  ON public.jobs (posted_at DESC, first_seen_at DESC, id DESC)
  WHERE is_active = true AND status = 'active';

-- Statement 4.7: Title trigram GIN index (Q6, Q7) - Qualified with extensions.gin_trgm_ops
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_title_trgm
  ON public.jobs USING GIN (title extensions.gin_trgm_ops);

-- Statement 4.8: Company trigram GIN index (Q6, Q7) - Qualified with extensions.gin_trgm_ops
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_company_trgm
  ON public.jobs USING GIN (company extensions.gin_trgm_ops);

-- Statement 4.9: Location trigram GIN index (Q6, Q7) - Qualified with extensions.gin_trgm_ops
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_location_trgm
  ON public.jobs USING GIN (location extensions.gin_trgm_ops);


-- ==============================================================================
-- PART 5: POST-CREATION VERIFICATION
-- ==============================================================================
SELECT
  tablename,
  indexname,
  indisvalid AS is_valid,
  pg_size_pretty(pg_relation_size(quote_ident(indexname)::regclass)) AS index_size
FROM pg_indexes i
JOIN pg_index idx ON idx.indexrelid = quote_ident(i.indexname)::regclass
WHERE schemaname = 'public'
  AND tablename IN ('jobs', 'tailored_resumes', 'ai_usage_quotas')
ORDER BY tablename, indexname;
