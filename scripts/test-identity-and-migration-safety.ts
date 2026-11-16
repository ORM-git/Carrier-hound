/**
 * scripts/test-identity-and-migration-safety.ts
 *
 * Dedicated PostgreSQL Integration & Safety Test Suite
 *
 * Runs against a real in-process PostgreSQL database (PGlite) with full migrations applied.
 * Verifies:
 * 1. Additive forward migration executes cleanly against already-mutated production baseline.
 * 2. Harmful triggers (trg_jobs_merge_dedupe_priority) and unique dedupe indexes are dropped.
 * 3. Incident recovery tables (recovery_642_restore48_20261116) are strictly preserved.
 * 4. Byte-for-byte parity between PostgreSQL public.compute_job_similarity_hash_v2() and TypeScript
 *    computeSimilarityHashV2() across all 11 language-neutral golden test cases.
 * 5. Backfills and enrichment updates do NOT touch last_seen_at (ranking order preserved).
 * 6. Authoritative identity (source_id, source_job_id) prevents cross-board and requisition collisions.
 * 7. Non-destructive rollback restores baseline view and drops temporary objects while preserving data.
 */

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import * as fs from "fs";
import * as path from "path";
import * as assert from "assert";

import {
  computeSimilarityHashV2,
  buildSimilarityPayloadV2,
  buildSourceId,
  buildScopedJobIdentity,
} from "../src/lib/jobs/highVolumeEnrichment";

interface GoldenItem {
  label: string;
  authoritative?: { sourceId: string; sourceJobId: string };
  input: {
    company: string | null;
    title: string | null;
    country: string | null;
    location: string | null;
  };
  expected_payload: string;
  expected_hash: string;
}

interface GoldenCase {
  id: string;
  name: string;
  description: string;
  items: GoldenItem[];
  expected_outcome: string;
}

interface GoldenFile {
  version: string;
  contract: string;
  cases: GoldenCase[];
}

