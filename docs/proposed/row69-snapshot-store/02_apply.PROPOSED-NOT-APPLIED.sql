-- ROW 69 FEED SNAPSHOT STORE. PROPOSED, NOT APPLIED. NOT A MIGRATION (kept out of supabase/migrations on purpose).
-- The owner applies it by hand, in this order: 01_precheck.READONLY.sql, this file, 03_verify.READONLY.sql.
-- Rollback: 04_rollback.PROPOSED-NOT-APPLIED.sql. Tested only on an in-memory PGlite fixture
-- (src/lib/pagination/__tests__/snapshotStore.pglite.test.ts), never on a real database.
--
-- Privilege model: every function is SECURITY INVOKER with search_path pinned to '' and schema-qualified names.
-- Callers are the server only, as service_role, which holds the table grants below and bypasses RLS. No function
-- needs a privilege the caller lacks, so there is no SECURITY DEFINER anywhere (see the design doc for the per-function
-- reasoning). anon and authenticated get nothing: no table privilege, no policy, no EXECUTE.
--
-- Binding: a 64-hex id (two gen_random_uuid() values, 244 random bits, never sequential) is a bearer HANDLE only.
-- Every read re-checks owner_id, tier and query_hash, passed by the server from the verified auth token, the server
-- entitlement lookup and the normalized request, plus expiry. Unknown, expired and mismatched ids all raise the same
-- 'snapshot_unavailable' error, so a caller cannot tell them apart. owner_id is a uuid: a shared literal such as
-- 'guest' cannot be stored. The repo has no verified server-side guest-session id, so guests get no snapshot.
BEGIN;

CREATE TABLE public.feed_snapshots (
  id           text        PRIMARY KEY
                           DEFAULT (pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
                                    || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''))
                           CHECK (id ~ '^[0-9a-f]{64}$'),
  kind         text        NOT NULL CHECK (kind IN ('search', 'multiword', 'recommended')),
  owner_id     uuid        NOT NULL,
  tier         text        NOT NULL CHECK (tier IN ('free', 'pro')),
  query_hash   text        NOT NULL CHECK (query_hash ~ '^[0-9a-f]{64}$'),
  scoring_rev  text        NOT NULL CHECK (pg_catalog.length(scoring_rev) BETWEEN 1 AND 128),
  ids          uuid[]      NOT NULL CHECK (pg_catalog.array_ndims(ids) = 1 AND pg_catalog.array_lower(ids, 1) = 1
                                           AND pg_catalog.array_position(ids, NULL::uuid) IS NULL),
  member_count integer     NOT NULL CHECK (member_count >= 1 AND member_count = pg_catalog.cardinality(ids)),
  created_at   timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at   timestamptz NOT NULL,
  CONSTRAINT feed_snapshots_ttl CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  -- Size bound per kind: multiword = the route's 200-row relevance pool, recommended = its 1000-row pool,
  -- search = 20000 (the capture bound carried over from the PR #898 fixture). Above it capture raises, never truncates.
  CONSTRAINT feed_snapshots_size CHECK ((kind = 'multiword' AND member_count <= 200)
                                     OR (kind = 'recommended' AND member_count <= 1000)
                                     OR (kind = 'search' AND member_count <= 20000))
);
CREATE INDEX feed_snapshots_expires_idx ON public.feed_snapshots (expires_at);
CREATE INDEX feed_snapshots_owner_created_idx ON public.feed_snapshots (owner_id, created_at);

ALTER TABLE public.feed_snapshots ENABLE ROW LEVEL SECURITY;   -- no policy at all: anon/authenticated can never see a row
REVOKE ALL ON TABLE public.feed_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.feed_snapshots TO service_role;

-- Limits, in one place. Changing them is a reviewed DDL change, never a request parameter.
CREATE FUNCTION public.feed_snapshot_limits(OUT per_owner_per_minute integer, OUT per_owner_active integer,
                                            OUT global_active integer, OUT max_ttl_minutes integer, OUT max_window integer)
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $$ SELECT 10, 20, 50000, 60, 100 $$;

