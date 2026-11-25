-- Local-only fixture for sourceVisibility.postgrest.test.ts (real PostgREST + real Postgres, never production).
-- Columns mirror supabase/schema.sql public.jobs plus later additive columns the routes select; the view is the
-- current public.jobs_public definition (supabase/schema.generated.sql).

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator LOGIN PASSWORD 'local-only' NOINHERIT;
GRANT anon, authenticated, service_role TO authenticator;

CREATE TABLE public.companies (
  id uuid PRIMARY KEY, name text NOT NULL, slug text UNIQUE NOT NULL, canonical_domain text, category text,
  logo_url text, domain text
);

CREATE TABLE public.jobs (
  id uuid PRIMARY KEY, company text NOT NULL, company_id uuid REFERENCES public.companies(id), company_slug text,
  title text NOT NULL, location text NOT NULL, country text, country_code text,
  remote boolean DEFAULT false, is_remote boolean DEFAULT false, remote_scope text, remote_eligibility text,
  job_type text, category text, role_category text, top_keywords text[] DEFAULT '{}'::text[], seniority text,
  salary_text text, salary_min numeric, salary_max numeric, salary_period text, currency text DEFAULT 'USD',
  description text, skills text[], apply_url text, logo_url text,
  source text, source_type text, source_id text, source_job_id text, source_url text, source_priority smallint DEFAULT 2,
  dedupe_hash text, verified boolean DEFAULT false,
  posted_at timestamptz, discovered_at timestamptz, expires_at timestamptz, first_seen_at timestamptz, last_seen_at timestamptz,
  is_active boolean DEFAULT true, status text DEFAULT 'active', created_at timestamptz
);

CREATE TABLE public.user_preferences (
  user_id uuid PRIMARY KEY, roles text[], experience_level text, remote_preference text, locations text[],
  employment_types text[], categories text[], min_salary numeric, salary_currency text
);

CREATE VIEW public.jobs_public AS
SELECT id, title, location, remote, remote_scope, remote_eligibility, job_type, category, country, country_code,
  seniority, verified, source_type, first_seen_at, last_seen_at, discovered_at, posted_at, created_at, status, is_active,
  'Verified Employer'::text AS company, NULL::text AS salary_text, NULL::text AS description, NULL::text AS apply_url,
  '{}'::text[] AS skills, role_category, COALESCE(top_keywords, '{}'::text[]) AS top_keywords,
  COALESCE(is_remote, remote, false) AS is_remote
FROM public.jobs
WHERE is_active = true OR status = 'active';

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON public.jobs_public TO anon, authenticated, service_role;
GRANT SELECT ON public.jobs, public.companies, public.user_preferences TO service_role;

INSERT INTO public.companies (id, name, slug, domain) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'Acme', 'acme', 'acme.example'),
  ('c0000000-0000-4000-8000-000000000002', 'Globex', 'globex', 'globex.example');

