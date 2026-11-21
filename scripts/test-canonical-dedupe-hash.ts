/**
 * scripts/test-canonical-dedupe-hash.ts
 *
 * Dedicated Parity & Backfill Verification Suite for Canonical Job Dedupe Hash
 *
 * Verifies the canonical dedupe hash contract across:
 *   1. TypeScript ingest runtime (computeDedupeHash / computeSimilarityHashV2)
 *   2. Python scraper runtime (compute_dedupe_hash / build_similarity_payload_v2)
 *   3. PostgreSQL SQL function (public.compute_job_dedupe_hash / compute_job_similarity_hash_v2)
 *
 * Checks:
 *   - 25 shared test vectors from scripts/fixtures/job_dedupe_test_vectors.json
 *   - 100% byte-for-byte identical SHA-256 output across all three runtimes
 *   - Resumable zero-downtime batch backfill procedure (preserves last_seen_at, idempotent)
 *   - Legacy collision demonstration (showing why canonical v2 prevents #642 regression)
 */

import { PGlite } from "@electric-sql/pglite";
import * as fs from "fs";
import * as path from "path";
import * as assert from "assert";
import { spawnSync } from "child_process";

import {
  computeDedupeHash,
  computeSimilarityHashV2,
  buildSimilarityPayloadV2,
  computeLegacyDedupeHash,
} from "../src/lib/jobs/highVolumeEnrichment";

interface DedupeTestVector {
  id: string;
  description: string;
  input: {
    company: string | null;
    title: string | null;
    country: string | null;
    location: string | null;
  };
  expected_payload: string;
  expected_hash: string;
}

interface TestVectorFile {
  version: string;
  contract: string;
  total_vectors: number;
  vectors: DedupeTestVector[];
}

