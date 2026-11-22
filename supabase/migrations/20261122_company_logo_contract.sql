-- =============================================================================
-- Migration: 20261122_company_logo_contract.sql   (NOT APPLIED - apply only after owner approval)
--
-- Purpose: durable, race-free company-logo repair loop shared by the TS ingest, the Python ingest
-- and the scheduled sweep. Additive only: no existing column, row, object or policy is changed.
--
--   1. companies.logo_* state columns (status, source, reason, attempts, backoff, content hash,
--      claim lease) + indexes.
--   2. company_logo_eligible(url, origin) - THE eligibility rule in SQL, identical to
--      src/lib/companies/logoEligibility.ts: this project's origin + public company-logos bucket +
--      id-scoped raster key (<company_id>.<ext> or <company_id>/<sha256>.<ext>). Callers pass their
--      own project origin (NEXT_PUBLIC_SUPABASE_URL), so a foreign project/host never counts.
--   3. enqueue_company_logos(ids, origin) - ingest paths mark new / ineligible companies pending.
--   4. claim_company_logo_batch(limit, origin, ...) - FOR UPDATE SKIP LOCKED + lease; explicit cap
--      1..200, never unlimited. One writer per company at a time. Pending rows (incl. hosted logos the
--      sweep verified broken) are always claimable and are repaired, never re-blessed by URL shape.
--   5. company_logo_runs - per-run summary history (stall / no-progress / backlog alerts).
--   6. company_logo_coverage(origin) - counts for every ingest/sweep summary; a hosted URL counts as
--      healthy only when it is eligible AND not pending (verified-broken assets are pending).
-- All functions are SECURITY INVOKER and executable by service_role only.
-- =============================================================================

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS logo_status          text,
  ADD COLUMN IF NOT EXISTS logo_source          text,
  ADD COLUMN IF NOT EXISTS logo_failure_reason  text,
  ADD COLUMN IF NOT EXISTS logo_attempts        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS logo_last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS logo_next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS logo_verified_at     timestamptz,
  ADD COLUMN IF NOT EXISTS logo_hash            text,
  ADD COLUMN IF NOT EXISTS logo_claimed_until   timestamptz,
  ADD COLUMN IF NOT EXISTS logo_claim_token     uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_logo_status_check') THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT companies_logo_status_check
      CHECK (logo_status IS NULL OR logo_status IN ('pending', 'hosted', 'missing', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS companies_logo_queue_idx ON public.companies (logo_status, logo_next_attempt_at);
CREATE INDEX IF NOT EXISTS companies_logo_hash_idx ON public.companies (logo_hash) WHERE logo_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.company_logo_runs (
  id                         bigserial PRIMARY KEY,
  trigger                    text NOT NULL CHECK (trigger IN ('ingest-ts', 'ingest-python', 'sweep', 'backfill')),
  started_at                 timestamptz NOT NULL DEFAULT now(),
  finished_at                timestamptz,
  ok                         boolean,
  cap                        integer NOT NULL CHECK (cap BETWEEN 1 AND 200),
  companies_with_active_jobs integer,
  eligible_hosted            integer,
  missing_or_ineligible      integer,
  failed                     integer,
  repaired                   integer,
  queued_retries             integer,
  orphan_links               integer,
  details                    jsonb
);
ALTER TABLE public.company_logo_runs ENABLE ROW LEVEL SECURITY;  -- no policies: service_role only

CREATE OR REPLACE FUNCTION public.company_logo_eligible(p_url text, p_origin text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_url IS NOT NULL
     AND p_origin ~ '^https://[^/?#]+$'
     AND left(p_url, length(p_origin) + 40) = p_origin || '/storage/v1/object/public/company-logos/'
     AND substr(p_url, length(p_origin) + 41)
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.(png|jpe?g|webp|gif)|/[0-9a-f]{64}\.(png|jpe?g|webp|gif))$';
$$;

-- Ingest paths: mark companies whose logo is not eligible as pending, without resetting an active
-- backoff (failed/missing rows keep their next_attempt_at) and without touching hosted rows.
CREATE OR REPLACE FUNCTION public.enqueue_company_logos(p_ids uuid[], p_origin text)
RETURNS integer
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  WITH upd AS (
    UPDATE public.companies c
       SET logo_status = 'pending',
           logo_next_attempt_at = COALESCE(c.logo_next_attempt_at, now())
     WHERE c.id = ANY (COALESCE(p_ids, '{}'::uuid[]))
       AND NOT public.company_logo_eligible(c.logo_url, p_origin)
       AND (c.logo_status IS NULL OR c.logo_status = 'hosted')
    RETURNING 1
  )
  SELECT count(*)::integer FROM upd;
$$;

-- Workers: lease up to p_limit due companies, highest active-job count first. Rows already leased
-- by another worker are skipped (SKIP LOCKED + unexpired lease), so TS ingest, Python ingest and the
-- sweep can never process the same company concurrently. p_ids restricts to a reviewed manifest.
CREATE OR REPLACE FUNCTION public.claim_company_logo_batch(
  p_limit integer,
  p_origin text,
  p_lease_seconds integer DEFAULT 600,
  p_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid, name text, slug text, domain text, careers_url text, ats_type text,
  logo_url text, logo_status text, logo_attempts integer, logo_hash text, claim_token uuid
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'claim_company_logo_batch: p_limit must be between 1 and 200 (got %)', p_limit;
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'claim_company_logo_batch: p_lease_seconds must be between 30 and 3600 (got %)', p_lease_seconds;
  END IF;
  IF p_origin IS NULL OR p_origin !~ '^https://[^/?#]+$' THEN
    RAISE EXCEPTION 'claim_company_logo_batch: p_origin must be the project origin (got %)', p_origin;
  END IF;

  RETURN QUERY
  WITH due AS (
    SELECT c.id
      FROM public.companies c
     WHERE (c.logo_claimed_until IS NULL OR c.logo_claimed_until < now())
       AND (
             (p_ids IS NOT NULL AND c.id = ANY (p_ids))
          OR (p_ids IS NULL AND (
                c.logo_status = 'pending'
             OR (c.logo_status IN ('failed', 'missing') AND c.logo_next_attempt_at <= now())
             OR (c.logo_status IS NULL AND NOT public.company_logo_eligible(c.logo_url, p_origin))
             ))
           )
     ORDER BY (SELECT count(*) FROM public.jobs j
                WHERE j.company_id = c.id AND j.status = 'active' AND j.is_active = true) DESC,
              c.logo_next_attempt_at NULLS FIRST, c.id
     LIMIT p_limit
       FOR UPDATE OF c SKIP LOCKED
  )
  UPDATE public.companies c
     SET logo_claimed_until = now() + make_interval(secs => p_lease_seconds),
         logo_claim_token = gen_random_uuid()
    FROM due
   WHERE c.id = due.id
  RETURNING c.id, c.name, c.slug, c.domain, c.careers_url, c.ats_type,
            c.logo_url, c.logo_status, c.logo_attempts, c.logo_hash, c.logo_claim_token;
END;
$$;

-- Counts for run summaries (one round trip, same eligibility rule; pending = queued or verified-broken).
CREATE OR REPLACE FUNCTION public.company_logo_coverage(p_origin text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH live AS (
    SELECT j.company_id, count(*) AS n
      FROM public.jobs j
     WHERE j.status = 'active' AND j.is_active = true AND j.company_id IS NOT NULL
     GROUP BY j.company_id
  ), lc AS (
    SELECT c.*, public.company_logo_eligible(c.logo_url, p_origin)
                AND c.logo_status IS DISTINCT FROM 'pending' AS healthy
      FROM public.companies c JOIN live ON live.company_id = c.id
  )
  SELECT jsonb_build_object(
    'companies_with_active_jobs', (SELECT count(*) FROM lc),
    'eligible_hosted', (SELECT count(*) FROM lc WHERE healthy),
    'missing_or_ineligible', (SELECT count(*) FROM lc WHERE NOT healthy),
    'pending', (SELECT count(*) FROM lc WHERE logo_status = 'pending'),
    'failed', (SELECT count(*) FROM lc WHERE logo_status = 'failed'),
    'missing', (SELECT count(*) FROM lc WHERE logo_status = 'missing'),
    'queued_retries', (SELECT count(*) FROM lc WHERE logo_status IN ('failed', 'missing') AND logo_next_attempt_at IS NOT NULL),
    'orphan_links', (SELECT count(*) FROM public.jobs j
                      WHERE j.status = 'active' AND j.is_active = true
                        AND (j.company_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = j.company_id)))
  );
$$;

REVOKE ALL ON FUNCTION public.company_logo_eligible(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_company_logos(uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_company_logo_batch(integer, text, integer, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.company_logo_coverage(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.company_logo_eligible(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_company_logos(uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_company_logo_batch(integer, text, integer, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.company_logo_coverage(text) TO service_role;

-- ============================================================================
-- ROLLBACK (manual, after disabling LOGO_REPAIR_ENABLED). Drops only what this migration added;
-- companies.logo_url values and storage objects are untouched:
--   DROP FUNCTION IF EXISTS public.company_logo_coverage(text);
--   DROP FUNCTION IF EXISTS public.claim_company_logo_batch(integer, text, integer, uuid[]);
--   DROP FUNCTION IF EXISTS public.enqueue_company_logos(uuid[], text);
--   DROP FUNCTION IF EXISTS public.company_logo_eligible(text, text);
--   DROP TABLE IF EXISTS public.company_logo_runs;
--   DROP INDEX IF EXISTS public.companies_logo_hash_idx;
--   DROP INDEX IF EXISTS public.companies_logo_queue_idx;
--   ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_logo_status_check;
--   ALTER TABLE public.companies
--     DROP COLUMN IF EXISTS logo_claim_token, DROP COLUMN IF EXISTS logo_claimed_until,
--     DROP COLUMN IF EXISTS logo_hash, DROP COLUMN IF EXISTS logo_verified_at,
--     DROP COLUMN IF EXISTS logo_next_attempt_at, DROP COLUMN IF EXISTS logo_last_attempt_at,
--     DROP COLUMN IF EXISTS logo_attempts, DROP COLUMN IF EXISTS logo_failure_reason,
--     DROP COLUMN IF EXISTS logo_source, DROP COLUMN IF EXISTS logo_status;
-- ============================================================================
