-- ==============================================================================
-- DO NOT APPLY / REVIEW PENDING — RELABEL SENIORITY TAXONOMY V2 (SINGLE-BATCH)
-- CareerMonke (Carrier-hound) — Database Remediation: Seniority Alignment
-- File: supabase/scripts/relabel-seniority-draft.sql
-- Status: UNDER REVIEW — DO NOT RUN ON LIVE PRODUCTION DATABASE
--
-- PURPOSE:
-- Recomputes seniority for ALL rows in public.jobs based on job title using
-- the reconciled Seniority V2 rules.
--
-- OPERATIONAL DESIGN (SUPABASE SQL EDITOR SAFE):
-- 1. Single-batch execution: processes up to 2,000 rows per run (LIMIT 2000).
-- 2. Strictly idempotent: only touches rows where current seniority IS DISTINCT FROM
--    the newly evaluated V2 result. Once updated, rows are excluded from subsequent runs.
-- 3. The operator runs the remaining count query, then executes the single-batch update
--    repeatedly until the remaining count reaches 0.
--
-- ROLLBACK STRATEGY (BACKUP COLUMN PRE-RUN):
-- Before running Batch 1, create and populate a backup column:
--   ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS seniority_old text;
--   UPDATE public.jobs SET seniority_old = seniority WHERE seniority_old IS NULL;
--
-- If rollback is required to restore historical classifications:
--   UPDATE public.jobs SET seniority = seniority_old WHERE seniority_old IS NOT NULL;
--   ALTER TABLE public.jobs DROP COLUMN IF EXISTS seniority_old;
-- ==============================================================================


-- ==============================================================================
-- 1. PRE-RUN / PROGRESS COUNT CHECK (RUN IN SUPABASE SQL EDITOR)
-- ==============================================================================
-- Returns the count of rows whose current seniority differs from the V2 derivation.
-- When this returns 0, the relabeling process is 100% complete.

WITH evaluated AS (
  SELECT
    id,
    seniority,
    CASE
      -- 1. Executive / Director level
      -- Matches: Director, Executive Director, VP, Vice President, Head of, Chief [X] Officer
      -- EXCLUDES: Bare "executive", "Account Executive", "Sales Executive", "Executive Assistant"
      WHEN title ~* '\y(director|vp|vice president|head of|chief [a-z]+ officer|executive director)\y'
        OR (title ~* '\ychief\y' AND title ~* '\y(executive|technology|operating|financial|information|product|revenue|marketing)\y')
        OR title ~* '\y(cto|cpo|ceo|cfo|coo|ciso)\y'
        THEN 'director'

      -- 2. Staff & Principal level
      -- Matches: staff, principal, distinguished, fellow
      -- EXCLUDES: "Chief of Staff" (unknown), "Member of Technical Staff" (MTS -> unknown, SMTS -> senior)
      WHEN title ~* '\y(staff|principal|distinguished|fellow)\y'
        AND title !~* '\y(chief of staff|member of technical staff)\y'
        THEN 'staff'

      -- 3. Senior level (BEFORE manager/lead)
      -- "Senior"/"Sr." WINS over account executive roles and general managers (Senior Engineering Manager -> senior)
      -- Excludes bare "iii/iv", "specialist", "expert", and bare "l3" mistakes
      WHEN title ~* '\y(senior|sr\.?|level 3|sde 3|sde iii|software engineer iii)\y'
        THEN 'senior'

      -- 4. Mid-level management exemptions
      -- Associate Manager and Assistant Manager win over general manager -> 'mid'
      WHEN title ~* '\y(associate manager|assistant manager)\y'
        THEN 'mid'

      -- 5. Manager titles & contextual role Leads -> 'lead'
      -- EXCLUDES: "Lead Generation", "Lead Gen", "Leads", "Lead Capture"
      WHEN (
        (title ~* '\y(manager|general manager)\y')
        OR (
          title ~* '(^|[,\-\/:|]\s*)lead\y'
          OR title ~* '\ylead($|[,\-\/:|])'
          OR title ~* '\y(team lead|tech lead|engineering lead|product lead|shift lead|alliance lead|lead engineer|lead developer|lead architect|lead data scientist)\y'
        )
      )
      AND title !~* '\y(lead gen(eration)?|leads|lead capture)\y'
      THEN 'lead'

      -- 6. Mid level (explicit mid / intermediate, strictly excluding "Mid-Market")
      WHEN title ~* '\y(mid-level|intermediate|level 2|l2|sde 2|sde ii|software engineer ii)\y'
        OR (title ~* '\ymid\y' AND title !~* '\ymid-?market\y')
        THEN 'mid'

      -- 7. Entry level & Internships
      -- STRICTLY EXCLUDES: "Data Entry" (Data Entry Clerk -> unknown)
      -- STRICTLY EXCLUDES: Sales/Account/Consulting Executives when matching "associate"
      WHEN title ~* '\y(intern|internship|fresher|graduate|grad|trainee|apprentice|co-op|campus|new grad)\y'
        THEN 'entry'
      WHEN (title ~* '\y(junior|entry|entry-level|jr\.?|level 1|l1|sde 1|sde i|software engineer i)\y'
        OR (title ~* '\yassociate\y' AND title !~* '\y(account executive|sales executive|consulting executive)\y'))
        AND title !~* '\ydata entry\y'
        THEN 'entry'

      -- 8. Default unranked roles to unknown
      ELSE 'unknown'
    END AS v2_seniority
  FROM public.jobs
)
SELECT COUNT(*) AS remaining_rows_to_relabel
FROM evaluated
WHERE seniority IS DISTINCT FROM v2_seniority;


