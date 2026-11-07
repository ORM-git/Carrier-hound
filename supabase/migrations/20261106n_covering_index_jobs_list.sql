-- ============================================================================
-- Migration: 20261106n_covering_index_jobs_list.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261106n_covering_index_jobs_list
--
-- Database row #12 (Covering indexes (INCLUDE)).
--
-- What this does:
--   Creates jobs_active_list_covering_idx: a partial covering btree for the
--   hottest read in the product, the public jobs list
--   (src/lib/api/jobs.ts CARD_FIELDS over jobs / jobs_public, keyset
--   pagination ORDER BY first_seen_at DESC, id DESC, filter status =
--   'active'). Every selected column is a key column, the predicate column,
--   or an INCLUDE column, so the list page can be served as an index-only
--   scan instead of fetching each row from the heap.
--
-- Why the predicate is status = 'active' and not (is_active, status):
--   the jobs_public view (20261010_lock_paid_jobs_data.sql) filters
--   is_active = true OR status = 'active', so only status = 'active' is
--   implied by every list query. A tighter predicate would make the index
--   unusable for the view path. The predicate is immutable, matching the
--   20261001_filter_upgrades.sql convention.
--
-- Why is_active is an INCLUDE column: the jobs_public view filters
--   is_active = true OR status = 'active'; every column the view's WHERE
--   references must be readable from the index for an index-only scan.
--
-- Why the key order: the app keyset-paginates on (first_seen_at, id)
--   descending (src/lib/api/jobs.ts). The existing partial index
--   jobs_active_discovered_idx is on (discovered_at, id), which cannot
--   serve this ordering.
--
-- Build cost: plain CREATE INDEX takes a share lock on jobs while it
--   builds - run it off-peak. CONCURRENTLY is intentionally not used
--   (house precedent 20261028_ats_board_ingestion.sql: it cannot run
--   inside a migration transaction).
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

CREATE INDEX IF NOT EXISTS jobs_active_list_covering_idx
  ON public.jobs (first_seen_at DESC, id DESC)
  INCLUDE (
    is_active,
    title,
    company,
    location,
    remote,
    remote_scope,
    job_type,
    salary_text,
    last_seen_at,
    posted_at,
    category,
    country,
    country_code,
    apply_url
  )
  WHERE status = 'active';

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.jobs_active_list_covering_idx;
-- ============================================================================
