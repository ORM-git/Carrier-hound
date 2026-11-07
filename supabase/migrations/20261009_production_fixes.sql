-- ==============================================================================
-- PRODUCTION INTEGRITY & SCHEMA SYNCHRONIZATION MIGRATION (NON-DESTRUCTIVE)
-- Date: 2026-10-09
-- Scope: candidate_profiles, user_preferences, applications, daily_digests, subscriptions
-- Safe for execution on live Supabase production database (Idempotent: IF NOT EXISTS)
-- ==============================================================================

-- 1. CANDIDATE PROFILES
-- Ensure candidate_profiles table and missing columns exist
CREATE TABLE IF NOT EXISTS public.candidate_profiles (
  user_id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name              TEXT,
  email             TEXT,
  phone             TEXT,
  headline          TEXT,
  summary           TEXT,
  skills            TEXT[] DEFAULT '{}',
  experience_json   JSONB DEFAULT '[]'::jsonb,
  education_json    JSONB DEFAULT '[]'::jsonb,
  certifications    TEXT[] DEFAULT '{}',
  raw_resume_text   TEXT,
  confirmed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Add any missing columns defensively (non-destructive)
ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS experience_json JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS education_json JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS certifications TEXT[] DEFAULT '{}';
ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS raw_resume_text TEXT;

-- Enable RLS and idempotent policies for candidate_profiles
ALTER TABLE public.candidate_profiles ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'candidate_profiles' AND policyname = 'candidate_profiles_owner_select') THEN
    CREATE POLICY "candidate_profiles_owner_select" ON public.candidate_profiles FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'candidate_profiles' AND policyname = 'candidate_profiles_owner_insert') THEN
    CREATE POLICY "candidate_profiles_owner_insert" ON public.candidate_profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'candidate_profiles' AND policyname = 'candidate_profiles_owner_update') THEN
    CREATE POLICY "candidate_profiles_owner_update" ON public.candidate_profiles FOR UPDATE USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'candidate_profiles' AND policyname = 'candidate_profiles_owner_delete') THEN
    CREATE POLICY "candidate_profiles_owner_delete" ON public.candidate_profiles FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;


-- 2. USER PREFERENCES
CREATE TABLE IF NOT EXISTS public.user_preferences (
  user_id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  roles                TEXT[] DEFAULT '{}',
  categories           TEXT[] DEFAULT '{}',
  experience_level     TEXT,
  employment_types     TEXT[] DEFAULT '{}',
  locations            TEXT[] DEFAULT '{}',
  remote_preference    TEXT DEFAULT 'any',
  work_auth            TEXT,
  min_salary           NUMERIC,
  salary_currency      TEXT DEFAULT 'USD',
  daily_digest_opt_in  BOOLEAN DEFAULT TRUE,
  onboarding_completed BOOLEAN DEFAULT FALSE,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS and idempotent policies for user_preferences
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_preferences' AND policyname = 'user_preferences_owner_select') THEN
    CREATE POLICY "user_preferences_owner_select" ON public.user_preferences FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_preferences' AND policyname = 'user_preferences_owner_insert') THEN
    CREATE POLICY "user_preferences_owner_insert" ON public.user_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_preferences' AND policyname = 'user_preferences_owner_update') THEN
    CREATE POLICY "user_preferences_owner_update" ON public.user_preferences FOR UPDATE USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_preferences' AND policyname = 'user_preferences_owner_delete') THEN
    CREATE POLICY "user_preferences_owner_delete" ON public.user_preferences FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;


-- 3. APPLICATIONS TRACKER
CREATE TABLE IF NOT EXISTS public.applications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id            UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
  company           TEXT NOT NULL,
  title             TEXT NOT NULL,
  location          TEXT,
  salary_text       TEXT,
  apply_url         TEXT,
  stage             TEXT NOT NULL CHECK (stage IN ('saved', 'applied', 'interview', 'offer', 'rejected')) DEFAULT 'saved',
  notes             TEXT,
  applied_at        TIMESTAMPTZ,
  follow_up_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS applications_user_stage_idx ON public.applications (user_id, stage);
CREATE INDEX IF NOT EXISTS applications_user_created_idx ON public.applications (user_id, created_at DESC);

ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'applications' AND policyname = 'applications_owner_select') THEN
    CREATE POLICY "applications_owner_select" ON public.applications FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'applications' AND policyname = 'applications_owner_insert') THEN
    CREATE POLICY "applications_owner_insert" ON public.applications FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'applications' AND policyname = 'applications_owner_update') THEN
    CREATE POLICY "applications_owner_update" ON public.applications FOR UPDATE USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'applications' AND policyname = 'applications_owner_delete') THEN
    CREATE POLICY "applications_owner_delete" ON public.applications FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;


-- 4. DAILY DIGESTS
CREATE TABLE IF NOT EXISTS public.daily_digests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  digest_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  matched_jobs JSONB NOT NULL DEFAULT '[]'::jsonb,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'viewed')),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT daily_digests_user_date_unique UNIQUE (user_id, digest_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_digests_user_date ON public.daily_digests(user_id, digest_date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_digests_status ON public.daily_digests(status);

ALTER TABLE public.daily_digests ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'daily_digests' AND policyname = 'daily_digests_owner_select') THEN
    CREATE POLICY "daily_digests_owner_select" ON public.daily_digests FOR SELECT TO authenticated USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'daily_digests' AND policyname = 'daily_digests_owner_update') THEN
    CREATE POLICY "daily_digests_owner_update" ON public.daily_digests FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;


