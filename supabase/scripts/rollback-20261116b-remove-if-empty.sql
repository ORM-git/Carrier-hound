-- ============================================================================
-- rollback-20261116b-remove-if-empty.sql: Level 2 rollback of 20261116b (optional, after Level 1)
--
-- Removes the objects 20261116b CREATED, only when that destroys no data:
--   refuses unless Level 1 ran (state 'disabled'), every created table is empty, and no column the
--   migration added to a pre-existing table still holds a reference into a created table.
-- Then drops: created views -> created tables in FK-dependency order -> created enum types nothing uses.
-- Never drops: pre-existing objects, columns added to pre-existing tables, jobs.source_id, #645 objects,
-- the internal_ingestion schema or the provenance record. No CASCADE. Atomic: any refusal changes nothing.
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
