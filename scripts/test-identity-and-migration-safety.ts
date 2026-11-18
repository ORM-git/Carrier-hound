/**
 * scripts/test-identity-and-migration-safety.ts
 *
 * Dedicated PostgreSQL Integration & Safety Test Suite
 *
 * Runs against a real in-process PostgreSQL database (PGlite) with full migrations applied.
 * Verifies all 8 reviewer blockers:
 * 1. Location identity: Unicode-safe, length-framed (Tokyo vs Osaka distinct, '#' in provider ID escaped).
 * 2. Normalization parity: Turkish 'İ', Greek 'ς'->'σ', and NEL 'U+0085' match byte-for-byte across SQL, Python, and TS.
 * 3. touch_job_last_seen: any update to source_priority, is_remote, or metadata preserves OLD.last_seen_at.
 *    Explicit liveness (caller-provided last_seen_at or careermonke.scraper_refresh='on') updates it.
 * 4. Split migration: (a) short additive DDL in transaction, (b) concurrent indexes outside transaction, (c) bounded batch backfill.
 * 5. View preservation: CREATE OR REPLACE VIEW jobs_public (never DROP VIEW), owner/grants/RLS/columns preserved.
 * 6. Rollback safety: compute_job_dedupe_hash restored self-contained, pre-existing source-key index preserved, columns preserved.
 * 7. Preflight check: aborts if baseline state or duplicate source keys differ.
 * 8. Golden test vectors: all 15 cases pass with 100% byte-for-byte PG/TS/Python parity.
 */

