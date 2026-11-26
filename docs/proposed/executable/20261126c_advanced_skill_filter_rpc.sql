-- PROPOSED, NOT APPLIED. Review-only service-side candidate relation.
-- READINESS BLOCKERS: shared JS/SQL normalization fixtures, real PostgREST query
-- composition, API masking/gates, preview EXPLAIN/capacity, catalog/privileges.
-- No title/description/top_keywords matching. No data backfill or helper column.
BEGIN;
CREATE OR REPLACE FUNCTION public.advanced_skill_key(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
  -- Shared skillKey contract: ASCII whitespace/case only. Non-ASCII stays
  -- byte-for-byte and case-sensitive. No truncation of stored job skill strings.
  SELECT pg_catalog.translate(pg_catalog.btrim(pg_catalog.regexp_replace(
    p_value, '[' || pg_catalog.chr(32) || pg_catalog.chr(9) || pg_catalog.chr(10) ||
    pg_catalog.chr(13) || pg_catalog.chr(12) || pg_catalog.chr(11) || ']+', ' ', 'g'), ' '),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
$$;
REVOKE ALL ON FUNCTION public.advanced_skill_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advanced_skill_key(text) TO service_role;

CREATE OR REPLACE FUNCTION public.jobs_without_excluded_skills(p_excluded text[])
RETURNS SETOF public.jobs LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE keys text[];
BEGIN
  -- A NULL/empty list is no-op. Reject invalid shapes/values, never silently drop.
  IF p_excluded IS NOT NULL AND (
    pg_catalog.cardinality(p_excluded)>50 OR pg_catalog.array_ndims(p_excluded)>1
    OR pg_catalog.array_lower(p_excluded,1) IS DISTINCT FROM 1 AND pg_catalog.cardinality(p_excluded)>0
  ) THEN
    RAISE EXCEPTION 'invalid excluded skill list' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.unnest(p_excluded) AS x(value)
    WHERE value IS NULL OR pg_catalog.char_length(value)>100 OR public.advanced_skill_key(value)='') THEN
    RAISE EXCEPTION 'invalid excluded skill item' USING ERRCODE='22023';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT public.advanced_skill_key(value)) INTO keys
    FROM pg_catalog.unnest(p_excluded) AS x(value);
  RETURN QUERY SELECT j.* FROM public.jobs j
    WHERE j.status='active' AND j.is_active=true AND (j.source_type IS NULL OR j.source_type<>'jobspy')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.unnest(j.skills) AS skill(value)
      WHERE public.advanced_skill_key(value)=ANY(keys));
END $$;
REVOKE ALL ON FUNCTION public.jobs_without_excluded_skills(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jobs_without_excluded_skills(text[]) TO service_role;
COMMIT;
-- Proposed backend use: existing server readiness gates first, RPC relation then the
-- existing hard filters/order/range before limit. Never return private jobs.* raw.
-- SECURITY INVOKER means callers need existing table privileges; no new bypass.
-- Available to Free and Pro per user choice; preserve existing paid payload masks.
-- Missing function readiness or normalization proof must fail closed in the API.
-- Rollback, after dependent API code disabled: DROP FUNCTION public.jobs_without_excluded_skills(text[]);
-- DROP FUNCTION public.advanced_skill_key(text); No data changes to undo.