-- 5. SUBSCRIPTIONS & BILLING
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL CHECK (provider IN ('razorpay', 'stripe', 'manual')),
  customer_id          TEXT,
  subscription_id      TEXT,
  plan_id              TEXT NOT NULL DEFAULT 'domestic_monthly_199',
  currency             TEXT NOT NULL DEFAULT 'INR' CHECK (currency IN ('INR', 'USD', 'EUR', 'GBP')),
  amount               INT NOT NULL DEFAULT 19900,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trialing', 'in_grace_period', 'past_due', 'canceled', 'unpaid')),
  current_period_start TIMESTAMPTZ DEFAULT NOW(),
  current_period_end   TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
  grace_period_end     TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  metadata             JSONB DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT subscriptions_user_unique UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON public.subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON public.subscriptions(status);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'subscriptions' AND policyname = 'subscriptions_owner_select') THEN
    CREATE POLICY "subscriptions_owner_select" ON public.subscriptions FOR SELECT TO authenticated USING (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "daily_digests_owner_select" ON public.daily_digests;
--   DROP POLICY IF EXISTS "daily_digests_owner_update" ON public.daily_digests;
--   DROP POLICY IF EXISTS "subscriptions_owner_select" ON public.subscriptions;
--   ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS location;
--   ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS confirmed_at;
--   ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS experience_json;
--   ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS education_json;
--   ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS certifications;
--   ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS raw_resume_text;
--   NOTE: re-declares table public.candidate_profiles (created in 20261008_phase1_candidate_and_tracker.sql); rollback of THIS file does not drop it.
--   NOTE: re-declares table public.user_preferences (created in 20261008_phase4_user_preferences_and_onboarding.sql); rollback of THIS file does not drop it.
--   NOTE: re-declares table public.applications (created in 20261008_phase1_candidate_and_tracker.sql); rollback of THIS file does not drop it.
--   NOTE: re-declares table public.daily_digests (created in 20261008_phase2_daily_digest_cron.sql); rollback of THIS file does not drop it.
--   NOTE: re-declares table public.subscriptions (created in 20261008_phase3_subscriptions_and_billing.sql); rollback of THIS file does not drop it.
--   NOTE: re-declares index applications_user_stage_idx (created in 20261008_phase1_candidate_and_tracker.sql); not dropped here.
--   NOTE: re-declares index applications_user_created_idx (created in 20261008_phase1_candidate_and_tracker.sql); not dropped here.
--   NOTE: re-declares index idx_daily_digests_user_date (created in 20261008_phase2_daily_digest_cron.sql); not dropped here.
--   NOTE: re-declares index idx_daily_digests_status (created in 20261008_phase2_daily_digest_cron.sql); not dropped here.
--   NOTE: re-declares index idx_subscriptions_user_id (created in 20261008_phase3_subscriptions_and_billing.sql); not dropped here.
--   NOTE: re-declares index idx_subscriptions_status (created in 20261008_phase3_subscriptions_and_billing.sql); not dropped here.
--   NOTE: re-declares policy "candidate_profiles_owner_select" on public.candidate_profiles (from 20261008_phase1_candidate_and_tracker.sql).
--   NOTE: re-declares policy "candidate_profiles_owner_insert" on public.candidate_profiles (from 20261008_phase1_candidate_and_tracker.sql).
--   NOTE: re-declares policy "candidate_profiles_owner_update" on public.candidate_profiles (from 20261008_phase1_candidate_and_tracker.sql).
--   NOTE: re-declares policy "candidate_profiles_owner_delete" on public.candidate_profiles (from 20261008_phase1_candidate_and_tracker.sql).
--   NOTE: re-declares policy "user_preferences_owner_select" on public.user_preferences (from 20261008_phase4_user_preferences_and_onboarding.sql).
--   NOTE: re-declares policy "user_preferences_owner_insert" on public.user_preferences (from 20261008_phase4_user_preferences_and_onboarding.sql).
--   NOTE: re-declares policy "user_preferences_owner_update" on public.user_preferences (from 20261008_phase4_user_preferences_and_onboarding.sql).
--   NOTE: re-declares policy "user_preferences_owner_delete" on public.user_preferences (from 20261008_phase4_user_preferences_and_onboarding.sql).
--   NOTE: re-declares policy "applications_owner_select" on public.applications (from 20261008_phase1_candidate_and_tracker.sql).
--   NOTE: re-declares policy "applications_owner_insert" on public.applications (from 20261008_phase1_candidate_and_tracker.sql).
--   NOTE: re-declares policy "applications_owner_update" on public.applications (from 20261008_phase1_candidate_and_tracker.sql).
--   NOTE: re-declares policy "applications_owner_delete" on public.applications (from 20261008_phase1_candidate_and_tracker.sql).
--   NOTE: re-enables RLS on public.candidate_profiles (first enabled in 20261008_phase1_candidate_and_tracker.sql); rollback of THIS file leaves RLS as it was.
--   NOTE: re-enables RLS on public.user_preferences (first enabled in 20261008_phase4_user_preferences_and_onboarding.sql); rollback of THIS file leaves RLS as it was.
--   NOTE: re-enables RLS on public.applications (first enabled in 20261008_phase1_candidate_and_tracker.sql); rollback of THIS file leaves RLS as it was.
--   NOTE: re-enables RLS on public.daily_digests (first enabled in 20261008_phase2_daily_digest_cron.sql); rollback of THIS file leaves RLS as it was.
--   NOTE: re-enables RLS on public.subscriptions (first enabled in 20261008_phase3_subscriptions_and_billing.sql); rollback of THIS file leaves RLS as it was.
-- ============================================================================
