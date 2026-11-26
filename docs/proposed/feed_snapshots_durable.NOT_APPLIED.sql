-- PROPOSED, NOT APPLIED. Owner-run only. Nothing here has been executed anywhere except a PGlite fixture.
-- Reconciled line by line (read-only) against the feed_snapshots SQL in the PR #798 body (head bd9a3aa3, body fetched
-- 2026-11-26). The body SQL stays canonical for everything it already defines; this file = that table + ONLY:
--   (1) epoch_id uuid, frozen_at timestamptz   (new columns the frozen-epoch design persists)
--   (2) a job_ids cardinality bound and service_role-only grants
--   (3) put_feed_snapshot(): one transaction that cleans expired rows and refuses a new row past a row-count and
--       total-ID admission bound, so growth is bounded by the function, not by a best-effort cleanup.
-- Never mix with the incompatible #799 feed_snapshots schema.

create table if not exists public.feed_snapshots (
  id          uuid primary key,
  identity    text not null check (identity ~ '^[0-9a-f]{64}$'),
  job_ids     uuid[] not null,
  corpus_mark timestamptz,
  built_at    timestamptz not null,
  expires_at  timestamptz not null,
  check (expires_at > built_at)
);
create index if not exists feed_snapshots_expires_at_idx on public.feed_snapshots (expires_at);
alter table public.feed_snapshots enable row level security;   -- no policies: service_role only
revoke all on table public.feed_snapshots from public, anon, authenticated;

-- (1) additions over the PR-body table. epoch_id is the frozen epoch's uuid (feed_corpus_epochs.epoch); no FK, because
-- epochs are purged on their own schedule and a snapshot only needs the ID list it already stored.
alter table public.feed_snapshots add column if not exists epoch_id  uuid;
alter table public.feed_snapshots add column if not exists frozen_at timestamptz;
-- (2) Re-runnable guard. A pre-existing column of the wrong type or a pre-existing bound with another definition makes
-- this script FAIL, never silently accept it. One row can never hold more IDs than the freeze cap (100000 =
-- SNAPSHOT_MAX_ROWS, placeholder, must match freeze_feed_corpus p_max_rows). Added NOT VALID: scans nothing; validate separately.
do $guard$
declare t1 text; t2 text; t3 text; t4 text; def text; ctype text; expected text;
begin
  select format_type(a.atttypid, a.atttypmod) into t1 from pg_catalog.pg_attribute a where a.attrelid = 'public.feed_snapshots'::regclass and a.attname = 'epoch_id' and not a.attisdropped;
  select format_type(a.atttypid, a.atttypmod) into t2 from pg_catalog.pg_attribute a where a.attrelid = 'public.feed_snapshots'::regclass and a.attname = 'frozen_at' and not a.attisdropped;
  select format_type(a.atttypid, a.atttypmod) into t3 from pg_catalog.pg_attribute a where a.attrelid = 'public.feed_snapshots'::regclass and a.attname = 'job_ids' and not a.attisdropped;
  select format_type(a.atttypid, a.atttypmod) into t4 from pg_catalog.pg_attribute a where a.attrelid = 'public.feed_snapshots'::regclass and a.attname = 'id' and not a.attisdropped;
  if t1 is distinct from 'uuid' or t2 is distinct from 'timestamp with time zone' or t3 is distinct from 'uuid[]' or t4 is distinct from 'uuid' then
    raise exception 'feed_snapshots column types differ from the canonical schema (id %, job_ids %, epoch_id %, frozen_at %)', t4, t3, t1, t2 using errcode = '42804';
  end if;
  -- Exact comparison: build the canonical constraint on a scratch temp table and compare the catalog's own rendering
  -- (so formatting differences cannot matter, but any extra OR/AND/NOT, other bound or non-check constraint does).
  create temp table feed_snapshots_guard_probe (job_ids uuid[]) on commit drop;
  alter table pg_temp.feed_snapshots_guard_probe add constraint probe check (cardinality(job_ids) <= 100000);
  select pg_catalog.pg_get_constraintdef(c.oid) into expected from pg_catalog.pg_constraint c where c.conrelid = 'pg_temp.feed_snapshots_guard_probe'::regclass and c.conname = 'probe';
  select pg_catalog.pg_get_constraintdef(c.oid), c.contype::text into def, ctype from pg_catalog.pg_constraint c where c.conrelid = 'public.feed_snapshots'::regclass and c.conname = 'feed_snapshots_job_ids_bound';
  if def is null then
    alter table public.feed_snapshots add constraint feed_snapshots_job_ids_bound check (cardinality(job_ids) <= 100000) not valid;
  elsif ctype <> 'c' or pg_catalog.regexp_replace(def, ' NOT VALID$', '') <> expected then
    raise exception 'existing feed_snapshots_job_ids_bound is not the canonical check (found: %, expected: %)', def, expected using errcode = '42710';
  end if;
  drop table pg_temp.feed_snapshots_guard_probe;
end $guard$;
-- Privileges: REVOKE ALL first, so any pre-existing or default service_role INSERT/UPDATE/TRUNCATE/REFERENCES/TRIGGER is
-- removed, then grant only what the app needs. Inserts go through put_feed_snapshot() (admission). A privilege that is
-- inherited through role membership or ownership is NOT removed by this; the read-only catalog checks must report it.
revoke all on public.feed_snapshots from service_role;
grant select, delete on public.feed_snapshots to service_role;

-- (3) Admission. Fail closed with 53400 before inserting; never evicts a live snapshot to make room (a viewer's open
-- cursor would silently break). Caps are parameters, UNMEASURED placeholders chosen by the owner after measuring
-- feed_snapshots size on a preview; this file invents no capacity.
create or replace function public.put_feed_snapshot(
  p_id uuid, p_identity text, p_job_ids uuid[], p_corpus_mark timestamptz, p_epoch_id uuid, p_frozen_at timestamptz,
  p_built_at timestamptz, p_expires_at timestamptz, p_max_snapshots int, p_max_total_ids int)
returns void language plpgsql security definer set search_path = '' as $$
declare n bigint; ids bigint;
begin
  if p_id is null or p_identity is null or p_job_ids is null or p_built_at is null or p_expires_at is null
     or p_max_snapshots is null or p_max_total_ids is null or p_max_snapshots < 1 or p_max_total_ids < 1
     or pg_catalog.cardinality(p_job_ids) > p_max_total_ids then
    raise exception 'invalid_snapshot_parameters' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('put_feed_snapshot'));
  delete from public.feed_snapshots s where s.expires_at <= pg_catalog.now();
  select pg_catalog.count(*), coalesce(pg_catalog.sum(pg_catalog.cardinality(s.job_ids)), 0) into n, ids from public.feed_snapshots s;
  if n >= p_max_snapshots or ids + pg_catalog.cardinality(p_job_ids) > p_max_total_ids then
    raise exception 'snapshot_store_full' using errcode = '53400';
  end if;
  insert into public.feed_snapshots (id, identity, job_ids, corpus_mark, epoch_id, frozen_at, built_at, expires_at)
    values (p_id, p_identity, p_job_ids, p_corpus_mark, p_epoch_id, p_frozen_at, p_built_at, p_expires_at);
end $$;
revoke all on function public.put_feed_snapshot(uuid, text, uuid[], timestamptz, uuid, timestamptz, timestamptz, timestamptz, int, int) from public, anon, authenticated;
grant execute on function public.put_feed_snapshot(uuid, text, uuid[], timestamptz, uuid, timestamptz, timestamptz, timestamptz, int, int) to service_role;
