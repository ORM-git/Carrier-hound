-- ============================================================================
-- rollback-20261116b-remove-if-empty.sql: Level 2 rollback of 20261116b (optional, after Level 1)
--
-- Removes the objects 20261116b CREATED, only when that destroys no data:
--   refuses unless Level 1 ran (state 'disabled'), every created table is empty, and no column the
--   migration added to a pre-existing table still holds a reference into a created table.
-- Then drops: created views -> created tables in FK-dependency order -> created enum types nothing uses.
-- Never drops: pre-existing objects, columns added to pre-existing tables, jobs.source_id, #645 objects,
-- the internal_ingestion schema or the provenance record. No CASCADE. Atomic: any refusal changes nothing.
-- Concurrency: before any check it locks, in one fixed order (FK children before parents), every created
-- table and every pre-existing FK parent of one in ACCESS EXCLUSIVE (what the DROPs take), and every other
-- pre-existing table that holds or can hold references into them in EXCLUSIVE (writes blocked, reads not),
-- and holds the locks through COMMIT. A concurrent writer therefore either blocks until removal has
-- committed, or makes removal refuse (lock_timeout / deadlock while locking, or non-empty at check time).
-- A committed write is never dropped. Reads of jobs, companies and auth.users also wait while it runs
-- (DROP TABLE of a child needs ACCESS EXCLUSIVE on its parent): run it in a maintenance window.
--
-- Run as one unit:  psql -v ON_ERROR_STOP=1 -f supabase/scripts/rollback-20261116b-remove-if-empty.sql
-- Tested by scripts/test-10m-schema-step1-rehearsal.ts (PGlite) and scripts/test-10m-schema-step1-postgres.ts.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15min';

DO $$
DECLARE
  r record;
  rel regclass;
  n bigint;
  blockers text := '';
  progressed boolean;
  remaining integer;
