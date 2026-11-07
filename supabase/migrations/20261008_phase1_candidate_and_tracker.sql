-- ============================================================================
-- Phase 1 (v1.1) Migration: Candidate Profiles & Application Kanban Tracker
-- ============================================================================

-- 1. Candidate Profiles (Parsed & Confirmed Facts)
create table if not exists public.candidate_profiles (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  name              text,
  email             text,
  phone             text,
  headline          text,
  summary           text,
  skills            text[] default '{}',
  experience_json   jsonb default '[]'::jsonb,
  education_json    jsonb default '[]'::jsonb,
  certifications    text[] default '{}',
  raw_resume_text   text,
  confirmed_at      timestamptz,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- RLS on candidate_profiles
alter table public.candidate_profiles enable row level security;

drop policy if exists "candidate_profiles_owner_select" on public.candidate_profiles;
create policy "candidate_profiles_owner_select"
  on public.candidate_profiles for select
  using (auth.uid() = user_id);

drop policy if exists "candidate_profiles_owner_insert" on public.candidate_profiles;
create policy "candidate_profiles_owner_insert"
  on public.candidate_profiles for insert
  with check (auth.uid() = user_id);

drop policy if exists "candidate_profiles_owner_update" on public.candidate_profiles;
create policy "candidate_profiles_owner_update"
  on public.candidate_profiles for update
  using (auth.uid() = user_id);

drop policy if exists "candidate_profiles_owner_delete" on public.candidate_profiles;
create policy "candidate_profiles_owner_delete"
  on public.candidate_profiles for delete
  using (auth.uid() = user_id);

-- 2. Applications (Kanban Tracker)
create table if not exists public.applications (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete cascade,
  job_id            uuid references public.jobs(id) on delete set null,
  company           text not null,
  title             text not null,
  location          text,
  salary_text       text,
  apply_url         text,
  stage             text not null check (stage in ('saved', 'applied', 'interview', 'offer', 'rejected')) default 'saved',
  notes             text,
  applied_at        timestamptz,
  follow_up_at      timestamptz,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- Indexes for performance
create index if not exists applications_user_stage_idx
  on public.applications (user_id, stage);

create index if not exists applications_user_created_idx
  on public.applications (user_id, created_at desc);

-- RLS on applications
alter table public.applications enable row level security;

drop policy if exists "applications_owner_select" on public.applications;
create policy "applications_owner_select"
  on public.applications for select
  using (auth.uid() = user_id);

drop policy if exists "applications_owner_insert" on public.applications;
create policy "applications_owner_insert"
  on public.applications for insert
  with check (auth.uid() = user_id);

drop policy if exists "applications_owner_update" on public.applications;
create policy "applications_owner_update"
  on public.applications for update
  using (auth.uid() = user_id);

drop policy if exists "applications_owner_delete" on public.applications;
create policy "applications_owner_delete"
  on public.applications for delete
  using (auth.uid() = user_id);

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "candidate_profiles_owner_select" ON public.candidate_profiles;
--   DROP POLICY IF EXISTS "candidate_profiles_owner_insert" ON public.candidate_profiles;
--   DROP POLICY IF EXISTS "candidate_profiles_owner_update" ON public.candidate_profiles;
--   DROP POLICY IF EXISTS "candidate_profiles_owner_delete" ON public.candidate_profiles;
--   DROP POLICY IF EXISTS "applications_owner_select" ON public.applications;
--   DROP POLICY IF EXISTS "applications_owner_insert" ON public.applications;
--   DROP POLICY IF EXISTS "applications_owner_update" ON public.applications;
--   DROP POLICY IF EXISTS "applications_owner_delete" ON public.applications;
--   DROP INDEX IF EXISTS public.applications_user_stage_idx;
--   DROP INDEX IF EXISTS public.applications_user_created_idx;
--   ALTER TABLE public.candidate_profiles DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.applications DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.candidate_profiles CASCADE;
--   DROP TABLE IF EXISTS public.applications CASCADE;
-- ============================================================================
