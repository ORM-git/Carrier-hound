-- ==============================================================================
-- DO NOT APPLY / REVIEW PENDING — PHASE B: RECONCILED BACKFILL DML (SINGLE-BATCH)
-- CareerMonke (Carrier-hound) — Database Migration Staged Deployment: Phase B
-- File: supabase/scripts/phase-b-backfill.sql
-- Status: UNDER REVIEW — DO NOT RUN ON LIVE PRODUCTION DATABASE
--
-- OPERATIONAL DESIGN (SUPABASE SQL EDITOR SAFE):
-- 1. No continuous PL/pgSQL DO-block loops that risk hitting Supabase statement timeouts.
-- 2. Each backfill is structured as an idempotent single-batch statement (LIMIT 2000).
-- 3. The operator runs the remaining count query, then executes the single-batch update
--    repeatedly until the remaining count reaches 0.
-- 4. eligible_countries NEVER contains NULL: when country_code is NULL, it sets an empty array '{}'.
-- 5. Seniority backfill integrates Seniority V2 rules.
-- ==============================================================================


-- ==============================================================================
-- 1. BACKFILL 1: discovered_at (Historical NULL rows populated from first_seen_at)
-- ==============================================================================

-- 1.1 Progress / Remaining count check:
-- Run this before and between batches. If count is 0, this backfill is complete.
SELECT COUNT(*) AS remaining_unbackfilled_discovered_at
FROM public.jobs
WHERE discovered_at IS NULL;

-- 1.2 Single-batch update (Run repeatedly until remaining count is 0):
WITH batch AS (
  SELECT id
  FROM public.jobs
  WHERE discovered_at IS NULL
  ORDER BY id
  LIMIT 2000
)
UPDATE public.jobs j
SET discovered_at = COALESCE(j.first_seen_at, j.created_at, NOW())
FROM batch
WHERE j.id = batch.id;


-- ==============================================================================
-- 2. BACKFILL 2: categories array from legacy category column
-- ==============================================================================

-- 2.1 Progress / Remaining count check:
-- Run this before and between batches. If count is 0, this backfill is complete.
SELECT COUNT(*) AS remaining_unbackfilled_categories
FROM public.jobs
WHERE (categories IS NULL OR cardinality(categories) = 0)
  AND category IS NOT NULL;

-- 2.2 Single-batch update (Run repeatedly until remaining count is 0):
WITH batch AS (
  SELECT id
  FROM public.jobs
  WHERE (categories IS NULL OR cardinality(categories) = 0)
    AND category IS NOT NULL
  ORDER BY id
  LIMIT 2000
)
UPDATE public.jobs j
SET categories = ARRAY[j.category]
FROM batch
WHERE j.id = batch.id;


-- ==============================================================================
-- 3. BACKFILL 3: country_code (Conservative Exact Mapping for NULL rows)
-- ==============================================================================
-- Only targets rows with unambiguous evidence (explicit country names or ISO codes).
-- Unmatchable rows stay NULL and are not re-processed.

-- 3.1 Progress / Remaining count check:
-- Counts rows with matchable country evidence that still have country_code IS NULL.
SELECT COUNT(*) AS remaining_backfillable_country_code
FROM public.jobs
WHERE country_code IS NULL
  AND (
    country ILIKE ANY (ARRAY['United States', 'USA', 'US', 'Canada', 'CA', 'United Kingdom', 'GB', 'UK', 'Germany', 'Deutschland', 'DE', 'India', 'IN', 'Australia', 'AU', 'France', 'FR', 'Japan', 'JP'])
    OR location ~* '\y(United States|USA|Canada|Germany|Deutschland|United Kingdom|Australia|India|France|Japan)\y'
  );

