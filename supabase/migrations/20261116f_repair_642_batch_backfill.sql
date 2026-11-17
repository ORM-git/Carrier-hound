-- ============================================================================
-- Migration: 20261116f_repair_642_batch_backfill.sql
-- STATUS: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261116f_repair_642_batch_backfill
--
-- Purpose:
--   Phase 3 of Repair PR #642: Bounded, Resumable Batch Backfill.
--   - Sets careermonke.skip_touch_last_seen = 'on' to preserve last_seen_at.
--   - Updates companies.canonical_domain and jobs.source_priority safely.
--   - Uses keyset / cursor loop with LIMIT 500 FOR UPDATE SKIP LOCKED to backfill
--     similarity_hash_v2 without table-level locking or ranking corruption.
-- ============================================================================

SET LOCAL lock_timeout = '3s';
SET careermonke.skip_touch_last_seen = 'on';

-- 1. Backfill companies canonical_domain
UPDATE public.companies
SET canonical_domain = lower(trim(domain))
WHERE canonical_domain IS NULL AND domain IS NOT NULL;

-- 2. Backfill jobs source_priority based on source_type or source metadata
UPDATE public.jobs
SET source_priority = CASE
  WHEN source_type IN ('ats', 'direct', 'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'amazon', 'microsoft')
    OR lower(COALESCE(source, '')) IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'workable', 'breezy', 'teamtailor', 'personio', 'bamboohr', 'join')
  THEN 1
  ELSE 2
END
WHERE source_priority IS NULL;

-- 3. Resumable batch backfill of similarity_hash_v2 in bounded chunks of 500 rows
DO $$
DECLARE
  v_batch_size constant integer := 500;
  v_updated integer := 0;
  v_total integer := 0;
BEGIN
  LOOP
    UPDATE public.jobs
    SET similarity_hash_v2 = public.compute_job_similarity_hash_v2(
      company,
      title,
      COALESCE(country_code, country),
      location
    )
    WHERE id IN (
      SELECT id
      FROM public.jobs
      WHERE is_active = TRUE AND similarity_hash_v2 IS NULL
      LIMIT v_batch_size
      FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    v_total := v_total + v_updated;
    EXIT WHEN v_updated = 0;
    RAISE NOTICE 'Backfilled % similarity hashes (total: %)...', v_updated, v_total;
  END LOOP;
  RAISE NOTICE 'Batch backfill complete. Total backfilled: %', v_total;
END $$;

RESET careermonke.skip_touch_last_seen;

-- ============================================================================
-- ROLLBACK (Run manually if batch backfill data must be reset):
--   -- NOTE: Backfilled columns (canonical_domain, source_priority, similarity_hash_v2)
--   -- are non-destructive and can safely remain populated. To reset if desired:
--   -- UPDATE public.jobs SET similarity_hash_v2 = NULL;
-- ============================================================================
