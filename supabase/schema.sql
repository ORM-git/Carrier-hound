-- ============================================================
-- Career Hound — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- ── COMPANIES TABLE ──────────────────────────────────────────────────────────
create table if not exists public.companies (
  id               uuid        primary key default gen_random_uuid(),
  name             text        not null,
  slug             text        unique not null,
  canonical_domain text,
  category         text        check (category is null or category in ('MNC_BIGTECH', 'HIGH_PRODUCT_YC', 'OTHER_STARTUPS', 'INDIAN_IT_AND_OTHER')),
  logo_url         text,
  ats_type         text,
  careers_url      text,
  domain           text,
  country          text,
  country_code     text,
  enabled          boolean     default true,
  failure_count    integer     default 0,
  last_success_at  timestamptz,
  last_failure_at  timestamptz,
  last_job_count   integer     default 0,
  created_at       timestamptz default now()
);

-- ── JOBS TABLE ───────────────────────────────────────────────────────────────
create table if not exists public.jobs (
  id              uuid        primary key default gen_random_uuid(),
  company         text        not null,
  company_id      uuid        references public.companies(id) on delete set null,
  title           text        not null,
  location        text        not null,
  country         text,
  country_code    text,
  remote          boolean     default false,
  is_remote       boolean     default false,
  remote_scope    text        check (remote_scope in ('remote', 'hybrid', 'onsite', 'any')),
  remote_eligibility text,
  job_type        text        check (job_type in ('job', 'internship', 'full-time', 'part-time', 'contract', 'other')),
  category        text,
  role_category   text        check (role_category is null or role_category in ('SDE', 'AI_ML', 'CLOUD', 'DATA', 'OTHER')),
  top_keywords    text[]      default '{}'::text[],
  salary_text     text,                          -- e.g. "$120k–$160k" or null = "Not listed"
  salary_min      numeric,
  salary_max      numeric,
  salary_period   text,
  currency        text        default 'USD',
  description     text,                          -- Auth-gated — never returned to guests
  skills          text[],                        -- Auth-gated — never returned to guests
  apply_url       text,                          -- Auth-gated — direct ATS link
  logo_url        text,
  source          text,                          -- e.g. 'greenhouse', 'lever', 'ashby', 'remotive'
  source_type     text,                          -- e.g. 'ats', 'api', 'feed', 'direct'
  source_job_id   text,                          -- ID from source system
  source_url      text,                          -- The careers page this job was scraped from
  source_priority smallint    default 2 check (source_priority is null or source_priority in (1, 2)),
  dedupe_hash     text,                          -- SHA-256 of normalized company + normalized title + country + city
  verified        boolean     default false,
  posted_at       timestamptz default now(),
  discovered_at   timestamptz default now(),
  expires_at      timestamptz,
  first_seen_at   timestamptz default now(),
  last_seen_at    timestamptz default now(),
  is_active       boolean     default true,
  status          text        default 'active' check (status in ('active', 'expired')),
  created_at      timestamptz default now()
);

-- ── PROFILES TABLE ───────────────────────────────────────────────────────────
create table if not exists public.profiles (
  user_id      uuid        primary key references auth.users on delete cascade,
  full_name    text,
  target_roles text[],
  created_at   timestamptz default now()
);

-- ── ROW LEVEL SECURITY ───────────────────────────────────────────────────────
alter table public.jobs     enable row level security;
alter table public.profiles enable row level security;

-- Jobs: any authenticated or anonymous user can SELECT active jobs.
-- Full vs teaser field split is enforced in the API route, not RLS.
-- This keeps RLS simple and correct; the API is the enforcement point.
drop policy if exists "jobs_public_read" on public.jobs;
create policy "jobs_public_read"
  on public.jobs
  for select
  using (is_active = true or status = 'active');

-- Profiles: owner can read their own profile
drop policy if exists "profiles_owner_select" on public.profiles;
create policy "profiles_owner_select"
  on public.profiles
  for select
  using (auth.uid() = user_id);

-- Profiles: owner can insert their own profile
drop policy if exists "profiles_owner_insert" on public.profiles;
create policy "profiles_owner_insert"
  on public.profiles
  for insert
  with check (auth.uid() = user_id);

-- Profiles: owner can update their own profile
drop policy if exists "profiles_owner_update" on public.profiles;
create policy "profiles_owner_update"
  on public.profiles
  for update
  using (auth.uid() = user_id);

-- ── INDEXES ──────────────────────────────────────────────────────────────────
create index if not exists jobs_status_idx
  on public.jobs (status);

create index if not exists jobs_is_active_idx
  on public.jobs (is_active);

create index if not exists jobs_first_seen_idx
  on public.jobs (first_seen_at desc);

create index if not exists jobs_posted_at_idx
  on public.jobs (posted_at desc);

create index if not exists jobs_last_seen_at_idx
  on public.jobs (last_seen_at desc);

create index if not exists jobs_company_idx
  on public.jobs (company);

-- Unique index on (source, source_job_id) for reliable deduplication & upserts
create unique index if not exists jobs_source_source_job_id_unique
  on public.jobs (source, source_job_id)
  where source is not null and source_job_id is not null;

-- Partial indexes on is_active = true for fast filtering by category, country, and posted_at DESC
create index if not exists idx_jobs_active_category
  on public.jobs (category)
  where is_active = true;

create index if not exists idx_jobs_active_role_category
  on public.jobs (role_category)
  where is_active = true;

create index if not exists idx_jobs_active_country
  on public.jobs (country, country_code)
  where is_active = true;

create index if not exists idx_jobs_active_posted_at_desc
  on public.jobs (posted_at desc)
  where is_active = true;

create index if not exists idx_jobs_active_category_country_posted_at
  on public.jobs (category, country, posted_at desc)
  where is_active = true;

-- Prevent duplicate jobs from the same ATS (same apply URL = same job)
create unique index if not exists jobs_apply_url_unique
  on public.jobs (apply_url)
  where apply_url is not null;

-- ── AUTO-UPDATE last_seen_at FUNCTION ────────────────────────────────────────
-- When the ingestion worker touches an existing job, update last_seen_at.
create or replace function public.touch_job_last_seen()
returns trigger language plpgsql as $$
begin
  new.last_seen_at := now();
  return new;
end;
$$;

drop trigger if exists jobs_touch_last_seen on public.jobs;
create trigger jobs_touch_last_seen
  before update on public.jobs
  for each row execute function public.touch_job_last_seen();
