-- REVIEW ONLY, NOT APPLIED. Owner-run after preflight and review.
-- No backfill, defaults, RLS/grant changes or source-data population.
-- Existing experience_level text is reused for comma-serialized levels; no new level column.
-- NULL preference = unset/never saved; upper required_years_max NULL = unbounded.
-- See docs/proposed/advanced_preferences_slice1.READONLY.sql before applying.
-- All mutations are atomic. Unexpected existing types, data or same-name checks abort.
BEGIN;

DO $types$
DECLARE item record; actual text;
BEGIN
  IF pg_catalog.to_regclass('public.jobs') IS NULL OR pg_catalog.to_regclass('public.user_preferences') IS NULL THEN
    RAISE EXCEPTION 'advanced preferences: jobs and user_preferences must already exist' USING ERRCODE = '42P01';
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('jobs', 'min_experience_years', 'numeric', false),
    ('jobs', 'max_experience_years', 'numeric', false),
    ('jobs', 'experience_years_source', 'text', true),
    ('user_preferences', 'experience_level', 'text', false),
    ('user_preferences', 'required_years_min', 'numeric', true),
    ('user_preferences', 'required_years_max', 'numeric', true),
    ('user_preferences', 'preferred_skills', 'text[]', true),
    ('user_preferences', 'excluded_skills', 'text[]', true)
  ) AS wanted(tbl, col, typ, optional)
  LOOP
    SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) INTO actual
      FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = pg_catalog.to_regclass('public.' || item.tbl)
        AND a.attname = item.col AND a.attnum > 0 AND NOT a.attisdropped;
    IF actual IS NULL THEN
      IF NOT item.optional THEN
        RAISE EXCEPTION 'advanced preferences: missing %.%', item.tbl, item.col USING ERRCODE = '42703';
      END IF;
    ELSIF actual <> item.typ AND NOT (item.tbl = 'jobs' AND item.col IN ('min_experience_years', 'max_experience_years') AND actual = 'integer') THEN
      RAISE EXCEPTION 'advanced preferences: unexpected type %.%: %, expected %', item.tbl, item.col, actual, item.typ USING ERRCODE = '42804';
    END IF;
  END LOOP;
END $types$;

-- Block invalid existing data BEFORE widening/adding columns. Optional existing
-- preference fields are checked individually so partially migrated schemas are safe.
DO $preflight$
DECLARE item record; bad boolean; col_exists boolean; have_min boolean; have_max boolean;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('jobs','min_experience_years'), ('jobs','max_experience_years'),
    ('user_preferences','required_years_min'), ('user_preferences','required_years_max')
  ) AS cols(tbl,col)
  LOOP
    SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.'||item.tbl) AND attname=item.col AND NOT attisdropped) INTO col_exists;
    IF col_exists THEN
      EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE %I < 0 OR %I::text IN (''NaN'',''Infinity'',''-Infinity''))',item.tbl,item.col,item.col) INTO bad;
      IF bad THEN RAISE EXCEPTION 'advanced preferences: invalid existing %.%',item.tbl,item.col USING ERRCODE='23514'; END IF;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.jobs WHERE min_experience_years > max_experience_years) THEN
    RAISE EXCEPTION 'advanced preferences: inverted existing job years' USING ERRCODE='23514';
  END IF;
  SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='public.user_preferences'::regclass AND attname='required_years_min' AND NOT attisdropped),
         EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='public.user_preferences'::regclass AND attname='required_years_max' AND NOT attisdropped) INTO have_min,have_max;
  IF have_min AND have_max THEN
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.user_preferences WHERE required_years_min > required_years_max)' INTO bad;
    IF bad THEN RAISE EXCEPTION 'advanced preferences: inverted existing preference years' USING ERRCODE='23514'; END IF;
  END IF;
  FOR item IN SELECT * FROM (VALUES ('preferred_skills'),('excluded_skills')) AS cols(col) LOOP
    IF EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='public.user_preferences'::regclass AND attname=item.col AND NOT attisdropped) THEN
      EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM public.user_preferences WHERE cardinality(%I)>50)',item.col) INTO bad;
      IF bad THEN RAISE EXCEPTION 'advanced preferences: oversized existing %',item.col USING ERRCODE='23514'; END IF;
    END IF;
  END LOOP;
END $preflight$;

