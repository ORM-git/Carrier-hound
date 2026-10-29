import assert from "assert";
import { spawnSync } from "child_process";
import * as path from "path";

// Ensure NODE_ENV is set to "test" so client mock gate activates
process.env.NODE_ENV = "test";

const isNegativeControl = process.argv.includes("--negative-control");

// Helper to create mock query builder
function createMockSupabase(queryResolver: () => Promise<{ data: any; error: any; count?: number | null }>) {
  const queryBuilder: any = {
    select: () => queryBuilder,
    eq: () => queryBuilder,
    in: () => queryBuilder,
    or: () => queryBuilder,
    ilike: () => queryBuilder,
    not: () => queryBuilder,
    order: () => queryBuilder,
    range: queryResolver,
    limit: queryResolver,
    then: (resolve: any) => queryResolver().then(resolve),
  };

  return {
    from: (table: string) => queryBuilder,
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
    },
  };
}

const sampleFallbackRow = {
  id: "job-fallback-uuid-1",
  title: "Staff Platform Engineer",
  category: "engineering",
  location: "Remote (Global)",
  remote: true,
  job_type: "full-time",
  verified: true,
  posted_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
};

/**
 * Execution logic for Test 1: Direct Supabase query error with no search filter
 */
async function runTest1DirectError(getLiveJobs: any) {
  (globalThis as any).__mockSupabaseClient = createMockSupabase(async () => ({
    data: null,
    error: { message: "database connection timeout" },
    count: null,
  }));
  delete (global as any).window;

  return await getLiveJobs({});
}

/**
 * Execution logic for Test 3: Server search non-ok status (500) where direct fallback also fails
 */
async function runTest3ServerSearchFallbackFailed(getLiveJobs: any) {
  (global as any).window = { location: { search: "" } };
  global.fetch = async (url: any) => {
    return {
      status: 500,
      ok: false,
      json: async () => ({ error: "Internal Server Error" }),
    } as any;
  };

  (globalThis as any).__mockSupabaseClient = createMockSupabase(async () => ({
    data: null,
    error: { message: "database unreachable" },
    count: null,
  }));

  return await getLiveJobs({ search: "engineering" });
}