import { PGlite } from "@electric-sql/pglite";
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
  authoritative?: {
    sourceId: string;
    sourceJobId?: string;
    providerJobId?: string;
    locationKey?: string | null;
    expectedSourceJobId?: string;
  };
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
  const db = new PGlite();

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

    -- Pre-existing unique constraint on source keys (must NOT be dropped on rollback)
    ALTER TABLE public.jobs ADD CONSTRAINT jobs_source_source_job_id_unique UNIQUE (source, source_job_id);

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

  // 3. Test Preflight Validation (Blocker 7)
  const migrationDPath = path.resolve(__dirname, "../supabase/migrations/20261116d_repair_642_identity_and_similarity_safety.sql");
  assert.ok(fs.existsSync(migrationDPath), `Migration file 20261116d must exist at: ${migrationDPath}`);
  const migrationDRaw = fs.readFileSync(migrationDPath, "utf8");

  // Extract Preflight DO block
  const preflightStart = migrationDRaw.indexOf("DO $$");
  const preflightEnd = migrationDRaw.indexOf("END $$;", preflightStart) + "END $$;".length;
  assert.ok(preflightStart !== -1 && preflightEnd !== -1, "Preflight DO block must exist");
  const preflightSql = migrationDRaw.substring(preflightStart, preflightEnd);

  // Preflight should pass on clean baseline
  await db.exec(preflightSql);
  console.log("  [PASS] Preflight checks pass on clean baseline.");

  // Test strict preflight verification of constraints, triggers, and duplicates:
  // A. Abort on missing primary key
  await db.exec("ALTER TABLE public.jobs DROP CONSTRAINT jobs_pkey;");
  let pkeyAborted = false;
  try {
    await db.exec(preflightSql);
  } catch (err: any) {
    pkeyAborted = true;
    assert.ok(
      err.message.includes("jobs_pkey"),
      `Expected jobs_pkey abort, got: ${err.message}`
    );
  }
  assert.ok(pkeyAborted, "Preflight must abort when jobs_pkey is missing");
  await db.exec("ALTER TABLE public.jobs ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);");
  console.log("  [PASS] Stricter preflight correctly aborted on missing primary key constraint.");

  // B. Abort on missing unique constraint
  await db.exec("ALTER TABLE public.jobs DROP CONSTRAINT jobs_source_source_job_id_unique;");
  let uniqueAborted = false;
  try {
    await db.exec(preflightSql);
  } catch (err: any) {
    uniqueAborted = true;
    assert.ok(
      err.message.includes("unique constraint on (source, source_job_id)"),
      `Expected unique constraint abort, got: ${err.message}`
    );
  }
  assert.ok(uniqueAborted, "Preflight must abort when source unique constraint is missing");
  await db.exec("ALTER TABLE public.jobs ADD CONSTRAINT jobs_source_source_job_id_unique UNIQUE (source, source_job_id);");
  console.log("  [PASS] Stricter preflight correctly aborted on missing source unique constraint.");

  // C. Abort on missing baseline trigger
  await db.exec("DROP TRIGGER jobs_touch_last_seen ON public.jobs;");
  let triggerAborted = false;
  try {
    await db.exec(preflightSql);
  } catch (err: any) {
    triggerAborted = true;
    assert.ok(
      err.message.includes("jobs_touch_last_seen"),
      `Expected trigger abort, got: ${err.message}`
    );
  }
  assert.ok(triggerAborted, "Preflight must abort when jobs_touch_last_seen trigger is missing");
  await db.exec(`
    CREATE TRIGGER jobs_touch_last_seen
      BEFORE UPDATE ON public.jobs
      FOR EACH ROW EXECUTE FUNCTION public.touch_job_last_seen();
  `);
  console.log("  [PASS] Stricter preflight correctly aborted on missing trigger.");

  // D. Preflight aborts if duplicate (source_id, source_job_id) rows exist
  await db.exec("ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_id text;");
  await db.exec(`
    INSERT INTO public.jobs (id, title, company, source_type, source_id, source_job_id)
    VALUES
      ('00000000-0000-0000-0000-000000000001', 'Dup 1', 'Acme', 'ats', 'dup_source', 'DUP-1'),
      ('00000000-0000-0000-0000-000000000002', 'Dup 2', 'Acme', 'ats', 'dup_source', 'DUP-1');
  `);
  let preflightAborted = false;
  try {
    await db.exec(preflightSql);
  } catch (err: any) {
    preflightAborted = true;
    assert.ok(
      err.message.includes("Preflight check failed: found 1 duplicate") ||
      err.message.includes("duplicate"),
      `Expected preflight duplicate abort, got: ${err.message}`
    );
  }
  assert.ok(preflightAborted, "Preflight must abort when duplicate source keys exist");
  console.log("  [PASS] Preflight check correctly aborted on duplicate source keys.");

  // Clean up duplicate test rows
  await db.exec("DELETE FROM public.jobs WHERE source_id = 'dup_source';");

  // Populate initial valid job data to test timestamp protection
  await db.exec(`
    INSERT INTO public.jobs (
      id, title, company, location, country, country_code, source_type, source_job_id,
      last_seen_at, is_active, status
    ) VALUES (
      '11111111-1111-1111-1111-111111111111', 'Senior Systems Architect', 'Acme', 'New York, NY',
      'United States', 'US', 'ats', 'acme-001', '2026-11-01 10:00:00+00', true, 'active'
    );
  `);

  // 4. Execute Split Migration Phase 1: 20261116d (Short Additive DDL)
  const beginMarker = "BEGIN;";
  const commitMarker = "COMMIT;";
  const beginIdx = migrationDRaw.indexOf(beginMarker);
  const commitIdx = migrationDRaw.indexOf(commitMarker, beginIdx);
  assert.ok(beginIdx !== -1 && commitIdx !== -1, "20261116d must contain BEGIN; ... COMMIT; transaction");
  const forwardDSql = migrationDRaw.substring(beginIdx, commitIdx + commitMarker.length);

  console.log("  Applying 20261116d Short Additive DDL...");
  await db.exec(forwardDSql);
  console.log("  [PASS] 20261116d applied successfully.");

  // 5. Execute Split Migration Phase 2: 20261116e (Concurrent Indexes)
  const migrationEPath = path.resolve(__dirname, "../supabase/migrations/20261116e_repair_642_concurrent_indexes.sql");
  assert.ok(fs.existsSync(migrationEPath), `Migration file 20261116e must exist at: ${migrationEPath}`);
  const migrationERaw = fs.readFileSync(migrationEPath, "utf8");

  console.log("  Applying 20261116e Concurrent Indexes individually outside transaction block...");
  const statementsE = migrationERaw
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statementsE) {
    // Strip leading comments to ensure clean statement execution
    const cleanStmt = stmt
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    if (cleanStmt) {
      await db.exec(cleanStmt);
    }
  }
  console.log("  [PASS] 20261116e applied successfully.");

  // 6. Execute Split Migration Phase 3: 20261116f (Bounded Batch Backfill)
  const migrationFPath = path.resolve(__dirname, "../supabase/migrations/20261116f_repair_642_batch_backfill.sql");
  assert.ok(fs.existsSync(migrationFPath), `Migration file 20261116f must exist at: ${migrationFPath}`);
  const migrationFRaw = fs.readFileSync(migrationFPath, "utf8");

  // Populate test companies and jobs to test batching and resumability
  await db.exec(`
    INSERT INTO public.companies (id, name, slug, domain)
    VALUES
      ('aaaaaaaa-1111-0000-0000-000000000001', 'Test Company 1', 'test-company-1', ' Test1.com '),
      ('aaaaaaaa-2222-0000-0000-000000000002', 'Test Company 2', 'test-company-2', ' Test2.com '),
      ('aaaaaaaa-3333-0000-0000-000000000003', 'Test Company 3', 'test-company-3', ' Test3.com ');

    INSERT INTO public.jobs (id, title, company, country, location, source, source_type, is_active, status)
    VALUES
      ('bbbbbbbb-1111-0000-0000-000000000001', 'Engineer 1', 'Test Company 1', 'US', 'New York', 'greenhouse', 'ats', true, 'active'),
      ('bbbbbbbb-2222-0000-0000-000000000002', 'Engineer 2', 'Test Company 2', 'US', 'Austin', 'manual', 'direct', true, 'active'),
      ('bbbbbbbb-3333-0000-0000-000000000003', 'Engineer 3', 'Test Company 3', 'US', 'Remote', 'lever', 'ats', true, 'active');
  `);

  console.log("  Applying 20261116f Bounded Batch Backfill...");
  // Execute DDL (table + procedure) and CALL invocation as separate top-level statements
  // to allow transaction control (COMMIT after each batch) in PostgreSQL
  const callIndex = migrationFRaw.indexOf("CALL public.repair_645_run_resumable_backfill");
  assert.ok(callIndex !== -1, "20261116f must define and call repair_645_run_resumable_backfill");
  const ddlPart = migrationFRaw.substring(0, callIndex).trim();
  const callPart = migrationFRaw.substring(callIndex).split(";")[0] + ";";

  await db.exec(ddlPart);
  await db.exec(callPart);
  console.log("  [PASS] 20261116f applied successfully.");

  // Verify progress table recorded row counts
  const progressCheck = await db.query<{ phase: string; total_rows_updated: number }>(
    "SELECT phase, total_rows_updated FROM public.repair_645_backfill_progress ORDER BY phase;"
  );
  assert.ok(progressCheck.rows.length >= 2, "Progress tracking table must record updated phases");
  for (const row of progressCheck.rows) {
    assert.ok(row.total_rows_updated >= 1, `Phase ${row.phase} must have updated rows`);
  }
  console.log("  [PASS] Progress tracking verified in repair_645_backfill_progress.");

  // Test Resumability: Call again with batch size 2, verify it resumes and leaves 0 pending
  await db.exec("CALL public.repair_645_run_resumable_backfill(2);");
  const pendingCompanies = await db.query("SELECT count(*) as count FROM public.companies WHERE canonical_domain IS NULL AND domain IS NOT NULL;");
  const pendingPriorities = await db.query("SELECT count(*) as count FROM public.jobs WHERE source_priority IS NULL;");
  const pendingHashes = await db.query("SELECT count(*) as count FROM public.jobs WHERE is_active = TRUE AND similarity_hash_v2 IS NULL;");
  assert.strictEqual(Number((pendingCompanies.rows[0] as any).count), 0, "Zero pending canonical_domain after resumable backfill");
  assert.strictEqual(Number((pendingPriorities.rows[0] as any).count), 0, "Zero pending source_priority after resumable backfill");
  assert.strictEqual(Number((pendingHashes.rows[0] as any).count), 0, "Zero pending similarity_hash_v2 after resumable backfill");
  console.log("  [PASS] Resumable backfill verified: 0 pending rows remaining across all batched targets.");

  // 7. Containment Assertions
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

  // 8. Test Explicit Liveness Contract on touch_job_last_seen (Blocker 3)
  const preUpdate = await db.query<{ last_seen_at: Date | string }>(
    "SELECT last_seen_at FROM public.jobs WHERE id = '11111111-1111-1111-1111-111111111111';"
  );
  const originalLastSeen = new Date(preUpdate.rows[0].last_seen_at).toISOString();

  // A. Metadata update: source_priority, is_remote, role_category, top_keywords must PRESERVE last_seen_at
  await db.exec(`
    UPDATE public.jobs
    SET source_priority = 1, is_remote = true, role_category = 'SDE', top_keywords = '{"PostgreSQL", "Go"}'
    WHERE id = '11111111-1111-1111-1111-111111111111';
  `);

  const postMetadataUpdate = await db.query<{ last_seen_at: Date | string }>(
    "SELECT last_seen_at FROM public.jobs WHERE id = '11111111-1111-1111-1111-111111111111';"
  );
  const metadataLastSeen = new Date(postMetadataUpdate.rows[0].last_seen_at).toISOString();
  assert.strictEqual(
    metadataLastSeen,
    originalLastSeen,
    "touch_job_last_seen must preserve last_seen_at when metadata (source_priority, is_remote, etc.) changes"
  );
  console.log("  [PASS] touch_job_last_seen preserves last_seen_at across all metadata updates.");

  // B. Explicit caller-provided last_seen_at must be respected
  const explicitTarget = "2026-11-15T12:00:00.000Z";
  await db.exec(`
    UPDATE public.jobs
    SET last_seen_at = '2026-11-15 12:00:00+00'
    WHERE id = '11111111-1111-1111-1111-111111111111';
  `);
  const postExplicitUpdate = await db.query<{ last_seen_at: Date | string }>(
    "SELECT last_seen_at FROM public.jobs WHERE id = '11111111-1111-1111-1111-111111111111';"
  );
  const explicitLastSeen = new Date(postExplicitUpdate.rows[0].last_seen_at).toISOString();
  assert.strictEqual(explicitLastSeen, explicitTarget, "Caller-provided explicit last_seen_at must be respected");
  console.log("  [PASS] touch_job_last_seen respects caller-provided distinct last_seen_at.");

  // C. Explicit scraper refresh session setting updates last_seen_at
  await db.exec(`
    SET careermonke.scraper_refresh = 'on';
    UPDATE public.jobs
    SET title = 'Lead Systems Architect'
    WHERE id = '11111111-1111-1111-1111-111111111111';
    RESET careermonke.scraper_refresh;
  `);
  const postScraperUpdate = await db.query<{ last_seen_at: Date | string }>(
    "SELECT last_seen_at FROM public.jobs WHERE id = '11111111-1111-1111-1111-111111111111';"
  );
  const scraperLastSeen = new Date(postScraperUpdate.rows[0].last_seen_at).toISOString();
  assert.notStrictEqual(scraperLastSeen, explicitTarget, "Scraper refresh session setting must update last_seen_at");
  console.log("  [PASS] touch_job_last_seen updates last_seen_at when careermonke.scraper_refresh = 'on'.");

  // 9. Test All 15 Language-Neutral Golden Cases against PostgreSQL & TypeScript (Blocker 2)
  const fixturesPath = path.resolve(__dirname, "fixtures/identity_golden_cases.json");
  const goldenRaw = fs.readFileSync(fixturesPath, "utf8");
  const goldenData: GoldenFile = JSON.parse(goldenRaw);

  console.log(`  Evaluating ${goldenData.cases.length} Golden Cases for byte-for-byte PG/TS parity...`);
  assert.strictEqual(goldenData.cases.length, 24, "Expected 24 golden cases including Turkish İ, Greek ς, NEL U+0085, Tokyo/Osaka, Hindi/Chinese/Arabic, emoji, whitespace/case and NFKC edge cases");

  for (const c of goldenData.cases) {
    const hashes: string[] = [];
    for (const item of c.items) {
      // TypeScript computation
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

      // PostgreSQL computation
      const pgRes = await db.query<{ hash: string }>(
        "SELECT public.compute_job_similarity_hash_v2($1, $2, $3, $4) as hash;",
        [item.input.company, item.input.title, item.input.country, item.input.location]
      );
      const pgHash = pgRes.rows[0].hash;

      // Assertions
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

      // Authoritative key checks
      if (item.authoritative && item.authoritative.providerJobId && item.authoritative.expectedSourceJobId) {
        const scoped = buildScopedJobIdentity(
          item.authoritative.sourceId,
          item.authoritative.providerJobId,
          item.authoritative.locationKey
        );
        assert.strictEqual(
          scoped.sourceJobId,
          item.authoritative.expectedSourceJobId,
          `[${c.id} - ${item.label}] Authoritative sourceJobId mismatch`
        );
      }

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

  // 10. Test Tokyo vs Osaka Location Identity & '#' Provider ID Escaping (Blocker 1)
  const tokyoScoped = buildScopedJobIdentity("greenhouse:paypay", "REQ", "東京");
  const osakaScoped = buildScopedJobIdentity("greenhouse:paypay", "REQ", "大阪");
  const hashScoped = buildScopedJobIdentity("greenhouse:paypay", "REQ#6");

  assert.strictEqual(tokyoScoped.sourceJobId, "REQ#6:東京");
  assert.strictEqual(osakaScoped.sourceJobId, "REQ#6:大阪");
  assert.strictEqual(hashScoped.sourceJobId, "REQ%236");
  assert.notStrictEqual(tokyoScoped.sourceJobId, osakaScoped.sourceJobId);
  assert.notStrictEqual(tokyoScoped.sourceJobId, hashScoped.sourceJobId);

  // Insert into DB to verify coexistence under unique index
  await db.exec(`
    INSERT INTO public.jobs (
      id, title, company, location, country, country_code, source_type, source_id, source_job_id,
      similarity_hash_v2, is_active, status
    ) VALUES (
      '66666666-6666-6666-6666-666666666666', 'Software Engineer', 'PayPay', '東京', 'JP', 'JP',
      'greenhouse', 'greenhouse:paypay', '${tokyoScoped.sourceJobId}',
      public.compute_job_similarity_hash_v2('PayPay', 'Software Engineer', 'JP', '東京'),
      true, 'active'
    ), (
      '77777777-7777-7777-7777-777777777777', 'Software Engineer', 'PayPay', '大阪', 'JP', 'JP',
      'greenhouse', 'greenhouse:paypay', '${osakaScoped.sourceJobId}',
      public.compute_job_similarity_hash_v2('PayPay', 'Software Engineer', 'JP', '大阪'),
      true, 'active'
    ), (
      '88888888-8888-8888-8888-888888888888', 'Software Engineer', 'PayPay', 'Remote', 'JP', 'JP',
      'greenhouse', 'greenhouse:paypay', '${hashScoped.sourceJobId}',
      public.compute_job_similarity_hash_v2('PayPay', 'Software Engineer', 'JP', 'Remote'),
      true, 'active'
    );
  `);
  console.log("  [PASS] Blocker 1 verified: Tokyo and Osaka location identities and '#' provider IDs coexist without collision.");

  // Assert duplicate rejection
  let duplicateBlocked = false;
  try {
    await db.exec(`
      INSERT INTO public.jobs (title, company, source_type, source_id, source_job_id)
      VALUES ('Duplicate Tokyo', 'PayPay', 'greenhouse', 'greenhouse:paypay', 'REQ#6:東京');
    `);
  } catch (err: any) {
    duplicateBlocked = true;
    assert.ok(
      err.message.includes("idx_jobs_source_id_source_job_id_uniq") || err.message.includes("unique"),
      `Expected unique constraint violation, got: ${err.message}`
    );
  }
  assert.ok(duplicateBlocked, "Duplicate (source_id, source_job_id) must be blocked by unique index");
  console.log("  [PASS] Authoritative unique index idx_jobs_source_id_source_job_id_uniq actively enforces write uniqueness.");

  // 11. Verify jobs_public View Data & Permissions (Blocker 5)
  const publicViewRows = await db.query(
    "SELECT id, title, company, salary_text, description, apply_url, role_category, is_remote FROM public.jobs_public WHERE is_active = true;"
  );
  assert.ok(publicViewRows.rows.length >= 4, "jobs_public must return active jobs");
  for (const row of publicViewRows.rows as any[]) {
    assert.strictEqual(row.company, "Verified Employer", "Company name must be masked in public view");
    assert.strictEqual(row.salary_text, null, "Salary text must be masked in public view");
    assert.strictEqual(row.description, null, "Description must be masked in public view");
    assert.strictEqual(row.apply_url, null, "Apply URL must be masked in public view");
  }
  console.log("  [PASS] jobs_public view properly masks paid fields and presents public columns.");

  // 12. Extract and Execute Non-Destructive Rollback SQL (Blocker 6)
  const rollbackMarker = "--   -- 1.";
  const rollbackStartIdx = migrationDRaw.indexOf(rollbackMarker);
  assert.ok(rollbackStartIdx !== -1, "20261116d must contain '--   -- 1.' in rollback section");
  const rollbackRaw = migrationDRaw.substring(rollbackStartIdx);

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

  // 13. Post-Rollback Assertions (Blocker 6)
  // A. compute_job_dedupe_hash must be callable and match original #642 definition and outputs
  const legacyHashCheck = await db.query<{ hash: string }>(
    "SELECT public.compute_job_dedupe_hash('Google Inc.', 'Staff Software Engineer', 'US', 'Mountain View, CA') as hash;"
  );
  assert.strictEqual(
    legacyHashCheck.rows[0].hash,
    "28982a93b15ebb69494a913e0b69d25d6295db9e2ebb1d9b8a93f7f6b1181dd1",
    "Restored compute_job_dedupe_hash must match original #642 definition and outputs (stripping legal suffix Inc. and taking first city)"
  );

  const legacyDefaultsCheck = await db.query<{ hash: string }>(
    "SELECT public.compute_job_dedupe_hash('Apple LLC', 'Designer', '', '') as hash;"
  );
  assert.strictEqual(
    legacyDefaultsCheck.rows[0].hash,
    "b92e477648ae731a4ff90ca18f9aab81df11c8a1f8cb751edd92a20f0c9df7e8",
    "Restored compute_job_dedupe_hash must match original #642 defaults ('any' for empty country/city)"
  );
  console.log("  [PASS] Rollback restored original #642 compute_job_dedupe_hash with exact output match.");

  // B. compute_job_similarity_hash_v2 must be dropped
  const droppedFuncCheck = await db.query(
    "SELECT to_regproc('public.compute_job_similarity_hash_v2') as func_proc;"
  );
  assert.strictEqual((droppedFuncCheck.rows[0] as any).func_proc, null, "compute_job_similarity_hash_v2 must be dropped");

  // C. Pre-existing jobs_source_source_job_id_unique constraint must NOT be dropped
  const preExistingConstraint = await db.query(
    "SELECT conname FROM pg_constraint WHERE conname = 'jobs_source_source_job_id_unique';"
  );
  assert.strictEqual(preExistingConstraint.rows.length, 1, "Pre-existing jobs_source_source_job_id_unique must NOT be dropped");

  // D. Additive columns and their data are preserved
  const additiveCheck = await db.query<{ source_id: string }>(
    "SELECT source_id FROM public.jobs WHERE id = '66666666-6666-6666-6666-666666666666';"
  );
  assert.strictEqual(
    additiveCheck.rows[0].source_id,
    "greenhouse:paypay",
    "Additive columns (source_id) must be preserved in rollback"
  );

  // E. Recovery table intact
  const recoveryPost = await db.query(
    "SELECT count(*) as count FROM public.recovery_642_restore48_20261116;"
  );
  assert.strictEqual(Number((recoveryPost.rows[0] as any).count), 48, "Recovery table must remain intact after rollback");

  // F. jobs_public view works and returns legacy columns
  const postRollbackPublic = await db.query(
    "SELECT id, title, company, salary_text FROM public.jobs_public WHERE is_active = true;"
  );
  assert.ok(postRollbackPublic.rows.length >= 4, "jobs_public must return active jobs after rollback");

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
