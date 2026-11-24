-- Company profile storage for the Company tab. Additive; do not apply automatically.
-- ROLLBACK (manual, data-preserving): revert the API/UI first and leave these profile
-- tables in place. No existing rows are updated here. Before any later manual DROP,
-- export and hash each table, verify the export, then remove only these three tables
-- and their indexes after confirming no reader or writer depends on them.
-- NOTE: retaining the additive tables is the recovery path; never discard populated data.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.company_profile_facts (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fact_key text NOT NULL CHECK (fact_key IN ('overview','website','headquarters','founded_year','employee_count_range','linkedin_url','twitter_url')),
  fact_value text NOT NULL CHECK (length(fact_value) <= 700),
  source_url text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('official_site','official_report','official_announcement')),
  observed_at timestamptz,
  fact_status text NOT NULL DEFAULT 'fresh' CHECK (fact_status IN ('fresh','stale','conflict')),
  conflict_value text,
  conflict_source_url text,
  conflict_source_kind text CHECK (conflict_source_kind IS NULL OR conflict_source_kind IN ('official_site','official_report','official_announcement')),
  conflict_retrieved_at timestamptz,
  conflict_observed_at timestamptz,
  retrieved_at timestamptz NOT NULL,
  PRIMARY KEY (company_id, fact_key)
);

ALTER TABLE public.company_profile_facts ADD COLUMN IF NOT EXISTS fact_status text NOT NULL DEFAULT 'fresh';
ALTER TABLE public.company_profile_facts ADD COLUMN IF NOT EXISTS conflict_value text;
ALTER TABLE public.company_profile_facts ADD COLUMN IF NOT EXISTS conflict_source_url text;
ALTER TABLE public.company_profile_facts ADD COLUMN IF NOT EXISTS conflict_source_kind text;
ALTER TABLE public.company_profile_facts ADD COLUMN IF NOT EXISTS conflict_retrieved_at timestamptz;
ALTER TABLE public.company_profile_facts ADD COLUMN IF NOT EXISTS conflict_observed_at timestamptz;
DO $$ BEGIN
  ALTER TABLE public.company_profile_facts ADD CONSTRAINT company_profile_facts_status_check CHECK (fact_status IN ('fresh','stale','conflict'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.company_profile_leadership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) <= 100),
  role text NOT NULL CHECK (length(role) <= 120),
  role_as_of date,
  source_url text NOT NULL,
  retrieved_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS public.company_profile_news (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  headline text NOT NULL CHECK (length(headline) <= 220),
  published_at timestamptz NOT NULL,
  source_url text NOT NULL,
  excerpt text CHECK (length(excerpt) <= 300),
  retrieved_at timestamptz NOT NULL,
  UNIQUE (company_id, source_url)
);

CREATE TABLE IF NOT EXISTS public.company_profile_refresh_state (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('fresh','stale','conflict')),
  last_attempted_at timestamptz NOT NULL,
  last_succeeded_at timestamptz,
  next_refresh_at timestamptz NOT NULL,
  last_error text CHECK (length(last_error) <= 500)
);

CREATE INDEX IF NOT EXISTS company_profile_leadership_company_idx ON public.company_profile_leadership(company_id, role_as_of DESC);
ALTER TABLE public.company_profile_leadership DROP CONSTRAINT IF EXISTS company_profile_leadership_company_id_name_role_role_as_of_key;
CREATE UNIQUE INDEX IF NOT EXISTS company_profile_leadership_identity_idx ON public.company_profile_leadership(company_id, name, role, role_as_of) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS company_profile_news_company_idx ON public.company_profile_news(company_id, published_at DESC);
CREATE INDEX IF NOT EXISTS jobs_company_active_posted_idx ON public.jobs(company_id, posted_at DESC NULLS LAST, id DESC) WHERE is_active = true AND status = 'active';

CREATE OR REPLACE FUNCTION public.record_company_profile_leadership_observation(p_observations jsonb)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $function$
  INSERT INTO public.company_profile_leadership(company_id,name,role,role_as_of,source_url,retrieved_at)
  SELECT observation.company_id, observation.name, observation.role, observation.role_as_of, observation.source_url, observation.retrieved_at
  FROM pg_catalog.jsonb_to_recordset(p_observations) AS observation(
    company_id uuid, name text, role text, role_as_of date, source_url text, retrieved_at timestamptz
  )
  ON CONFLICT (company_id,name,role,role_as_of)
  DO UPDATE SET retrieved_at = EXCLUDED.retrieved_at;
$function$;

CREATE OR REPLACE FUNCTION public.record_company_profile_news_observation(p_observations jsonb)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $function$
  INSERT INTO public.company_profile_news(company_id,headline,published_at,source_url,excerpt,retrieved_at)
  SELECT observation.company_id, observation.headline, observation.published_at, observation.source_url, observation.excerpt, observation.retrieved_at
  FROM pg_catalog.jsonb_to_recordset(p_observations) AS observation(
    company_id uuid, headline text, published_at timestamptz, source_url text, excerpt text, retrieved_at timestamptz
  )
  ON CONFLICT (company_id,source_url)
  DO UPDATE SET retrieved_at = EXCLUDED.retrieved_at;
$function$;

REVOKE ALL ON FUNCTION public.record_company_profile_leadership_observation(jsonb), public.record_company_profile_news_observation(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_company_profile_leadership_observation(jsonb), public.record_company_profile_news_observation(jsonb) TO service_role;

ALTER TABLE public.company_profile_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_profile_leadership ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_profile_news ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_profile_refresh_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_profile_facts, public.company_profile_leadership, public.company_profile_news, public.company_profile_refresh_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.company_profile_facts, public.company_profile_leadership, public.company_profile_news, public.company_profile_refresh_state TO service_role;
COMMIT;
