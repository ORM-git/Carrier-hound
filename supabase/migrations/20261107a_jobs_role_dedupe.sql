-- ============================================================================
-- Migration: 20261107a_jobs_role_dedupe.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261107a_jobs_role_dedupe
--
-- Backend sheet rank 98 (Dedup of ingested jobs): "Ingestion dedupe exists;
-- cross-board duplicates still possible."
--
-- Why: the unique constraints on jobs (source + source_job_id, apply_url) only
-- stop exact repeats. The same role (company + title + location) published by
-- two sources has different source ids and different apply URLs, so both rows
-- stay active. scripts/board-ingest.ts already skips such roles in application
-- code; there is no DB-side view or cleanup for rows that got in through other
-- paths or before that check existed.
--
-- What this does (additive; nothing is deleted, nothing changes until run):
--   1. public.jobs_slug(text) and public.jobs_role_key(company, title,
--      location): IMMUTABLE SQL mirrors of scripts/utils/sanitizer.ts slugify
--      and the board-ingest roleKey (company::title::location, empty location
--      = 'unspecified'). ASCII word characters only, like the JS regex.
--   2. jobs_role_key_active_idx: plain (non-unique) expression index over
--      active rows so duplicate lookups do not scan the table. Plain CREATE
--      INDEX takes a short write lock on jobs; run in a quiet window, or run
--      the CONCURRENTLY form from the comment (cannot be inside a transaction).
--   3. public.jobs_duplicate_roles: read-only view listing active role keys
--      with more than one row (service_role only).
--   4. public.dedupe_jobs_by_role(p_apply boolean DEFAULT false): picks one
--      keeper per active role key (verified first, then earliest first_seen_at,
--      then id) and reports the rest. Default is a DRY RUN that only returns
--      the plan. With p_apply = true it sets the non-keepers to
--      is_active = false, status = 'expired' (a value the status CHECK allows).
--      It never deletes rows. SECURITY DEFINER, pinned search_path,
--      service_role only.
--
-- Not enforced as a UNIQUE index on purpose: existing duplicates would make it
-- fail, and a hard constraint would reject legitimate same-title roles in one
-- city. Prevention stays in the ingest code (scripts/ingest.ts cross-source
-- check + board-ingest roleKey); this migration is the DB-side audit and
-- cleanup path.
--
-- Caveat (owner to confirm): a later ingest upsert for a deactivated row's
-- (source, source_job_id) sets it active again; the ingest-side check is what
-- keeps it from coming back as a duplicate.
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.jobs_slug(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(lower(coalesce(p_text, '')), '[^a-zA-Z0-9_[:space:]-]', '', 'g'),
      '[[:space:]_-]+', '-', 'g'
    ),
    '-'
  );
$$;

CREATE OR REPLACE FUNCTION public.jobs_role_key(p_company text, p_title text, p_location text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT public.jobs_slug(p_company) || '::' || public.jobs_slug(p_title) || '::'
         || public.jobs_slug(coalesce(nullif(p_location, ''), 'unspecified'));
$$;

CREATE INDEX IF NOT EXISTS jobs_role_key_active_idx
  ON public.jobs (public.jobs_role_key(company, title, location))
  WHERE is_active IS TRUE;
-- CONCURRENTLY form (run alone, outside a transaction, if write locks matter):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_role_key_active_idx
--     ON public.jobs (public.jobs_role_key(company, title, location))
--     WHERE is_active IS TRUE;

CREATE OR REPLACE VIEW public.jobs_duplicate_roles
WITH (security_invoker = true) AS
SELECT
  public.jobs_role_key(company, title, location) AS role_key,
  count(*)                                       AS active_rows,
  array_agg(id ORDER BY first_seen_at NULLS LAST, id) AS job_ids,
  array_agg(DISTINCT source)                     AS sources
FROM public.jobs
WHERE is_active IS TRUE
GROUP BY public.jobs_role_key(company, title, location)
HAVING count(*) > 1;

REVOKE ALL ON public.jobs_duplicate_roles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.jobs_duplicate_roles TO service_role;

CREATE OR REPLACE FUNCTION public.dedupe_jobs_by_role(p_apply boolean DEFAULT false)
RETURNS TABLE (role_key text, kept_id uuid, duplicate_id uuid, applied boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_apply IS TRUE THEN
    RETURN QUERY
    WITH ranked AS (
      SELECT j.id,
             public.jobs_role_key(j.company, j.title, j.location) AS rk,
             row_number() OVER (
               PARTITION BY public.jobs_role_key(j.company, j.title, j.location)
               ORDER BY coalesce(j.verified, false) DESC, j.first_seen_at ASC NULLS LAST, j.id
             ) AS rn
      FROM public.jobs j
      WHERE j.is_active IS TRUE
    ),
    keepers AS (SELECT r.rk, r.id FROM ranked r WHERE r.rn = 1),
    upd AS (
      UPDATE public.jobs jb
         SET is_active = false, status = 'expired'
        FROM ranked r
       WHERE jb.id = r.id AND r.rn > 1
      RETURNING jb.id AS dup_id, r.rk AS dup_rk
    )
    SELECT upd.dup_rk, k.id, upd.dup_id, true
      FROM upd JOIN keepers k ON k.rk = upd.dup_rk;
  ELSE
    RETURN QUERY
    WITH ranked AS (
      SELECT j.id,
             public.jobs_role_key(j.company, j.title, j.location) AS rk,
             row_number() OVER (
               PARTITION BY public.jobs_role_key(j.company, j.title, j.location)
               ORDER BY coalesce(j.verified, false) DESC, j.first_seen_at ASC NULLS LAST, j.id
             ) AS rn
      FROM public.jobs j
      WHERE j.is_active IS TRUE
    )
    SELECT d.rk, k.id, d.id, false
      FROM ranked d JOIN ranked k ON k.rk = d.rk AND k.rn = 1
     WHERE d.rn > 1;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.dedupe_jobs_by_role(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dedupe_jobs_by_role(boolean) TO service_role;

-- ============================================================================
-- Usage (SQL editor, as service role / postgres):
--   SELECT * FROM public.jobs_duplicate_roles;                 -- read-only audit
--   SELECT * FROM public.dedupe_jobs_by_role();                -- dry run, changes nothing
--   SELECT * FROM public.dedupe_jobs_by_role(true);            -- deactivates non-keepers
--
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.dedupe_jobs_by_role(boolean);
--   DROP VIEW IF EXISTS public.jobs_duplicate_roles;
--   DROP INDEX IF EXISTS public.jobs_role_key_active_idx;
--   DROP FUNCTION IF EXISTS public.jobs_role_key(text, text, text);
--   DROP FUNCTION IF EXISTS public.jobs_slug(text);
--   -- Rows deactivated by dedupe_jobs_by_role(true) are not restored by the
--   -- rollback; re-activate from the dry-run output you saved if needed.
-- ============================================================================
