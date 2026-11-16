/**
 * scripts/test-postgres-migration-rollback-fixture.ts
 *
 * Executes forward migration 20261116a followed by rollback SQL on a real
 * in-process PostgreSQL database (PGlite) populated with legacy and vendor-valued fixtures.
 *
 * Verifies:
 * 1. Pre-migration populated baseline: old app queries on jobs & jobs_public work.
 * 2. Forward migration executes cleanly, creates columns, backfills data, adds constraints and indexes.
 * 3. Vendor-valued rows (greenhouse, lever, microsoft) are inserted successfully.
 * 4. Rollback SQL executes cleanly without column-rename errors on jobs_public.
 * 5. In rollback, compatible expanded source_type constraint prevents violation on vendor rows.
 * 6. Post-rollback: old app queries still work, all data (legacy + vendor) remains, and additive columns are preserved.
 */

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import * as fs from "fs";
import * as path from "path";
import * as assert from "assert";

export async function runMigrationRollbackFixtureTest(): Promise<void> {
  console.log("Starting PostgreSQL Forward & Rollback Fixture Test with PGlite...");
  const db = new PGlite({ extensions: { pgcrypto } });

  // 1. Setup Postgres roles required by migrations
  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
    END $$;
  `);

  // 2. Setup pre-migration baseline schema
  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE public.companies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      slug text UNIQUE NOT NULL,
      domain text,
      created_at timestamptz DEFAULT now()
    );

    CREATE TABLE public.jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL,
      company text NOT NULL,
      company_slug text,
      company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL,
      location text,
      country text,
      country_code text,
      currency text,
      remote boolean DEFAULT false,
      remote_scope text,
      remote_eligibility text,
      job_type text,
      category text,
      seniority text,
      status text DEFAULT 'active',
      is_active boolean DEFAULT true,
      description text,
      apply_url text,
      salary_text text,
      salary_min numeric,
      salary_max numeric,
      salary_period text,
      verified boolean DEFAULT false,
      source text,
      source_type text CHECK (source_type IN ('ats', 'api', 'feed', 'direct')),
      source_job_id text,
      first_seen_at timestamptz DEFAULT now(),
      last_seen_at timestamptz DEFAULT now(),
      discovered_at timestamptz DEFAULT now(),
      posted_at timestamptz DEFAULT now(),
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      expires_at timestamptz,
      is_featured boolean DEFAULT false,
      featured_until timestamptz,
      experience_level text,
      tags text[],
      workplace_type text,
      department text,
      external_id text,
      skills text[] DEFAULT '{}'::text[]
    );

    -- Pre-migration true definition of jobs_public (from 20261010_lock_paid_jobs_data.sql)
    CREATE VIEW public.jobs_public AS
    SELECT
      id,
      title,
      location,
      remote,
      remote_scope,
      remote_eligibility,
      job_type,
      category,
      country,
      country_code,
      seniority,
      verified,
      source_type,
      first_seen_at,
      last_seen_at,
      discovered_at,
      posted_at,
      created_at,
      status,
      is_active,
      'Verified Employer'::text AS company,
      NULL::text AS salary_text,
      NULL::text AS description,
      NULL::text AS apply_url,
      '{}'::text[] AS skills
    FROM public.jobs
    WHERE is_active = true OR status = 'active';

    GRANT SELECT ON public.jobs_public TO anon, authenticated, service_role;
  `);

  // 3. Populate pre-migration baseline data
  await db.exec(`
    INSERT INTO public.companies (id, name, slug, domain)
    VALUES ('11111111-1111-1111-1111-111111111111', 'Stripe', 'stripe', 'stripe.com');

    INSERT INTO public.jobs (
      id, title, company, company_slug, company_id, location, country, country_code,
      remote, source_type, source_job_id, salary_min, salary_max, is_active, status
    ) VALUES (
      '22222222-2222-2222-2222-222222222222', 'Staff Backend Engineer', 'Stripe', 'stripe',
      '11111111-1111-1111-1111-111111111111', 'San Francisco, CA', 'United States', 'US',
      true, 'ats', 'stripe-1001', 180000, 240000, true, 'active'
    ), (
      '33333333-3333-3333-3333-333333333333', 'Product Manager', 'Stripe', 'stripe',
      '11111111-1111-1111-1111-111111111111', 'Remote', 'United States', 'US',
      true, 'direct', 'stripe-1002', 140000, 190000, true, 'active'
    );
  `);

  // Assert baseline app queries work
  const baselinePublic = await db.query("SELECT id, title, location, remote, is_active, company FROM public.jobs_public;");
  assert.strictEqual(baselinePublic.rows.length, 2, "Baseline jobs_public must return 2 rows");
  console.log("  [PASS] Pre-migration populated baseline verified.");

  // 4. Read forward migration SQL
  const migrationPath = path.resolve(__dirname, "../supabase/migrations/20261116a_high_volume_ingestion_schema.sql");
  const migrationContent = fs.readFileSync(migrationPath, "utf-8");

  // Extract forward SQL (between BEGIN; and COMMIT;)
  const beginIdx = migrationContent.indexOf("BEGIN;");
  const commitIdx = migrationContent.indexOf("COMMIT;");
  assert.ok(beginIdx !== -1 && commitIdx !== -1, "Migration must contain BEGIN and COMMIT");
  const forwardSql = migrationContent.substring(beginIdx, commitIdx + "COMMIT;".length);

  // Execute forward migration on PGlite
  await db.exec(forwardSql);
  console.log("  [PASS] Forward migration executed successfully.");

  // Assert forward migration state: columns exist, backfills applied
  const migratedJob = await db.query<{ is_remote: boolean; source_priority: number; dedupe_hash: string }>(
    "SELECT is_remote, source_priority, dedupe_hash FROM public.jobs WHERE id = '22222222-2222-2222-2222-222222222222';"
  );
  assert.strictEqual(migratedJob.rows[0].is_remote, true, "is_remote must be backfilled from remote");
  assert.strictEqual(migratedJob.rows[0].source_priority, 1, "source_priority must be backfilled to 1 for ATS");
  assert.ok(migratedJob.rows[0].dedupe_hash, "dedupe_hash must be backfilled");

  const migratedCompany = await db.query<{ canonical_domain: string }>(
    "SELECT canonical_domain FROM public.companies WHERE slug = 'stripe';"
  );
  assert.strictEqual(migratedCompany.rows[0].canonical_domain, "stripe.com", "canonical_domain must be backfilled");

  // 5. Ingest new vendor-valued rows (greenhouse, lever, microsoft)
  await db.exec(`
    INSERT INTO public.jobs (
      id, title, company, company_slug, source_type, source_id, source_job_id,
      role_category, is_remote, source_priority, is_active, status
    ) VALUES (
      '44444444-4444-4444-4444-444444444444', 'Infrastructure Architect', 'Stripe', 'stripe',
      'greenhouse', 'greenhouse:stripe', 'stripe:gh-1', 'SDE', true, 1, true, 'active'
    ), (
      '55555555-5555-5555-5555-555555555555', 'Site Reliability Engineer', 'Figma', 'figma',
      'lever', 'lever:figma', 'figma:lev-1', 'CLOUD', true, 1, true, 'active'
    ), (
      '66666666-6666-6666-6666-666666666666', 'Data Scientist', 'Microsoft', 'microsoft',
      'microsoft', 'microsoft:global', 'ms:202', 'DATA', false, 2, true, 'active'
    );
  `);
  console.log("  [PASS] Vendor-valued rows (greenhouse, lever, microsoft) inserted successfully.");

  // 6. Extract and execute actual ROLLBACK SQL from migration footer
  const startMarker = "--   -- 1.";
  const startIdx = migrationContent.indexOf(startMarker);
  assert.ok(startIdx !== -1, "Migration must contain '--   -- 1.' in rollback section");
  const rollbackSqlRaw = migrationContent.substring(startIdx);

  const rollbackLines = rollbackSqlRaw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("--   --") && !l.startsWith("--    Policy:") && !l.startsWith("-- ====") && l.length > 0)
    .map((l) => l.replace(/^--\s*/, ""))
    .join("\n");

  console.log("  Executing extracted Rollback SQL commands on populated database...");
  await db.exec(rollbackLines);
  console.log("  [PASS] Rollback SQL executed cleanly with ZERO errors.");

  // 7. Assert Post-Rollback Behavior
  // A. Assert old app queries on jobs_public work and return all 5 active jobs
  const postRollbackPublic = await db.query(
    "SELECT id, title, location, remote, is_active, company, salary_text FROM public.jobs_public WHERE is_active = true;"
  );
  assert.strictEqual(postRollbackPublic.rows.length, 5, "jobs_public must return all 5 jobs after rollback");

  // B. Assert old app queries on jobs work and return expected rows
  const postRollbackJobs = await db.query(
    "SELECT id, title, company, source_type, salary_min, salary_max FROM public.jobs ORDER BY created_at;"
  );
  assert.strictEqual(postRollbackJobs.rows.length, 5, "public.jobs must still contain all 5 rows");

  // C. Assert vendor-valued rows still exist and do NOT violate constraint checks
  const vendorJobs = await db.query(
    "SELECT source_type, count(*) as count FROM public.jobs GROUP BY source_type ORDER BY source_type;"
  );
  const vendorTypes = vendorJobs.rows.map((r: any) => r.source_type);
  assert.ok(vendorTypes.includes("greenhouse"), "greenhouse row must remain");
  assert.ok(vendorTypes.includes("lever"), "lever row must remain");
  assert.ok(vendorTypes.includes("microsoft"), "microsoft row must remain");

  // D. Assert additive columns are NOT dropped and their data is intact
  const additiveCheck = await db.query<{ source_id: string; role_category: string }>(
    "SELECT source_id, role_category FROM public.jobs WHERE id = '44444444-4444-4444-4444-444444444444';"
  );
  assert.strictEqual(additiveCheck.rows[0].source_id, "greenhouse:stripe", "source_id column must still exist and retain data");
  assert.strictEqual(additiveCheck.rows[0].role_category, "SDE", "role_category column must still exist and retain data");

  // E. Assert new check constraints and indexes were dropped
  const droppedConstraints = await db.query(
    "SELECT conname FROM pg_constraint WHERE conname IN ('jobs_role_category_check', 'jobs_source_priority_check', 'companies_category_check');"
  );
  assert.strictEqual(droppedConstraints.rows.length, 0, "New check constraints must be dropped");

  const droppedIndexes = await db.query(
    "SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_jobs_source_id_source_job_id_uniq', 'idx_jobs_active_dedupe_hash_uniq');"
  );
  assert.strictEqual(droppedIndexes.rows.length, 0, "New partial unique indexes must be dropped");

  // F. Assert trigger was dropped
  const droppedTrigger = await db.query(
    "SELECT tgname FROM pg_trigger WHERE tgname = 'trg_jobs_merge_dedupe_priority';"
  );
  assert.strictEqual(droppedTrigger.rows.length, 0, "Trigger must be dropped");

  console.log("  [PASS] All post-rollback assertions PASSED (data intact, queries work, columns preserved).");
  console.log("PGlite Forward & Rollback Fixture Test completed successfully.");
}

// Allow direct CLI invocation via tsx
if (require.main === module) {
  runMigrationRollbackFixtureTest()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("FAIL in runMigrationRollbackFixtureTest:", err);
      process.exit(1);
    });
}