-- id suffix: 1xx visible provider rows, 2xx jobspy (must stay hidden), 3xx NULL source_type (must stay visible).
INSERT INTO public.jobs (id, company, company_id, title, location, country_code, remote, is_remote, remote_scope, job_type,
  category, source, source_type, status, is_active, posted_at, created_at, first_seen_at, description, skills, apply_url) VALUES
  ('00000000-0000-4000-8000-000000000101', 'Acme',   'c0000000-0000-4000-8000-000000000001', 'Machine Learning Engineer', 'Bengaluru, India', 'IN', false, false, 'onsite', 'full-time', 'engineering', 'greenhouse', 'greenhouse', 'active', true, '2026-11-24T10:00:00Z', '2026-11-24T10:00:00Z', '2026-11-24T10:00:00Z', 'ML', '{Python}', 'https://jobs.example/101'),
  ('00000000-0000-4000-8000-000000000201', 'Acme',   'c0000000-0000-4000-8000-000000000001', 'Machine Learning Engineer', 'Bengaluru, India', 'IN', false, false, 'onsite', 'full-time', 'engineering', 'linkedin',   'jobspy',     'active', true, '2026-11-24T23:00:00Z', '2026-11-24T23:00:00Z', '2026-11-24T23:00:00Z', 'ML', '{Python}', 'https://jobs.example/201'),
  ('00000000-0000-4000-8000-000000000301', 'Globex', 'c0000000-0000-4000-8000-000000000002', 'AI Research Scientist',     'Remote',           'US', true,  true,  'remote', 'full-time', 'ai',          NULL,         NULL,         'active', true, '2026-11-24T09:00:00Z', '2026-11-24T09:00:00Z', '2026-11-24T09:00:00Z', 'AI', '{PyTorch}', 'https://jobs.example/301'),
  ('00000000-0000-4000-8000-000000000202', 'Globex', 'c0000000-0000-4000-8000-000000000002', 'AI Platform Lead',          'Remote',           'US', true,  true,  'remote', 'full-time', 'ai',          'indeed',     'jobspy',     'active', true, '2026-11-24T22:00:00Z', '2026-11-24T22:00:00Z', '2026-11-24T22:00:00Z', 'AI', '{Go}', 'https://jobs.example/202'),
  ('00000000-0000-4000-8000-000000000102', 'Acme',   'c0000000-0000-4000-8000-000000000001', 'Data Analyst',              'Pune (Hybrid)',    'IN', false, false, 'hybrid', 'full-time', 'data',        'lever',      'lever',      'active', true, '2026-11-24T08:00:00Z', '2026-11-24T08:00:00Z', '2026-11-24T08:00:00Z', 'SQL', '{SQL}', 'https://jobs.example/102'),
  ('00000000-0000-4000-8000-000000000203', 'Acme',   'c0000000-0000-4000-8000-000000000001', 'Data Analyst',              'Remote India',     'IN', false, false, 'remote', 'full-time', 'data',        'naukri',     'jobspy',     'active', true, '2026-11-24T21:00:00Z', '2026-11-24T21:00:00Z', '2026-11-24T21:00:00Z', 'SQL', '{SQL}', 'https://jobs.example/203'),
  ('00000000-0000-4000-8000-000000000103', 'Globex', 'c0000000-0000-4000-8000-000000000002', 'Senior Data Engineer',      'Berlin, Germany',  'DE', true,  true,  'remote', 'full-time', 'engineering', 'arbeitnow',  'arbeitnow',  'active', true, '2026-11-24T07:00:00Z', '2026-11-24T07:00:00Z', '2026-11-24T07:00:00Z', 'ETL', '{Spark}', 'https://jobs.example/103'),
  ('00000000-0000-4000-8000-000000000104', 'Acme',   'c0000000-0000-4000-8000-000000000001', 'Analytics Manager',         'Hyderabad, India', 'IN', false, false, 'onsite', 'full-time', 'operations',  'adzuna',     'adzuna',     'active', true, '2026-11-24T06:00:00Z', '2026-11-24T06:00:00Z', '2026-11-24T06:00:00Z', 'BI', '{Tableau}', 'https://jobs.example/104'),
  ('00000000-0000-4000-8000-000000000302', 'Globex', 'c0000000-0000-4000-8000-000000000002', 'Backend Engineer',          'Remote - US',      'US', false, false, 'any',    'full-time', 'engineering', NULL,         NULL,         'active', true, '2026-11-24T05:00:00Z', '2026-11-24T05:00:00Z', '2026-11-24T05:00:00Z', 'API', '{Go}', 'https://jobs.example/302'),
  ('00000000-0000-4000-8000-000000000204', 'Globex', 'c0000000-0000-4000-8000-000000000002', 'Backend Engineer',          'Remote',           'US', true,  true,  'remote', 'full-time', 'engineering', 'linkedin',   'jobspy',     'active', true, '2026-11-24T20:00:00Z', '2026-11-24T20:00:00Z', '2026-11-24T20:00:00Z', 'API', '{Go}', 'https://jobs.example/204'),
  ('00000000-0000-4000-8000-000000000105', 'Acme',   'c0000000-0000-4000-8000-000000000001', 'Frontend Developer',        'Hybrid - London',  'GB', false, false, 'hybrid', 'full-time', 'engineering', 'ashby',      'ashby',      'active', true, '2026-11-24T04:00:00Z', '2026-11-24T04:00:00Z', '2026-11-24T04:00:00Z', 'UI', '{React}', 'https://jobs.example/105'),
  ('00000000-0000-4000-8000-000000000106', 'Globex', 'c0000000-0000-4000-8000-000000000002', 'LLM Engineer',              'Chennai, India',   'IN', false, false, 'onsite', 'full-time', NULL,          'workday',    'workday',    'active', true, '2026-11-24T03:00:00Z', '2026-11-24T03:00:00Z', '2026-11-24T03:00:00Z', 'LLM', '{Python}', 'https://jobs.example/106'),
  ('00000000-0000-4000-8000-000000000205', 'Globex', 'c0000000-0000-4000-8000-000000000002', 'NLP Engineer',              'Chennai, India',   'IN', false, false, 'onsite', 'full-time', NULL,          'naukri',     'jobspy',     'active', true, '2026-11-24T19:00:00Z', '2026-11-24T19:00:00Z', '2026-11-24T19:00:00Z', 'NLP', '{Python}', 'https://jobs.example/205'),
  ('00000000-0000-4000-8000-000000000107', 'Acme',   'c0000000-0000-4000-8000-000000000001', 'Product Designer',          'Remote',           'US', true,  true,  'remote', 'full-time', 'design',      'lever',      'lever',      'active', true, '2026-11-24T02:00:00Z', '2026-11-24T02:00:00Z', '2026-11-24T02:00:00Z', 'UX', '{Figma}', 'https://jobs.example/107'),
  ('00000000-0000-4000-8000-000000000303', 'Acme',   'c0000000-0000-4000-8000-000000000001', 'Sales Executive',           'Mumbai, India',    'IN', false, false, 'onsite', 'full-time', 'sales',       NULL,         NULL,         'active', true, '2026-11-24T01:00:00Z', '2026-11-24T01:00:00Z', '2026-11-24T01:00:00Z', 'Sales', '{CRM}', 'https://jobs.example/303'),
  ('00000000-0000-4000-8000-000000000108', 'Globex', 'c0000000-0000-4000-8000-000000000002', 'Database Administrator',    'Remote',           'US', true,  true,  'remote', 'full-time', 'engineering', 'smartrecruiters', 'smartrecruiters', 'active', true, '2026-11-24T00:30:00Z', '2026-11-24T00:30:00Z', '2026-11-24T00:30:00Z', 'DBA', '{Postgres}', 'https://jobs.example/108'),
  ('00000000-0000-4000-8000-000000000109', 'Acme',   'c0000000-0000-4000-8000-000000000001', 'Data Scientist',            'Remote',           'US', true,  true,  'remote', 'full-time', 'data',        'greenhouse', 'greenhouse', 'expired', false, '2026-11-23T00:00:00Z', '2026-11-23T00:00:00Z', '2026-11-23T00:00:00Z', 'DS', '{R}', 'https://jobs.example/109');
