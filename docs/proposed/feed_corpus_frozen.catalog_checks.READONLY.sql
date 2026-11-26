-- READ-ONLY checks for the owner to run BEFORE the proposed freeze SQL. They change nothing.
-- 1. Every frozen column must exist on public.jobs (company_slug is used by the company filter but is NOT in supabase/schema.sql):
select c as wanted, exists (select 1 from information_schema.columns where table_schema='public' and table_name='jobs' and column_name=c) as present
from unnest(array['id','title','company','company_id','company_slug','location','remote','remote_scope','remote_eligibility','job_type','salary_text','salary_min','salary_max','salary_period','currency','first_seen_at','posted_at','created_at','category','country','country_code','description','skills','source_type','source','status','is_active']) c;
-- 2. Size of what one freeze would copy (rows and bytes of exactly the frozen columns):
select count(*) as rows,
       sum(pg_column_size(row(j.id, j.title, j.company, j.company_id, j.location, j.remote, j.remote_scope, j.remote_eligibility, j.job_type, j.salary_text, j.salary_min, j.salary_max, j.salary_period, j.currency, j.first_seen_at, j.posted_at, j.created_at, j.category, j.country, j.country_code, j.description, j.skills, j.source_type, j.source, j.status, j.is_active))) as approx_bytes
from public.jobs j
where j.status = 'active' and j.is_active = true and (j.source_type is null or j.source_type <> 'jobspy');
-- 3. Names must be free:
select to_regclass('public.feed_corpus_frozen') as frozen, to_regclass('public.feed_corpus_epochs') as epochs, to_regprocedure('public.freeze_feed_corpus(int,int,int,int,int)') as fn5;
-- 4. OBSOLETE OVERLOADS must be absent. Any freeze_feed_corpus with another signature (e.g. the old 3-argument one) would
-- bypass the aggregate admission. Expect exactly the 5-argument row or none. Do NOT drop automatically: the owner reviews
-- each extra row and drops only a known-obsolete overload by its exact signature.
select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('freeze_feed_corpus', 'put_feed_snapshot');
-- 5. Who can write the three tables? Expect service_role/anon/authenticated/PUBLIC to hold NO insert/update/delete/truncate on the
-- frozen and epoch tables, and no insert/update/truncate on feed_snapshots (selecting rows lists only holders of those rights).
select c.relname, r.rolname, p.priv
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join pg_roles r cross join (values ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(priv)
 where n.nspname = 'public' and c.relname in ('feed_corpus_frozen','feed_corpus_epochs','feed_snapshots')
   and r.rolname in ('service_role','anon','authenticated') and has_table_privilege(r.rolname, c.oid, p.priv);
-- 6. Privileges that explicit REVOKE cannot remove: ownership and role membership. Review every row by hand.
select c.relname, pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('feed_corpus_frozen','feed_corpus_epochs','feed_snapshots');
select m.roleid::regrole as granted_role, m.member::regrole as member from pg_auth_members m
 where m.member::regrole::text in ('service_role','anon','authenticated') or m.roleid::regrole::text in ('service_role','anon','authenticated');
-- 7. feed_snapshots column types (expect id uuid, job_ids uuid[], epoch_id uuid, frozen_at timestamp with time zone) and constraints:
select a.attname, format_type(a.atttypid, a.atttypmod) as type from pg_attribute a
 where a.attrelid = to_regclass('public.feed_snapshots') and a.attnum > 0 and not a.attisdropped;
select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = to_regclass('public.feed_snapshots');
