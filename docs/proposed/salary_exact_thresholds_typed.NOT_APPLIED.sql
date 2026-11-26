-- PROPOSAL, NOT APPLIED. Validate-once companion to salary_exact_predicate.NOT_APPLIED.sql.
-- An RPC calls this ONCE per call (not per row) and joins the typed result in the SAME statement that reads the
-- frozen relation, so exact numeric comparison and row membership share one MVCC snapshot:
--   select f.id from feed_corpus_frozen f
--   join public.salary_thresholds_typed(p_thresholds) t on t.currency = f.currency and t.period = f.salary_period
--   where f.epoch = p_epoch and f.salary_min is not null and f.salary_min::text not in ('NaN','Infinity','-Infinity')
--     and f.salary_min * t.den >= t.num;
-- Validation is identical to the per-row function (whole payload before any cast; malformed raises 22023).
-- A numeric overflow in the multiplication raises (SQLSTATE 22003): the caller must map it to a fail-closed 503.
create or replace function public.salary_thresholds_typed(p_thresholds jsonb)
returns table(currency text, period text, num numeric, den numeric)
language plpgsql stable parallel safe
set search_path = pg_catalog
as $$
declare
  n integer;
  n_unique integer;
  n_invalid integer;
begin
  if p_thresholds is null or jsonb_typeof(p_thresholds) <> 'array' then
    raise exception 'salary thresholds must be a json array' using errcode = '22023';
  end if;
  n := jsonb_array_length(p_thresholds);
  if n < 1 or n > 18 then
    raise exception 'salary thresholds must have 1..18 entries' using errcode = '22023';
  end if;
  select count(*) into n_invalid
  from jsonb_array_elements(p_thresholds) as e
  where not coalesce(
    jsonb_typeof(e) = 'object'
    and jsonb_typeof(e -> 'currency') = 'string' and (e ->> 'currency') in ('USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD')
    and jsonb_typeof(e -> 'period') = 'string' and (e ->> 'period') in ('hourly', 'monthly', 'yearly')
    and jsonb_typeof(e -> 'num') = 'string' and (e ->> 'num') ~ '^[1-9][0-9]{0,79}$'
    and jsonb_typeof(e -> 'den') = 'string' and (e ->> 'den') ~ '^[1-9][0-9]{0,79}$',
    false);
  if n_invalid > 0 then
    raise exception 'malformed salary threshold entry' using errcode = '22023';
  end if;
  select count(distinct ((e ->> 'currency') || '|' || (e ->> 'period'))) into n_unique
  from jsonb_array_elements(p_thresholds) as e;
  if n_unique <> n then
    raise exception 'duplicate currency/period salary threshold' using errcode = '22023';
  end if;
  return query
    select (e ->> 'currency'), (e ->> 'period'), (e ->> 'num')::numeric, (e ->> 'den')::numeric
    from jsonb_array_elements(p_thresholds) as e;
end
$$;
revoke all on function public.salary_thresholds_typed(jsonb) from public, anon, authenticated;
grant execute on function public.salary_thresholds_typed(jsonb) to service_role;
