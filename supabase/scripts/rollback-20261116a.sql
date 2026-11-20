-- ============================================================================
-- Rollback for 20261116a_high_volume_ingestion_schema.sql (data-preserving, atomic)
--   psql -v ON_ERROR_STOP=1 -f supabase/scripts/rollback-20261116a.sql
--
-- Considers ONLY columns marked COMMENT 'added by 20261116a' (columns #645 / #643 created are never
-- marked and never touched). A marked column is dropped only when:
--   - every row holds NULL or the column default (nothing to lose; re-applying 16a recreates it), and
--   - no view, index, constraint or other object depends on it (no CASCADE is ever used).
-- Otherwise it is kept and reported with a NOTICE. No row is updated or deleted.
--
-- Concurrency: before the emptiness check, the transaction takes ACCESS EXCLUSIVE on every table that
-- has a marked column (jobs before companies) and holds it through DROP COLUMN to COMMIT, so no ingest
-- write can commit between the check and the drop. ACCESS EXCLUSIVE is what DROP COLUMN needs anyway, so
-- there is no lock upgrade inside the rollback (SHARE ROW EXCLUSIVE would have to upgrade at the drop and
-- can deadlock with a read-then-write ingest transaction). Readers and writers of those tables wait for
-- this short transaction. If the lock is not granted within lock_timeout (3s), or PostgreSQL reports a
-- deadlock, the rollback refuses and changes nothing; retry later.
-- Tested by scripts/test-16a-repair-aware.ts (populated scoped/full #645 + #643 baselines) and
-- scripts/test-16a-rollback-concurrency.ts (two sessions on a disposable real PostgreSQL cluster).
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
  r record;
  v_rel regclass;
  v_has_data boolean;
BEGIN
  -- [lock:begin] writer-blocking lock first, held to COMMIT
  BEGIN
    FOR v_rel IN
      SELECT c.oid::regclass FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('jobs', 'companies')
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                       AND col_description(a.attrelid, a.attnum) = 'added by 20261116a')
       ORDER BY CASE c.relname WHEN 'jobs' THEN 0 ELSE 1 END
    LOOP
      EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', v_rel);
    END LOOP;
  EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    RAISE EXCEPTION '20261116a rollback refused: could not take write-blocking locks (%: a concurrent session holds a conflicting lock); nothing was changed, retry later',
      SQLERRM USING ERRCODE = 'lock_not_available';
  END;
  -- [lock:end]

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
    -- [check-to-drop window]
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN %I', r.t, r.col);
    RAISE NOTICE 'rollback 20261116a: dropped empty public.%.%', r.t, r.col;
  END LOOP;
END $$;

COMMIT;
