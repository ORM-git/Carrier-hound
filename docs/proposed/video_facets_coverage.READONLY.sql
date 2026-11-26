-- READ-ONLY coverage checks for the reference-video facets that the feed builder does not filter on yet.
-- Owner-run; nothing here changes data. NOT run by the agent (no authorized database path): every facet stays
-- BLOCKED on data until these numbers are back. Scope = the rows the feed can show (active, visible sources).
-- Rule for wiring a param: the column must exist AND cover enough of this scope to filter honestly (the owner sets
-- the bar; this file reports the numbers, it invents no threshold).

-- 0. Which facet columns exist on public.jobs / public.companies in THIS database (repo migrations are not proof).
select c.table_name, c.column_name, c.data_type
  from information_schema.columns c
 where c.table_schema = 'public'
   and ((c.table_name = 'jobs' and c.column_name in ('role_category', 'category', 'categories', 'min_experience_years', 'max_experience_years',
                                                     'skills', 'seniority', 'industry', 'visa_sponsorship', 'security_clearance_required',
                                                     'citizenship_required', 'latitude', 'longitude'))
     or (c.table_name = 'companies' and c.column_name in ('industry', 'company_stage', 'is_staffing_agency')))
 order by 1, 2;

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

-- 3. Value distribution, to check the columns hold the vocabulary the UI would offer.
select 'role_category' as facet, j.role_category::text as value, count(*) from public.jobs j
 where j.status = 'active' and j.is_active = true group by 2
union all
select 'seniority', j.seniority, count(*) from public.jobs j where j.status = 'active' and j.is_active = true group by 2
union all
select 'min_experience_years', j.min_experience_years::text, count(*) from public.jobs j where j.status = 'active' and j.is_active = true group by 2
 order by 1, 3 desc;
