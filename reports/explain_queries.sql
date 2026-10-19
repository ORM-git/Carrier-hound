-- =============================================================================
-- CareerMonke Read-Only Query Optimization & EXPLAIN Pack
-- Task: EXPLAIN (ANALYZE, BUFFERS) for core application queries
-- Status: NOT RUN (Local Postgres not provisioned; to be run by database owner on staging/prod)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Query 1: Jobs List (Default active jobs feed sorted by recency)
-- Code References:
--   - src/lib/api/jobs.ts:92-93, 198-201
--   - src/lib/jobs/service.ts:245-250, 324-326
-- Indexed columns used:
--   - status: jobs_active_discovered_idx, jobs_verified_status_idx
--   - is_active: jobs_is_active_idx, jobs_active_discovered_idx
--   - first_seen_at / posted_at: jobs_active_discovered_idx, jobs_posted_at_idx
--   - id: jobs_pkey (PRIMARY KEY), jobs_active_discovered_idx
-- -----------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS)
SELECT
  id,
  title,
  company,
  location,
  remote,
  remote_scope,
  job_type,
  salary_text,
  first_seen_at,
  last_seen_at,
  posted_at,
  status,
  category,
  country,
  apply_url
FROM public.jobs
WHERE status = 'active'
  AND is_active = true
ORDER BY first_seen_at DESC, id DESC
LIMIT 50;


-- -----------------------------------------------------------------------------
-- Query 2: Faceted Filter Query (location, role/category, company, remote, salary)
-- Code References:
--   - src/lib/api/jobs.ts:98-100 (city/location), 102-128 (category), 130-139 (country & remote), 170-193 (salary)
--   - netlify/functions/jobs-search.ts:205-234
-- Indexed columns used:
--   - location: idx_jobs_location_trgm (GIN trgm)
--   - category / categories: jobs_categories_gin_idx (GIN array)
--   - company: idx_jobs_company_trgm (GIN trgm)
--   - remote_scope: jobs_remote_scope_idx
--   - salary_min: jobs_salary_min_idx
--   - country_code: jobs_country_code_idx
-- -----------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS)
SELECT
  id,
  title,
  company,
  location,
  remote,
  remote_scope,
  job_type,
  salary_text,
  salary_min,
  first_seen_at,
  posted_at,
  status,
  category,
  country
FROM public.jobs
WHERE status = 'active'
  AND is_active = true
  AND remote_scope = 'remote'
  AND category = 'engineering'
  AND company = 'Stripe'
  AND country_code = 'US'
  AND salary_min >= 100000
  AND location ILIKE '%San Francisco%'
ORDER BY posted_at DESC, id DESC
LIMIT 50;


-- -----------------------------------------------------------------------------
-- Query 3: Multi-Word Text Search (Trigram and Full-Text Vector)
-- Code References:
--   - src/lib/api/jobs.ts:94-96 (OR title/company ilike)
--   - netlify/functions/jobs-search.ts:236-248 (All-words AND matching across title, company, location)
--   - supabase/migrations/20261001_filter_upgrades.sql:177 (search_vector GIN index)
-- Indexed columns used:
--   - title: idx_jobs_title_trgm (GIN)
--   - company: idx_jobs_company_trgm (GIN)
--   - location: idx_jobs_location_trgm (GIN)
--   - search_vector: jobs_search_vector_idx (GIN tsvector)
-- -----------------------------------------------------------------------------
-- 3a: Trigram ilike text search
EXPLAIN (ANALYZE, BUFFERS)
SELECT
  id,
  title,
  company,
  location,
  remote,
  remote_scope,
  category,
  salary_text,
  posted_at
FROM public.jobs
WHERE status = 'active'
  AND is_active = true
  AND (title ILIKE '%engineer%' OR company ILIKE '%engineer%' OR location ILIKE '%engineer%')
ORDER BY posted_at DESC, id DESC
LIMIT 50;

-- 3b: Full-text search_vector query
EXPLAIN (ANALYZE, BUFFERS)
SELECT
  id,
  title,
  company,
  location,
  remote,
  remote_scope,
  category,
  salary_text,
  posted_at
FROM public.jobs
WHERE status = 'active'
  AND is_active = true
  AND search_vector @@ websearch_to_tsquery('english', 'software engineer')
ORDER BY ts_rank(search_vector, websearch_to_tsquery('english', 'software engineer')) DESC
LIMIT 50;


-- -----------------------------------------------------------------------------
-- Query 4: Job Detail Single Lookup
-- Code References:
--   - src/lib/jobs/service.ts:556-560 (Guest preview lookup by ID)
--   - netlify/functions/jobs-pro.ts:80-95 (Pro unlocked detail lookup by ID)
-- Indexed columns used:
--   - id: jobs_pkey (B-tree primary key unique index)
-- -----------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS)
SELECT
  id,
  title,
  company,
  location,
  category,
  remote,
  remote_scope,
  remote_eligibility,
  country_code,
  job_type,
  verified,
  posted_at,
  created_at,
  description,
  apply_url,
  salary_text
FROM public.jobs
WHERE id = 'a0000000-0000-0000-0000-000000000001'
LIMIT 1;
