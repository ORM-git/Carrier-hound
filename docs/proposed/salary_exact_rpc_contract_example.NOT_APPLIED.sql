-- EXAMPLE / CONTRACT SHAPE ONLY, NOT APPLIED. Not the final RPC: the frozen relation name and column list belong to
-- the Lane 2 frozen-corpus RPC. It shows the required order: (1) validate and materialize the thresholds in an
-- explicit statement BEFORE any candidate query, so a malformed payload raises 22023 even for an empty relation, a
-- non-matching epoch or a zero limit; (2) one RETURN QUERY that reads the frozen rows and applies the exact predicate
-- against the already-validated constants (same statement = same MVCC snapshot for the rows).
-- A numeric error inside the multiplication (SQLSTATE 22003) propagates and must be mapped to a fail-closed 503.
create or replace function public.example_salary_candidates(p_epoch integer, p_thresholds jsonb, p_limit integer)
returns table(id integer)
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare
  v_th jsonb;
begin
  -- (1) explicit validation + materialization, executed unconditionally
  select jsonb_agg(jsonb_build_object('currency', t.currency, 'period', t.period, 'num', t.num::text, 'den', t.den::text))
    into v_th
  from public.salary_thresholds_typed(p_thresholds) as t;
  if p_limit is null or p_limit < 0 then
    raise exception 'limit must be >= 0' using errcode = '22023';
  end if;
  -- (2) one statement over the frozen rows with the exact predicate
  return query
    select f.id
    from public.frozen f
    join jsonb_to_recordset(v_th) as t(currency text, period text, num numeric, den numeric)
      on t.currency = f.currency and t.period = f.salary_period
    where f.epoch = p_epoch
      and f.salary_min is not null
      and f.salary_min::text not in ('NaN', 'Infinity', '-Infinity')
      and f.salary_min * t.den >= t.num
    order by f.id
    limit p_limit;
end
$$;