BEGIN
  IF to_regclass('internal_ingestion.schema_migration_provenance') IS NULL THEN
    RAISE EXCEPTION '20261116b removal refused: provenance record missing';
  END IF;

  -- Lock prelude. No state, emptiness or reference check runs before these locks are held, and they are
  -- held through COMMIT, so no write can land between a check and the DROP that relies on it, and no
  -- lock is requested after the checks (no upgrade, no mid-script lock_timeout). Locked tables:
  --   - created tables: ACCESS EXCLUSIVE (what DROP TABLE takes);
  --   - pre-existing FK parents of created tables (e.g. jobs, companies, auth.users): ACCESS EXCLUSIVE, which
  --     DROP TABLE of the referencing child takes anyway (it removes the FK triggers on the parent);
  --   - pre-existing reference holders (tables where 16b added a column pointing into a created table, or
  --     with a live FK into one), unless already a parent above: EXCLUSIVE (blocks writes, allows reads).
  -- Order: one fixed topological order over all of them, FK children before parents (the migration
  -- prelude's saved_jobs -> job_descriptions -> jobs -> companies), ties by name. A lock_timeout or a
  -- deadlock while locking refuses the removal with nothing changed.
  BEGIN
    FOR r IN
      WITH RECURSIVE created AS (
        SELECT to_regclass(format('%I.%I', p.schema_name, p.object_name))::oid AS oid_
          FROM internal_ingestion.schema_migration_provenance p
         WHERE p.migration = '20261116b' AND p.kind = 'relation' AND p.detail IN ('r', 'p')
           AND NOT (p.schema_name = 'internal_ingestion' AND p.object_name = 'schema_migration_provenance')
           AND to_regclass(format('%I.%I', p.schema_name, p.object_name)) IS NOT NULL
      ), recorded_refs AS (   -- 16b FK columns on pre-existing tables (Level 1 dropped the constraint itself)
        SELECT to_regclass(format('%I.%I', p.schema_name, p.object_name))::oid AS child,
               to_regclass(substring(p.detail FROM 'REFERENCES ([^ (]+)\('))::oid AS parent
          FROM internal_ingestion.schema_migration_provenance p
         WHERE p.migration = '20261116b' AND p.kind = 'constraint' AND p.detail LIKE 'FOREIGN KEY%'
           AND NOT EXISTS (SELECT 1 FROM internal_ingestion.schema_migration_provenance x WHERE x.migration = '20261116b'
                             AND x.kind = 'relation' AND x.schema_name = p.schema_name AND x.object_name = p.object_name)
      ), live_refs AS (
        SELECT k.conrelid AS child, k.confrelid AS parent FROM pg_constraint k
         WHERE k.contype = 'f' AND k.conrelid <> k.confrelid
           AND (k.conrelid IN (SELECT oid_ FROM created) OR k.confrelid IN (SELECT oid_ FROM created))
      ), touching AS (
        SELECT child, parent FROM recorded_refs WHERE child IS NOT NULL AND parent IN (SELECT oid_ FROM created)
        UNION SELECT child, parent FROM live_refs
      ), nodes AS (
        SELECT oid_, 'ACCESS EXCLUSIVE' AS mode FROM created
        UNION ALL SELECT DISTINCT parent, 'ACCESS EXCLUSIVE' FROM touching
         WHERE child IN (SELECT oid_ FROM created) AND parent NOT IN (SELECT oid_ FROM created)
        UNION ALL SELECT DISTINCT child, 'EXCLUSIVE' FROM touching
         WHERE parent IN (SELECT oid_ FROM created) AND child NOT IN (SELECT oid_ FROM created)
           AND child NOT IN (SELECT parent FROM touching WHERE child IN (SELECT oid_ FROM created))
      ), edges AS (   -- every FK child -> parent among the nodes (recorded 16b columns included)
        SELECT DISTINCT e.child, e.parent FROM (
          SELECT child, parent FROM recorded_refs
          UNION SELECT k.conrelid, k.confrelid FROM pg_constraint k WHERE k.contype = 'f' AND k.conrelid <> k.confrelid) e
         WHERE e.child IN (SELECT oid_ FROM nodes) AND e.parent IN (SELECT oid_ FROM nodes) AND e.child <> e.parent
      ), d(oid_, lvl) AS (   -- lvl = longest FK chain below it (0 = nothing among the nodes references it)
        SELECT oid_, 0 FROM nodes
        UNION ALL
        SELECT e.parent, d.lvl + 1 FROM d JOIN edges e ON e.child = d.oid_ WHERE d.lvl < 32
      )
      SELECT nd.oid_::regclass AS rel, nd.mode, max(d.lvl) AS lvl
        FROM nodes nd JOIN d ON d.oid_ = nd.oid_
       GROUP BY nd.oid_, nd.mode
       ORDER BY 3, (SELECT format('%I.%I', ns.nspname, c.relname) FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE c.oid = nd.oid_)
    LOOP
      EXECUTE format('LOCK TABLE %s IN %s MODE', r.rel, r.mode);
    END LOOP;
  EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    RAISE EXCEPTION '20261116b removal refused: could not take write-blocking locks (%: a concurrent session holds a conflicting lock); nothing was changed, retry later',
      SQLERRM USING ERRCODE = 'lock_not_available';
  END;

  IF NOT EXISTS (SELECT 1 FROM internal_ingestion.schema_migration_provenance
                  WHERE migration = '20261116b' AND kind = 'state' AND object_name = 'disabled') THEN
    RAISE EXCEPTION '20261116b removal refused: run supabase/scripts/rollback-20261116b-disable.sql first';
  END IF;

  -- Precondition 1: every created table is empty (the provenance table itself is kept)
  FOR r IN
    SELECT p.schema_name, p.object_name FROM internal_ingestion.schema_migration_provenance p
     WHERE p.migration = '20261116b' AND p.kind = 'relation' AND p.detail IN ('r', 'p')
       AND NOT (p.schema_name = 'internal_ingestion' AND p.object_name = 'schema_migration_provenance')
       AND to_regclass(format('%I.%I', p.schema_name, p.object_name)) IS NOT NULL
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I', r.schema_name, r.object_name) INTO n;
    IF n > 0 THEN blockers := blockers || format(' %I.%I has %s rows;', r.schema_name, r.object_name, n); END IF;
  END LOOP;

  -- Precondition 2: added columns that referenced a created table hold no values pointing into it
  FOR r IN
    SELECT p.schema_name, p.object_name, substring(p.detail FROM '^FOREIGN KEY \(([a-z_]+)\)') AS col
      FROM internal_ingestion.schema_migration_provenance p
     WHERE p.migration = '20261116b' AND p.kind = 'constraint' AND p.detail LIKE 'FOREIGN KEY%'
       AND NOT EXISTS (SELECT 1 FROM internal_ingestion.schema_migration_provenance x WHERE x.migration = '20261116b'
                         AND x.kind = 'relation' AND x.schema_name = p.schema_name AND x.object_name = p.object_name)
  LOOP
    CONTINUE WHEN r.col IS NULL OR to_regclass(format('%I.%I', r.schema_name, r.object_name)) IS NULL;
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I IS NOT NULL', r.schema_name, r.object_name, r.col) INTO n;
    IF n > 0 THEN blockers := blockers || format(' %I.%I.%I is set on %s rows;', r.schema_name, r.object_name, r.col, n); END IF;
  END LOOP;

  IF blockers <> '' THEN
    RAISE EXCEPTION '20261116b removal refused (data would be lost):%', blockers;
  END IF;

  -- 1. created views
  FOR r IN
    SELECT p.schema_name, p.object_name FROM internal_ingestion.schema_migration_provenance p
     WHERE p.migration = '20261116b' AND p.kind = 'relation' AND p.detail IN ('v', 'm')
       AND to_regclass(format('%I.%I', p.schema_name, p.object_name)) IS NOT NULL
  LOOP
    EXECUTE format('DROP VIEW %I.%I', r.schema_name, r.object_name);
  END LOOP;

  -- 2. created tables, leaves first: drop a table only when no OTHER table still references it
  LOOP
    progressed := false;
    FOR r IN
      SELECT p.schema_name, p.object_name, to_regclass(format('%I.%I', p.schema_name, p.object_name)) AS oid_
        FROM internal_ingestion.schema_migration_provenance p
       WHERE p.migration = '20261116b' AND p.kind = 'relation' AND p.detail IN ('r', 'p')
         AND NOT (p.schema_name = 'internal_ingestion' AND p.object_name = 'schema_migration_provenance')
         AND to_regclass(format('%I.%I', p.schema_name, p.object_name)) IS NOT NULL
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.contype = 'f' AND k.confrelid = r.oid_ AND k.conrelid <> r.oid_) THEN
        EXECUTE format('DROP TABLE %I.%I', r.schema_name, r.object_name);
        progressed := true;
      END IF;
    END LOOP;
    SELECT count(*) INTO remaining FROM internal_ingestion.schema_migration_provenance p
     WHERE p.migration = '20261116b' AND p.kind = 'relation' AND p.detail IN ('r', 'p')
       AND NOT (p.schema_name = 'internal_ingestion' AND p.object_name = 'schema_migration_provenance')
       AND to_regclass(format('%I.%I', p.schema_name, p.object_name)) IS NOT NULL;
    EXIT WHEN remaining = 0;
    IF NOT progressed THEN
      RAISE EXCEPTION '20261116b removal refused: % created table(s) are still referenced from outside (no CASCADE)', remaining;
    END IF;
  END LOOP;

  -- 3. created enum types nothing depends on any more
  FOR r IN
    SELECT p.schema_name, p.object_name, t.oid AS type_oid FROM internal_ingestion.schema_migration_provenance p
      JOIN pg_namespace ns ON ns.nspname = p.schema_name
      JOIN pg_type t ON t.typnamespace = ns.oid AND t.typname = p.object_name
     WHERE p.migration = '20261116b' AND p.kind = 'type'
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.refclassid = 'pg_type'::regclass AND d.refobjid = r.type_oid AND d.deptype = 'n') THEN
      EXECUTE format('DROP TYPE %I.%I', r.schema_name, r.object_name);
    ELSE
      RAISE NOTICE 'keeping type %.% (still in use)', r.schema_name, r.object_name;
    END IF;
  END LOOP;

  INSERT INTO internal_ingestion.schema_migration_provenance (migration, kind, schema_name, object_name, sub_name, detail)
  VALUES ('20261116b', 'state', '', 'removed', '', now()::text)
  ON CONFLICT (migration, kind, schema_name, object_name, sub_name) DO UPDATE SET detail = EXCLUDED.detail, recorded_at = now();
END $$;

COMMIT;
