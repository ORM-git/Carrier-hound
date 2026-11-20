-- ============================================================================
-- Rollback for 20261116a_high_volume_ingestion_schema.sql (data-preserving, atomic)
--   psql -v ON_ERROR_STOP=1 -f supabase/scripts/rollback-20261116a.sql
--
-- Considers ONLY columns marked COMMENT 'added by 20261116a' (columns #645 / #643 created are never
-- marked and never touched). A marked column is dropped only when:
--   - every row holds NULL or the column default (nothing to lose; re-applying 16a recreates it), and
--   - no view, index, constraint or other object depends on it (no CASCADE is ever used).
-- Otherwise it is kept and reported with a NOTICE. No row is updated or deleted.
-- Tested by scripts/test-16a-repair-aware.ts on populated scoped/full #645 + #643 baselines.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
  r record;
  v_has_data boolean;
BEGIN
  FOR r IN
    SELECT c.relname AS t, a.attname AS col, a.attnum, a.attrelid,
           coalesce(pg_get_expr(d.adbin, d.adrelid), 'NULL') AS dflt
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('jobs', 'companies')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND col_description(a.attrelid, a.attnum) = 'added by 20261116a'
     ORDER BY 1, 2
  LOOP
    IF EXISTS (SELECT 1 FROM pg_depend dep
                WHERE dep.refclassid = 'pg_class'::regclass AND dep.refobjid = r.attrelid
                  AND dep.refobjsubid = r.attnum AND dep.deptype IN ('n', 'a')
                  AND NOT (dep.classid = 'pg_attrdef'::regclass)) THEN
      RAISE NOTICE 'rollback 20261116a: keeping public.%.% (other objects depend on it)', r.t, r.col;
      CONTINUE;
    END IF;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE %I IS DISTINCT FROM (%s))', r.t, r.col, r.dflt)
      INTO v_has_data;
    IF v_has_data THEN
      RAISE NOTICE 'rollback 20261116a: keeping public.%.% (holds data)', r.t, r.col;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN %I', r.t, r.col);
    RAISE NOTICE 'rollback 20261116a: dropped empty public.%.%', r.t, r.col;
  END LOOP;
END $$;

COMMIT;
