-- PROPOSED, NOT APPLIED. Owner-run only; nothing in the app or CI executes this file.
-- Columns for the reference-video facets that have NO column anywhere in the repo schema. Adding a column populates
-- nothing: every facet below stays BLOCKED until a named source fills it and video_facets_coverage.READONLY.sql shows
-- the coverage the owner accepts. Names and types are a proposal for review; no source has been chosen.
-- All nullable, no defaults: NULL means "unknown", never "no".

-- Company-level facets (one value per company, not per posting).
alter table public.companies add column if not exists industry text;
alter table public.companies add column if not exists company_stage text
  check (company_stage is null or company_stage in ('seed', 'early', 'growth', 'late', 'public'));
alter table public.companies add column if not exists is_staffing_agency boolean;

-- Posting-level facets (must come from the job text or the source; unknown stays NULL).
alter table public.jobs add column if not exists visa_sponsorship boolean;
alter table public.jobs add column if not exists security_clearance_required boolean;
alter table public.jobs add column if not exists citizenship_required text[];   -- ISO 3166-1 alpha-2 codes

-- Radius search needs coordinates per posting location. Proposed as two plain columns; PostGIS is NOT assumed.
alter table public.jobs add column if not exists latitude double precision check (latitude is null or latitude between -90 and 90);
alter table public.jobs add column if not exists longitude double precision check (longitude is null or longitude between -180 and 180);

-- Not proposed here: "seniority track" (IC vs manager). jobs.seniority holds a level (entry..director), not a track;
-- a track needs a product definition first.
