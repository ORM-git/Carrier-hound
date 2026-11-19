-- ============================================================================
-- rollback-20261116b-disable.sql: Level 1 rollback of 20261116b_ten_million_system_design_schema.sql
--
-- Data-preserving, provenance-aware, atomic. Keeps every table, column and row. Uses ONLY
-- internal_ingestion.schema_migration_provenance (written by the migration) to decide what to undo:
--   1. drop the policies, constraints and indexes the migration CREATED on tables that existed before it
--      (pre-existing objects are never touched, even when the migration file mentions their names)
--   2. restore the exact prior grants and RLS flags of pre-existing tables the migration changed
--   3. revoke API access (PUBLIC, anon, authenticated) from relations the migration created
-- No CASCADE, no DROP TABLE, no DROP COLUMN. Idempotent. Re-enable by re-applying the migration.
--
-- Run as one unit:  psql -v ON_ERROR_STOP=1 -f supabase/scripts/rollback-20261116b-disable.sql
-- Tested by scripts/test-10m-schema-step1-rehearsal.ts (PGlite) and scripts/test-10m-schema-step1-postgres.ts.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15min';

DO $$
DECLARE
  t text;
  r record;
  g record;
  rel regclass;
  owner_oid oid;
  n_created integer;
BEGIN
  IF to_regclass('internal_ingestion.schema_migration_provenance') IS NULL THEN
    RAISE EXCEPTION '20261116b rollback refused: provenance record missing, cannot tell what the migration created';
  END IF;
  SELECT count(*) INTO n_created FROM internal_ingestion.schema_migration_provenance
   WHERE migration = '20261116b' AND kind NOT LIKE 'prior\_%' AND kind <> 'state';
  IF n_created = 0 THEN
    RAISE EXCEPTION '20261116b rollback refused: provenance record is empty';
  END IF;

  -- Same lock order as the migration prelude (children before parents)
  FOREACH t IN ARRAY ARRAY['public.saved_jobs', 'public.job_descriptions', 'public.jobs', 'public.companies'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', t);
    END IF;
  END LOOP;

  -- 1a. policies created by the migration on pre-existing tables
  FOR r IN
    SELECT p.schema_name, p.object_name, p.sub_name FROM internal_ingestion.schema_migration_provenance p
     WHERE p.migration = '20261116b' AND p.kind = 'policy'
       AND NOT EXISTS (SELECT 1 FROM internal_ingestion.schema_migration_provenance x WHERE x.migration = '20261116b'
                         AND x.kind = 'relation' AND x.schema_name = p.schema_name AND x.object_name = p.object_name)
       AND EXISTS (SELECT 1 FROM pg_policy pp JOIN pg_class c ON c.oid = pp.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = p.schema_name AND c.relname = p.object_name AND pp.polname = p.sub_name)
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.sub_name, r.schema_name, r.object_name);
  END LOOP;

  -- 1b. constraints created by the migration on pre-existing tables (CHECK, FK, UNIQUE; never NOT NULL)
  FOR r IN
    SELECT p.schema_name, p.object_name, p.sub_name FROM internal_ingestion.schema_migration_provenance p
     WHERE p.migration = '20261116b' AND p.kind = 'constraint'
       AND NOT EXISTS (SELECT 1 FROM internal_ingestion.schema_migration_provenance x WHERE x.migration = '20261116b'
                         AND x.kind = 'relation' AND x.schema_name = p.schema_name AND x.object_name = p.object_name)
       AND EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = p.schema_name AND c.relname = p.object_name AND k.conname = p.sub_name AND k.contype <> 'n')
     ORDER BY CASE WHEN p.detail LIKE 'FOREIGN KEY%' THEN 0 ELSE 1 END, p.object_name, p.sub_name
  LOOP
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', r.schema_name, r.object_name, r.sub_name);
  END LOOP;

  -- 1c. indexes created by the migration on pre-existing tables (constraint-backed indexes went with 1b)
  FOR r IN
    SELECT n.nspname AS schema_name, ic.relname AS index_name
      FROM internal_ingestion.schema_migration_provenance p
      JOIN pg_namespace n ON n.nspname = p.schema_name
      JOIN pg_class ic ON ic.relnamespace = n.oid AND ic.relname = p.object_name AND ic.relkind = 'i'
      JOIN pg_index i ON i.indexrelid = ic.oid
      JOIN pg_class tc ON tc.oid = i.indrelid
     WHERE p.migration = '20261116b' AND p.kind = 'relation' AND p.detail = 'i'
       AND NOT EXISTS (SELECT 1 FROM internal_ingestion.schema_migration_provenance x WHERE x.migration = '20261116b'
                         AND x.kind = 'relation' AND x.schema_name = n.nspname AND x.object_name = tc.relname)
       AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = ic.oid)
  LOOP
    EXECUTE format('DROP INDEX %I.%I', r.schema_name, r.index_name);
  END LOOP;

  -- 2a. restore the exact prior grants of pre-existing relations the migration changed
  FOR r IN
    SELECT p.schema_name, p.object_name, p.detail FROM internal_ingestion.schema_migration_provenance p
     WHERE p.migration = '20261116b' AND p.kind = 'prior_acl'
  LOOP
    rel := to_regclass(format('%I.%I', r.schema_name, r.object_name));
    CONTINUE WHEN rel IS NULL;
    SELECT relowner INTO owner_oid FROM pg_class WHERE oid = rel;
    FOR g IN SELECT DISTINCT a.grantee FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = rel AND a.grantee <> owner_oid LOOP
      EXECUTE format('REVOKE ALL ON %s FROM %s', rel,
                     CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END);
    END LOOP;
    IF r.detail <> '' THEN
      FOR g IN SELECT a.grantee, string_agg(a.privilege_type, ', ') AS privs
                 FROM aclexplode(r.detail::aclitem[]) a WHERE a.grantee <> owner_oid GROUP BY a.grantee LOOP
        EXECUTE format('GRANT %s ON %s TO %s', g.privs, rel,
                       CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END);
      END LOOP;
    END IF;
  END LOOP;

  -- 2b. restore the prior RLS flags ('<enabled>,<forced>')
  FOR r IN
    SELECT p.schema_name, p.object_name, split_part(p.detail, ',', 1)::boolean AS enabled, split_part(p.detail, ',', 2)::boolean AS forced
      FROM internal_ingestion.schema_migration_provenance p
     WHERE p.migration = '20261116b' AND p.kind = 'prior_rls'
  LOOP
    rel := to_regclass(format('%I.%I', r.schema_name, r.object_name));
    CONTINUE WHEN rel IS NULL;
    EXECUTE format('ALTER TABLE %s %s ROW LEVEL SECURITY', rel, CASE WHEN r.enabled THEN 'ENABLE' ELSE 'DISABLE' END);
    EXECUTE format('ALTER TABLE %s %s ROW LEVEL SECURITY', rel, CASE WHEN r.forced THEN 'FORCE' ELSE 'NO FORCE' END);
  END LOOP;

  -- 3. no API access to relations the migration created (data kept for service_role / owner)
  FOR r IN
    SELECT p.schema_name, p.object_name FROM internal_ingestion.schema_migration_provenance p
     WHERE p.migration = '20261116b' AND p.kind = 'relation' AND p.detail IN ('r', 'p', 'v', 'm')
       AND to_regclass(format('%I.%I', p.schema_name, p.object_name)) IS NOT NULL
  LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC, anon, authenticated', r.schema_name, r.object_name);
  END LOOP;

  INSERT INTO internal_ingestion.schema_migration_provenance (migration, kind, schema_name, object_name, sub_name, detail)
  VALUES ('20261116b', 'state', '', 'disabled', '', now()::text)
  ON CONFLICT (migration, kind, schema_name, object_name, sub_name) DO UPDATE SET detail = EXCLUDED.detail, recorded_at = now();
END $$;

COMMIT;
