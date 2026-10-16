-- owner runs in Supabase SQL Editor; agent does not run it
-- ==============================================================================
-- View: public.worldwide_company_counts
-- Purpose: Safely exposes active worldwide remote job counts per company
--          to anonymous and authenticated clients WITHOUT exposing locked
--          job fields (descriptions, salaries, apply URLs).
-- ==============================================================================

CREATE OR REPLACE VIEW public.worldwide_company_counts AS
SELECT
  c.id,
  c.name,
  c.slug,
  c.country,
  COUNT(j.id)::int AS job_count
FROM public.companies c
JOIN public.jobs j ON (j.company_id = c.id OR LOWER(TRIM(j.company)) = LOWER(TRIM(c.name)))
WHERE j.is_active = true
  AND j.status = 'active'
  AND (
    j.remote_scope = 'worldwide'
    OR j.remote_eligibility = 'worldwide'
    OR j.location ILIKE '%worldwide%'
    OR j.location ILIKE '%anywhere%'
    OR j.location ILIKE '%global%'
    OR j.location ILIKE '%work from anywhere%'
  )
GROUP BY c.id, c.name, c.slug, c.country
HAVING COUNT(j.id) > 0
ORDER BY job_count DESC;

-- Grant public read access to anon and authenticated roles
GRANT SELECT ON public.worldwide_company_counts TO anon, authenticated, service_role;
