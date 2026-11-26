-- PROPOSED, NOT APPLIED. Owner-run only; nothing in the app or CI executes this file (PGlite fixtures only).
-- Exact annual-salary filter for the snapshot feed (PR #798 frozen corpus + PR #796 exact rational thresholds).
-- Depends on: docs/proposed/feed_corpus_frozen.NOT_APPLIED.sql (public.feed_corpus_frozen) and
--             docs/proposed/salary_exact_thresholds_typed.NOT_APPLIED.sql (public.salary_thresholds_typed).
--
-- Contract of both functions:
--   (1) The WHOLE threshold payload is validated ONCE per call, by an explicit statement that runs before the
--       RETURN QUERY (malformed => SQLSTATE 22023), also when the candidate set is empty or the epoch/ids match nothing.
--   (2) ONE RETURN QUERY reads the rows and joins the already-validated typed thresholds in the same statement
--       (one MVCC snapshot; no per-row validation; no fetch-IDs-then-hydrate).
--   (3) A numeric overflow in salary_min * den raises 22003; the app maps it fail-closed (503 snapshot_unavailable).
-- The app chains its unchanged filter builder (applyRecommendedFilters) on the returned rows through PostgREST.
-- Caveat proven by fixture: an OUTER `LIMIT 0` never executes a plpgsql set-returning body, so validation would not
-- run; the app refuses a limit below 1 before calling (frozenSalaryQuery / readAllCandidates).
-- (currency, period) pairs are unique after validation, so each row matches at most one threshold: no duplicates.

-- Build: frozen rows of one epoch that meet the exact threshold.
create or replace function public.feed_frozen_salary_rows(p_epoch uuid, p_thresholds jsonb)
returns setof public.feed_corpus_frozen
language plpgsql stable
set search_path = ''
as $$
declare
  v_th jsonb;
begin
  if p_epoch is null then
    raise exception 'epoch is required' using errcode = '22023';
  end if;
  -- (1) validate + materialize once, unconditionally, before any candidate read
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('currency', t.currency, 'period', t.period, 'num', t.num::text, 'den', t.den::text))
    into v_th
  from public.salary_thresholds_typed(p_thresholds) as t;
  -- (2) one statement: rows + typed thresholds
  return query
    select f.*
    from public.feed_corpus_frozen f
    join pg_catalog.jsonb_to_recordset(v_th) as t(currency text, period text, num numeric, den numeric)
      on t.currency = f.currency and t.period = f.salary_period
    where f.epoch = p_epoch
      and f.salary_min is not null
      and f.salary_min::text not in ('NaN', 'Infinity', '-Infinity')
      and f.salary_min * t.den >= t.num;
end
$$;

-- Serve-time recheck: the current live rows among the snapshot's next IDs that still meet the threshold HELD by the
-- snapshot (never recomputed from current FX). Bounded id list.
create or replace function public.jobs_salary_rows(p_ids uuid[], p_thresholds jsonb)
returns setof public.jobs
language plpgsql stable
set search_path = ''
as $$
declare
  v_th jsonb;
begin
  if p_ids is null or pg_catalog.cardinality(p_ids) < 1 or pg_catalog.cardinality(p_ids) > 1000 then
    raise exception 'ids must hold 1..1000 entries' using errcode = '22023';
  end if;
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('currency', t.currency, 'period', t.period, 'num', t.num::text, 'den', t.den::text))
    into v_th
  from public.salary_thresholds_typed(p_thresholds) as t;
  return query
    select j.*
    from public.jobs j
    join pg_catalog.jsonb_to_recordset(v_th) as t(currency text, period text, num numeric, den numeric)
      on t.currency = j.currency and t.period = j.salary_period
    where j.id = any (p_ids)
      and j.salary_min is not null
      and j.salary_min::text not in ('NaN', 'Infinity', '-Infinity')
      and j.salary_min * t.den >= t.num;
end
$$;

revoke all on function public.feed_frozen_salary_rows(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.jobs_salary_rows(uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.feed_frozen_salary_rows(uuid, jsonb) to service_role;
grant execute on function public.jobs_salary_rows(uuid[], jsonb) to service_role;
