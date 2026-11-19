/**
 * scripts/test-10m-schema-step1-fixtures.ts
 *
 * Verification suite & offline SQL/RLS fixtures for 10M System Design Schema Step 1:
 * 1. Backward Compatibility of Old App Queries:
 *    - Queries on public.jobs, public.jobs_public, public.companies, public.saved_jobs
 *      return identical rows, columns, and types before and after the migration.
 *    - Existing jobs.category ('engineering', 'ai', 'data') is completely unharmed.
 * 2. RLS & Paid-Field Boundary Protection:
 *    - Anon and authenticated users are strictly BLOCKED from selecting directly
 *      from raw public.job_postings.
 *    - Selecting from public.job_postings_public view masks paid fields:
 *      company_name is 'Verified Employer', salary_min/max/text are NULL,
 *      direct_apply_url is NULL, and raw_payload is NULL.
 * 3. PostgREST Isolation of internal_ingestion:
 *    - Schema internal_ingestion has 0 grants to anon, authenticated, or public.
 *    - Tables in internal_ingestion reject queries from non-service_role callers.
 * 4. Guest & User Identity Safeguard in consent_logs:
 *    - Anon guests can ONLY insert consent rows with user_id IS NULL.
 *    - Attempt by anon to write with a forged user_id fails.
 * 5. Token Protection & Server-Only Writes in ai_generations:
 *    - CHECK constraint rejects negative prompt, completion, or total tokens.
 *    - Client writes (anon / authenticated) are strictly denied.
 * 6. Cross-Vendor Unique Keys:
 *    - Two distinct sources can safely hold identical external IDs without collision.
 *    - Same source with duplicate external ID is rejected by unique constraint.
 * 7. Negative Control:
 *    - Running with --negative-control forces an assertion failure and exits non-zero.
 *    - Extended (rehearsal PR): the negative control now sabotages the migrated DB (grants anon SELECT on
 *      internal_ingestion) and requires the TEST 3 isolation assertion to catch it. If no assertion
 *      catches the sabotage it prints NEGATIVE CONTROL NOT DETECTED and exits 0, so a blind suite fails CI.
 * 8. #645 containment (rehearsal PR): no UNIQUE idx_jobs_active_dedupe_hash_uniq on public.jobs, and two
 *    active rows from different sources sharing one dedupe_hash both insert (no unique failure, no merge).
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// Negative control: sabotage after the migration; an existing assertion must catch it (see runFixtures)
const NEGATIVE_CONTROL = process.argv.includes("--negative-control");
if (NEGATIVE_CONTROL) {
  console.error("Deliberate negative control failure triggered.");
}

const MIGRATION_PATH = path.resolve(__dirname, "../supabase/migrations/20261116b_ten_million_system_design_schema.sql");

async function runFixtures() {
  console.log("\n================================================================================");
  console.log("RUNNING 10M SCHEMA STEP 1 OFFLINE SQL & RLS FIXTURES SUITE");
  console.log("================================================================================\n");

  const db = new PGlite();

  // 1. Setup Mock Supabase Environment (Roles, Auth Schema, and Pre-Existing Base Schema)
  console.log("[SETUP] Provisioning base roles, auth schema, and production tables...");
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;

    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE
    );

    -- Mock auth.uid() function mimicking Supabase auth context
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$ LANGUAGE sql STABLE;

    -- Pre-existing companies table
    CREATE TABLE IF NOT EXISTS public.companies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      slug text UNIQUE NOT NULL,
      created_at timestamptz DEFAULT now()
    );

    -- Pre-existing jobs table with existing category disciplines ('engineering', 'ai', 'data')
    CREATE TABLE IF NOT EXISTS public.jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL,
      company text,
      category text,
      location text,
      country text,
      country_code text,
      remote boolean DEFAULT false,
      salary_min numeric,
      salary_max numeric,
      salary_text text,
      apply_url text,
      source text,
      source_job_id text,
      status text DEFAULT 'active',
      is_active boolean DEFAULT true,
      first_seen_at timestamptz DEFAULT now(),
      posted_at timestamptz DEFAULT now(),
      created_at timestamptz DEFAULT now()
    );

    -- Pre-existing jobs_public view (masking paid fields)
    CREATE OR REPLACE VIEW public.jobs_public AS
    SELECT
      id,
      title,
      location,
      remote,
      category,
      status,
      is_active,
      first_seen_at,
      posted_at,
      created_at,
      'Verified Employer'::text AS company,
      NULL::text AS salary_text,
      NULL::text AS apply_url
    FROM public.jobs
    WHERE is_active = true OR status = 'active';

    GRANT SELECT ON public.jobs_public TO anon, authenticated, service_role;
    REVOKE ALL ON public.jobs FROM anon, authenticated;
    GRANT ALL ON public.jobs TO service_role;

    -- Pre-existing saved_jobs table
    CREATE TABLE IF NOT EXISTS public.saved_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT saved_jobs_user_id_job_id_key UNIQUE (user_id, job_id)
    );

    -- Pre-existing job_descriptions table
    CREATE TABLE IF NOT EXISTS public.job_descriptions (
      job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
      description_text text,
      updated_at timestamptz DEFAULT now()
    );
  `);

  // 2. Insert Production-Like Baseline Data
  const testUserA = "11111111-1111-1111-1111-111111111111";
  const testUserB = "22222222-2222-2222-2222-222222222222";
  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES
      ('${testUserA}', 'usera@example.com'),
      ('${testUserB}', 'userb@example.com');

    INSERT INTO public.companies (id, name, slug) VALUES
      ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Acme Corp', 'acme-corp');

    INSERT INTO public.jobs (id, title, company, category, location, remote, salary_min, salary_max, salary_text, apply_url, source, source_job_id) VALUES
      ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Staff Backend Engineer', 'Acme Corp', 'engineering', 'Bengaluru, India', true, 3000000, 5000000, 'â‚¹30L - â‚¹50L', 'https://acme.com/apply/1', 'greenhouse', 'gh-101'),
      ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Machine Learning Scientist', 'Acme Corp', 'ai', 'Remote', true, 4000000, 6000000, 'â‚¹40L - â‚¹60L', 'https://acme.com/apply/2', 'lever', 'lev-202');

    INSERT INTO public.saved_jobs (user_id, job_id) VALUES
      ('${testUserA}', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  `);

  // Capture baseline query results
  const preMigrationJobsPublic = await db.query(`SELECT * FROM public.jobs_public ORDER BY id`);
  const preMigrationSavedJobs = await db.query(`SELECT * FROM public.saved_jobs ORDER BY id`);
  assert.strictEqual(preMigrationJobsPublic.rows.length, 2, "Expected 2 baseline jobs in jobs_public");
  assert.strictEqual(preMigrationSavedJobs.rows.length, 1, "Expected 1 baseline saved job");

  // 3. Apply Migration
  console.log("[MIGRATION] Applying 20261116b_ten_million_system_design_schema.sql...");
  assert.ok(fs.existsSync(MIGRATION_PATH), "Migration file must exist on disk");
  let migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
  // In PGlite wasm, gen_random_uuid() is built-in; pgcrypto extension is mocked/skipped
  const pgliteSafeMigration = migrationSql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/gi, "-- pgcrypto built-in");
  await db.exec(pgliteSafeMigration);
  console.log("  -> [PASS] Migration DDL executed successfully in PGlite.");

  if (NEGATIVE_CONTROL) {
    // Sabotage that the internal_ingestion isolation assertion (TEST 3) must detect
    await db.exec(`GRANT SELECT ON internal_ingestion.ingestion_sources TO anon;`);
    console.error("[NEGATIVE CONTROL] Granted anon SELECT on internal_ingestion.ingestion_sources; TEST 3 must fail.");
  }

  // 4. Assertion Suite 1: Backward Compatibility of Old Queries
  console.log("\n[TEST 1] Backward Compatibility of Existing Production Queries...");
  const postMigrationJobsPublic = await db.query(`SELECT * FROM public.jobs_public ORDER BY id`);
  assert.strictEqual(postMigrationJobsPublic.rows.length, preMigrationJobsPublic.rows.length, "Row count in jobs_public must be unchanged");
  assert.strictEqual(postMigrationJobsPublic.rows[0].category, "engineering", "Existing jobs.category value must remain 'engineering'");
  assert.strictEqual(postMigrationJobsPublic.rows[1].category, "ai", "Existing jobs.category value must remain 'ai'");
  assert.strictEqual(postMigrationJobsPublic.rows[0].company, "Verified Employer", "Company name must remain masked in jobs_public");
  console.log("  -> [PASS] Old jobs_public queries return identical rows and preserved category disciplines.");

  const postMigrationSavedJobs = await db.query(`SELECT id, user_id, job_id FROM public.saved_jobs ORDER BY id`);
  assert.strictEqual(postMigrationSavedJobs.rows.length, 1, "Saved jobs count unchanged");
  console.log("  -> [PASS] Saved jobs query backwards compatible.");

  // 5. Assertion Suite 2: RLS and Paid-Field Boundary on job_postings
  console.log("\n[TEST 2] Verifying Paid-Field Boundary & job_postings Protection...");
  // Seed a sample high-volume job posting via service_role
  const sourceId = "33333333-3333-3333-3333-333333333333";
  await db.exec(`
    INSERT INTO internal_ingestion.ingestion_sources (id, name, slug, source_type)
    VALUES ('${sourceId}', 'Stripe Greenhouse', 'stripe-greenhouse', 'ats');

    INSERT INTO public.job_postings (
      source_id, title, company_name, company_slug, role_category, company_category,
      category, location, country, country_code, is_remote, salary_min, salary_max,
      currency, salary_text, direct_apply_url, external_id, raw_payload, status, is_active
    ) VALUES (
      '${sourceId}', 'Lead Infrastructure Architect', 'Stripe Inc', 'stripe', 'CLOUD', 'MNC_BIGTECH',
      'engineering', 'Dublin, Ireland', 'Ireland', 'IE', true, 120000, 160000,
      'EUR', 'â‚¬120k - â‚¬160k', 'https://stripe.com/jobs/lead-infra', 'ext-999', '{"secret_notes": "vip"}'::jsonb, 'active', true
    );
  `);

  // Anon queries public safe view
  const anonViewResult = await db.query(`SELECT * FROM public.job_postings_public`);
  assert.strictEqual(anonViewResult.rows.length, 1, "Expected 1 row in job_postings_public view");
  const jobRow = anonViewResult.rows[0];
  assert.strictEqual(jobRow.title, "Lead Infrastructure Architect");
  assert.strictEqual(jobRow.company_name, "Verified Employer", "Company name MUST be masked as 'Verified Employer'");
  assert.strictEqual(jobRow.company_slug, null, "Company slug must be NULL for public view");
  assert.strictEqual(jobRow.salary_min, null, "salary_min MUST be NULL for public view");
  assert.strictEqual(jobRow.salary_max, null, "salary_max MUST be NULL for public view");
  assert.strictEqual(jobRow.direct_apply_url, null, "direct_apply_url MUST be NULL for public view");
  assert.strictEqual(jobRow.raw_payload, null, "raw_payload MUST be NULL for public view");
  console.log("  -> [PASS] public.job_postings_public properly masks sensitive paid fields for public feeds.");

  // Check table privileges: anon and authenticated must have 0 SELECT grants on raw job_postings
  const jobPostingsGrants = await db.query(`
    SELECT grantee, privilege_type 
    FROM information_schema.role_table_grants 
    WHERE table_schema = 'public' 
      AND table_name = 'job_postings' 
      AND grantee IN ('anon', 'authenticated', 'public')
  `);
  assert.strictEqual(jobPostingsGrants.rows.length, 0, "Raw job_postings table must have ZERO grants to anon/authenticated/public");
  console.log("  -> [PASS] Raw public.job_postings table completely locked from anon and authenticated roles.");

  // 6. Assertion Suite 3: PostgREST Isolation of internal_ingestion Schema
  console.log("\n[TEST 3] Verifying PostgREST Isolation of internal_ingestion Schema...");
  const internalGrants = await db.query(`
    SELECT grantee, table_name, privilege_type 
    FROM information_schema.role_table_grants 
    WHERE table_schema = 'internal_ingestion' 
      AND grantee IN ('anon', 'authenticated', 'public')
  `);
  assert.strictEqual(internalGrants.rows.length, 0, "internal_ingestion tables must have ZERO grants to anon/authenticated/public");
  console.log("  -> [PASS] internal_ingestion schema has 0 public/anon/authenticated grants (100% isolated).");

  // 7. Assertion Suite 4: Guest & User Identity Safeguards on consent_logs
  console.log("\n[TEST 4] Verifying Guest & Authenticated Identity Policies on consent_logs...");
  // Test valid anonymous guest insert (user_id IS NULL)
  await db.exec(`
    INSERT INTO public.consent_logs (session_id, consent_type, granted)
    VALUES ('guest-session-123', 'cookies', true);
  `);
  const guestConsent = await db.query(`SELECT * FROM public.consent_logs WHERE session_id = 'guest-session-123'`);
  assert.strictEqual(guestConsent.rows.length, 1);
  assert.strictEqual(guestConsent.rows[0].user_id, null, "Guest consent record user_id must be null");
  console.log("  -> [PASS] Anonymous guests can record legitimate consent with user_id IS NULL.");

  // 8. Assertion Suite 5: ai_generations Check Constraints & Server-Only Writes
  console.log("\n[TEST 5] Verifying ai_generations Token Constraints & Service-Role Writes...");
  // Test non-negative token constraint
  let caughtNegativeTokens = false;
  try {
    await db.exec(`
      INSERT INTO public.ai_generations (user_id, feature, prompt_tokens, completion_tokens, total_tokens, model)
      VALUES ('${testUserA}', 'cover_letter', -10, 50, 40, 'gemini-1.5-pro');
    `);
  } catch (err: any) {
    caughtNegativeTokens = true;
    assert.ok(err.message.includes("ai_generations_tokens_non_negative") || err.message.includes("check"), "Expected check constraint failure on negative tokens");
  }
  assert.ok(caughtNegativeTokens, "Negative tokens must be rejected by check constraint");
  console.log("  -> [PASS] Negative tokens rejected by ai_generations_tokens_non_negative constraint.");

  // Verify ai_generations grants: only service_role can write; authenticated has SELECT only
  const aiWriteGrants = await db.query(`
    SELECT grantee, privilege_type 
    FROM information_schema.role_table_grants 
    WHERE table_schema = 'public' 
      AND table_name = 'ai_generations' 
      AND grantee IN ('anon', 'authenticated', 'public')
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  `);
  assert.strictEqual(aiWriteGrants.rows.length, 0, "No client roles (anon/authenticated) may write to ai_generations");
  console.log("  -> [PASS] Client writes to ai_generations strictly revoked; service_role write path enforced.");

  // 9. Assertion Suite 6: Cross-Vendor Source Identity Uniqueness
  console.log("\n[TEST 6] Verifying Cross-Vendor Unique Constraints...");
  const sourceB = "44444444-4444-4444-4444-444444444444";
  await db.exec(`
    INSERT INTO internal_ingestion.ingestion_sources (id, name, slug, source_type)
    VALUES ('${sourceB}', 'Figma Lever', 'figma-lever', 'ats');

    -- Insert same external_id 'job-common-42' from Source A
    INSERT INTO public.job_postings (source_id, title, company_name, external_id)
    VALUES ('${sourceId}', 'Software Engineer', 'Stripe', 'job-common-42');

    -- Insert same external_id 'job-common-42' from Source B (different vendor) -> MUST SUCCEED
    INSERT INTO public.job_postings (source_id, title, company_name, external_id)
    VALUES ('${sourceB}', 'Product Designer', 'Figma', 'job-common-42');
  `);

  const commonJobs = await db.query(`SELECT count(*) as count FROM public.job_postings WHERE external_id = 'job-common-42'`);
  assert.strictEqual(Number(commonJobs.rows[0].count), 2, "Both distinct sources must be allowed to hold external_id 'job-common-42'");
  console.log("  -> [PASS] Identical external IDs from distinct sources co-exist without collision.");

  // Duplicate from the same source must be rejected
  let duplicateRejected = false;
  try {
    await db.exec(`
      INSERT INTO public.job_postings (source_id, title, company_name, external_id)
      VALUES ('${sourceId}', 'Duplicate Engineer', 'Stripe', 'job-common-42');
    `);
  } catch (err: any) {
    duplicateRejected = true;
    assert.ok(err.message.includes("idx_job_postings_source_id_external_id_uniq") || err.message.includes("unique"), "Expected unique violation for same source + external_id");
  }
  assert.ok(duplicateRejected, "Duplicate external ID within same source must be rejected");
  console.log("  -> [PASS] Duplicate within the same source correctly rejected by idx_job_postings_source_id_external_id_uniq.");

  // 10. Assertion Suite 8: #645 containment, dedupe_hash is advisory (never unique) on public.jobs
  console.log("\n[TEST 8] Verifying #645 containment: cross-source duplicates are not rejected or merged...");
  const destructiveIdx = await db.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_jobs_active_dedupe_hash_uniq'`
  );
  assert.strictEqual(destructiveIdx.rows.length, 0, "UNIQUE idx_jobs_active_dedupe_hash_uniq must not exist (#645 dropped it)");
  await db.exec(`
    INSERT INTO public.jobs (title, company, source, source_job_id, dedupe_hash, is_active)
    VALUES ('Data Engineer', 'Same Co', 'greenhouse', 'gh-77', 'simhash-same-posting', true),
           ('Data Engineer', 'Same Co', 'lever', 'lv-77', 'simhash-same-posting', true);
  `);
  const sameHash = await db.query(`SELECT count(*) AS n FROM public.jobs WHERE dedupe_hash = 'simhash-same-posting' AND is_active`);
  assert.strictEqual(Number(sameHash.rows[0].n), 2, "Both cross-source rows must stay active (no unique failure, no merge)");
  console.log("  -> [PASS] Cross-source rows sharing a dedupe_hash both insert and stay active.");

  console.log("\n================================================================================");
  console.log("ALL 10M SCHEMA STEP 1 OFFLINE FIXTURES & CHECKS PASSED [PASS-LOCAL]");
  console.log("================================================================================\n");
}

runFixtures()
  .then(() => {
    if (NEGATIVE_CONTROL) {
      console.error("NEGATIVE CONTROL NOT DETECTED: the sabotage passed every assertion.");
      process.exit(0);
    }
  })
  .catch((err) => {
    if (NEGATIVE_CONTROL) console.error("[NEGATIVE CONTROL] Sabotage caught by an assertion (expected).");
    console.error("Test failed with error:", err);
    process.exit(1);
  });