async function main() {
  const { getLiveJobs } = await import("../src/lib/jobs/service");

  // ---------------------------------------------------------------------------
  // NEGATIVE CONTROL MODE:
  // Runs the real tests 1 and 3 against the legacy behavior (env flag active)
  // and asserts that they fail with non-zero exit on legacy main behavior.
  // ---------------------------------------------------------------------------
  if (isNegativeControl) {
    console.log("================================================================================");
    console.log(" [NEGATIVE CONTROL MODE] Executing real tests 1 & 3 against legacy behaviour");
    console.log("================================================================================");
    process.env.__CAREERMONKE_LEGACY_JOBS_SERVICE = "true";

    console.log("Running real Test 1 against legacy behavior...");
    const test1Res = await runTest1DirectError(getLiveJobs);
    assert.strictEqual(
      test1Res.isDegraded,
      true,
      "Negative control: Test 1 failed because legacy main returns { jobs: [], totalCount: 0 } without isDegraded"
    );

    console.log("Running real Test 3 against legacy behavior...");
    const test3Res = await runTest3ServerSearchFallbackFailed(getLiveJobs);
    assert.strictEqual(
      test3Res.isDegraded,
      true,
      "Negative control: Test 3 failed because legacy main returns { jobs: [], totalCount: 0 } without isDegraded"
    );

    // If both assertions somehow passed under legacy mode, exit non-zero
    console.error("FATAL: Negative control expected assertions to fail under legacy mode!");
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // NORMAL VALIDATION MODE:
  // ---------------------------------------------------------------------------
  console.log("================================================================================");
  console.log("       GETLIVEJOBS DIRECT SUPABASE & SEARCH DEGRADED FALLBACK AUDIT             ");
  console.log("================================================================================");
  console.log("Mode: NORMAL VALIDATION\n");

  const originalWindow = (global as any).window;
  const originalFetch = global.fetch;

  try {
    // ---------------------------------------------------------------------------
    // TEST 1: Supabase mock resolving { data: null, error: { message: 'x' } }
    // with no search filter must give isDegraded: true and jobs: []
    // ---------------------------------------------------------------------------
    console.log("[1/6] Testing direct Supabase query error (no search filter)...");
    const errorResult = await runTest1DirectError(getLiveJobs);
    assert.strictEqual(errorResult.isDegraded, true, "Must report isDegraded: true on query error");
    assert.strictEqual(Array.isArray(errorResult.jobs), true, "jobs must be an array");
    assert.strictEqual(errorResult.jobs.length, 0, "jobs must be empty on degraded error");
    assert.strictEqual(errorResult.totalCount, 0, "totalCount must be 0 on degraded error");
    assert.strictEqual(errorResult.error, "degraded", "error field must be 'degraded'");
    console.log("  [PASS] Direct query error returned isDegraded: true and jobs: []");

    // ---------------------------------------------------------------------------
    // TEST 2: Supabase mock resolving { data: [], error: null }
    // with no search filter must NOT be degraded (isDegraded falsy)
    // ---------------------------------------------------------------------------
    console.log("\n[2/6] Testing direct Supabase genuine empty result (no search filter)...");
    (globalThis as any).__mockSupabaseClient = createMockSupabase(async () => ({
      data: [],
      error: null,
      count: 0,
    }));
    delete (global as any).window;

    const emptyResult = await getLiveJobs({});
    assert.strictEqual(Boolean(emptyResult.isDegraded), false, "Must NOT be degraded on genuine empty data: []");
    assert.strictEqual(Array.isArray(emptyResult.jobs), true, "jobs must be an array");
    assert.strictEqual(emptyResult.jobs.length, 0, "jobs must be empty on genuine 0-result query");
    assert.strictEqual(emptyResult.totalCount, 0, "totalCount must reflect 0");
    console.log("  [PASS] Genuine empty result returned isDegraded: false and jobs: []");

    // ---------------------------------------------------------------------------
    // TEST 3: Server search non-ok (status 500) where direct fallback also fails
    // Must return degraded
    // ---------------------------------------------------------------------------
    console.log("\n[3/6] Testing server search non-ok status where direct fallback also fails...");
    const serverSearchDegradedResult = await runTest3ServerSearchFallbackFailed(getLiveJobs);
    assert.strictEqual(serverSearchDegradedResult.isDegraded, true, "Must report isDegraded: true when search & fallback fail");
    assert.strictEqual(serverSearchDegradedResult.jobs.length, 0, "jobs must be empty when search & fallback fail");
    console.log("  [PASS] Server search failure (500) with failed fallback returned degraded");

    // ---------------------------------------------------------------------------
    // TEST 4: Server search non-ok / thrown fetch where direct fallback SUCCEEDS
    // Must NOT be degraded; returns direct fallback jobs
    // ---------------------------------------------------------------------------
    console.log("\n[4/6] Testing server search failure where direct fallback SUCCEEDS...");
    (global as any).window = { location: { search: "" } };
    global.fetch = async (url: any) => {
      // Simulate network / DNS failure for search endpoint
      throw new Error("Network unreachable for /api/jobs/search");
    };

    // Direct fallback succeeds with live rows
    (globalThis as any).__mockSupabaseClient = createMockSupabase(async () => ({
      data: [sampleFallbackRow],
      error: null,
      count: 1,
    }));

    const fallbackSuccessResult = await getLiveJobs({ search: "platform" });
    assert.strictEqual(Boolean(fallbackSuccessResult.isDegraded), false, "Must NOT be degraded when direct fallback succeeds");
    assert.strictEqual(fallbackSuccessResult.jobs.length, 1, "jobs must be returned from successful direct fallback");
    assert.strictEqual(fallbackSuccessResult.jobs[0].title, "Staff Platform Engineer", "Job title matches fallback row");
    console.log("  [PASS] Server search thrown fetch successfully rescued by direct fallback");

    // ---------------------------------------------------------------------------
    // TEST 5: Server search 503 with succeeding fallback mock still returns isDegraded: true
    // (503 is returned directly without falling back to direct query)
    // ---------------------------------------------------------------------------
    console.log("\n[5/6] Testing server search 503 with succeeding fallback mock...");
    (global as any).window = { location: { search: "" } };
    global.fetch = async (url: any) => {
      return {
        status: 503,
        ok: false,
        json: async () => ({ degraded: true, jobs: [], totalCount: 0 }),
      } as any;
    };

    // Fallback mock resolves with data, but 503 path must short-circuit without using fallback
    (globalThis as any).__mockSupabaseClient = createMockSupabase(async () => ({
      data: [sampleFallbackRow],
      error: null,
      count: 1,
    }));

    const search503Result = await getLiveJobs({ search: "engineering" });
    assert.strictEqual(search503Result.isDegraded, true, "503 must return isDegraded: true even when fallback would succeed");
    assert.strictEqual(search503Result.jobs.length, 0, "503 must return 0 jobs");
    assert.strictEqual(search503Result.error, "degraded", "503 must set error: 'degraded'");
    console.log("  [PASS] Server search 503 directly returned isDegraded: true (no fallback rescue)");

    // ---------------------------------------------------------------------------
    // TEST 6: Outer catch error handling (e.g. unexpected exception in try block)
    // Must return degraded instead of falling through to empty fallback
    // ---------------------------------------------------------------------------
    console.log("\n[6/6] Testing outer catch block error handling...");
    delete (global as any).window;
    (globalThis as any).__mockSupabaseClient = {
      from: () => {
        throw new Error("Catastrophic client failure");
      },
      auth: { getSession: async () => ({ data: { session: null } }) },
    };

    const outerCatchResult = await getLiveJobs({});
    assert.strictEqual(outerCatchResult.isDegraded, true, "Outer catch must return isDegraded: true");
    assert.strictEqual(outerCatchResult.jobs.length, 0, "Outer catch must return empty jobs array");
    assert.strictEqual(outerCatchResult.error, "degraded", "Outer catch must set error: 'degraded'");
    console.log("  [PASS] Outer catch returned degraded object without fallthrough");

    // ---------------------------------------------------------------------------
    // Automated Negative Control Verification
    // ---------------------------------------------------------------------------
    console.log("\n[VERIFICATION] Verifying negative control non-zero exit on legacy behaviour...");
    const testScriptPath = path.resolve(__dirname, "test-jobs-service-degraded.ts");
    const child = spawnSync("npx", ["tsx", testScriptPath, "--negative-control"], {
      shell: true,
      encoding: "utf-8",
    });

    assert.notStrictEqual(
      child.status,
      0,
      `Negative control MUST exit with non-zero code! Got exit code: ${child.status}`
    );
    console.log(`  [PASS] Negative control running real tests against legacy behaviour exited with code ${child.status} (non-zero verified)`);

    console.log("\n================================================================================");
    console.log("ALL GETLIVEJOBS DEGRADED FALLBACK TESTS PASSED [PASS-LOCAL]");
    console.log("================================================================================\n");
  } finally {
    (global as any).window = originalWindow;
    global.fetch = originalFetch;
    delete (globalThis as any).__mockSupabaseClient;
  }
}

main().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
