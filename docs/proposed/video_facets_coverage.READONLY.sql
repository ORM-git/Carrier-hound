-- READ-ONLY coverage checks for the reference-video facets that the feed builder does not filter on yet.
-- Owner-run; nothing here changes data. NOT run by the agent (no authorized database path): every facet stays
-- BLOCKED on data until these numbers are back. Scope of EVERY count below = the rows the feed can show:
--   status = 'active' and is_active and (source_type is null or source_type <> 'jobspy')   -- = VISIBLE_SOURCE_FILTER
-- Rule for wiring a param: the column must exist with the expected type AND cover enough of this scope to filter
-- honestly (the owner sets the bar; this file reports the numbers, it invents no threshold).
--
-- Run so that the first error stops the script:  psql -v ON_ERROR_STOP=1 -f video_facets_coverage.READONLY.sql
-- (the Supabase SQL editor also stops at the first error).

-- 0. Which facet columns exist on public.jobs / public.companies in THIS database (repo migrations are not proof).
select c.table_name, c.column_name, c.data_type
  from information_schema.columns c
 where c.table_schema = 'public'
   and ((c.table_name = 'jobs' and c.column_name in ('status', 'is_active', 'source_type', 'role_category', 'category', 'categories',
                                                     'min_experience_years', 'max_experience_years', 'skills', 'seniority', 'industry',
                                                     'visa_sponsorship', 'security_clearance_required', 'citizenship_required',
                                                     'latitude', 'longitude'))
     or (c.table_name = 'companies' and c.column_name in ('industry', 'company_stage', 'is_staffing_agency')))
 order by 1, 2;

-- 0b. Stop here unless every column the queries below read exists with the type they assume (read-only: it only
--     selects from the catalog). A missing or differently typed column raises 42703 naming it, so no later query runs
--     against a column that is absent or means something else.
do $check$
declare problems text;
begin
  select pg_catalog.string_agg(w.col || ' (want ' || coalesce(w.want, 'any type') || ', have '
                               || coalesce(pg_catalog.format_type(a.atttypid, a.atttypmod), 'MISSING') || ')', ', ' order by w.col)
    into problems
  from (values ('status', null), ('is_active', 'boolean'), ('source_type', null),
               ('role_category', 'text'), ('min_experience_years', 'integer'), ('max_experience_years', 'integer'),
               ('skills', 'text[]'), ('seniority', 'text')) as w(col, want)
  left join pg_catalog.pg_attribute a
    on a.attrelid = 'public.jobs'::regclass and a.attname = w.col and a.attnum > 0 and not a.attisdropped
  where a.attname is null or (w.want is not null and pg_catalog.format_type(a.atttypid, a.atttypmod) <> w.want);
  if problems is not null then
    raise exception 'video facet coverage checks stopped: %', problems using errcode = '42703';
  end if;
end
$check$;

-- 1. Population of the facet columns that exist in the repo schema (min/max years: 20261116b_ten_million_system_design_schema.sql).
select count(*)                                                           as visible_active_rows,
       count(j.role_category)                                             as role_category_set,
       count(*) filter (where j.role_category = 'OTHER')                  as role_category_other,
       count(j.min_experience_years)                                      as min_years_set,
       count(j.max_experience_years)                                      as max_years_set,
       count(*) filter (where j.min_experience_years > j.max_experience_years) as years_inverted,
       count(*) filter (where coalesce(pg_catalog.cardinality(j.skills), 0) > 0) as skills_nonempty,
       count(*) filter (where j.seniority is not null and j.seniority <> 'unknown') as seniority_known
  from public.jobs j
 where j.status = 'active' and j.is_active = true and (j.source_type is null or j.source_type <> 'jobspy');

-- 2. The same coverage per source_type (a facet populated by one source only would filter that source's jobs).
select coalesce(j.source_type, '(null)') as source_type, count(*) as rows,
       count(j.role_category) as role_category_set, count(j.min_experience_years) as min_years_set,
       count(*) filter (where coalesce(pg_catalog.cardinality(j.skills), 0) > 0) as skills_nonempty
  from public.jobs j
 where j.status = 'active' and j.is_active = true and (j.source_type is null or j.source_type <> 'jobspy')
 group by 1 order by 2 desc;

-- 3. Value distribution, to check the columns hold the vocabulary the UI would offer. Same scope in EVERY branch.
select 'role_category' as facet, j.role_category::text as value, count(*) from public.jobs j
 where j.status = 'active' and j.is_active = true and (j.source_type is null or j.source_type <> 'jobspy') group by 2
union all
select 'seniority', j.seniority, count(*) from public.jobs j
 where j.status = 'active' and j.is_active = true and (j.source_type is null or j.source_type <> 'jobspy') group by 2
union all
select 'min_experience_years', j.min_experience_years::text, count(*) from public.jobs j
 where j.status = 'active' and j.is_active = true and (j.source_type is null or j.source_type <> 'jobspy') group by 2
 order by 1, 3 desc;