DO $widen$
DECLARE col text;
BEGIN
  FOREACH col IN ARRAY ARRAY['min_experience_years','max_experience_years'] LOOP
    IF EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='public.jobs'::regclass AND attname=col AND atttypid='integer'::regtype AND NOT attisdropped) THEN
      EXECUTE pg_catalog.format('ALTER TABLE public.jobs ALTER COLUMN %I TYPE numeric USING %I::numeric',col,col);
    END IF;
  END LOOP;
END $widen$;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS experience_years_source text;
ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS required_years_min numeric,
  ADD COLUMN IF NOT EXISTS required_years_max numeric,
  ADD COLUMN IF NOT EXISTS preferred_skills text[],
  ADD COLUMN IF NOT EXISTS excluded_skills text[];

-- Compare PostgreSQL's canonical check rendering, not substring/name-only checks.
-- ADD CHECK validates every existing row before it can commit. NaN compares above finite
-- numbers in Postgres, so explicit text checks are required as well as lower bounds.
DO $checks$
DECLARE target record; expected text; existing text; kind text;
BEGIN
  CREATE TEMP TABLE advanced_preferences_check_probe (
    min_experience_years numeric, max_experience_years numeric,
    required_years_min numeric, required_years_max numeric,
    preferred_skills text[], excluded_skills text[]
  ) ON COMMIT DROP;
  FOR target IN SELECT * FROM (VALUES
    ('jobs', 'jobs_required_experience_bounds_check',
     '(min_experience_years IS NULL OR (min_experience_years >= 0 AND min_experience_years::text NOT IN (''NaN'', ''Infinity'', ''-Infinity''))) AND (max_experience_years IS NULL OR (max_experience_years >= 0 AND max_experience_years::text NOT IN (''NaN'', ''Infinity'', ''-Infinity''))) AND (min_experience_years IS NULL OR max_experience_years IS NULL OR min_experience_years <= max_experience_years)'),
    ('user_preferences', 'user_preferences_required_years_check',
     '(required_years_min IS NULL OR (required_years_min >= 0 AND required_years_min::text NOT IN (''NaN'', ''Infinity'', ''-Infinity''))) AND (required_years_max IS NULL OR (required_years_max >= 0 AND required_years_max::text NOT IN (''NaN'', ''Infinity'', ''-Infinity''))) AND (required_years_min IS NULL OR required_years_max IS NULL OR required_years_min <= required_years_max)'),
    ('user_preferences', 'user_preferences_skill_list_sizes_check',
     'coalesce(cardinality(preferred_skills), 0) <= 50 AND coalesce(cardinality(excluded_skills), 0) <= 50')
  ) AS checks(tbl, cname, expr)
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE pg_temp.advanced_preferences_check_probe ADD CONSTRAINT probe CHECK (%s)', target.expr);
    SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO expected
      FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'pg_temp.advanced_preferences_check_probe'::regclass AND c.conname = 'probe';
    SELECT pg_catalog.pg_get_constraintdef(c.oid), c.contype::text INTO existing, kind
      FROM pg_catalog.pg_constraint c WHERE c.conrelid = pg_catalog.to_regclass('public.' || target.tbl) AND c.conname = target.cname;
    IF existing IS NULL THEN
      EXECUTE pg_catalog.format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s)', target.tbl, target.cname, target.expr);
    ELSIF kind <> 'c' OR pg_catalog.regexp_replace(existing, ' NOT VALID$', '') <> expected THEN
      RAISE EXCEPTION 'advanced preferences: conflicting check %.%', target.tbl, target.cname USING ERRCODE = '42710';
    ELSE
      -- An identical pre-existing NOT VALID check is not proof existing rows are valid.
      EXECUTE pg_catalog.format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', target.tbl, target.cname);
    END IF;
    ALTER TABLE pg_temp.advanced_preferences_check_probe DROP CONSTRAINT probe;
  END LOOP;
END $checks$;
COMMIT;

-- ROLLBACK PLAN, owner review required, never automatic:
-- Restore application readers first; export any saved new preferences/provenance.
-- Drop only the three checks named above, then the five newly added columns if no
-- other migration owns them. Do NOT automatically narrow numeric back to integer:
-- fractional/large values could be lost or rejected. Retain numeric until a separate
-- owner-reviewed data audit proves narrowing safe. Existing experience_level unchanged.
