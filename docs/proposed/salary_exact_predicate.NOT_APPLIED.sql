-- PROPOSAL, NOT APPLIED. Exact salary threshold predicate for one-statement use inside a frozen-relation RPC.
-- p_thresholds: jsonb array of 1..18 objects {currency, period, num, den}; num/den are JSON strings of positive
-- integers (1..80 digits, no sign/decimal/exponent/NaN/Infinity) produced by annualSalaryRationals (TypeScript
-- BigInt). currency/period come from the supported sets and each (currency, period) pair appears once.
-- A job passes iff its (currency, period) row has salary_min * den >= num, evaluated in Postgres numeric
-- (exact at any scale; no rounding, no column constraint).
-- The WHOLE payload is validated first, in its own statement, before any numeric cast or evaluation. A malformed
-- payload raises 22023 (an error, never a pass). NULL, NaN and +/-Infinity salaries return false.
create or replace function public.salary_meets_threshold(p_salary numeric, p_currency text, p_period text, p_thresholds jsonb)
returns boolean language plpgsql immutable parallel safe
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
  if p_salary is null or p_salary::text in ('NaN', 'Infinity', '-Infinity') then
    return false;
  end if;
  return exists (
    select 1
    from jsonb_to_recordset(p_thresholds) as t(currency text, period text, num text, den text)
    where t.currency = p_currency and t.period = p_period
      and p_salary * t.den::numeric >= t.num::numeric
  );
end
$$;
revoke all on function public.salary_meets_threshold(numeric, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.salary_meets_threshold(numeric, text, text, jsonb) to service_role;
