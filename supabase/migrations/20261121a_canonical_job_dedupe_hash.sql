-- ============================================================================
-- Migration: 20261121a_canonical_job_dedupe_hash.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261121a_canonical_job_dedupe_hash
--
-- Agent Z: Job Dedupe Hash Contract & Production Transition
--
-- Purpose:
--   1. Defines one canonical job dedupe hash contract producing identical output
--      in PostgreSQL SQL, TypeScript ingest, and the Python scraper.
--   2. Ensures public.compute_job_dedupe_hash(company, title, country, location)
--      delegates to the length-framed UTF-8 SHA-256 v2 hash (public.compute_job_similarity_hash_v2).
--   3. Provides public.compute_legacy_job_dedupe_hash for backward-compatibility
--      audits and verification of pre-v2 plain hash rows.
--   4. Provides a bounded, resumable, zero-downtime batch backfill stored procedure
--      (public.backfill_canonical_job_dedupe_hashes) that updates existing active rows
--      in chunks of 500 rows with per-batch COMMIT, FOR UPDATE SKIP LOCKED, and
--      careermonke.skip_touch_last_seen = 'on' to preserve last_seen_at ranking order.
--   5. Retains advisory similarity contract: dedupe_hash has NO unique constraint,
--      no automatic destructive expiration trigger, and no data loss.
--
-- PRE-CHECK SQL (read-only):
--   -- Verify table and dedupe_hash column exist
--   SELECT table_name, column_name, data_type
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'dedupe_hash';
--
--   -- Inspect count of active rows needing canonical dedupe hash update
--   SELECT count(*) AS pending_canonical_backfill
--   FROM public.jobs
--   WHERE is_active = TRUE
--     AND (dedupe_hash IS NULL OR dedupe_hash IS DISTINCT FROM public.compute_job_dedupe_hash(company, title, COALESCE(country_code, country), location));
--
-- VERIFICATION SQL (after applying and running backfill):
--   -- 1. Check canonical function definition delegates to v2
--   SELECT pg_get_functiondef('public.compute_job_dedupe_hash(text,text,text,text)'::regprocedure)
--          LIKE '%compute_job_similarity_hash_v2%' AS delegates_to_v2;
--
--   -- 2. Verify sample test vector matches expected hash
--   SELECT public.compute_job_dedupe_hash('Google Inc.', 'Staff Software Engineer', 'US', 'Mountain View, CA') =
--          '14c69420611ec43c96858f7f83a496f656388c4b698b3bac6d19a8559996939a' AS test_vector_ok;
--
--   -- 3. Check backfill progress
--   SELECT * FROM public.canonical_dedupe_hash_backfill_progress;
--
--   -- 4. Verify 0 pending active rows
--   SELECT count(*) AS remaining_outdated_hashes
--   FROM public.jobs
--   WHERE is_active = TRUE
--     AND (dedupe_hash IS NULL OR dedupe_hash IS DISTINCT FROM public.compute_job_dedupe_hash(company, title, COALESCE(country_code, country), location));
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. PREFLIGHT SAFETY CHECK
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'Preflight check failed: public.jobs table does not exist';
  END IF;
END $$;

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

-- Ensure dedupe_hash column exists
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS dedupe_hash text;

