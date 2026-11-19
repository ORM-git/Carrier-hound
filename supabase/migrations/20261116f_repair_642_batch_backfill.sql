-- ============================================================================
-- Migration: 20261116f_repair_642_batch_backfill.sql
-- STATUS: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261116f_repair_642_batch_backfill
--
-- Purpose:
--   Phase 3 of Repair PR #642: Bounded, Resumable Batch Backfill.
--   - Bounded, resumable batch processing committing after EACH batch (no single DO transaction).
--   - LIMIT 500 loop per batch with FOR UPDATE SKIP LOCKED.
--   - Batched updates for all three target fields:
--       1) public.companies.canonical_domain
--       2) public.jobs.source_priority
--       3) public.jobs.similarity_hash_v2
--   - Tracks progress in public.repair_645_backfill_progress so a rerun resumes automatically.
--   - Sets careermonke.skip_touch_last_seen = 'on' to preserve last_seen_at.
-- ============================================================================

-- 1. Create progress tracking table if it does not already exist
CREATE TABLE IF NOT EXISTS public.repair_645_backfill_progress (
  phase text PRIMARY KEY,
  total_rows_updated integer NOT NULL DEFAULT 0,
  last_batch_rows integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Define resumable batch coordinator procedure
CREATE OR REPLACE PROCEDURE public.repair_645_run_resumable_backfill(p_batch_size integer DEFAULT 500)
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch_count integer := 0;
  v_phase_total integer := 0;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 5000 THEN
    RAISE EXCEPTION 'repair_645_run_resumable_backfill: p_batch_size must be between 1 and 5000, got %', p_batch_size;
  END IF;

  SET careermonke.skip_touch_last_seen = 'on';

  -- Phase 1: Bounded batched backfill of companies.canonical_domain
  LOOP
    WITH batch AS (
      SELECT id, lower(trim(domain)) AS new_canon
      FROM public.companies
      WHERE canonical_domain IS NULL AND domain IS NOT NULL
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.companies c
    SET canonical_domain = b.new_canon
    FROM batch b
    WHERE c.id = b.id;

    GET DIAGNOSTICS v_batch_count = ROW_COUNT;
    EXIT WHEN v_batch_count = 0;

    v_phase_total := v_phase_total + v_batch_count;
    INSERT INTO public.repair_645_backfill_progress (phase, total_rows_updated, last_batch_rows, updated_at)
    VALUES ('companies_canonical_domain', v_phase_total, v_batch_count, now())
    ON CONFLICT (phase) DO UPDATE
    SET total_rows_updated = repair_645_backfill_progress.total_rows_updated + EXCLUDED.last_batch_rows,
        last_batch_rows = EXCLUDED.last_batch_rows,
        updated_at = EXCLUDED.updated_at;

    COMMIT;
  END LOOP;

  -- Phase 2: Bounded batched backfill of jobs.source_priority.
  -- 20261116d adds the column with DEFAULT 2, so existing ATS rows already read 2 (not NULL):
  -- also pick up ATS rows not yet at 1. Only ever upgrades to 1; never downgrades a row.
  v_phase_total := 0;
  LOOP
    WITH batch AS (
      SELECT j.id, p.new_priority
      FROM public.jobs j
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN j.source_type IN ('ats', 'direct', 'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'amazon', 'microsoft')
            OR lower(COALESCE(j.source, '')) IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'workable', 'breezy', 'teamtailor', 'personio', 'bamboohr', 'join')
          THEN 1
          ELSE 2
        END AS new_priority
      ) p
      WHERE j.source_priority IS NULL OR (p.new_priority = 1 AND j.source_priority <> 1)
      LIMIT p_batch_size
      FOR UPDATE OF j SKIP LOCKED
    )
    UPDATE public.jobs j
    SET source_priority = b.new_priority
    FROM batch b
    WHERE j.id = b.id;

    GET DIAGNOSTICS v_batch_count = ROW_COUNT;
    EXIT WHEN v_batch_count = 0;

    v_phase_total := v_phase_total + v_batch_count;
    INSERT INTO public.repair_645_backfill_progress (phase, total_rows_updated, last_batch_rows, updated_at)
    VALUES ('jobs_source_priority', v_phase_total, v_batch_count, now())
    ON CONFLICT (phase) DO UPDATE
    SET total_rows_updated = repair_645_backfill_progress.total_rows_updated + EXCLUDED.last_batch_rows,
        last_batch_rows = EXCLUDED.last_batch_rows,
        updated_at = EXCLUDED.updated_at;

    COMMIT;
  END LOOP;

  -- Phase 3: Bounded batched backfill of jobs.similarity_hash_v2
  v_phase_total := 0;
  LOOP
    WITH batch AS (
      SELECT id,
        public.compute_job_similarity_hash_v2(
          company,
          title,
          COALESCE(country_code, country),
          location
        ) AS new_hash
      FROM public.jobs
      WHERE is_active = TRUE AND similarity_hash_v2 IS NULL
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.jobs j
    SET similarity_hash_v2 = b.new_hash
    FROM batch b
    WHERE j.id = b.id;

    GET DIAGNOSTICS v_batch_count = ROW_COUNT;
    EXIT WHEN v_batch_count = 0;

    v_phase_total := v_phase_total + v_batch_count;
    INSERT INTO public.repair_645_backfill_progress (phase, total_rows_updated, last_batch_rows, updated_at)
    VALUES ('jobs_similarity_hash_v2', v_phase_total, v_batch_count, now())
    ON CONFLICT (phase) DO UPDATE
    SET total_rows_updated = repair_645_backfill_progress.total_rows_updated + EXCLUDED.last_batch_rows,
        last_batch_rows = EXCLUDED.last_batch_rows,
        updated_at = EXCLUDED.updated_at;

    COMMIT;
  END LOOP;

  RESET careermonke.skip_touch_last_seen;
END;
$$;

-- 3. Execute batch backfill in bounded chunks of 500 rows with per-batch commits
CALL public.repair_645_run_resumable_backfill(500);

-- ============================================================================
-- ROLLBACK (Run manually if batch backfill data or tracking must be reset):
--   DROP PROCEDURE IF EXISTS public.repair_645_run_resumable_backfill(integer);
--   DROP TABLE IF EXISTS public.repair_645_backfill_progress;
--   -- NOTE: Backfilled columns (canonical_domain, source_priority, similarity_hash_v2)
--   -- are non-destructive and can safely remain populated. To reset if desired:
--   -- UPDATE public.jobs SET similarity_hash_v2 = NULL;
-- ============================================================================