-- Rate limit + capacity, ATOMIC under concurrent captures: one transaction-scoped advisory lock serializes every
-- capture, so the counts read below cannot change before this transaction's insert commits (no read-then-insert race).
CREATE FUNCTION public.feed_snapshot_admit(p_owner uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
DECLARE lim record; recent integer; active integer; total integer;
BEGIN
  SELECT * INTO lim FROM public.feed_snapshot_limits();
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.feed_snapshots:capture', 0));
  SELECT count(*) FILTER (WHERE s.created_at > pg_catalog.now() - interval '1 minute'),
         count(*) FILTER (WHERE s.expires_at > pg_catalog.now())
    INTO recent, active
    FROM public.feed_snapshots s WHERE s.owner_id = p_owner AND s.created_at > pg_catalog.now() - interval '1 hour';
  IF recent >= lim.per_owner_per_minute OR active >= lim.per_owner_active THEN
    RAISE EXCEPTION 'snapshot_rate' USING ERRCODE = '53400';
  END IF;
  SELECT count(*) INTO total FROM public.feed_snapshots s WHERE s.expires_at > pg_catalog.now();
  IF total >= lim.global_active THEN
    RAISE EXCEPTION 'snapshot_capacity' USING ERRCODE = '53400';
  END IF;
END $$;

CREATE FUNCTION public.feed_snapshot_check_args(p_kind text, p_tier text, p_query_hash text, p_scoring_rev text, p_ttl_min integer)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('search', 'multiword', 'recommended') THEN RAISE EXCEPTION 'bad_kind' USING ERRCODE = '22023'; END IF;
  IF p_tier IS NULL OR p_tier NOT IN ('free', 'pro') THEN RAISE EXCEPTION 'bad_tier' USING ERRCODE = '22023'; END IF;
  IF p_query_hash IS NULL OR p_query_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'bad_query_hash' USING ERRCODE = '22023'; END IF;
  IF p_scoring_rev IS NULL OR pg_catalog.length(p_scoring_rev) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'bad_scoring_rev' USING ERRCODE = '22023'; END IF;
  IF p_ttl_min IS NULL OR p_ttl_min < 1 OR p_ttl_min > 60 THEN RAISE EXCEPTION 'bad_ttl' USING ERRCODE = '22023'; END IF;
END $$;

-- Capture of an already-ranked list (recommended pool, multiword relevance: the ranking runs in the server, unchanged).
CREATE FUNCTION public.feed_capture_snapshot(p_kind text, p_owner uuid, p_tier text, p_query_hash text, p_scoring_rev text,
                                             p_ids uuid[], p_ttl_min integer)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
DECLARE new_id text;
  bound integer := CASE p_kind WHEN 'multiword' THEN 200 WHEN 'recommended' THEN 1000 ELSE 20000 END;   -- per-kind size bound
BEGIN
  IF p_owner IS NULL THEN RAISE EXCEPTION 'bad_owner' USING ERRCODE = '22023'; END IF;
  PERFORM public.feed_snapshot_check_args(p_kind, p_tier, p_query_hash, p_scoring_rev, p_ttl_min);
  IF p_ids IS NULL OR pg_catalog.cardinality(p_ids) = 0 THEN RAISE EXCEPTION 'empty_snapshot' USING ERRCODE = '22023'; END IF;
  IF pg_catalog.array_position(p_ids, NULL::uuid) IS NOT NULL
     OR (SELECT count(DISTINCT x) FROM pg_catalog.unnest(p_ids) AS u(x)) <> pg_catalog.cardinality(p_ids) THEN
    RAISE EXCEPTION 'bad_ids' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.cardinality(p_ids) > bound THEN
    RAISE EXCEPTION 'capture_too_large' USING ERRCODE = '54000';
  END IF;
  PERFORM public.feed_snapshot_admit(p_owner);
  INSERT INTO public.feed_snapshots (kind, owner_id, tier, query_hash, scoring_rev, ids, member_count, expires_at)
  VALUES (p_kind, p_owner, p_tier, p_query_hash, p_scoring_rev, p_ids, pg_catalog.cardinality(p_ids),
          pg_catalog.now() + pg_catalog.make_interval(mins => p_ttl_min))
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

-- Filter AST (jsonb) -> SQL predicate, from the PR #898 capture fixture: allowlisted columns/operators, values via %L.
-- {"and":[..]} | {"or":[..]} | {"col":c,"op":o,"not":bool,"val":v}. Anything else raises (fail closed).
CREATE FUNCTION public.feed_snapshot_filter_sql(f jsonb, depth integer DEFAULT 0) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $f$
DECLARE cols text[] := ARRAY['title','company','company_slug','location','category','job_type','remote','remote_scope','country_code',
  'source','source_type','salary_min','description','min_experience_years','max_experience_years','posted_at','is_active','status','id'];
  parts text[]; el jsonb; col text; op text; v jsonb; s text;
BEGIN
  IF depth > 8 THEN RAISE EXCEPTION 'filter_too_deep' USING ERRCODE = '22023'; END IF;
  IF pg_catalog.jsonb_typeof(f) <> 'object' THEN RAISE EXCEPTION 'filter_shape' USING ERRCODE = '22023'; END IF;
  IF f ? 'and' OR f ? 'or' THEN
    FOR el IN SELECT * FROM pg_catalog.jsonb_array_elements(coalesce(f->'and', f->'or')) LOOP
      parts := parts || public.feed_snapshot_filter_sql(el, depth + 1);
    END LOOP;
    IF parts IS NULL THEN RETURN 'true'; END IF;
    RETURN '(' || pg_catalog.array_to_string(parts, CASE WHEN f ? 'and' THEN ' and ' ELSE ' or ' END) || ')';
  END IF;
  col := f->>'col'; op := f->>'op'; v := f->'val';
  IF v IS NOT NULL AND (pg_catalog.jsonb_typeof(v) NOT IN ('string','number','boolean')
     OR pg_catalog.length(v #>> '{}') > CASE WHEN op = 'imatch' THEN 1024 ELSE 512 END) THEN
    RAISE EXCEPTION 'filter_value' USING ERRCODE = '22023';
  END IF;
  IF op = 'ilike' AND pg_catalog.length(v #>> '{}') - pg_catalog.length(pg_catalog.replace(v #>> '{}', '%', '')) > 8 THEN
    RAISE EXCEPTION 'filter_cost' USING ERRCODE = '22023';
  END IF;
  IF col IS NULL OR NOT (col = ANY (cols)) THEN RAISE EXCEPTION 'filter_column' USING ERRCODE = '22023'; END IF;
  IF op = 'is_null' THEN s := pg_catalog.format('%I is null', col);
  ELSIF op = 'eq' THEN s := pg_catalog.format('%I::text = %L', col, v #>> '{}');
  ELSIF op = 'neq' THEN s := pg_catalog.format('%I::text <> %L', col, v #>> '{}');
  ELSIF op = 'ilike' THEN s := pg_catalog.format('%I ilike %L', col, v #>> '{}');
  ELSIF op = 'imatch' THEN s := pg_catalog.format('%I ~* %L', col, v #>> '{}');
  ELSIF op = 'gte' THEN s := pg_catalog.format('%I >= %L', col, v #>> '{}');
  ELSIF op = 'lt' THEN s := pg_catalog.format('%I < %L', col, v #>> '{}');
  ELSIF op = 'lte' THEN s := pg_catalog.format('%I <= %L', col, v #>> '{}');
  ELSE RAISE EXCEPTION 'filter_op' USING ERRCODE = '22023'; END IF;
  IF coalesce((f->>'not')::boolean, false) THEN s := 'not (' || s || ')'; END IF;   -- PostgREST not.<op>: NULL stays NULL
  RETURN s;
END $f$;

-- Search capture: ONE statement (ordered -> aggregate in rank order -> insert), the single-CTE capture of the PR #898
-- fixture. Order = the route's: verified DESC (Postgres default NULLS FIRST) when sort=match, posted_at DESC NULLS LAST,
-- id DESC. Base relation: public.jobs, or public.jobs_without_excluded_skills(text[]) when excluded skills are given.
-- That function's real definition is not in the repo; 01_precheck prints it. Only its name and (text[]) signature are
-- relied on here (the same signature as docs/proposed/executable/20261126c_advanced_skill_filter_rpc.sql).
CREATE FUNCTION public.feed_capture_search_snapshot(p_filters jsonb, p_verified_first boolean, p_owner uuid, p_tier text,
                                                    p_query_hash text, p_scoring_rev text, p_max integer, p_ttl_min integer,
                                                    p_excluded text[] DEFAULT NULL)
RETURNS TABLE (snapshot_id text, n integer) LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $f$
DECLARE w text; q text; base text := 'public.jobs'; ord text; leaves integer;
BEGIN
  IF p_owner IS NULL THEN RAISE EXCEPTION 'bad_owner' USING ERRCODE = '22023'; END IF;
  PERFORM public.feed_snapshot_check_args('search', p_tier, p_query_hash, p_scoring_rev, p_ttl_min);
  IF p_max IS NULL OR p_max < 1 OR p_max > 20000 THEN RAISE EXCEPTION 'bad_max' USING ERRCODE = '22023'; END IF;
  IF pg_catalog.octet_length(p_filters::text) > 16384 THEN RAISE EXCEPTION 'filter_bytes' USING ERRCODE = '22023'; END IF;
  SELECT count(*) INTO leaves FROM pg_catalog.jsonb_path_query(p_filters, 'strict $.**.col');
  IF leaves > 200 THEN RAISE EXCEPTION 'filter_nodes' USING ERRCODE = '22023'; END IF;
  IF p_excluded IS NOT NULL THEN
    IF pg_catalog.cardinality(p_excluded) > 50
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_excluded) AS e(x) WHERE x IS NULL OR pg_catalog.length(x) > 100) THEN
      RAISE EXCEPTION 'excluded_skills' USING ERRCODE = '22023';
    END IF;
    base := 'public.jobs_without_excluded_skills($5)';
  END IF;
  w := public.feed_snapshot_filter_sql(p_filters);
  PERFORM public.feed_snapshot_admit(p_owner);
  ord := CASE WHEN p_verified_first THEN 'verified desc, ' ELSE '' END || 'posted_at desc nulls last, id desc';
  q := pg_catalog.format($q$
    WITH ordered AS (SELECT id, pg_catalog.row_number() OVER (ORDER BY %s) AS rn FROM %s WHERE %s ORDER BY %s LIMIT %s),
    agg AS (SELECT count(*)::integer AS c, pg_catalog.array_agg(id ORDER BY rn) AS ids FROM ordered),
    ins AS (INSERT INTO public.feed_snapshots (kind, owner_id, tier, query_hash, scoring_rev, ids, member_count, expires_at)
            SELECT 'search', $1, $2, $3, $4, agg.ids, agg.c, pg_catalog.now() + pg_catalog.make_interval(mins => $6)
              FROM agg WHERE agg.c > 0 AND agg.c <= %s
            RETURNING id)
    SELECT (SELECT id FROM ins), (SELECT c FROM agg)$q$, ord, base, w, ord, p_max + 1, p_max);
  EXECUTE q INTO snapshot_id, n USING p_owner, p_tier, p_query_hash, p_scoring_rev, p_excluded, p_ttl_min;
  IF n > p_max THEN RAISE EXCEPTION 'capture_too_large' USING ERRCODE = '54000'; END IF;   -- insert was skipped
  IF n = 0 THEN RETURN; END IF;                                                            -- nothing matched: no row
  RETURN NEXT;
END $f$;

-- Read one id window. Re-checks expiry AND the full binding inside the function on every call. Unknown, expired and
-- mismatched ids raise the same error (no oracle for guessing). Never an offset fallback.
CREATE FUNCTION public.feed_read_snapshot_window(p_id text, p_owner uuid, p_tier text, p_query_hash text,
                                                 p_position integer, p_count integer)
RETURNS TABLE (ids uuid[], total integer, kind text, scoring_rev text, expires_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE r record;
BEGIN
  IF p_count IS NULL OR p_count < 1 OR p_count > (SELECT l.max_window FROM public.feed_snapshot_limits() l) THEN
    RAISE EXCEPTION 'bad_count' USING ERRCODE = '22023';
  END IF;
  IF p_position IS NULL OR p_position < 0 THEN RAISE EXCEPTION 'bad_position' USING ERRCODE = '22023'; END IF;
  SELECT s.* INTO r FROM public.feed_snapshots s
   WHERE s.id = p_id AND s.expires_at > pg_catalog.now()
     AND s.owner_id = p_owner AND s.tier = p_tier AND s.query_hash = p_query_hash;
  IF NOT FOUND THEN RAISE EXCEPTION 'snapshot_unavailable' USING ERRCODE = 'P0002'; END IF;
  IF p_position > r.member_count THEN RAISE EXCEPTION 'bad_position' USING ERRCODE = '22023'; END IF;
  ids := r.ids[p_position + 1 : p_position + p_count];
  total := r.member_count; kind := r.kind; scoring_rev := r.scoring_rev; expires_at := r.expires_at;
  RETURN NEXT;
END $$;

-- Bounded TTL purge. Reads never serve expired rows; this only reclaims space.
CREATE FUNCTION public.feed_purge_expired_snapshots(p_limit integer DEFAULT 500) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
DECLARE removed integer;
BEGIN
  DELETE FROM public.feed_snapshots s WHERE s.id IN (
    SELECT x.id FROM public.feed_snapshots x WHERE x.expires_at <= pg_catalog.now()
     ORDER BY x.expires_at LIMIT least(greatest(coalesce(p_limit, 500), 1), 5000));
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

REVOKE ALL ON FUNCTION public.feed_snapshot_limits() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feed_snapshot_admit(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feed_snapshot_check_args(text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feed_capture_snapshot(text, uuid, text, text, text, uuid[], integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feed_snapshot_filter_sql(jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feed_capture_search_snapshot(jsonb, boolean, uuid, text, text, text, integer, integer, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feed_read_snapshot_window(text, uuid, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feed_purge_expired_snapshots(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feed_snapshot_limits() TO service_role;
GRANT EXECUTE ON FUNCTION public.feed_snapshot_admit(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.feed_snapshot_check_args(text, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.feed_capture_snapshot(text, uuid, text, text, text, uuid[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.feed_snapshot_filter_sql(jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.feed_capture_search_snapshot(jsonb, boolean, uuid, text, text, text, integer, integer, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.feed_read_snapshot_window(text, uuid, text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.feed_purge_expired_snapshots(integer) TO service_role;

COMMIT;