-- 3.2 Single-batch update (Run repeatedly until remaining count is 0):
WITH batch AS (
  SELECT id
  FROM public.jobs
  WHERE country_code IS NULL
    AND (
      country ILIKE ANY (ARRAY['United States', 'USA', 'US', 'Canada', 'CA', 'United Kingdom', 'GB', 'UK', 'Germany', 'Deutschland', 'DE', 'India', 'IN', 'Australia', 'AU', 'France', 'FR', 'Japan', 'JP'])
      OR location ~* '\y(United States|USA|Canada|Germany|Deutschland|United Kingdom|Australia|India|France|Japan)\y'
    )
  ORDER BY id
  LIMIT 2000
)
UPDATE public.jobs j
SET country_code = CASE
  -- 1. Explicit country column: exact normalized country name or ISO code (highest precedence)
  WHEN j.country ILIKE 'United States' OR j.country ILIKE 'USA' OR j.country = 'US' THEN 'US'
  WHEN j.country ILIKE 'Canada' OR j.country = 'CA' THEN 'CA'
  WHEN j.country ILIKE 'United Kingdom' OR j.country = 'GB' OR j.country = 'UK' THEN 'GB'
  WHEN j.country ILIKE 'Germany' OR j.country ILIKE 'Deutschland' OR j.country = 'DE' THEN 'DE'
  WHEN j.country ILIKE 'India' OR j.country = 'IN' THEN 'IN'
  WHEN j.country ILIKE 'Australia' OR j.country = 'AU' THEN 'AU'
  WHEN j.country ILIKE 'France' OR j.country = 'FR' THEN 'FR'
  WHEN j.country ILIKE 'Japan' OR j.country = 'JP' THEN 'JP'
  -- 2. Unambiguous FULL country name evidence from location only (NO city or state code inference)
  WHEN j.location ~* '\y(United States|USA)\y' THEN 'US'
  WHEN j.location ~* '\y(Canada)\y' THEN 'CA'
  WHEN j.location ~* '\y(Germany|Deutschland)\y' THEN 'DE'
  WHEN j.location ~* '\y(United Kingdom)\y' THEN 'GB'
  WHEN j.location ~* '\y(Australia)\y' THEN 'AU'
  WHEN j.location ~* '\y(India)\y' THEN 'IN'
  WHEN j.location ~* '\y(France)\y' THEN 'FR'
  WHEN j.location ~* '\y(Japan)\y' THEN 'JP'
  ELSE j.country_code
END
FROM batch
WHERE j.id = batch.id;


-- ==============================================================================
-- 4. BACKFILL 4: eligible_countries & remote_eligibility (Single Decision CTE)
-- ==============================================================================
-- Populates eligible_countries for all rows. Ensures eligible_countries NEVER contains NULL.
-- When country_code is NULL, sets empty array '{}' instead of '{NULL}'.

-- 4.1 Progress / Remaining count check:
-- Tracks unbackfilled rows where eligible_countries IS NULL.
SELECT COUNT(*) AS remaining_unbackfilled_eligible_countries
FROM public.jobs
WHERE eligible_countries IS NULL;