export async function runIdentityAndMigrationSafetyTest(): Promise<void> {
  console.log("=== Starting Identity & Database Migration Safety Test Suite ===");
  const db = new PGlite({ extensions: { pgcrypto } });

  // 1. Setup required Postgres roles
  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
    END $$;
  `);

  // 2. Setup baseline production schema & tables
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
      last_seen_at timestamptz DEFAULT '2026-11-01 10:00:00Z',
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

    -- Baseline jobs_touch_last_seen trigger from schema.sql
    CREATE OR REPLACE FUNCTION public.touch_job_last_seen()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.last_seen_at := now();
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER jobs_touch_last_seen
      BEFORE UPDATE ON public.jobs
      FOR EACH ROW EXECUTE FUNCTION public.touch_job_last_seen();

    -- Baseline jobs_public view
    CREATE VIEW public.jobs_public AS
    SELECT
      id, title, location, remote, remote_scope, remote_eligibility,
      job_type, category, country, country_code, seniority, verified,
      source_type, first_seen_at, last_seen_at, discovered_at, posted_at,
      created_at, status, is_active,
      'Verified Employer'::text AS company,
      NULL::text AS salary_text,
      NULL::text AS description,
      NULL::text AS apply_url,
      '{}'::text[] AS skills
    FROM public.jobs
    WHERE is_active = true OR status = 'active';

    GRANT SELECT ON public.jobs_public TO anon, authenticated, service_role;

    -- Simulated Incident Recovery Table (48 restored incident rows, MUST NOT BE MODIFIED)
    CREATE TABLE public.recovery_642_restore48_20261116 (
      id uuid PRIMARY KEY,
      title text,
      company text,
      restored_at timestamptz DEFAULT now()
    );

    INSERT INTO public.recovery_642_restore48_20261116 (id, title, company)
    SELECT gen_random_uuid(), 'Restored Job ' || i, 'Employer ' || i
    FROM generate_series(1, 48) g(i);

    -- Simulated debris from earlier flawed 20261116a migration
    ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS dedupe_hash text;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_dedupe_hash_uniq
      ON public.jobs (dedupe_hash) WHERE is_active = TRUE;

    CREATE OR REPLACE FUNCTION public.merge_job_by_dedupe_priority()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER trg_jobs_merge_dedupe_priority
      BEFORE INSERT ON public.jobs
      FOR EACH ROW EXECUTE FUNCTION public.merge_job_by_dedupe_priority();
  `);
  console.log("  [PASS] Pre-migration mutated baseline and recovery tables established.");

  // 3. Populate initial job data to test timestamp protection
  await db.exec(`
    INSERT INTO public.jobs (
      id, title, company, location, country, country_code, source_type, source_job_id,
      last_seen_at, is_active, status
    ) VALUES (
      '11111111-1111-1111-1111-111111111111', 'Senior Systems Architect', 'Acme', 'New York, NY',
      'United States', 'US', 'ats', 'acme-001', '2026-11-01 10:00:00+00', true, 'active'
    );
  `);

  // 4. Read and Execute Forward Migration 20261116d
  const migrationPath = path.resolve(__dirname, "../supabase/migrations/20261116d_repair_642_identity_and_similarity_safety.sql");
  assert.ok(fs.existsSync(migrationPath), `Migration file must exist at: ${migrationPath}`);
  const migrationRaw = fs.readFileSync(migrationPath, "utf8");

  // Extract executable transaction body
  const beginMarker = "BEGIN;";
  const commitMarker = "COMMIT;";
  const beginIdx = migrationRaw.indexOf(beginMarker);
  const commitIdx = migrationRaw.indexOf(commitMarker, beginIdx);
  assert.ok(beginIdx !== -1 && commitIdx !== -1, "Migration must contain BEGIN; ... COMMIT; transaction");
  const forwardSql = migrationRaw.substring(beginIdx, commitIdx + commitMarker.length);

  console.log("  Applying 20261116d Forward Migration...");
  await db.exec(forwardSql);
  console.log("  [PASS] Forward Migration applied successfully.");

  // 5. Containment Assertions
  const triggerCheck = await db.query(
    "SELECT tgname FROM pg_trigger WHERE tgname = 'trg_jobs_merge_dedupe_priority';"
  );
  assert.strictEqual(triggerCheck.rows.length, 0, "Harmful trigger trg_jobs_merge_dedupe_priority must be dropped");

  const dedupeIndexCheck = await db.query(
    "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_jobs_active_dedupe_hash_uniq';"
  );
  assert.strictEqual(dedupeIndexCheck.rows.length, 0, "Harmful unique index idx_jobs_active_dedupe_hash_uniq must be dropped");

  const recoveryCheck = await db.query(
    "SELECT count(*) as count FROM public.recovery_642_restore48_20261116;"
  );
  assert.strictEqual(Number((recoveryCheck.rows[0] as any).count), 48, "Recovery table must remain untouched with all 48 rows");
  console.log("  [PASS] Containment verified: harmful objects dropped, recovery table preserved.");

  // 6. Test Timestamp Protection during Backfills & Enrichment Updates
  const preUpdate = await db.query<{ last_seen_at: Date | string }>(
    "SELECT last_seen_at FROM public.jobs WHERE id = '11111111-1111-1111-1111-111111111111';"
  );
  const originalLastSeen = new Date(preUpdate.rows[0].last_seen_at).toISOString();

  // Perform enrichment update
  await db.exec(`
    UPDATE public.jobs
    SET role_category = 'SDE', top_keywords = '{"PostgreSQL", "Go"}'
    WHERE id = '11111111-1111-1111-1111-111111111111';
  `);

  const postUpdate = await db.query<{ last_seen_at: Date | string }>(
    "SELECT last_seen_at FROM public.jobs WHERE id = '11111111-1111-1111-1111-111111111111';"
  );
  const updatedLastSeen = new Date(postUpdate.rows[0].last_seen_at).toISOString();

  assert.strictEqual(
    updatedLastSeen,
    originalLastSeen,
    "Repaired touch_job_last_seen trigger must preserve last_seen_at during metadata/enrichment updates"
  );
  console.log("  [PASS] Ranking timestamp protection verified (last_seen_at preserved during enrichment update).");

  // 7. Test All 11 Language-Neutral Golden Cases against PostgreSQL & TypeScript
  const fixturesPath = path.resolve(__dirname, "fixtures/identity_golden_cases.json");
  const goldenRaw = fs.readFileSync(fixturesPath, "utf8");
  const goldenData: GoldenFile = JSON.parse(goldenRaw);

  console.log(`  Evaluating ${goldenData.cases.length} Golden Cases for byte-for-byte PG/TS parity...`);

  for (const c of goldenData.cases) {
    const hashes: string[] = [];
    for (const item of c.items) {
      // 1. TypeScript computation
      const tsPayload = buildSimilarityPayloadV2(
        item.input.company,
        item.input.title,
        item.input.country,
        item.input.location
      );
      const tsHash = computeSimilarityHashV2(
        item.input.company,
        item.input.title,
        item.input.country,
        item.input.location
      );

      // 2. PostgreSQL computation
      const pgRes = await db.query<{ hash: string }>(
        "SELECT public.compute_job_similarity_hash_v2($1, $2, $3, $4) as hash;",
        [item.input.company, item.input.title, item.input.country, item.input.location]
      );
      const pgHash = pgRes.rows[0].hash;

      // 3. Assertions
      assert.strictEqual(
        tsPayload,
        item.expected_payload,
        `[${c.id} - ${item.label}] TS payload mismatch against golden fixture`
      );
      assert.strictEqual(
        tsHash,
        item.expected_hash,
        `[${c.id} - ${item.label}] TS hash mismatch against golden fixture`
      );
      assert.strictEqual(
        pgHash,
        item.expected_hash,
        `[${c.id} - ${item.label}] PG hash mismatch against golden fixture`
      );
      assert.strictEqual(
        pgHash,
        tsHash,
        `[${c.id} - ${item.label}] PG hash and TS hash must be byte-for-byte identical`
      );

      hashes.push(pgHash);
    }

    // Evaluate Case-level outcome expectations
    if (c.expected_outcome === "distinct_hashes") {
      assert.strictEqual(hashes.length, 2);
      assert.notStrictEqual(hashes[0], hashes[1], `[${c.id}] Expected distinct hashes, got collision!`);
    } else if (c.expected_outcome === "all_distinct_hashes") {
      const uniqueHashes = new Set(hashes);
      assert.strictEqual(uniqueHashes.size, hashes.length, `[${c.id}] Expected all distinct hashes`);
    } else if (c.expected_outcome === "identical_hashes") {
      const uniqueHashes = new Set(hashes);
      assert.strictEqual(uniqueHashes.size, 1, `[${c.id}] Expected identical hashes`);
    }
    console.log(`    [PASS] ${c.id}: ${c.name}`);
  }

  // 8. Test Case 10 & 11 in Database (Authoritative Write Identity Uniqueness)
  // Two jobs with identical title/location at Google, distinct requisition IDs
  await db.exec(`
    INSERT INTO public.jobs (
      id, title, company, location, country, country_code, source_type, source_id, source_job_id,
      similarity_hash_v2, is_active, status
    ) VALUES (
      '22222222-2222-2222-2222-222222222222', 'Software Engineer', 'Google', 'Mountain View, CA',
      'United States', 'US', 'greenhouse', 'greenhouse:google', 'REQ-101',
      public.compute_job_similarity_hash_v2('Google', 'Software Engineer', 'US', 'Mountain View, CA'),
      true, 'active'
    ), (
      '33333333-3333-3333-3333-333333333333', 'Software Engineer', 'Google', 'Mountain View, CA',
      'United States', 'US', 'greenhouse', 'greenhouse:google', 'REQ-102',
      public.compute_job_similarity_hash_v2('Google', 'Software Engineer', 'US', 'Mountain View, CA'),
      true, 'active'
    );
  `);
  console.log("  [PASS] Case 10: Same title/location with distinct requisitions coexists safely without collision.");

  // Provider job IDs duplicated across different boards
  await db.exec(`
    INSERT INTO public.jobs (
      id, title, company, location, country, country_code, source_type, source_id, source_job_id,
      similarity_hash_v2, is_active, status
    ) VALUES (
      '44444444-4444-4444-4444-444444444444', 'Data Scientist', 'Alpha Corp', 'New York, NY',
      'United States', 'US', 'greenhouse', 'greenhouse:board_alpha', '101',
      public.compute_job_similarity_hash_v2('Alpha Corp', 'Data Scientist', 'US', 'New York, NY'),
      true, 'active'
    ), (
      '55555555-5555-5555-5555-555555555555', 'DevOps Specialist', 'Beta Corp', 'Austin, TX',
      'United States', 'US', 'greenhouse', 'greenhouse:board_beta', '101',
      public.compute_job_similarity_hash_v2('Beta Corp', 'DevOps Specialist', 'US', 'Austin, TX'),
      true, 'active'
    );
  `);
  console.log("  [PASS] Case 11: Identical provider requisition IDs scoped across boards coexist cleanly.");

  // 9. Assert Exact Duplicate (source_id, source_job_id) is Rejected by Unique Index
  let duplicateRejected = false;
  try {
    await db.exec(`
      INSERT INTO public.jobs (
        title, company, source_type, source_id, source_job_id
      ) VALUES (
        'Duplicate Attempt', 'Google', 'greenhouse', 'greenhouse:google', 'REQ-101'
      );
    `);
  } catch (err: any) {
    duplicateRejected = true;
    assert.ok(
      err.message.includes("idx_jobs_source_id_source_job_id_uniq") ||
      err.message.includes("unique constraint"),
      `Expected unique constraint violation, got: ${err.message}`
    );
  }
  assert.ok(duplicateRejected, "Duplicate (source_id, source_job_id) must be rejected by unique index");
  console.log("  [PASS] Authoritative unique constraint idx_jobs_source_id_source_job_id_uniq actively enforces write safety.");

  // 10. Verify jobs_public View Data & Permissions
  const publicViewRows = await db.query(
    "SELECT id, title, company, salary_text, description, apply_url, role_category, is_remote FROM public.jobs_public WHERE is_active = true;"
  );
  assert.ok(publicViewRows.rows.length >= 5, "jobs_public must return active jobs");
  for (const row of publicViewRows.rows as any[]) {
    assert.strictEqual(row.company, "Verified Employer", "Company name must be masked in public view");
    assert.strictEqual(row.salary_text, null, "Salary text must be masked in public view");
    assert.strictEqual(row.description, null, "Description must be masked in public view");
    assert.strictEqual(row.apply_url, null, "Apply URL must be masked in public view");
  }
  console.log("  [PASS] jobs_public view properly masks paid fields and presents public columns.");

  // 11. Extract and Execute Non-Destructive Rollback SQL
  const rollbackMarker = "--   -- 1.";
  const rollbackStartIdx = migrationRaw.indexOf(rollbackMarker);
  assert.ok(rollbackStartIdx !== -1, "Migration must contain '--   -- 1.' in rollback section");
  const rollbackRaw = migrationRaw.substring(rollbackStartIdx);

  const rollbackLines = rollbackRaw
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        !l.startsWith("--   --") &&
        !l.startsWith("--    Policy:") &&
        !l.startsWith("-- ====") &&
        l.length > 0
    )
    .map((l) => l.replace(/^--\s*/, ""))
    .join("\n");

  console.log("  Executing Non-Destructive Rollback SQL...");
  await db.exec(rollbackLines);
  console.log("  [PASS] Rollback SQL executed cleanly.");

  // 12. Post-Rollback Assertions
  // A. All rows remain intact
  const postRollbackCount = await db.query("SELECT count(*) as count FROM public.jobs;");
  assert.strictEqual(Number((postRollbackCount.rows[0] as any).count), 5, "All 5 jobs must remain after rollback");

  // B. jobs_public view works and returns legacy columns
  const postRollbackPublic = await db.query(
    "SELECT id, title, company, salary_text FROM public.jobs_public WHERE is_active = true;"
  );
  assert.strictEqual(postRollbackPublic.rows.length, 5, "jobs_public must return all 5 rows");

  // C. Additive columns and their data are preserved
  const additiveCheck = await db.query<{ source_id: string }>(
    "SELECT source_id FROM public.jobs WHERE id = '22222222-2222-2222-2222-222222222222';"
  );
  assert.strictEqual(
    additiveCheck.rows[0].source_id,
    "greenhouse:google",
    "Additive columns (source_id) must be preserved in rollback"
  );

  // D. Recovery table intact
  const recoveryPost = await db.query(
    "SELECT count(*) as count FROM public.recovery_642_restore48_20261116;"
  );
  assert.strictEqual(Number((recoveryPost.rows[0] as any).count), 48, "Recovery table must remain intact after rollback");

  console.log("=== ALL INTEGRATION & MIGRATION SAFETY CHECKS PASSED ===");
}

if (require.main === module) {
  runIdentityAndMigrationSafetyTest()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("FAIL in runIdentityAndMigrationSafetyTest:", err);
      process.exit(1);
    });
}