-- ==============================================================================
-- 2. RE-RUNNABLE SINGLE-BATCH UPDATE (LIMIT 2000 PER RUN)
-- ==============================================================================
-- Execute repeatedly in Supabase SQL Editor until the query above returns 0.

WITH evaluated AS (
  SELECT
    id,
    CASE
      -- 1. Executive / Director level
      WHEN title ~* '\y(director|vp|vice president|head of|chief [a-z]+ officer|executive director)\y'
        OR (title ~* '\ychief\y' AND title ~* '\y(executive|technology|operating|financial|information|product|revenue|marketing)\y')
        OR title ~* '\y(cto|cpo|ceo|cfo|coo|ciso)\y'
        THEN 'director'

      -- 2. Staff & Principal level
      WHEN title ~* '\y(staff|principal|distinguished|fellow)\y'
        AND title !~* '\y(chief of staff|member of technical staff)\y'
        THEN 'staff'

      -- 3. Senior level (BEFORE manager/lead)
      WHEN title ~* '\y(senior|sr\.?|level 3|sde 3|sde iii|software engineer iii)\y'
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
          OR title ~* '\y(team lead|tech lead|engineering lead|product lead|shift lead|alliance lead|lead engineer|lead developer|lead architect|lead data scientist)\y'
        )
      )
      AND title !~* '\y(lead gen(eration)?|leads|lead capture)\y'
      THEN 'lead'

      -- 6. Mid level (explicit mid / intermediate, strictly excluding "Mid-Market")
      WHEN title ~* '\y(mid-level|intermediate|level 2|l2|sde 2|sde ii|software engineer ii)\y'
        OR (title ~* '\ymid\y' AND title !~* '\ymid-?market\y')
        THEN 'mid'

      -- 7. Entry level & Internships
      WHEN title ~* '\y(intern|internship|fresher|graduate|grad|trainee|apprentice|co-op|campus|new grad)\y'
        THEN 'entry'
      WHEN (title ~* '\y(junior|entry|entry-level|jr\.?|level 1|l1|sde 1|sde i|software engineer i)\y'
        OR (title ~* '\yassociate\y' AND title !~* '\y(account executive|sales executive|consulting executive)\y'))
        AND title !~* '\ydata entry\y'
        THEN 'entry'

      -- 8. Default unranked roles to unknown
      ELSE 'unknown'
    END AS v2_seniority
  FROM public.jobs
),
batch AS (
  SELECT e.id, e.v2_seniority
  FROM evaluated e
  JOIN public.jobs j ON j.id = e.id
  WHERE j.seniority IS DISTINCT FROM e.v2_seniority
  ORDER BY e.id
  LIMIT 2000
)
UPDATE public.jobs j
SET seniority = batch.v2_seniority
FROM batch
WHERE j.id = batch.id;


-- ==============================================================================
-- 3. POST-REMEDIATION VERIFICATION
-- ==============================================================================
SELECT
  seniority,
  COUNT(*) AS count,
  ROUND(COUNT(*)::numeric / SUM(COUNT(*)) OVER () * 100, 2) AS percentage
FROM public.jobs
GROUP BY seniority
ORDER BY count DESC;