export async function runCanonicalDedupeHashSuite(): Promise<void> {
  console.log("=== Canonical Job Dedupe Hash: Cross-Runtime Parity & Safety Suite ===");

  const fixturePath = path.resolve(__dirname, "fixtures/job_dedupe_test_vectors.json");
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Test vector fixture not found at ${fixturePath}`);
  }

  const fixture: TestVectorFile = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
  console.log(`Loaded ${fixture.vectors.length} test vectors from ${path.basename(fixturePath)}`);
  assert.strictEqual(
    fixture.vectors.length >= 20,
    true,
    `Fixture must contain at least 20 test vectors, found ${fixture.vectors.length}`
  );

  // --------------------------------------------------------------------------
  // STEP 1: TypeScript Runtime Parity Check
  // --------------------------------------------------------------------------
  console.log("\n[1/5] Verifying TypeScript Ingest Runtime...");
  for (const vec of fixture.vectors) {
    const payload = buildSimilarityPayloadV2(
      vec.input.company,
      vec.input.title,
      vec.input.country,
      vec.input.location
    );
    assert.strictEqual(
      payload,
      vec.expected_payload,
      `[TS Payload Mismatch] ${vec.id}: expected "${vec.expected_payload}", got "${payload}"`
    );

    const hash = computeDedupeHash(
      vec.input.company,
      vec.input.title,
      vec.input.country,
      vec.input.location
    );
    assert.strictEqual(
      hash,
      vec.expected_hash,
      `[TS Hash Mismatch] ${vec.id}: expected "${vec.expected_hash}", got "${hash}"`
    );

    // Verify computeSimilarityHashV2 also matches directly
    const v2Hash = computeSimilarityHashV2(
      vec.input.company,
      vec.input.title,
      vec.input.country,
      vec.input.location
    );
    assert.strictEqual(
      v2Hash,
      vec.expected_hash,
      `[TS v2 Hash Mismatch] ${vec.id}: expected "${vec.expected_hash}", got "${v2Hash}"`
    );
  }
  console.log(`  ✓ All ${fixture.vectors.length} vectors match byte-for-byte in TypeScript.`);

  // --------------------------------------------------------------------------
  // STEP 2: Python Scraper Runtime Parity Check
  // --------------------------------------------------------------------------
  console.log("\n[2/5] Verifying Python Scraper Runtime...");
  const pythonScript = `
import json, sys
from scripts.scraper.enrichment import compute_dedupe_hash, build_similarity_payload_v2

fixture_path = sys.argv[1]
with open(fixture_path, 'r', encoding='utf-8') as f:
    data = json.load(f)

mismatches = []
for vec in data['vectors']:
    inp = vec['input']
    c, t, co, loc = inp['company'], inp['title'], inp['country'], inp['location']
    py_payload = build_similarity_payload_v2(c, t, co, loc)
    py_hash = compute_dedupe_hash(c, t, co, loc)
    if py_payload != vec['expected_payload']:
        mismatches.append(f"Payload mismatch on {vec['id']}: expected {vec['expected_payload']} != {py_payload}")
    if py_hash != vec['expected_hash']:
        mismatches.append(f"Hash mismatch on {vec['id']}: expected {vec['expected_hash']} != {py_hash}")

if mismatches:
    print("\\n".join(mismatches))
    sys.exit(1)
print(f"OK:{len(data['vectors'])}")
`;

  const pyResult = spawnSync("python", ["-c", pythonScript, fixturePath], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf-8",
  });

  if (pyResult.status !== 0) {
    throw new Error(`Python verification failed:\nSTDOUT: ${pyResult.stdout}\nSTDERR: ${pyResult.stderr}`);
  }
  assert.strictEqual(pyResult.stdout.trim(), `OK:${fixture.vectors.length}`);
  console.log(`  ✓ All ${fixture.vectors.length} vectors match byte-for-byte in Python scraper.`);

  // --------------------------------------------------------------------------
  // STEP 3: PostgreSQL SQL Runtime Check (PGlite)
  // --------------------------------------------------------------------------
  console.log("\n[3/5] Verifying PostgreSQL SQL Functions (PGlite)...");
  const db = new PGlite();

  // Setup roles and tables
  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS public.jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company text NOT NULL,
      title text NOT NULL,
      country text,
      country_code text,
      location text,
      dedupe_hash text,
      is_active boolean DEFAULT true,
      last_seen_at timestamptz DEFAULT now()
    );
  `);

  // Load migration DDL
  const migrationPath = path.resolve(
    __dirname,
    "../supabase/migrations/20261121a_canonical_job_dedupe_hash.sql"
  );
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`Migration SQL not found at ${migrationPath}`);
  }
  const migrationSql = fs.readFileSync(migrationPath, "utf-8");

  // In PGlite, run the DDL statements
  await db.exec(migrationSql);

  // Verify function existence and delegation
  const delegationCheck = await db.query<{ delegates: boolean }>(`
    SELECT pg_get_functiondef('public.compute_job_dedupe_hash(text,text,text,text)'::regprocedure)
           LIKE '%compute_job_similarity_hash_v2%' AS delegates;
  `);
  assert.strictEqual(
    delegationCheck.rows[0].delegates,
    true,
    "compute_job_dedupe_hash must delegate to compute_job_similarity_hash_v2"
  );

  // Verify all 25 test vectors against public.compute_job_dedupe_hash
  for (const vec of fixture.vectors) {
    const res = await db.query<{ hash: string }>(
      `SELECT public.compute_job_dedupe_hash($1, $2, $3, $4) AS hash;`,
      [vec.input.company, vec.input.title, vec.input.country, vec.input.location]
    );
    const sqlHash = res.rows[0].hash;
    assert.strictEqual(
      sqlHash,
      vec.expected_hash,
      `[SQL Hash Mismatch] ${vec.id}: expected "${vec.expected_hash}", got "${sqlHash}"`
    );
  }
  console.log(`  ✓ All ${fixture.vectors.length} vectors match byte-for-byte in PostgreSQL.`);

  // --------------------------------------------------------------------------
  // STEP 4: Three-Way Identity Parity Matrix
  // --------------------------------------------------------------------------
  console.log("\n[4/5] Cross-Checking Three-Way Parity (TS === Python === SQL)...");
  for (const vec of fixture.vectors) {
    const tsHash = computeDedupeHash(
      vec.input.company,
      vec.input.title,
      vec.input.country,
      vec.input.location
    );
    const sqlRes = await db.query<{ hash: string }>(
      `SELECT public.compute_job_dedupe_hash($1, $2, $3, $4) AS hash;`,
      [vec.input.company, vec.input.title, vec.input.country, vec.input.location]
    );
    const sqlHash = sqlRes.rows[0].hash;

    assert.strictEqual(tsHash, sqlHash, `Parity failure between TS and SQL for ${vec.id}`);
    assert.strictEqual(tsHash, vec.expected_hash, `Parity failure with expected hash for ${vec.id}`);
  }
  console.log("  ✓ Three-way parity confirmed across all test cases.");

  // --------------------------------------------------------------------------
  // STEP 5: Backfill Procedure & last_seen_at Safety Verification
  // --------------------------------------------------------------------------
  console.log("\n[5/5] Verifying Backfill Procedure & last_seen_at Safety...");

  // Install touch_job_last_seen trigger on public.jobs to simulate production trigger
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.touch_job_last_seen()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF current_setting('careermonke.skip_touch_last_seen', true) = 'on' THEN
        RETURN NEW;
      END IF;
      NEW.last_seen_at := now();
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS trg_jobs_touch_last_seen ON public.jobs;
    CREATE TRIGGER trg_jobs_touch_last_seen
    BEFORE UPDATE ON public.jobs
    FOR EACH ROW
    EXECUTE FUNCTION public.touch_job_last_seen();
  `);

  // Clear jobs and insert sample active jobs with legacy / null hashes and fixed last_seen_at
  await db.exec("DELETE FROM public.jobs;");
  const baselineTimestamp = "2026-11-01 10:00:00+00";

  await db.exec(`
    INSERT INTO public.jobs (company, title, country, location, dedupe_hash, is_active, last_seen_at)
    VALUES
      ('Google Inc.', 'Staff Software Engineer', 'US', 'Mountain View, CA', 'outdated_legacy_hash_1', true, '${baselineTimestamp}'),
      ('Apple LLC', 'Designer', '', '', NULL, true, '${baselineTimestamp}'),
      ('Stripe Inc.', 'Backend Engineer', 'US', 'San Francisco, CA', 'outdated_legacy_hash_3', true, '${baselineTimestamp}'),
      ('Inactive Corp', 'Old Role', 'US', 'Austin, TX', 'inactive_hash', false, '${baselineTimestamp}');
  `);

  // Verify pre-backfill count
  const preCheck = await db.query<{ count: string }>(`
    SELECT count(*) AS count
    FROM public.jobs
    WHERE is_active = TRUE
      AND (dedupe_hash IS NULL OR dedupe_hash IS DISTINCT FROM public.compute_job_dedupe_hash(company, title, COALESCE(country_code, country), location));
  `);
  assert.strictEqual(parseInt(preCheck.rows[0].count, 10), 3, "3 active rows must need canonical backfill");

  // Execute procedure
  await db.exec(`CALL public.backfill_canonical_job_dedupe_hashes(500);`);

  // Verify post-backfill count is 0
  const postCheck = await db.query<{ count: string }>(`
    SELECT count(*) AS count
    FROM public.jobs
    WHERE is_active = TRUE
      AND (dedupe_hash IS NULL OR dedupe_hash IS DISTINCT FROM public.compute_job_dedupe_hash(company, title, COALESCE(country_code, country), location));
  `);
  assert.strictEqual(parseInt(postCheck.rows[0].count, 10), 0, "0 active rows remaining to be updated");

  // Verify inactive rows were not touched
  const inactiveRow = await db.query<{ dedupe_hash: string }>(`
    SELECT dedupe_hash FROM public.jobs WHERE is_active = FALSE;
  `);
  assert.strictEqual(inactiveRow.rows[0].dedupe_hash, "inactive_hash", "Inactive row dedupe_hash untouched");

  // Verify last_seen_at was preserved (trigger skipped)
  const lastSeenCheck = await db.query<{ last_seen_at: string; dedupe_hash: string; title: string }>(`
    SELECT title, dedupe_hash, to_char(last_seen_at, 'YYYY-MM-DD HH24:MI:SS') as last_seen_at
    FROM public.jobs
    ORDER BY company ASC;
  `);
  for (const row of lastSeenCheck.rows) {
    assert.strictEqual(
      row.last_seen_at,
      "2026-11-01 10:00:00",
      `last_seen_at for "${row.title}" must not be modified during dedupe hash backfill`
    );
  }

  // Verify canonical hashes match expected
  const googleRow = lastSeenCheck.rows.find((r) => r.title === "Staff Software Engineer");
  assert.strictEqual(
    googleRow?.dedupe_hash,
    "14c69420611ec43c96858f7f83a496f656388c4b698b3bac6d19a8559996939a"
  );

  // Verify backfill progress tracking record
  const progress = await db.query<{ total_rows_updated: number }>(`
    SELECT total_rows_updated FROM public.canonical_dedupe_hash_backfill_progress WHERE phase = 'jobs_canonical_dedupe_hash';
  `);
  assert.strictEqual(progress.rows[0].total_rows_updated, 3, "Progress table must record 3 updated rows");

  // Verify idempotency on second run
  await db.exec(`CALL public.backfill_canonical_job_dedupe_hashes(500);`);
  const progress2 = await db.query<{ total_rows_updated: number }>(`
    SELECT total_rows_updated FROM public.canonical_dedupe_hash_backfill_progress WHERE phase = 'jobs_canonical_dedupe_hash';
  `);
  assert.strictEqual(progress2.rows[0].total_rows_updated, 3, "Second run must be idempotent");

  console.log("  ✓ Backfill procedure safely migrated hashes without altering last_seen_at.");

  // --------------------------------------------------------------------------
  // BONUS CHECK: Legacy vs Canonical Collision Proof
  // --------------------------------------------------------------------------
  console.log("\n[Bonus] Verifying Legacy vs Canonical Collision Defense...");
  const legacyP1 = computeLegacyDedupeHash("PayPay", "Senior Engineer / Backend", "JP", "Tokyo");
  const legacyP2 = computeLegacyDedupeHash("PayPay", "Senior Engineer - Backend", "JP", "Tokyo");
  assert.strictEqual(
    legacyP1,
    legacyP2,
    "Legacy hash collapsed punctuation, erroneously causing a collision (#642 bug)"
  );

  const canonP1 = computeDedupeHash("PayPay", "Senior Engineer / Backend", "JP", "Tokyo");
  const canonP2 = computeDedupeHash("PayPay", "Senior Engineer - Backend", "JP", "Tokyo");
  assert.notStrictEqual(
    canonP1,
    canonP2,
    "Canonical hash preserves title punctuation distinction, preventing #642 collision"
  );
  console.log("  ✓ Canonical contract successfully defends against legacy collision bugs.");

  await db.close();

  console.log("\n=== ALL CANONICAL DEDUPE HASH CHECKS PASSED SUCCESSFULLY ===");
}

if (require.main === module) {
  runCanonicalDedupeHashSuite().catch((err) => {
    console.error("FATAL ERROR in canonical dedupe hash suite:", err);
    process.exit(1);
  });
}