-- ----------------------------------------------------------------------------
-- 2. SELF-CONTAINED CANONICAL v2 SIMILARITY HASH FUNCTION
-- ----------------------------------------------------------------------------
-- Normalization contract matches TypeScript and Python byte-for-byte:
--   - Unicode NFKC normalization + lowercase
--   - Turkish 'İ' (U+0130) and combining dot -> 'i' (U+0069)
--   - Greek final sigma 'ς' (U+03C2 / chr(962)) -> 'σ' (U+03C3 / chr(963))
--   - German sharp s 'ß' (U+00DF / chr(223)) -> 'ss'
--   - Next Line 'U+0085' (chr(133)) -> ' '
--   - Legal entity suffixes stripped on company at word boundaries
--   - All whitespace sequences collapsed to single space ' ' and trimmed
--   - Location takes primary segment before comma
--   - Length-framed UTF-8 serialization:
--       v2|c:{len}:{comp}|t:{len}:{title}|co:{len}:{co}|loc:{len}:{loc}
--   - SHA-256 hex digest via built-in pg_catalog.sha256
CREATE OR REPLACE FUNCTION public.compute_job_similarity_hash_v2(
  p_company text,
  p_title text,
  p_country text,
  p_location text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_company text;
  v_title text;
  v_country text;
  v_location text;
  v_c_len integer;
  v_t_len integer;
  v_co_len integer;
  v_loc_len integer;
  v_payload text;
BEGIN
  -- 1. Normalize company: NFKC, sharp s -> ss, lowercase, edge characters, strip legal suffixes, collapse whitespace
  v_company := lower(COALESCE(normalize(p_company, NFKC), ''));
  v_company := replace(replace(replace(replace(replace(v_company, 'İ', 'i'), 'i' || chr(775), 'i'), chr(133), ' '), chr(962), chr(963)), chr(223), 'ss');
  v_company := regexp_replace(v_company, '\y(inc|llc|ltd|corp|corporation|limited|pvt|private|gmbh|plc|co)\y\.?', ' ', 'gi');
  v_company := trim(regexp_replace(v_company, '[ \t\n\r\f\v\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+', ' ', 'g'));

  -- 2. Normalize title: NFKC, sharp s -> ss, lowercase, edge characters, collapse whitespace (preserves Unicode & punctuation)
  v_title := lower(COALESCE(normalize(p_title, NFKC), ''));
  v_title := replace(replace(replace(replace(replace(v_title, 'İ', 'i'), 'i' || chr(775), 'i'), chr(133), ' '), chr(962), chr(963)), chr(223), 'ss');
  v_title := trim(regexp_replace(v_title, '[ \t\n\r\f\v\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+', ' ', 'g'));

  -- 3. Normalize country: NFKC, sharp s -> ss, lowercase, edge characters, collapse whitespace
  v_country := lower(COALESCE(normalize(p_country, NFKC), ''));
  v_country := replace(replace(replace(replace(replace(v_country, 'İ', 'i'), 'i' || chr(775), 'i'), chr(133), ' '), chr(962), chr(963)), chr(223), 'ss');
  v_country := trim(regexp_replace(v_country, '[ \t\n\r\f\v\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+', ' ', 'g'));

  -- 4. Normalize location: primary city/territory before comma, NFKC, sharp s -> ss, lowercase, edge characters, collapse whitespace
  v_location := lower(COALESCE(normalize(p_location, NFKC), ''));
  v_location := replace(replace(replace(replace(replace(v_location, 'İ', 'i'), 'i' || chr(775), 'i'), chr(133), ' '), chr(962), chr(963)), chr(223), 'ss');
  v_location := split_part(v_location, ',', 1);
  v_location := trim(regexp_replace(v_location, '[ \t\n\r\f\v\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+', ' ', 'g'));

  -- 5. Length framing in UTF-8 octets
  v_c_len := octet_length(convert_to(v_company, 'UTF8'));
  v_t_len := octet_length(convert_to(v_title, 'UTF8'));
  v_co_len := octet_length(convert_to(v_country, 'UTF8'));
  v_loc_len := octet_length(convert_to(v_location, 'UTF8'));

  v_payload := 'v2|c:' || v_c_len || ':' || v_company ||
               '|t:' || v_t_len || ':' || v_title ||
               '|co:' || v_co_len || ':' || v_country ||
               '|loc:' || v_loc_len || ':' || v_location;

  RETURN encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload, 'UTF8')), 'hex');
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. CANONICAL DEDUPE HASH FUNCTION (Points to v2 contract)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_job_dedupe_hash(
  p_company text,
  p_title text,
  p_country text,
  p_location text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT public.compute_job_similarity_hash_v2(p_company, p_title, p_country, p_location);
$$;

-- ----------------------------------------------------------------------------
-- 4. LEGACY PLAIN DEDUPE HASH FUNCTION (Retained for audit and backfill verification)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_legacy_job_dedupe_hash(
  p_company text,
  p_title text,
  p_country text,
  p_location text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_company text;
  v_title text;
  v_country text;
  v_city text;
  v_payload text;
BEGIN
  v_company := lower(trim(COALESCE(p_company, '')));
  v_company := regexp_replace(v_company, '\m(inc|llc|ltd|corp|corporation|limited|pvt|private|gmbh|plc|co)\M\.?', '', 'gi');
  v_company := trim(regexp_replace(v_company, '[^a-z0-9]+', ' ', 'g'));

  v_title := lower(trim(COALESCE(p_title, '')));
  v_title := trim(regexp_replace(v_title, '[^a-z0-9]+', ' ', 'g'));

  v_country := lower(trim(COALESCE(NULLIF(trim(p_country), ''), 'any')));
  v_country := trim(regexp_replace(v_country, '[^a-z0-9]+', ' ', 'g'));

  v_city := lower(trim(split_part(COALESCE(p_location, ''), ',', 1)));
  v_city := trim(regexp_replace(v_city, '[^a-z0-9]+', ' ', 'g'));
  IF v_city = '' THEN
    v_city := 'any';
  END IF;

  v_payload := v_company || '|' || v_title || '|' || v_country || '|' || v_city;
  RETURN encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload, 'UTF8')), 'hex');
