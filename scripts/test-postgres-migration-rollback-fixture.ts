/**
 * scripts/test-postgres-migration-rollback-fixture.ts
 *
 * Fresh (pre-#645) baseline variant of the 20261116a rehearsal. The populated post-#645 + #643
 * scenarios live in scripts/test-16a-repair-aware.ts.
 *
 * Verifies on a populated legacy baseline (in-process PGlite):
 * 1. 20261116a applies, adds only missing columns and marks them 'added by 20261116a'.
 * 2. It rewrites no row, and leaves the existing source_type CHECK, jobs_public and its grants untouched.
 * 3. New-style rows can write the added columns.
 * 4. supabase/scripts/rollback-20261116a.sql keeps every column that holds data, drops only empty marked
 *    columns, and keeps every row; old app queries on jobs and jobs_public still work.
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

  const fp = async () => (await db.query<{ j: string }>(
    `SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) j FROM (SELECT id, title, company, remote, source_type, source_job_id, last_seen_at, is_active FROM public.jobs) x`)).rows[0].j;
  const viewDef = async () => (await db.query<{ d: string }>(`SELECT pg_get_viewdef('public.jobs_public'::regclass) d`)).rows[0].d;
  const checkDef = async () => (await db.query<{ d: string }>(`SELECT string_agg(pg_get_constraintdef(oid), ';' ORDER BY conname) d FROM pg_constraint WHERE conrelid = 'public.jobs'::regclass AND contype = 'c'`)).rows[0].d;
  const before = { rows: await fp(), view: await viewDef(), checks: await checkDef() };

  // 4. Forward migration, exactly as shipped
  const migrationPath = path.resolve(__dirname, "../supabase/migrations/20261116a_high_volume_ingestion_schema.sql");
  await db.exec(fs.readFileSync(migrationPath, "utf-8"));
  console.log("  [PASS] Forward migration executed successfully.");

  const marked = async () => (await db.query<{ k: string }>(
    `SELECT c.relname || '.' || a.attname k FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('jobs', 'companies') AND a.attnum > 0 AND NOT a.attisdropped
        AND col_description(a.attrelid, a.attnum) = 'added by 20261116a' ORDER BY 1`)).rows.map((r) => r.k);
  assert.deepStrictEqual(await marked(), [
    "companies.canonical_domain", "companies.category", "companies.logo_url",
    "jobs.canonical_domain", "jobs.dedupe_hash", "jobs.is_remote", "jobs.logo_url", "jobs.role_category",
    "jobs.source_id", "jobs.source_priority", "jobs.top_keywords",
  ], "16a must add and mark exactly the missing columns");
  assert.strictEqual(await fp(), before.rows, "16a must not rewrite any row (no backfills, last_seen_at untouched)");
  assert.strictEqual(await viewDef(), before.view, "16a must not replace jobs_public");
  assert.strictEqual(await checkDef(), before.checks, "16a must not drop or replace existing CHECK constraints");
  const fn = await db.query(`SELECT 1 FROM pg_proc WHERE proname IN ('compute_job_dedupe_hash', 'merge_job_by_dedupe_priority')`);
  assert.strictEqual(fn.rows.length, 0, "16a must not create hash or merge functions");
  console.log("  [PASS] Forward migration is additive only.");

  // 5. New-style rows write the added columns
  await db.exec(`
    INSERT INTO public.jobs (id, title, company, company_slug, source_type, source_id, source_job_id, role_category, is_remote, source_priority, is_active, status)
    VALUES ('44444444-4444-4444-4444-444444444444', 'Infrastructure Architect', 'Stripe', 'stripe', 'ats', 'greenhouse:stripe', 'gh-1', 'SDE', true, 1, true, 'active');
  `);
  console.log("  [PASS] New-style rows inserted with source_id / role_category / is_remote / source_priority.");

  // 6. Rollback script, exactly as documented
  console.log("  Executing supabase/scripts/rollback-20261116a.sql on populated database...");
  await db.exec(fs.readFileSync(path.resolve(__dirname, "../supabase/scripts/rollback-20261116a.sql"), "utf-8"));
  console.log("  [PASS] Rollback SQL executed cleanly with ZERO errors.");

  // 7. Post-rollback: columns holding data kept, empty ones dropped, every row kept
  assert.deepStrictEqual(await marked(), ["jobs.is_remote", "jobs.role_category", "jobs.source_id", "jobs.source_priority"],
    "rollback must keep exactly the marked columns that hold data (source_priority holds non-default 1)");
  const kept = await db.query<{ source_id: string; role_category: string }>(
    "SELECT source_id, role_category FROM public.jobs WHERE id = '44444444-4444-4444-4444-444444444444'");
  assert.strictEqual(kept.rows[0].source_id, "greenhouse:stripe", "source_id data must survive rollback");
  assert.strictEqual(kept.rows[0].role_category, "SDE", "role_category data must survive rollback");
  const gone = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name IN ('canonical_domain', 'top_keywords', 'dedupe_hash')`);
  assert.strictEqual(gone.rows.length, 0, "empty 16a columns must be dropped");
  const all = await db.query("SELECT id FROM public.jobs");
  assert.strictEqual(all.rows.length, 3, "public.jobs must keep every row");
  const pub = await db.query("SELECT id, title, location, remote, is_active, company, salary_text FROM public.jobs_public WHERE is_active = true");
  assert.strictEqual(pub.rows.length, 3, "jobs_public must still serve every active row");
  assert.strictEqual(await viewDef(), before.view, "jobs_public definition unchanged after rollback");
  assert.strictEqual(await checkDef(), before.checks, "CHECK constraints unchanged after rollback");

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
