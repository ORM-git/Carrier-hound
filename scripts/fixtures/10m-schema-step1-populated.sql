-- ============================================================================
-- scripts/fixtures/10m-schema-step1-populated.sql
-- Synthetic, deterministic fixture for the PR #643 rehearsal (no customer data, no randomness).
-- Loaded AFTER supabase/schema.sql + the repo migration chain (post-#645), BEFORE 20261116b.
--
-- Shape (small-fixture correctness only, not a scale test):
--   3 synthetic auth users, 12 companies (Unicode names, valid + NULL category),
--   240 jobs: 4 vendors, cross-vendor identical external ids, active + inactive, NULL salary/country,
--   Unicode titles, fixed historical last_seen_at, text source_id (post-#645 type),
--   16 cross-source active pairs sharing one dedupe_hash (the same posting seen on two vendors,
--   which #645 explicitly keeps as advisory, NOT unique), 120 job_descriptions, 9 saved_jobs.
-- ============================================================================

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'fixture-user-1@example.invalid'),
  ('00000000-0000-4000-8000-0000000000a2', 'fixture-user-2@example.invalid'),
  ('00000000-0000-4000-8000-0000000000a3', 'fixture-user-3@example.invalid');

INSERT INTO public.companies (id, name, slug, domain, country_code, category, canonical_domain, enabled)
SELECT
  ('00000000-0000-4000-8000-0000000c' || lpad(g::text, 4, '0'))::uuid,
  (ARRAY['Acme Corp', 'Zürich Labs', 'Société Générale Tech', '株式会社テスト', 'Bengaluru Byte',
         'São Paulo Data', 'Kraków Systems', 'Ünicode GmbH', 'Null Category Inc', 'Delta Cloud',
         'Ελληνική AI', 'Fixture Twelve'])[g],
  'fixture-company-' || g,
  'company' || g || '.example.invalid',
  (ARRAY['US','CH','FR','JP','IN','BR','PL','DE',NULL,'US','GR','IN'])[g],
  (ARRAY['MNC_BIGTECH','HIGH_PRODUCT_YC','OTHER_STARTUPS','INDIAN_IT_AND_OTHER',NULL])[1 + (g % 5)],
  CASE WHEN g % 3 = 0 THEN NULL ELSE 'company' || g || '.example.invalid' END,
  g % 7 <> 0
FROM generate_series(1, 12) g;

-- 240 jobs: vendor = g % 4, external id repeats across vendors (cross-vendor collision by design)
INSERT INTO public.jobs (
  id, company, company_id, title, location, remote, remote_scope, remote_eligibility, job_type,
  salary_text, salary_min, salary_max, currency, salary_period, apply_url, source, source_job_id, source_id,
  source_type, category, country, country_code, posted_at, first_seen_at, last_seen_at, is_active, status,
  dedupe_hash, created_at
)
SELECT
  ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
  (ARRAY['Acme Corp', 'Zürich Labs', 'Société Générale Tech', '株式会社テスト', 'Bengaluru Byte',
         'São Paulo Data', 'Kraków Systems', 'Ünicode GmbH', 'Null Category Inc', 'Delta Cloud',
         'Ελληνική AI', 'Fixture Twelve'])[1 + (g % 12)],
  ('00000000-0000-4000-8000-0000000c' || lpad((1 + (g % 12))::text, 4, '0'))::uuid,
  (ARRAY['Software Engineer', 'Ingénieur logiciel', '软件工程师', 'Développeuse Full-Stack 🚀',
         'Инженер-программист', 'Data Analyst Intern', 'Senior SRE', 'ML Engineer (LLM)',
         'Backend Engineer – Payments', 'Ünïcödé QA'])[1 + (g % 10)] || ' #' || g,
  (ARRAY['Remote (Worldwide)', 'Bengaluru, India', 'Zürich, Switzerland', 'Austin, TX', 'Remote, United States', 'São Paulo, Brazil'])[1 + (g % 6)],
  (g % 6) IN (0, 4),
  (ARRAY['remote', 'onsite', 'onsite', 'onsite', 'remote', 'hybrid'])[1 + (g % 6)],
  (ARRAY['worldwide', NULL, NULL, NULL, 'country_restricted', NULL])[1 + (g % 6)],
  (ARRAY['full-time', 'internship', 'contract', 'part-time', 'full-time'])[1 + (g % 5)],
  CASE WHEN g % 4 = 0 THEN NULL ELSE '₹' || (g * 1000) || ' / month' END,
  CASE WHEN g % 4 = 0 THEN NULL ELSE g * 1000 END,
  CASE WHEN g % 4 = 0 THEN NULL ELSE g * 1500 END,
  CASE WHEN g % 4 = 0 THEN NULL ELSE (ARRAY['INR', 'USD', 'EUR'])[1 + (g % 3)] END,
  CASE WHEN g % 4 = 0 THEN NULL ELSE 'monthly' END,
  'https://apply.example.invalid/' || (ARRAY['greenhouse', 'lever', 'ashby', 'remotive'])[1 + (g % 4)] || '/' || g,
  (ARRAY['greenhouse', 'lever', 'ashby', 'remotive'])[1 + (g % 4)],
  -- external ids collide across vendors: ids 1..60 each appear once per vendor
  (1 + ((g - 1) / 4))::text,
  (ARRAY['src-greenhouse', 'src-lever', 'src-ashby', 'src-remotive'])[1 + (g % 4)],
  (ARRAY['ats', 'ats', 'ats', 'api'])[1 + (g % 4)],
  (ARRAY['engineering', 'ai', 'data', NULL])[1 + (g % 4)],
  CASE WHEN g % 9 = 0 THEN NULL ELSE (ARRAY['United States', 'India', 'Switzerland', 'Brazil'])[1 + (g % 4)] END,
  CASE WHEN g % 9 = 0 THEN NULL ELSE (ARRAY['US', 'IN', 'CH', 'BR'])[1 + (g % 4)] END,
  timestamptz '2026-10-01 00:00:00+00' + (g || ' hours')::interval,
  timestamptz '2026-09-01 00:00:00+00' + (g || ' hours')::interval,
  timestamptz '2026-11-01 00:00:00+00' + (g || ' minutes')::interval,
  -- pair members (1..32) are always active: genuine cross-source active duplicates
  g <= 32 OR g % 5 <> 0,
  CASE WHEN g > 32 AND g % 5 = 0 THEN 'expired' ELSE 'active' END,
  -- jobs 1..32 form 16 cross-source pairs (g and g+1 on different vendors) sharing a similarity hash
  CASE WHEN g <= 32 THEN 'simhash-pair-' || ((g + 1) / 2) ELSE 'simhash-' || g END,
  timestamptz '2026-09-01 00:00:00+00' + (g || ' hours')::interval
FROM generate_series(1, 240) g;

INSERT INTO public.job_descriptions (job_id, description_text, updated_at)
SELECT id, 'Synthetic description for ' || title || E'\nUnicode: café, naïve, 日本語, emoji 🚀', timestamptz '2026-11-02 00:00:00+00'
FROM public.jobs WHERE (substring(id::text from 25)::int % 2) = 0;

INSERT INTO public.saved_jobs (user_id, job_id, created_at)
SELECT u.id, ('00000000-0000-4000-8000-' || lpad((u.n * 10 + k)::text, 12, '0'))::uuid, timestamptz '2026-11-03 00:00:00+00'
FROM (VALUES ('00000000-0000-4000-8000-0000000000a1'::uuid, 1), ('00000000-0000-4000-8000-0000000000a2'::uuid, 2),
             ('00000000-0000-4000-8000-0000000000a3'::uuid, 3)) AS u(id, n)
CROSS JOIN generate_series(1, 3) k;
