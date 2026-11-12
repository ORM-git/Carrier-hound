/**
 * scripts/test-query-plan-review.ts
 *
 * Offline guard test for scripts/explain-hot-queries.ts and docs/query-plan-review.md.
 * Verifies:
 * 1. scripts/explain-hot-queries.ts and docs/query-plan-review.md exist.
 * 2. HOT_QUERY_CATALOG covers all four required hot query areas:
 *    job match/feed, digest candidate selection, reconciliation aggregates, public jobs listing.
 * 3. Every catalog SQL statement passes assertExplainOnlySql (EXPLAIN only, never ANALYZE, never writes)
 *    and SAFE_EXPLAIN_OPTIONS locks `analyze: false`.
 * 4. docs/query-plan-review.md documents every catalog ID, how to run capture, how to read a plan
 *    (seq scans, missing index use), and the monthly cadence.
 * 5. Subprocess `--dry-run` succeeds offline without Supabase env vars and prints all catalog SQL.
 * 6. Negative control confirms assertExplainOnlySql rejects `EXPLAIN ANALYZE` and mutating SQL.
 */

import * as fs from "fs";
import * as path from "path";
import * as assert from "assert";
import { spawnSync } from "child_process";
import {
  HOT_QUERY_CATALOG,
  SAFE_EXPLAIN_OPTIONS,
  assertExplainOnlySql,
  type HotQueryCategory,
} from "./explain-hot-queries";

const ROOT = process.cwd();
const SCRIPT_PATH = "scripts/explain-hot-queries.ts";
const DOC_PATH = "docs/query-plan-review.md";
const PLANS_DIR = "docs/perf/query-plans";

const REQUIRED_CATEGORIES: HotQueryCategory[] = [
  "job-match-feed",
  "digest-candidate-selection",
  "reconciliation-aggregates",
  "public-jobs-listing",
];

function runNegativeControl(): never {
  console.error("Running --negative-control with synthetic EXPLAIN ANALYZE fixture...");
  let caughtAnalyze = false;
  try {
    assertExplainOnlySql("EXPLAIN ANALYZE SELECT count(*) FROM public.jobs;", "bad-analyze");
  } catch {
    caughtAnalyze = true;
  }

  let caughtMutation = false;
  try {
    assertExplainOnlySql("DELETE FROM public.jobs WHERE id = $1;", "bad-mutation");
  } catch {
    caughtMutation = true;
  }

  if (!caughtAnalyze || !caughtMutation) {
    console.error("NEGATIVE CONTROL FAILED: forbidden SQL was NOT rejected!");
    process.exit(0);
  }

  console.error("NEGATIVE CONTROL PASSED: rejected EXPLAIN ANALYZE and mutating SQL fixtures");
  process.exit(1);
}

