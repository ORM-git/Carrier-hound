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
  retrieved_at timestamptz NOT NULL,
  PRIMARY KEY (company_id, fact_key)
);

CREATE TABLE IF NOT EXISTS public.company_profile_leadership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) <= 100),
  role text NOT NULL CHECK (length(role) <= 120),
  role_as_of date,
  source_url text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  UNIQUE (company_id, name, role, role_as_of)
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

CREATE INDEX IF NOT EXISTS company_profile_leadership_company_idx ON public.company_profile_leadership(company_id, role_as_of DESC);
CREATE INDEX IF NOT EXISTS company_profile_news_company_idx ON public.company_profile_news(company_id, published_at DESC);
CREATE INDEX IF NOT EXISTS jobs_company_active_posted_idx ON public.jobs(company_id, posted_at DESC NULLS LAST, id DESC) WHERE is_active = true AND status = 'active';

ALTER TABLE public.company_profile_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_profile_leadership ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_profile_news ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_profile_facts, public.company_profile_leadership, public.company_profile_news FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.company_profile_facts, public.company_profile_leadership, public.company_profile_news TO service_role;
COMMIT;
