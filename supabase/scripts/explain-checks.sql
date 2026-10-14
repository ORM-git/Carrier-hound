-- ==============================================================================
-- CareerMonke (Carrier-hound) — Read-Only DB Index & Query Plan Verification
-- File: supabase/scripts/explain-checks.sql
-- Safety: Strictly READ-ONLY (EXPLAIN ANALYZE on SELECT statements + catalog SELECTs)
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. JOBS LIST DEFAULT (Active jobs, default sort, Page 1)
-- ------------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, company, location, remote, remote_scope, job_type, salary_text,
       first_seen_at, last_seen_at, posted_at, status, category, country, apply_url
FROM public.jobs
WHERE is_active = true
  AND status = 'active'
ORDER BY first_seen_at DESC, id DESC
LIMIT 10 OFFSET 0;

-- ------------------------------------------------------------------------------
-- 2. REMOTE FILTER (remote_scope = 'remote')
-- ------------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, company, location, remote, remote_scope, job_type, salary_text,
       first_seen_at, last_seen_at, posted_at, status, category, country, apply_url
FROM public.jobs
WHERE is_active = true
  AND status = 'active'
  AND remote_scope = 'remote'
ORDER BY first_seen_at DESC, id DESC
LIMIT 10 OFFSET 0;

-- ------------------------------------------------------------------------------
-- 3. COUNTRY FILTER (country = 'United States')
-- ------------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, company, location, remote, remote_scope, job_type, salary_text,
       first_seen_at, last_seen_at, posted_at, status, category, country, apply_url
FROM public.jobs
WHERE is_active = true
  AND status = 'active'
  AND country = 'United States'
ORDER BY first_seen_at DESC, id DESC
LIMIT 10 OFFSET 0;

-- ------------------------------------------------------------------------------
-- 4. SALARY FILTER ($150k+ via salary_text prefix OR clauses / salary_min)
-- ------------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, company, location, remote, remote_scope, job_type, salary_text,
       first_seen_at, last_seen_at, posted_at, status, category, country, apply_url
FROM public.jobs
WHERE is_active = true
  AND status = 'active'
  AND (
    salary_min >= 150000
    OR salary_text ILIKE '$150%'
    OR salary_text ILIKE '$160%'
    OR salary_text ILIKE '$170%'
    OR salary_text ILIKE '$180%'
    OR salary_text ILIKE '$190%'
    OR salary_text ILIKE '$200%'
    OR salary_text ILIKE '$250%'
    OR salary_text ILIKE '$300%'
  )
ORDER BY first_seen_at DESC, id DESC
LIMIT 10 OFFSET 0;

-- ------------------------------------------------------------------------------
-- 5. CATEGORY FILTER (category IN expanded taxonomy slugs)
-- ------------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, company, location, remote, remote_scope, job_type, salary_text,
       first_seen_at, last_seen_at, posted_at, status, category, country, apply_url
FROM public.jobs
WHERE is_active = true
  AND status = 'active'
  AND category IN ('software', 'engineering', 'backend', 'frontend', 'fullstack')
ORDER BY first_seen_at DESC, id DESC
LIMIT 10 OFFSET 0;

-- ------------------------------------------------------------------------------
-- 6. MULTI-WORD SEARCH (AND across words: "Senior Procurement")
-- ------------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, company, location, remote, remote_scope, job_type, salary_text,
       first_seen_at, last_seen_at, posted_at, status, category, country, apply_url
FROM public.jobs
WHERE is_active = true
  AND status = 'active'
  AND (
    title ILIKE '%Senior%'
    OR company ILIKE '%Senior%'
    OR category ILIKE '%Senior%'
    OR location ILIKE '%Senior%'
  )
  AND (
    title ILIKE '%Procurement%'
    OR company ILIKE '%Procurement%'
    OR category ILIKE '%Procurement%'
    OR location ILIKE '%Procurement%'
  )
ORDER BY first_seen_at DESC, id DESC
LIMIT 10 OFFSET 0;

-- ------------------------------------------------------------------------------
-- 7. COMPANY SEARCH (q = 'OpenAI' across title / company)
-- ------------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, company, location, remote, remote_scope, job_type, salary_text,
       first_seen_at, last_seen_at, posted_at, status, category, country, apply_url
FROM public.jobs
WHERE is_active = true
  AND status = 'active'
  AND (title ILIKE '%OpenAI%' OR company ILIKE '%OpenAI%')
ORDER BY first_seen_at DESC, id DESC
LIMIT 10 OFFSET 0;

-- ------------------------------------------------------------------------------
-- 8. DATE SORT & RECENCY CUTOFF (Last 7 days sorted by posted_at / first_seen_at)
-- ------------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, company, location, remote, remote_scope, job_type, salary_text,
       first_seen_at, last_seen_at, posted_at, status, category, country, apply_url
FROM public.jobs
WHERE is_active = true
  AND status = 'active'
  AND first_seen_at >= NOW() - INTERVAL '7 days'
ORDER BY posted_at DESC, first_seen_at DESC, id DESC
LIMIT 10 OFFSET 0;

-- ------------------------------------------------------------------------------
-- 9a. PAGINATION — PAGE 1 (LIMIT 10 OFFSET 0)
-- ------------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, location, remote, remote_scope, remote_eligibility, job_type,
       category, country, country_code, seniority, first_seen_at, posted_at, status, is_active
FROM public.jobs_public
ORDER BY first_seen_at DESC, id DESC
LIMIT 10 OFFSET 0;

-- ------------------------------------------------------------------------------
-- 9b. PAGINATION — PAGE 500 (LIMIT 10 OFFSET 4990)
-- ------------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, location, remote, remote_scope, remote_eligibility, job_type,
       category, country, country_code, seniority, first_seen_at, posted_at, status, is_active
FROM public.jobs_public
ORDER BY first_seen_at DESC, id DESC
LIMIT 10 OFFSET 4990;

-- ------------------------------------------------------------------------------
-- 10. COUNT QUERY (Exact active corpus count)
-- ------------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS)
SELECT COUNT(*)
FROM public.jobs
WHERE is_active = true
  AND status = 'active';

-- ------------------------------------------------------------------------------
-- 11. EXISTING & UNUSED INDEXES AUDIT (pg_stat_user_indexes + pg_indexes)
-- ------------------------------------------------------------------------------
SELECT
  s.schemaname,
  s.relname AS table_name,
  s.indexrelname AS index_name,
  s.idx_scan,
  s.idx_tup_read,
  s.idx_tup_fetch,
  pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size,
  i.indexdef
FROM pg_stat_user_indexes s
JOIN pg_indexes i
  ON i.schemaname = s.schemaname
 AND i.tablename = s.relname
 AND i.indexname = s.indexrelname
WHERE s.schemaname = 'public'
ORDER BY s.relname ASC, s.idx_scan ASC, s.indexrelname ASC;

-- ------------------------------------------------------------------------------
-- 12. APPLIED MIGRATIONS CHECK (supabase_migrations.schema_migrations)
-- ------------------------------------------------------------------------------
SELECT version, name, statements
FROM supabase_migrations.schema_migrations
ORDER BY version ASC;
