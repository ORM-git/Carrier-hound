-- ROW 69 CANDIDATE. PROPOSED, NOT EXECUTED, NOT A MIGRATION. Exercised only on a local PGlite fixture. Owner-run SQL would need review.
-- Assumes public.jobs exists (and, for excluded skills, public.jobs_without_excluded_skills(text[]), whose definition is NOT in the repo).
create table if not exists public.feed_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  tier text not null check (tier in ('guest','free','pro')),
  binding_hash text not null check (binding_hash ~ '^[0-9a-f]{64}$'),
  member_ids bytea not null check (length(member_ids) > 0 and length(member_ids) % 16 = 0),
  member_count int not null check (member_count = length(member_ids) / 16),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null check (expires_at <= created_at + interval '1 hour'));
create index if not exists feed_sessions_expires_idx on public.feed_sessions (expires_at);
create index if not exists feed_sessions_caller_idx on public.feed_sessions (coalesce(user_id::text, binding_hash), created_at);
alter table public.feed_sessions enable row level security;   -- no policies: only service_role (bypasses RLS) can touch it
revoke all on table public.feed_sessions from public, anon, authenticated;
grant select, insert, delete on table public.feed_sessions to service_role;

-- Filter AST (jsonb): {"and":[..]} | {"or":[..]} | {"col":c,"op":o,"not":bool,"val":v}. Allowlisted columns/ops, values via %L.
create or replace function public.feed_filter_sql(f jsonb, depth int default 0) returns text language plpgsql immutable
set search_path = pg_catalog, public, pg_temp as $f$
declare cols text[] := array['title','company','company_slug','location','category','job_type','remote','remote_scope','country_code','source','source_type','salary_min','description','min_experience_years','max_experience_years','posted_at','is_active','status','id'];
 parts text[]; el jsonb; col text; op text; v jsonb; s text;