-- 4.2 Single-batch update (Run repeatedly until remaining count is 0):
WITH batch AS (
  SELECT id
  FROM public.jobs
  WHERE eligible_countries IS NULL
  ORDER BY id
  LIMIT 2000
),
decisions AS (
  SELECT
    b.id,
    j.country_code,
    j.remote_eligibility AS current_remote_eligibility,
    CASE
      -- 1. Non-remote: remote_scope != 'remote' -> unknown
      WHEN j.remote_scope IS DISTINCT FROM 'remote' THEN 1

      -- 2. Region phrases (Europe, EMEA, APAC, etc.) stay unknown
      WHEN j.location ~* '\y(europe|emea|apac|latam|asia)\y' THEN 2

      -- 3. Explicit US restrictions
      WHEN j.location ~* '\y(us only|usa only|united states only)\y'
        OR (j.location ~* '\y(united states|usa)\y' AND j.location ~* '\y(not accepted|ineligible|only)\y')
        OR j.location ~* '\y(anywhere in the us|anywhere in the usa)\y'
        OR j.country ILIKE 'United States' OR j.country_code = 'US' THEN 3

      -- 4. Explicit India restrictions
      WHEN j.country ILIKE 'India' OR j.country_code = 'IN' OR j.location ~* '\y(india only|anywhere in india)\y' THEN 4

      -- 5. Genuine Worldwide: explicit worldwide without regional restrictions
      WHEN (j.location ~* '\y(worldwide|anywhere in the world|work from anywhere)\y')
        AND j.location !~* '\y(only|us|usa|united states|uk|canada|europe|emea|apac|latam|asia|india|germany)\y' THEN 5

      -- 6. Other explicit country code
      WHEN j.country_code IS NOT NULL AND j.country_code != '' THEN 6

      -- 7. Plain Remote alone or unmapped
      ELSE 7
    END AS code
  FROM batch b
  JOIN public.jobs j ON j.id = b.id
)
UPDATE public.jobs j
SET
  remote_eligibility = CASE
    -- Preserve existing classifications if already worldwide or country_restricted
    WHEN d.current_remote_eligibility IN ('worldwide', 'country_restricted') THEN d.current_remote_eligibility
    WHEN d.code IN (3, 4, 6) THEN 'country_restricted'
    WHEN d.code = 5 THEN 'worldwide'
    ELSE 'unknown'
  END,
  eligible_countries = CASE
    WHEN d.current_remote_eligibility = 'worldwide' OR d.code = 5 THEN ARRAY['*']
    WHEN (d.current_remote_eligibility = 'country_restricted' OR d.code IN (3, 4, 6))
         AND d.country_code IS NOT NULL AND d.country_code != '' THEN ARRAY[d.country_code]
    WHEN d.code = 3 THEN ARRAY['US']
    WHEN d.code = 4 THEN ARRAY['IN']
    ELSE '{}'::text[]
  END
FROM decisions d
WHERE j.id = d.id;

-- 4.3 Post-backfill distribution & NULL-safety check:
SELECT
  remote_eligibility,
  COUNT(*) AS count,
  COUNT(*) FILTER (WHERE eligible_countries IS NULL OR NULL = ANY(eligible_countries)) AS invalid_null_arrays
FROM public.jobs
GROUP BY remote_eligibility;


-- ==============================================================================
-- 5. BACKFILL 5: seniority (Integrating Seniority V2 Rules on 'unknown' rows)
-- ==============================================================================
-- Reclassifies 'unknown' or NULL seniority rows using refined Seniority V2 rules.
-- Excludes bare "executive" and "Account Executive" from director; maps managers to lead;
-- maps "Associate Manager" to mid; excludes "Lead Generation" from lead.

-- 5.1 Progress / Remaining count check:
-- Counts unclassified rows that match at least one V2 seniority rule.
SELECT COUNT(*) AS remaining_reclassifiable_seniority
FROM public.jobs
WHERE (seniority = 'unknown' OR seniority IS NULL)
  AND (
    title ~* '\y(director|vp|vice president|head of|chief [a-z]+ officer|executive director)\y'
    OR (title ~* '\ychief\y' AND title ~* '\y(executive|technology|operating|financial|information|product|revenue|marketing)\y')
    OR title ~* '\y(staff|principal|distinguished)\y'
    OR title ~* '\y(senior|sr\.?|level 3|l3|sde 3|sde iii|software engineer iii)\y'
    OR title ~* '\y(associate manager|assistant manager)\y'
    OR ((title ~* '\y(manager|general manager)\y' OR title ~* '(^|[,\-\/:|]\s*)lead\y' OR title ~* '\ylead($|[,\-\/:|])' OR title ~* '\y(team lead|tech lead|engineering lead|product lead|shift lead|alliance lead)\y') AND title !~* '\y(lead gen(eration)?|leads|lead capture)\y')
    OR (title ~* '\y(mid-level|intermediate|level 2|l2|sde 2|sde ii|software engineer ii)\y' OR (title ~* '\ymid\y' AND title !~* '\ymid-?market\y'))
    OR title ~* '\y(intern|internship|fresher|graduate|trainee|apprentice|junior|entry|entry-level|jr\.?|level 1|l1|sde 1|sde i|software engineer i)\y'
    OR (title ~* '\yassociate\y' AND title !~* '\y(account executive|sales executive|consulting executive)\y')
  );

