-- ==============================================================================
-- DO NOT APPLY / REVIEW PENDING — SENIORITY DERIVATION RULES V2 (DRAFT)
-- CareerMonke (Carrier-hound) — Seniority Taxonomy V2
-- File: supabase/scripts/seniority-v2-draft.sql
-- Status: UNDER REVIEW — DO NOT RUN UPDATES ON LIVE PRODUCTION DATABASE
--
-- PURPOSE:
-- Refines seniority categorization to resolve false-positive anomalies discovered
-- in live preflight audit:
-- 1. "Account Executive" titles incorrectly categorized as 'director' by bare "executive".
--    Resolved: Director only matches explicit director, VP, vice president, head of,
--    chief [X] officer, executive director. Bare "executive" and "Account Executive" excluded.
-- 2. Manager roles and role-word Leads categorized as 'lead':
--    Engineering Manager, Sales Manager, Events Program Manager, Shift Lead, Product Lead -> 'lead'.
-- 3. "Associate Manager" and "Assistant Manager" mapped to 'mid'.
-- 4. Excluded lead-generation marketing titles:
--    "Lead Generation", "Lead Gen", "Leads" -> NOT lead (default to unknown).
-- 5. "Mid-Market" exclusion: "Sales Manager, Mid-Market - APAC" must not falsely match 'mid'.
-- 6. "Senior" precedence: "Senior Enterprise Account Executive" -> 'senior'.
-- 7. Account Executive without Senior -> 'unknown'.
-- 8. Staff / Principal caveat: non-engineering "Staff Nurse" / "Staff Accountant" will match 'staff'.
-- ==============================================================================


-- ==============================================================================
-- PART 1: READ-ONLY DRY-RUN COUNTS QUERY (FOR SUPABASE SQL EDITOR)
-- Compares live DB current_seniority vs. Proposed V2 seniority without any updates.
-- ==============================================================================
WITH rederived AS (
  SELECT
    id,
    seniority AS current_seniority,
    CASE
      -- 1. Executive / Director level
      -- Matches: Director, Executive Director, VP, Vice President, Head of, Chief [X] Officer
      WHEN title ~* '\y(director|vp|vice president|head of|chief [a-z]+ officer|executive director)\y'
        OR (title ~* '\ychief\y' AND title ~* '\y(executive|technology|operating|financial|information|product|revenue|marketing)\y')
        OR title ~* '\y(cto|cpo|ceo|cfo|coo|ciso)\y'
        THEN 'director'

      -- 2. Staff & Principal level
      -- Matches: staff, principal, distinguished, fellow.
      -- EXCLUDES: "Chief of Staff" (unknown), "Member of Technical Staff" (MTS -> unknown, SMTS -> senior)
      WHEN title ~* '\y(staff|principal|distinguished|fellow)\y'
        AND title !~* '\y(chief of staff|member of technical staff)\y'
        THEN 'staff'

      -- 3. Senior level
      -- "Senior"/"Sr." WINS over account executive roles (e.g. Senior Enterprise Account Executive -> senior)
      WHEN title ~* '\y(senior|sr\.?|level 3|l3|sde 3|sde iii|software engineer iii)\y'
        THEN 'senior'

      -- 4. Mid-level management exemptions
      -- Associate Manager and Assistant Manager win over general manager -> 'mid'
      WHEN title ~* '\y(associate manager|assistant manager)\y'
        THEN 'mid'

      -- 5. Manager titles & contextual role Leads -> 'lead'
      -- EXCLUDES: "Lead Generation", "Lead Gen", "Leads"
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

      -- 6. Mid level (explicit mid / intermediate, strictly excluding "Mid-Market")
      WHEN title ~* '\y(mid-level|intermediate|level 2|l2|sde 2|sde ii|software engineer ii)\y'
        OR (title ~* '\ymid\y' AND title !~* '\ymid-?market\y')
        THEN 'mid'

      -- 7. Entry level & Internships
      -- STRICTLY EXCLUDES: "Data Entry" (Data Entry Clerk -> unknown)
      WHEN title ~* '\y(intern|internship|fresher|graduate|trainee|apprentice)\y'
        THEN 'entry'
      WHEN (title ~* '\y(junior|entry|entry-level|jr\.?|level 1|l1|sde 1|sde i|software engineer i)\y'
        OR (title ~* '\yassociate\y' AND title !~* '\y(account executive|sales executive|consulting executive)\y'))
        AND title !~* '\ydata entry\y'
        THEN 'entry'

      -- 8. Default unranked roles to unknown
      ELSE 'unknown'
    END AS proposed_seniority_v2
  FROM public.jobs
)
SELECT
  current_seniority,
  proposed_seniority_v2,
  COUNT(*) AS count,
  ROUND(COUNT(*)::numeric / SUM(COUNT(*)) OVER (PARTITION BY current_seniority) * 100, 1) AS pct_of_current_label
FROM rederived
GROUP BY current_seniority, proposed_seniority_v2
ORDER BY current_seniority, count DESC;