begin
 if depth > 8 then raise exception 'filter_too_deep' using errcode='22023'; end if;
 if jsonb_typeof(f) <> 'object' then raise exception 'filter_shape' using errcode='22023'; end if;
 if f ? 'and' or f ? 'or' then
   for el in select * from jsonb_array_elements(coalesce(f->'and', f->'or')) loop parts := parts || public.feed_filter_sql(el, depth+1); end loop;
   if parts is null then return 'true'; end if;
   return '(' || array_to_string(parts, case when f ? 'and' then ' and ' else ' or ' end) || ')';
 end if;
 col := f->>'col'; op := f->>'op'; v := f->'val';
 if v is not null and (jsonb_typeof(v) not in ('string','number','boolean') or length(v #>> '{}') > case when op='imatch' then 1024 else 512 end) then raise exception 'filter_value' using errcode='22023'; end if;
 if op = 'ilike' and length(v #>> '{}') - length(replace(v #>> '{}','%','')) > 8 then raise exception 'filter_cost' using errcode='22023'; end if;
 if not (col = any(cols)) then raise exception 'filter_column' using errcode='22023'; end if;
 if op = 'is_null' then s := format('%I is null', col);
 elsif op = 'eq' then s := format('%I::text = %L', col, v #>> '{}');
 elsif op = 'neq' then s := format('%I::text <> %L', col, v #>> '{}');
 elsif op = 'ilike' then s := format('%I ilike %L', col, v #>> '{}');
 elsif op = 'imatch' then s := format('%I ~* %L', col, v #>> '{}');
 elsif op = 'gte' then s := format('%I >= %L', col, v #>> '{}');
 elsif op = 'lt' then s := format('%I < %L', col, v #>> '{}');
 elsif op = 'lte' then s := format('%I <= %L', col, v #>> '{}');
 else raise exception 'filter_op' using errcode='22023'; end if;
 if coalesce((f->>'not')::bool,false) then s := 'not (' || s || ')'; end if;  -- PostgREST not.<op>: NULL stays NULL, row excluded
 return s;
end $f$;

-- Bounded opportunistic cleanup (reads never serve expired rows; this only reclaims space).
create or replace function public.purge_expired_feed_sessions(p_limit int default 100) returns int language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $f$
declare n int;
begin
 delete from public.feed_sessions where id in (select id from public.feed_sessions where expires_at < now() order by expires_at limit least(greatest(coalesce(p_limit,100),1),1000));
 get diagnostics n = row_count; return n;
end $f$;

-- ONE statement: ordered capture -> aggregate (explicit ordinal order) -> insert -> handle. Visibility/liveness come in through p_filters
-- (the route's real applyBaseVisibility), there is no second visibility rule here.
create or replace function public.capture_feed_session(p_filters jsonb, p_verified_first bool, p_user uuid, p_tier text, p_bind text, p_max int, p_ttl_min int, p_excluded text[] default null)
returns table(handle uuid, n int) language plpgsql security definer set statement_timeout='5s' set search_path = pg_catalog, public, pg_temp as $f$
declare w text; q text; base text := 'public.jobs'; leaves int; caller text; recent int; active int; ord text;
begin
 if p_max is null or p_max < 1 or p_max > 20000 then raise exception 'bad_max' using errcode='22023'; end if;
 if p_ttl_min is null or p_ttl_min < 1 or p_ttl_min > 60 then raise exception 'bad_ttl' using errcode='22023'; end if;
 if p_tier is null or p_tier not in ('guest','free','pro') or (p_tier = 'guest') <> (p_user is null) then raise exception 'bad_tier' using errcode='22023'; end if;
 if p_bind is null or p_bind !~ '^[0-9a-f]{64}$' then raise exception 'bad_binding' using errcode='22023'; end if;
 if octet_length(p_filters::text) > 16384 then raise exception 'filter_bytes' using errcode='22023'; end if;
 select count(*) into leaves from jsonb_path_query(p_filters, 'strict $.**.col');
 if leaves > 200 then raise exception 'filter_nodes' using errcode='22023'; end if;
 if p_excluded is not null then
   if cardinality(p_excluded) > 50 or exists (select 1 from unnest(p_excluded) e where e is null or length(e) > 100) then raise exception 'excluded_skills' using errcode='22023'; end if;
   base := 'public.jobs_without_excluded_skills($5)';  -- the route's EXCLUDED_SKILLS_RPC base relation (real definition unproven here)
 end if;
 w := public.feed_filter_sql(p_filters);
 -- per-caller create-rate / concurrent-session bounds, serialized per caller; explicit error, never silent truncation
 caller := coalesce(p_user::text, p_bind);
 perform pg_advisory_xact_lock(hashtextextended(caller, 0));
 select count(*) filter (where created_at > now() - interval '1 minute'), count(*) filter (where expires_at > now()) into recent, active
   from public.feed_sessions where coalesce(user_id::text, binding_hash) = caller and created_at > now() - interval '1 hour';
 if recent >= 10 or active >= 20 then raise exception 'capture_rate' using errcode='53400'; end if;
 perform public.purge_expired_feed_sessions(20);
 ord := case when p_verified_first then 'verified desc, ' else '' end || 'posted_at desc nulls last, id desc';
 q := format($q$
  with ordered as (select id, row_number() over (order by %s) as rn from %s where %s order by %s limit %s),
  agg as (select count(*)::int c, string_agg(decode(replace(id::text,'-',''),'hex'), ''::bytea order by rn) ids from ordered),
  ins as (insert into public.feed_sessions(user_id,tier,binding_hash,member_ids,member_count,expires_at)
          select $1,$2,$3,ids,c, now()+make_interval(mins=>$4) from agg where c>0 and c <= %s returning id)
  select (select id from ins), (select c from agg)$q$, ord, base, w, ord, p_max+1, p_max);
 execute q into handle, n using p_user, p_tier, p_bind, p_ttl_min, p_excluded;
 if n > p_max then raise exception 'capture_too_large' using errcode='54000'; end if;  -- insert was skipped (c <= p_max); caller maps to explicit 503
 if n = 0 then return; end if;
 return next;
end $f$;
revoke all on function public.feed_filter_sql(jsonb,int) from public, anon, authenticated;
revoke all on function public.purge_expired_feed_sessions(int) from public, anon, authenticated;
revoke all on function public.capture_feed_session(jsonb,bool,uuid,text,text,int,int,text[]) from public, anon, authenticated;
grant execute on function public.capture_feed_session(jsonb,bool,uuid,text,text,int,int,text[]) to service_role;
grant execute on function public.purge_expired_feed_sessions(int) to service_role;