END;
$$;

-- Permissions: functions are safe for general invocation
GRANT EXECUTE ON FUNCTION public.compute_job_similarity_hash_v2(text, text, text, text) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.compute_job_dedupe_hash(text, text, text, text) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.compute_legacy_job_dedupe_hash(text, text, text, text) TO authenticated, anon, service_role;

-- ----------------------------------------------------------------------------
-- 5. RESUMABLE BATCH BACKFILL INFRASTRUCTURE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.canonical_dedupe_hash_backfill_progress (
  phase text PRIMARY KEY,
  total_rows_updated integer NOT NULL DEFAULT 0,
  last_batch_rows integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON public.canonical_dedupe_hash_backfill_progress FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.canonical_dedupe_hash_backfill_progress TO service_role;

CREATE OR REPLACE PROCEDURE public.backfill_canonical_job_dedupe_hashes(p_batch_size integer DEFAULT 500)
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch_count integer := 0;
  v_phase_total integer := 0;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 5000 THEN
    RAISE EXCEPTION 'backfill_canonical_job_dedupe_hashes: p_batch_size must be between 1 and 5000, got %', p_batch_size;
  END IF;

  -- Ensure last_seen_at ranking order is never altered during dedupe hash maintenance
  SET careermonke.skip_touch_last_seen = 'on';

  LOOP
    WITH batch AS (
      SELECT id,
        public.compute_job_dedupe_hash(
          company,
          title,
          COALESCE(country_code, country),
          location
        ) AS new_hash
      FROM public.jobs
      WHERE is_active = TRUE
        AND (dedupe_hash IS NULL OR dedupe_hash IS DISTINCT FROM public.compute_job_dedupe_hash(company, title, COALESCE(country_code, country), location))
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.jobs j
    SET dedupe_hash = b.new_hash
    FROM batch b
    WHERE j.id = b.id;

    GET DIAGNOSTICS v_batch_count = ROW_COUNT;
    EXIT WHEN v_batch_count = 0;

    v_phase_total := v_phase_total + v_batch_count;
    INSERT INTO public.canonical_dedupe_hash_backfill_progress (phase, total_rows_updated, last_batch_rows, updated_at)
    VALUES ('jobs_canonical_dedupe_hash', v_phase_total, v_batch_count, now())
    ON CONFLICT (phase) DO UPDATE
    SET total_rows_updated = canonical_dedupe_hash_backfill_progress.total_rows_updated + EXCLUDED.last_batch_rows,
        last_batch_rows = EXCLUDED.last_batch_rows,
        updated_at = EXCLUDED.updated_at;

    COMMIT;
  END LOOP;

  RESET careermonke.skip_touch_last_seen;
END;
$$;

REVOKE ALL ON PROCEDURE public.backfill_canonical_job_dedupe_hashes(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.backfill_canonical_job_dedupe_hashes(integer) TO service_role;

COMMIT;

-- ============================================================================
-- PROD EXECUTION STEP (Run manually after migration commits):
--   CALL public.backfill_canonical_job_dedupe_hashes(500);
--
-- ROLLBACK (Run manually in SQL editor if reverting to legacy plain hash):
--   -- 1. Restore legacy plain compute_job_dedupe_hash definition
--   CREATE OR REPLACE FUNCTION public.compute_job_dedupe_hash(
--     p_company text,
--     p_title text,
--     p_country text,
--     p_location text
--   )
--   RETURNS text
--   LANGUAGE plpgsql
--   IMMUTABLE
--   SET search_path = public
--   AS $$
--   BEGIN
--     RETURN public.compute_legacy_job_dedupe_hash(p_company, p_title, p_country, p_location);
--   END;
--   $$;
--   DROP PROCEDURE IF EXISTS public.backfill_canonical_job_dedupe_hashes(integer);
--   DROP TABLE IF EXISTS public.canonical_dedupe_hash_backfill_progress;
-- ============================================================================
