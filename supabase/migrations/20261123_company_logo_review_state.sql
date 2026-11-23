-- =============================================================================
-- Migration: 20261123_company_logo_review_state.sql   (NOT APPLIED - owner applies after approval)
-- Requires:  20261122_company_logo_contract.sql (applied first; this file does not modify it)
--
-- Persistent owner review state for company logos, honoured by EVERY automatic path:
--   1. company_logo_reviews        - per company (stable id): 'hold' (do not touch), 'initials'
--                                    (deliberately keep initials), 'approved' (owner approved automatic
--                                    repair). No row = unreviewed: automatic repair may run, but it is
--                                    never reported as an owner approval.
--   2. company_logo_rejected_hashes - per company image fingerprints (sha256) the owner rejected, with a
--                                    reason. The worker never re-selects them, whatever source returns them.
--   Rows are never deleted: clearing sets cleared_at/cleared_by/cleared_note, so history is the audit trail.
--   Clearing or changing a decision is only possible through set_company_logo_review /
--   set_company_logo_hash_rejection (explicit reviewer + reason), executable by service_role only.
--   3. companies_logo_review_guard trigger - any UPDATE that changes logo_url / logo_hash / logo_status of
--      a held or initials company, or points it at a rejected image, is refused. This backstops the TS
--      worker, the verification pass, both ingest paths and any future writer (a lease race included).
--   4. enqueue_company_logos / claim_company_logo_batch / company_logo_coverage re-created with the SAME
--      signatures: held and initials companies are never enqueued or claimed (manifest claims included),
--      and coverage reports held / intentional_initials / approved separately from the repair backlog.
--   5. Seeds the reviewed #698 exclusions (Appen, Glossier) as holds + rejected hashes. Ids, hashes and
--      reasons come from the review records (evidence commits 5f61f24b and 4be15678); a hold that was later
--      cleared is NOT re-created when this file is re-run.
-- Idempotent: safe to run twice. Rollback: docs/company-logo-auto-repair-rollout.md.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.company_logo_reviews (
  id                bigserial PRIMARY KEY,
  company_id        uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  decision          text NOT NULL CHECK (decision IN ('hold', 'initials', 'approved')),
  reason            text NOT NULL CHECK (btrim(reason) <> ''),
  reviewed_by       text NOT NULL CHECK (btrim(reviewed_by) <> ''),
  reviewed_at       timestamptz NOT NULL DEFAULT now(),
  previous_logo_url text,
  cleared_at        timestamptz,
  cleared_by        text,
  cleared_note      text,
  CHECK ((cleared_at IS NULL) = (cleared_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS company_logo_reviews_active_uniq ON public.company_logo_reviews (company_id) WHERE cleared_at IS NULL;

CREATE TABLE IF NOT EXISTS public.company_logo_rejected_hashes (
  id           bigserial PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  reason       text NOT NULL CHECK (btrim(reason) <> ''),
  rejected_by  text NOT NULL CHECK (btrim(rejected_by) <> ''),
  rejected_at  timestamptz NOT NULL DEFAULT now(),
  cleared_at   timestamptz,
  cleared_by   text,
  cleared_note text,
  CHECK ((cleared_at IS NULL) = (cleared_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS company_logo_rejected_hashes_active_uniq ON public.company_logo_rejected_hashes (company_id, sha256) WHERE cleared_at IS NULL;

-- Service-only: no client role can read or write; service_role may only READ (mutations go through the
-- reviewed functions below, so a hold/rejection can't be dropped by a stray UPDATE/DELETE).
ALTER TABLE public.company_logo_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_logo_rejected_hashes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.company_logo_reviews, public.company_logo_rejected_hashes FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.company_logo_reviews_id_seq, public.company_logo_rejected_hashes_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.company_logo_reviews, public.company_logo_rejected_hashes TO service_role;

-- SECURITY DEFINER so the guard sees review rows whatever role runs the UPDATE.
CREATE OR REPLACE FUNCTION public.company_logo_blocked(p_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_logo_reviews r
     WHERE r.company_id = p_company_id AND r.cleared_at IS NULL AND r.decision IN ('hold', 'initials')
  );
$$;

CREATE OR REPLACE FUNCTION public.company_logo_hash_rejected(p_company_id uuid, p_sha256 text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_logo_rejected_hashes h
     WHERE h.company_id = p_company_id AND h.sha256 = lower(p_sha256) AND h.cleared_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.companies_logo_review_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sha text;
BEGIN
  IF public.company_logo_blocked(NEW.id) THEN
    RAISE EXCEPTION 'company % logo is under owner review (hold/initials); change it only via set_company_logo_review', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.logo_url IS NOT NULL AND (NEW.logo_url IS DISTINCT FROM OLD.logo_url OR NEW.logo_hash IS DISTINCT FROM OLD.logo_hash) THEN
    -- versioned keys carry the content hash; legacy <id>.<ext> keys rely on logo_hash
    v_sha := COALESCE(substring(NEW.logo_url FROM '/([0-9a-fA-F]{64})\.[A-Za-z]+$'), NEW.logo_hash);
    IF v_sha IS NOT NULL AND public.company_logo_hash_rejected(NEW.id, v_sha) THEN
      RAISE EXCEPTION 'company % logo image % was rejected by owner review', NEW.id, lower(v_sha)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS companies_logo_review_guard ON public.companies;
CREATE TRIGGER companies_logo_review_guard
  BEFORE UPDATE OF logo_url, logo_hash, logo_status ON public.companies
  FOR EACH ROW
  WHEN (OLD.logo_url IS DISTINCT FROM NEW.logo_url OR OLD.logo_hash IS DISTINCT FROM NEW.logo_hash OR OLD.logo_status IS DISTINCT FROM NEW.logo_status)
  EXECUTE FUNCTION public.companies_logo_review_guard();

-- Reviewed operation: p_decision 'hold' | 'initials' | 'approved' | 'clear'. Any previous active decision is
-- cleared (kept as history). 'initials' clears logo_url (previous value kept in the review row for rollback);
-- every decision releases an in-flight lease so a running worker's conditional commit can't land.
CREATE OR REPLACE FUNCTION public.set_company_logo_review(p_company_id uuid, p_decision text, p_reason text, p_reviewed_by text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev text;
  v_id bigint;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('hold', 'initials', 'approved', 'clear') THEN
    RAISE EXCEPTION 'set_company_logo_review: decision must be hold|initials|approved|clear (got %)', p_decision;
  END IF;
  IF coalesce(btrim(p_reason), '') = '' OR coalesce(btrim(p_reviewed_by), '') = '' THEN
    RAISE EXCEPTION 'set_company_logo_review: a reason and a reviewer are required';
  END IF;
  SELECT logo_url INTO v_prev FROM public.companies WHERE id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'set_company_logo_review: unknown company %', p_company_id;
  END IF;

  UPDATE public.company_logo_reviews
     SET cleared_at = now(), cleared_by = p_reviewed_by, cleared_note = p_reason
   WHERE company_id = p_company_id AND cleared_at IS NULL;
  UPDATE public.companies SET logo_claimed_until = NULL, logo_claim_token = NULL WHERE id = p_company_id;
  IF p_decision = 'clear' THEN
    RETURN NULL;
  END IF;
  IF p_decision = 'initials' THEN
    UPDATE public.companies
       SET logo_url = NULL, logo_status = 'missing', logo_failure_reason = 'owner review: keep initials', logo_next_attempt_at = NULL
     WHERE id = p_company_id;
  END IF;
  INSERT INTO public.company_logo_reviews (company_id, decision, reason, reviewed_by, previous_logo_url)
  VALUES (p_company_id, p_decision, p_reason, p_reviewed_by, v_prev)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Reviewed operation: p_action 'reject' | 'clear' for one image fingerprint of one company.
CREATE OR REPLACE FUNCTION public.set_company_logo_hash_rejection(p_company_id uuid, p_sha256 text, p_action text, p_reason text, p_reviewed_by text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('reject', 'clear') THEN
    RAISE EXCEPTION 'set_company_logo_hash_rejection: action must be reject|clear (got %)', p_action;
  END IF;
  IF p_sha256 IS NULL OR lower(p_sha256) !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'set_company_logo_hash_rejection: sha256 must be 64 hex characters';
  END IF;
  IF coalesce(btrim(p_reason), '') = '' OR coalesce(btrim(p_reviewed_by), '') = '' THEN
    RAISE EXCEPTION 'set_company_logo_hash_rejection: a reason and a reviewer are required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company_id) THEN
    RAISE EXCEPTION 'set_company_logo_hash_rejection: unknown company %', p_company_id;
  END IF;
  IF p_action = 'clear' THEN
    UPDATE public.company_logo_rejected_hashes
       SET cleared_at = now(), cleared_by = p_reviewed_by, cleared_note = p_reason
     WHERE company_id = p_company_id AND sha256 = lower(p_sha256) AND cleared_at IS NULL;
  ELSE
    INSERT INTO public.company_logo_rejected_hashes (company_id, sha256, reason, rejected_by)
    SELECT p_company_id, lower(p_sha256), p_reason, p_reviewed_by
     WHERE NOT public.company_logo_hash_rejected(p_company_id, p_sha256);
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Same signatures and behaviour as 20261122, plus: held / initials companies are never enqueued.
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
       AND NOT public.company_logo_blocked(c.id)
    RETURNING 1
  )
  SELECT count(*)::integer FROM upd;
$$;

-- ... and never claimed, including through a manifest's p_ids.
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
       AND NOT public.company_logo_blocked(c.id)
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

-- Separate counts: hosted/readable, intentional initials, held, approved, pending, failed. Held and
-- initials companies are owner decisions, so they are not part of the repair backlog (missing_or_ineligible).
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
    SELECT c.*, r.decision,
           public.company_logo_eligible(c.logo_url, p_origin) AND c.logo_status IS DISTINCT FROM 'pending' AS healthy,
           COALESCE(r.decision IN ('hold', 'initials'), false) AS blocked
      FROM public.companies c
      JOIN live ON live.company_id = c.id
      LEFT JOIN public.company_logo_reviews r ON r.company_id = c.id AND r.cleared_at IS NULL
  )
  SELECT jsonb_build_object(
    'companies_with_active_jobs', (SELECT count(*) FROM lc),
    'eligible_hosted', (SELECT count(*) FROM lc WHERE healthy),
    'missing_or_ineligible', (SELECT count(*) FROM lc WHERE NOT healthy AND NOT blocked),
    'held', (SELECT count(*) FROM lc WHERE decision = 'hold'),
    'intentional_initials', (SELECT count(*) FROM lc WHERE decision = 'initials'),
    'approved', (SELECT count(*) FROM lc WHERE decision = 'approved'),
    'pending', (SELECT count(*) FROM lc WHERE logo_status = 'pending' AND NOT blocked),
    'failed', (SELECT count(*) FROM lc WHERE logo_status = 'failed' AND NOT blocked),
    'missing', (SELECT count(*) FROM lc WHERE logo_status = 'missing' AND NOT blocked),
    'queued_retries', (SELECT count(*) FROM lc WHERE logo_status IN ('failed', 'missing') AND logo_next_attempt_at IS NOT NULL AND NOT blocked),
    'orphan_links', (SELECT count(*) FROM public.jobs j
                      WHERE j.status = 'active' AND j.is_active = true
                        AND (j.company_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = j.company_id)))
  );
$$;

REVOKE ALL ON FUNCTION public.company_logo_blocked(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.company_logo_hash_rejected(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.companies_logo_review_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_company_logo_review(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_company_logo_hash_rejection(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_company_logos(uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_company_logo_batch(integer, text, integer, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.company_logo_coverage(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.company_logo_blocked(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.company_logo_hash_rejected(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_company_logo_review(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_company_logo_hash_rejection(uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_company_logos(uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_company_logo_batch(integer, text, integer, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.company_logo_coverage(text) TO service_role;

-- Reviewed #698 exclusions (removed from the reviewed manifest; left untouched by that backfill).
-- Only seeded for companies that exist, and never re-created once a reviewer cleared them.
INSERT INTO public.company_logo_reviews (company_id, decision, reason, reviewed_by, previous_logo_url)
SELECT c.id, 'hold', v.reason, 'owner review of #698 (' || v.evidence || ')', c.logo_url
  FROM (VALUES
    ('c89af545-4a0d-463d-bcad-f15e796bdfe8'::uuid, 'white mark invisible on light tile', 'evidence 5f61f24b'),
    ('44f03f3c-899b-488c-a589-cb20c4081cf7'::uuid, 'faint white logo on light tile', 'evidence 4be15678')
  ) AS v (id, reason, evidence)
  JOIN public.companies c ON c.id = v.id
 WHERE NOT EXISTS (SELECT 1 FROM public.company_logo_reviews r WHERE r.company_id = v.id AND r.reviewed_by LIKE 'owner review of #698 %');

INSERT INTO public.company_logo_rejected_hashes (company_id, sha256, reason, rejected_by)
SELECT c.id, v.sha256, v.reason, 'owner review of #698 (' || v.evidence || ')'
  FROM (VALUES
    ('c89af545-4a0d-463d-bcad-f15e796bdfe8'::uuid, '57677de07919ebf8437ed532471f09c1573fc872787665eb5cd97f4a4fefb821', 'white mark invisible on light tile (homepage-icon, review-d90fe55c)', 'evidence 5f61f24b'),
    ('44f03f3c-899b-488c-a589-cb20c4081cf7'::uuid, '186020c47f9bb6aa6cbd8b18ee7824d1644342a8366fe84456bc147aa76c6cca', 'faint white logo on light tile (homepage-icon, review-d4f688b7)', 'evidence 4be15678')
  ) AS v (id, sha256, reason, evidence)
  JOIN public.companies c ON c.id = v.id
 WHERE NOT EXISTS (SELECT 1 FROM public.company_logo_rejected_hashes h WHERE h.company_id = v.id AND h.sha256 = v.sha256);

-- ============================================================================
-- ROLLBACK (manual; LOGO_REPAIR_ENABLED must already be off). companies.logo_url values and storage objects
-- are untouched. Keep the review history first as evidence, e.g.
--   SELECT * FROM public.company_logo_reviews;  SELECT * FROM public.company_logo_rejected_hashes;
-- Step 1: re-run 20261122_company_logo_contract.sql (idempotent): its CREATE OR REPLACE restores
--         enqueue_company_logos / claim_company_logo_batch / company_logo_coverage without review checks.
-- Step 2:
--   DROP TRIGGER IF EXISTS companies_logo_review_guard ON public.companies;
--   DROP FUNCTION IF EXISTS public.companies_logo_review_guard();
--   DROP FUNCTION IF EXISTS public.set_company_logo_hash_rejection(uuid, text, text, text, text);
--   DROP FUNCTION IF EXISTS public.set_company_logo_review(uuid, text, text, text);
--   DROP FUNCTION IF EXISTS public.company_logo_hash_rejected(uuid, text);
--   DROP FUNCTION IF EXISTS public.company_logo_blocked(uuid);
--   DROP TABLE IF EXISTS public.company_logo_rejected_hashes;
--   DROP TABLE IF EXISTS public.company_logo_reviews;
-- ============================================================================
