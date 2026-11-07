-- ==============================================================================
-- Migration: Create Worldwide Remote Company Counts View
-- Date: 2026-10-16
-- Scope: public.worldwide_company_counts view
-- Status: PENDING APPLICATION (Run in Supabase SQL editor by project owner)
--   If/when applied: record with  node scripts/record-migration.cjs 20261016_worldwide_company_counts
--
-- SECURITY & PAID LOCK DISCIPLINE:
-- Why this view does NOT bypass the paid lock on jobs data:
-- 1. Aggregated Metrics Only: It exposes solely the aggregate active job count
--    (COUNT(j.id)) per company. It does NOT expose individual job records,
--    descriptions, salary figures, applicant contact details, or direct ATS apply URLs.
-- 2. Whitelisted Entities Only: Restricted via WHERE clause strictly to companies
--    already publicly visible in the static CareerMonke directory (src/data/companies.json).
--    Guests never see more organizations than they do in the public catalog today.
-- 3. Strict Column Boundary: Exposes only (name, slug, country, active_job_count).
--    All Pro-gated fields remain fully guarded by RLS on public.jobs and the
--    server-verified /api/jobs/pro entitlement endpoint.
-- ==============================================================================

CREATE OR REPLACE VIEW public.worldwide_company_counts AS
SELECT
  c.name,
  c.slug,
  COALESCE(c.country, c.country_code, 'Worldwide') AS country,
  COUNT(j.id)::int AS active_job_count
FROM public.companies c
JOIN public.jobs j ON (j.company_id = c.id OR LOWER(TRIM(j.company)) = LOWER(TRIM(c.name)))
WHERE (j.is_active = true OR j.status = 'active')
  AND (
    j.remote_scope = 'worldwide'
    OR j.remote_eligibility = 'worldwide'
    OR j.location ILIKE '%worldwide%'
    OR j.location ILIKE '%anywhere%'
    OR j.location ILIKE '%global%'
    OR j.location ILIKE '%work from anywhere%'
  )
  AND c.slug IN (
    'openai', 'harvey', 'plaid', 'cohere', 'notion', 'supabase', 'cloudflare', 'databricks',
    'vanta', 'baseten', 'perplexity', 'samsara', 'cursor', 'synthesia', 'temporal', 'sentry',
    'elevenlabs', 'stripe', 'twilio', 'drata', 'gitlab', 'clickhouse', 'snowflake', 'webflow',
    'bitwarden', 'zapier', 'roblox', 'discord', 'midjourney', 'anyscale', 'llamaindex', 'replit',
    'deepgram', 'hopper', 'amplitude', 'coinbase', 'chainguard', 'zscaler', 'toast', 'sierra',
    'langchain', 'posthog', 'planetscale', 'airbnb', 'elastic', 'linear', 'watershed', 'runway',
    'confluent', '1password', 'klaviyo', 'lyft', 'duolingo', 'docker', 'coalition-technologies',
    'datadog', 'modal', 'pinecone', 'intercom', 'clickup', 'character-ai', 'infisical', 'deliveroo',
    'unio-digital', 'credit-wellness-llc', 'instacart', 'secureframe', 'snyk', 'warp', 'flexport',
    'neon', 'anthropic', 'launchdarkly', 'faire', 'sanctuary-computer-inc', 'iapwe', 'ramp'
  )
GROUP BY c.name, c.slug, c.country, c.country_code
HAVING COUNT(j.id) > 0
ORDER BY active_job_count DESC;

-- Grant read access to public and authenticated roles
GRANT SELECT ON public.worldwide_company_counts TO anon, authenticated, service_role;