function main() {
  if (process.argv.includes("--negative-control")) {
    runNegativeControl();
  }

  console.log("=== Query Plan Review Offline Guard Test ===");

  // 1. Required files and plans directory exist
  assert.ok(fs.existsSync(path.join(ROOT, SCRIPT_PATH)), `Missing ${SCRIPT_PATH}`);
  assert.ok(fs.existsSync(path.join(ROOT, DOC_PATH)), `Missing ${DOC_PATH}`);
  assert.ok(fs.existsSync(path.join(ROOT, PLANS_DIR)), `Missing ${PLANS_DIR} directory`);
  console.log("  [PASS] 1. Script, doc, and docs/perf/query-plans/ directory exist");

  // 2. Catalog covers all four named hot query categories with parameterized SQL
  const categories = new Set(HOT_QUERY_CATALOG.map((q) => q.category));
  for (const reqCat of REQUIRED_CATEGORIES) {
    assert.ok(
      categories.has(reqCat),
      `HOT_QUERY_CATALOG missing required hot query category: ${reqCat}`
    );
  }
  assert.ok(HOT_QUERY_CATALOG.length >= 4, "Expected at least 4 hot queries in catalog");
  console.log(
    `  [PASS] 2. Catalog covers all ${REQUIRED_CATEGORIES.length} named hot query categories`
  );

  // 3. Enforce EXPLAIN-only (never EXPLAIN ANALYZE, never writes) in catalog & runtime options
  assert.strictEqual(
    SAFE_EXPLAIN_OPTIONS.analyze,
    false,
    "SAFE_EXPLAIN_OPTIONS.analyze MUST be strictly false"
  );

  const scriptSrc = fs.readFileSync(path.join(ROOT, SCRIPT_PATH), "utf8");
  const codeWithoutComments = scriptSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*/gm, "");
  assert.ok(
    !/analyze\s*:\s*true/i.test(codeWithoutComments),
    "scripts/explain-hot-queries.ts must never configure analyze: true"
  );
  assert.ok(
    !/EXPLAIN\s*(?:\([^)]*\))?\s*ANALYZE(?!\s+and\s+mutations)/i.test(codeWithoutComments),
    "scripts/explain-hot-queries.ts must never contain EXPLAIN ANALYZE"
  );

  for (const entry of HOT_QUERY_CATALOG) {
    assertExplainOnlySql(entry.sql, entry.id);
    assert.ok(
      /\$1\b/.test(entry.sql) && entry.sampleParams.length > 0,
      `Query "${entry.id}" should be parameterized ($1, ...)`
    );
  }
  console.log("  [PASS] 3. All catalog SQL queries are parameterized and strictly EXPLAIN-only");

  // 4. Verify docs/query-plan-review.md completeness
  const docText = fs.readFileSync(path.join(ROOT, DOC_PATH), "utf8");
  for (const entry of HOT_QUERY_CATALOG) {
    assert.ok(
      docText.includes(`\`${entry.id}\``),
      `${DOC_PATH} missing catalog entry "${entry.id}"`
    );
  }
  assert.ok(
    /--dry-run/.test(docText),
    `${DOC_PATH} must document --dry-run capture usage`
  );
  assert.ok(
    /Seq Scan/i.test(docText) && /missing index/i.test(docText),
    `${DOC_PATH} must explain how to read plans (Seq Scan and missing index use)`
  );
  assert.ok(
    /monthly/i.test(docText),
    `${DOC_PATH} must document monthly review cadence`
  );
  console.log("  [PASS] 4. docs/query-plan-review.md documents catalog, run instructions, plan reading, and monthly cadence");

  // 5. Verify --dry-run executes cleanly offline without Supabase credentials
  const cleanEnv: Record<string, string | undefined> = { ...process.env };
  delete cleanEnv.SUPABASE_SERVICE_ROLE_KEY;
  delete cleanEnv.SUPABASE_SERVICE_KEY;
  delete cleanEnv.NEXT_PUBLIC_SUPABASE_URL;
  delete cleanEnv.SUPABASE_URL;

  const dryRun = spawnSync(
    "npx",
    ["tsx", path.resolve(ROOT, SCRIPT_PATH), "--dry-run"],
    {
      encoding: "utf8",
      env: cleanEnv,
      shell: process.platform === "win32",
    }
  );
  assert.strictEqual(
    dryRun.status,
    0,
    `--dry-run must exit 0 offline without DB credentials (got ${dryRun.status}: ${dryRun.stderr})`
  );
  for (const entry of HOT_QUERY_CATALOG) {
    assert.ok(
      dryRun.stdout.includes(entry.id) && dryRun.stdout.includes("EXPLAIN"),
      `--dry-run output missing SQL for ${entry.id}`
    );
  }
  assert.ok(
    !/EXPLAIN\s+(?:\([^)]*\)\s*)?ANALYZE/i.test(dryRun.stdout),
    "--dry-run SQL output must never contain EXPLAIN ANALYZE"
  );
  console.log("  [PASS] 5. --dry-run prints EXPLAIN SQL cleanly offline with zero credentials");

  // 6. Negative control checks EXPLAIN ANALYZE and mutations are rejected
  assert.throws(
    () => assertExplainOnlySql("EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM public.jobs;", "neg"),
    /forbidden keyword/i,
    "assertExplainOnlySql must reject EXPLAIN (ANALYZE)"
  );
  const negChild = spawnSync(
    "npx",
    ["tsx", path.resolve(__filename), "--negative-control"],
    {
      encoding: "utf8",
      shell: process.platform === "win32",
    }
  );
  assert.strictEqual(
    negChild.status,
    1,
    `Subprocess --negative-control must exit 1 (got ${negChild.status})`
  );
  assert.ok(
    negChild.stderr.includes("NEGATIVE CONTROL PASSED"),
    "Subprocess stderr must confirm negative control pass"
  );
  console.log("  [PASS] 6. Negative control verified EXPLAIN ANALYZE and mutating SQL rejection");

  console.log("\nALL QUERY PLAN REVIEW CHECKS PASSED (PASS-LOCAL).");
}

main();
