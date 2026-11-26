-- NOT APPLIED. Proposed for OWNER review and execution only; nothing in the app or CI runs this file.
-- Coherent acquisition for the snapshot feed: a frozen copy of the visible active jobs, taken by ONE statement.
-- A statement is one MVCC snapshot, so membership and column values are coherent. Verify the catalog checks in the
-- PR body (column existence, row count, row bytes) BEFORE running; this file was fixture-tested only.
--
-- frozen columns: id, title, company, company_id, company_slug, location, remote, remote_scope, remote_eligibility, job_type, salary_text, salary_min, salary_max, salary_period, currency, first_seen_at, posted_at, created_at, category, country, country_code, description, skills, source_type, source, status, is_active

create table if not exists public.feed_corpus_epochs (
  epoch      uuid        primary key default gen_random_uuid(),
  frozen_at  timestamptz not null default now(),
  row_count  integer     not null default 0,
  corpus_mark timestamptz            -- newest first_seen_at INSIDE this epoch (best-effort staleness mark, captured with the rows)
);

-- Types are copied from the live public.jobs columns (WITH NO DATA), so they cannot drift from a hand-written list.
create table if not exists public.feed_corpus_frozen as
  select j.id, j.title, j.company, j.company_id, j.company_slug, j.location, j.remote, j.remote_scope, j.remote_eligibility, j.job_type, j.salary_text, j.salary_min, j.salary_max, j.salary_period, j.currency, j.first_seen_at, j.posted_at, j.created_at, j.category, j.country, j.country_code, j.description, j.skills, j.source_type, j.source, j.status, j.is_active, null::uuid as epoch from public.jobs j with no data;
create unique index if not exists feed_corpus_frozen_epoch_id on public.feed_corpus_frozen (epoch, id);

alter table public.feed_corpus_epochs enable row level security;   -- no policies: no anon/authenticated access
alter table public.feed_corpus_frozen enable row level security;
revoke all on public.feed_corpus_epochs, public.feed_corpus_frozen from public, anon, authenticated;
-- REVOKE ALL from service_role first: removes any pre-existing/default INSERT/UPDATE/DELETE/TRUNCATE so the frozen relation is
-- immutable to the app; only the SECURITY DEFINER function (owner) writes. Inherited/ownership privileges are NOT removed by
-- this; the read-only catalog checks must report them.
revoke all on public.feed_corpus_epochs, public.feed_corpus_frozen from service_role;
grant select on public.feed_corpus_epochs, public.feed_corpus_frozen to service_role;

-- Reuse a fresh epoch or take a new one. Hard row bound: copy at most max+1 rows, then raise (the whole transaction,
-- including the new epoch row and the purge, rolls back; nothing is truncated or half stored). Purge deletes an
-- epoch's row and its frozen rows in one transaction, never the newest epoch, and only past p_retain_seconds.
create or replace function public.freeze_feed_corpus(p_reuse_seconds int, p_retain_seconds int, p_max_rows int, p_max_total_rows int, p_max_epochs int)
returns table (out_epoch uuid, out_frozen_at timestamptz, out_row_count integer, out_corpus_mark timestamptz)
language plpgsql security definer set search_path = '' as $$
declare e uuid; fa timestamptz; n integer; cm timestamptz; tot bigint; ne bigint;
begin
  if p_reuse_seconds is null or p_retain_seconds is null or p_max_rows is null
     or p_max_total_rows is null or p_max_epochs is null
     or p_reuse_seconds < 1 or p_retain_seconds < 1 or p_max_rows < 1 or p_max_epochs < 1
     or p_max_total_rows < p_max_rows or p_max_total_rows > 2000000000 or p_max_epochs > 100000
     or p_reuse_seconds > p_retain_seconds or p_max_rows > 2000000000 or p_retain_seconds > 2000000000 then
    raise exception 'invalid_freeze_parameters' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('freeze_feed_corpus'));  -- concurrent freezers queue, then reuse
  select x.epoch, x.frozen_at, x.row_count, x.corpus_mark into e, fa, n, cm
    from public.feed_corpus_epochs x
   where x.frozen_at > pg_catalog.now() - pg_catalog.make_interval(secs => p_reuse_seconds)
   order by x.frozen_at desc limit 1;
  if e is not null then
    -- the caller's (possibly stricter) bound applies to a REUSED epoch as well
    if n > p_max_rows then raise exception 'snapshot_too_large' using errcode = '54000'; end if;
    return query select e, fa, n, cm;
    return;
  end if;
  delete from public.feed_corpus_frozen f where f.epoch in (
    select x.epoch from public.feed_corpus_epochs x
     where x.frozen_at < pg_catalog.now() - pg_catalog.make_interval(secs => p_retain_seconds)
       and x.epoch <> (select y.epoch from public.feed_corpus_epochs y order by y.frozen_at desc limit 1));
  delete from public.feed_corpus_epochs x
   where x.frozen_at < pg_catalog.now() - pg_catalog.make_interval(secs => p_retain_seconds)
     and x.epoch <> (select y.epoch from public.feed_corpus_epochs y order by y.frozen_at desc limit 1);
  -- Aggregate admission, fail closed BEFORE any copy: after the purge, the rows already stored plus the largest copy
  -- this call may make must fit p_max_total_rows, and the epoch count must be below p_max_epochs. Otherwise raise
  -- 53400 (nothing copied). The newest epoch is never purged, so one epoch can outlive p_retain_seconds; it is
  -- counted here. Row counts are a bound on rows, not bytes: a measured byte gate is still owed.
  select coalesce(sum(x.row_count), 0), count(*) into tot, ne from public.feed_corpus_epochs x;
  if ne >= p_max_epochs or tot + p_max_rows > p_max_total_rows then
    raise exception 'frozen_store_full' using errcode = '53400';
  end if;
  insert into public.feed_corpus_epochs default values returning public.feed_corpus_epochs.epoch, public.feed_corpus_epochs.frozen_at into e, fa;
  insert into public.feed_corpus_frozen (id, title, company, company_id, company_slug, location, remote, remote_scope, remote_eligibility, job_type, salary_text, salary_min, salary_max, salary_period, currency, first_seen_at, posted_at, created_at, category, country, country_code, description, skills, source_type, source, status, is_active, epoch)
    select j.id, j.title, j.company, j.company_id, j.company_slug, j.location, j.remote, j.remote_scope, j.remote_eligibility, j.job_type, j.salary_text, j.salary_min, j.salary_max, j.salary_period, j.currency, j.first_seen_at, j.posted_at, j.created_at, j.category, j.country, j.country_code, j.description, j.skills, j.source_type, j.source, j.status, j.is_active, e from public.jobs j
     where j.status = 'active' and j.is_active = true
       and (j.source_type is null or j.source_type <> 'jobspy')     -- = VISIBLE_SOURCE_FILTER (src/lib/jobs/sourcePolicy.ts)
     limit p_max_rows + 1;
  get diagnostics n = row_count;
  if n > p_max_rows then raise exception 'snapshot_too_large' using errcode = '54000'; end if;
  select max(f.first_seen_at) into cm from public.feed_corpus_frozen f where f.epoch = e;
  update public.feed_corpus_epochs x set row_count = n, corpus_mark = cm where x.epoch = e;
  return query select e, fa, n, cm;
end $$;
revoke all on function public.freeze_feed_corpus(int, int, int, int, int) from public, anon, authenticated;
grant execute on function public.freeze_feed_corpus(int, int, int, int, int) to service_role;