-- 5.2 Single-batch update (Run repeatedly until remaining count is 0):
WITH batch AS (
  SELECT id
  FROM public.jobs
  WHERE (seniority = 'unknown' OR seniority IS NULL)
    AND (
      title ~* '\y(director|vp|vice president|head of|chief [a-z]+ officer|executive director)\y'
      OR (title ~* '\ychief\y' AND title ~* '\y(executive|technology|operating|financial|information|product|revenue|marketing)\y')
      OR title ~* '\y(staff|principal|distinguished)\y'
      OR title ~* '\y(senior|sr\.?|level 3|l3|sde 3|sde iii|software engineer iii)\y'
      OR title ~* '\y(associate manager|assistant manager)\y'
      OR ((title ~* '\y(manager|general manager)\y' OR title ~* '(^|[,\-\/:|]\s*)lead\y' OR title ~* '\ylead($|[,\-\/:|])' OR title ~* '\y(team lead|tech lead|engineering lead|product lead|shift lead|alliance lead)\y') AND title !~* '\y(lead gen(eration)?|leads|lead capture)\y')
      OR (title ~* '\y(mid-level|intermediate|level 2|l2|sde 2|sde ii|software engineer ii)\y' OR (title ~* '\ymid\y' AND title !~* '\ymid-?market\y'))
      OR title ~* '\y(intern|internship|fresher|graduate|trainee|apprentice|junior|entry|entry-level|jr\.?|level 1|l1|sde 1|sde i|software engineer i)\y'
      OR (title ~* '\yassociate\y' AND title !~* '\y(account executive|sales executive|consulting executive)\y')
    )
  ORDER BY id
  LIMIT 2000
)
UPDATE public.jobs j
SET seniority = CASE
  -- 1. Executive / Director level
  WHEN title ~* '\y(director|vp|vice president|head of|chief [a-z]+ officer|executive director)\y'
    OR (title ~* '\ychief\y' AND title ~* '\y(executive|technology|operating|financial|information|product|revenue|marketing)\y')
    THEN 'director'

  -- 2. Staff & Principal level
  WHEN title ~* '\y(staff|principal|distinguished)\y'
    THEN 'staff'

  -- 3. Senior level (Senior wins over account executive, e.g. Senior Enterprise Account Executive -> senior)
  WHEN title ~* '\y(senior|sr\.?|level 3|l3|sde 3|sde iii|software engineer iii)\y'
    THEN 'senior'

  -- 4. Mid-level management exemptions
  WHEN title ~* '\y(associate manager|assistant manager)\y'
    THEN 'mid'

  -- 5. Manager titles & contextual role Leads -> 'lead'
  WHEN (
    (title ~* '\y(manager|general manager)\y')
    OR (
      title ~* '(^|[,\-\/:|]\s*)lead\y'
      OR title ~* '\ylead($|[,\-\/:|])'
      OR title ~* '\y(team lead|tech lead|engineering lead|product lead|shift lead|alliance lead)\y'
    )
  )
  AND title !~* '\y(lead gen(eration)?|leads|lead capture)\y'
  THEN 'lead'

  -- 6. Mid level (explicit mid / intermediate, excluding "Mid-Market")
  WHEN title ~* '\y(mid-level|intermediate|level 2|l2|sde 2|sde ii|software engineer ii)\y'
    OR (title ~* '\ymid\y' AND title !~* '\ymid-?market\y')
    THEN 'mid'

  -- 7. Entry level & Internships
  WHEN title ~* '\y(intern|internship|fresher|graduate|trainee|apprentice)\y'
    THEN 'entry'
  WHEN title ~* '\y(junior|entry|entry-level|jr\.?|level 1|l1|sde 1|sde i|software engineer i)\y'
    THEN 'entry'
  WHEN title ~* '\yassociate\y'
    AND title !~* '\y(account executive|sales executive|consulting executive)\y'
    THEN 'entry'

  ELSE 'unknown'
END
FROM batch
WHERE j.id = batch.id;

-- 5.3 Post-backfill distribution check:
SELECT
  seniority,
  COUNT(*) AS count,
  ROUND(COUNT(*)::numeric / SUM(COUNT(*)) OVER () * 100, 2) AS percentage
FROM public.jobs
GROUP BY seniority
ORDER BY count DESC;
