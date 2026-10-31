import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

// Set environment for testing
process.env.NODE_ENV = "test";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "mock_service_role_key";

import { POST as deleteRoutePost } from "../src/app/api/account/delete/route";
import { POST as trackRoutePost } from "../src/app/api/track/route";
import { GET as interviewPackRouteGet } from "../src/app/api/jobs/interview-pack/route";

const isNegativeControl = process.argv.includes("--negative-control");

async function run() {
  console.log("==================================================================================");
  console.log("   PROMPT 2 SECURITY FIXES: DELETE ABORT, TRACK VALIDATION & INTERVIEW PACK       ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL] Deliberately asserting false condition to verify runner exits non-zero...");
    // Prove negative control failure: an invalid path without leading slash must not return 200
    const res = await trackRoutePost(
      new Request("http://localhost:3000/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "jobs_without_leading_slash" }),
      })
    );
    assert.strictEqual(res.status, 200, "NEGATIVE CONTROL INTENTIONAL FAILURE: Expected 400 for path without leading slash");
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // 1. /api/account/delete: Subscription reconcile update error aborts with 500 before ANY deletion
  // ---------------------------------------------------------------------------
  console.log("--- 1. Testing /api/account/delete Aborts on Subscription Reconcile Error (Real Route Code) ---");

  const deletedTables = new Set<string>();
  const deletedEmailTables = new Set<string>();
  let authUserDeleted = false;
  let updateAttempted = false;

  const mockAdminWithUpdateError = {
    auth: {
      getUser: async (_token: string) => ({
        data: {
          user: {
            id: "user-with-failing-sub-update",
            email: "victim@example.com",
            user_metadata: {},
          },
        },
        error: null,
      }),
      admin: {
        deleteUser: async (_id: string) => {
          authUserDeleted = true;
          return { error: null };
        },
      },
    },
    from: (table: string) => {
      if (table === "blocked_users") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        };
      }
      if (table === "subscriptions") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: "sub-failing-update-123",
                      user_id: "user-with-failing-sub-update",
                      status: "active",
                      metadata: {},
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: (_payload: any) => ({
            eq: async (_col: string, _val: any) => {
              updateAttempted = true;
              return {
                error: {
                  code: "42P01",
                  message: "Database connection failed during subscription reconciliation update",
                },
              };
            },
          }),
        };
      }
      // User data tables
      return {
        delete: () => ({
          eq: async (_col: string, _val: string) => {
            if (_col === "user_id") {
              deletedTables.add(table);
            } else if (_col === "email") {
              deletedEmailTables.add(table);
            }
            return { error: null };
          },
        }),
      };
    },
    storage: {
      from: () => ({
        list: async () => ({ data: [], error: null }),
        remove: async () => ({ error: null }),
      }),
      listBuckets: async () => ({ data: [], error: null }),
    },
  };

  // Test real route code POST from src/app/api/account/delete/route
  (globalThis as any).__mockSupabaseClient = mockAdminWithUpdateError;

  const deleteReq = new Request("http://localhost:3000/api/account/delete", {
    method: "POST",
    headers: { Authorization: "Bearer valid_reconcile_token" },
  });

  const deleteRes = await deleteRoutePost(deleteReq);
  const deleteBody = await deleteRes.json();

  assert.strictEqual(updateAttempted, true, "Subscription update must be attempted");
  assert.strictEqual(deleteRes.status, 500, `Expected 500 abort status, got ${deleteRes.status}`);
  assert.strictEqual(deleteBody.success, false);
  assert.ok(
    deleteBody.error.includes("reconcile subscription"),
    `Expected reconciliation error message, got: ${deleteBody.error}`
  );

  // CRITICAL AUDIT: Prove zero user tables deleted and auth user was NOT deleted
  assert.strictEqual(
    deletedTables.size,
    0,
    `ABORT VIOLATION: ${deletedTables.size} user tables were deleted despite subscription update failure!`
  );
  assert.strictEqual(
    deletedEmailTables.size,
    0,
    `ABORT VIOLATION: Email tables were deleted despite subscription update failure!`
  );
  assert.strictEqual(
    authUserDeleted,
    false,
    "ABORT VIOLATION: auth.admin.deleteUser was called despite subscription update failure!"
  );

  console.log("  [PASS] /api/account/delete aborted with 500 before any deletions when subscription reconcile update returned error");
  console.log("  [PASS] Verified 0 tables deleted, 0 email tables deleted, auth identity preserved");

  delete (globalThis as any).__mockSupabaseClient;

  // ---------------------------------------------------------------------------
  // 2. /api/track: Accept only paths starting with '/' up to 200 chars, referrer up to 300, else 400
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. Testing /api/track Path and Referrer Validation (Real Route Code) ---");

  // Helper to test /api/track POST
  async function testTrack(body: any): Promise<{ status: number; body: any }> {
    const req = new Request("http://localhost:3000/api/track", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "198.51.100.99",
      },
      body: JSON.stringify(body),
    });
    const res = await trackRoutePost(req);
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  }

  // 2a. Path without leading slash -> 400
  {
    const { status, body } = await testTrack({ path: "jobs" });
    assert.strictEqual(status, 400, "Path without leading '/' must return 400");
    assert.strictEqual(body.error, "Invalid path");
  }

  // 2b. Missing / empty path -> 400
  {
    const { status, body } = await testTrack({ path: "" });
    assert.strictEqual(status, 400, "Empty path must return 400");
    assert.strictEqual(body.error, "Invalid path");
  }

  // 2c. Non-string path -> 400
  {
    const { status, body } = await testTrack({ path: 12345 });
    assert.strictEqual(status, 400, "Non-string path must return 400");
    assert.strictEqual(body.error, "Invalid path");
  }

  // 2d. Path longer than 200 chars -> 400 (e.g. 201 chars)
  {
    const longPath = "/" + "a".repeat(200); // 201 chars
    assert.strictEqual(longPath.length, 201);
    const { status, body } = await testTrack({ path: longPath });
    assert.strictEqual(status, 400, "Path with 201 chars must return 400");
    assert.strictEqual(body.error, "Invalid path");
  }

  // 2e. Path with exactly 200 chars starting with '/' -> 200 OK
  {
    const maxValidPath = "/" + "a".repeat(199); // exactly 200 chars
    assert.strictEqual(maxValidPath.length, 200);
    const { status, body } = await testTrack({ path: maxValidPath });
    assert.strictEqual(status, 200, `Path with exactly 200 chars must return 200, got ${status}`);
    assert.strictEqual(body.ok, true);
  }

  // 2f. Referrer longer than 300 chars -> 400 (e.g. 301 chars)
  {
    const longReferrer = "https://example.com/" + "b".repeat(300); // > 300 chars
    assert.ok(longReferrer.length > 300);
    const { status, body } = await testTrack({ path: "/jobs", referrer: longReferrer });
    assert.strictEqual(status, 400, "Referrer with >300 chars must return 400");
    assert.strictEqual(body.error, "Invalid referrer");
  }

  // 2g. Non-string referrer -> 400
  {
    const { status, body } = await testTrack({ path: "/jobs", referrer: 98765 });
    assert.strictEqual(status, 400, "Non-string referrer must return 400");
    assert.strictEqual(body.error, "Invalid referrer");
  }

  // 2h. Referrer with exactly 300 chars -> 200 OK
  {
    const valid300Referrer = "https://" + "x".repeat(292); // exactly 300 chars
    assert.strictEqual(valid300Referrer.length, 300);
    const { status, body } = await testTrack({ path: "/jobs", referrer: valid300Referrer });
    assert.strictEqual(status, 200, `Referrer with exactly 300 chars must return 200, got ${status}`);
    assert.strictEqual(body.ok, true);
  }

  // 2i. Normal valid path and referrer -> 200 OK
  {
    const { status, body } = await testTrack({ path: "/jobs/remote", referrer: "https://news.ycombinator.com" });
    assert.strictEqual(status, 200, "Normal path and referrer must return 200");
    assert.strictEqual(body.ok, true);
  }

  // 2j. Null referrer -> 200 OK
  {
    const { status, body } = await testTrack({ path: "/pricing", referrer: null });
    assert.strictEqual(status, 200, "Null referrer must be accepted and return 200");
    assert.strictEqual(body.ok, true);
  }

  // 2k. Omitted referrer -> 200 OK
  {
    const { status, body } = await testTrack({ path: "/about" });
    assert.strictEqual(status, 200, "Omitted referrer must be accepted and return 200");
    assert.strictEqual(body.ok, true);
  }

  console.log("  [PASS] /api/track path validation: only accepts paths starting with '/' up to 200 chars");
  console.log("  [PASS] /api/track referrer validation: accepts referrer up to 300 chars, else 400");

  // ---------------------------------------------------------------------------
  // 3. /api/jobs/interview-pack: Anon-key fallback removed, fails closed with 500
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. Testing Interview Pack Anon-Key Fallback Removal & Fail-Closed (Real Route Code) ---");

  // Verify static code: src/lib/interview-pack/handler.ts MUST NOT reference NEXT_PUBLIC_SUPABASE_ANON_KEY
  const handlerCode = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/interview-pack/handler.ts"),
    "utf-8"
  );
  assert.ok(
    !handlerCode.includes("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    "src/lib/interview-pack/handler.ts must NEVER contain NEXT_PUBLIC_SUPABASE_ANON_KEY"
  );
  console.log("  [PASS] Static check: NEXT_PUBLIC_SUPABASE_ANON_KEY completely removed from interview-pack handler");

  // Test real route code with ONLY anon key present (no service role key)
  const savedServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const savedServiceKey = process.env.SUPABASE_SERVICE_KEY;
  const savedAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  try {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "mock_anon_key_that_should_not_be_used";

    const ipReq = new Request("http://localhost:3000/api/jobs/interview-pack?jobId=job_real_123", {
      headers: { Authorization: "Bearer user_bearer_token" },
    });

    const ipRes = await interviewPackRouteGet(ipReq);
    const ipBody = await ipRes.json();

    assert.strictEqual(
      ipRes.status,
      500,
      `Expected status 500 (fail closed on missing service role key), got ${ipRes.status}`
    );
    assert.strictEqual(
      ipBody.missingVariable,
      "SUPABASE_SERVICE_ROLE_KEY",
      `Expected missingVariable 'SUPABASE_SERVICE_ROLE_KEY', got ${JSON.stringify(ipBody)}`
    );
    assert.strictEqual(
      ipBody.isPro === true,
      false,
      "Response must not leak isPro: true or any data"
    );

    console.log("  [PASS] Real route code GET /api/jobs/interview-pack fails closed with HTTP 500 and names SUPABASE_SERVICE_ROLE_KEY when anon key is provided");
  } finally {
    if (savedServiceRoleKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedServiceRoleKey;
    if (savedServiceKey !== undefined) process.env.SUPABASE_SERVICE_KEY = savedServiceKey;
    if (savedAnonKey !== undefined) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = savedAnonKey;
  }

  // ---------------------------------------------------------------------------
  // 4. Subprocess Negative Control Execution
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. Verifying Subprocess Negative Control ---");
  const negResult = spawnSync(
    process.execPath,
    ["--import", "tsx", __filename, "--negative-control"],
    {
      encoding: "utf-8",
      env: process.env,
    }
  );
  assert.notStrictEqual(negResult.status, 0, "Negative control subprocess must exit with non-zero exit code");
  console.log(`  [PASS] Subprocess negative control exited with non-zero code (${negResult.status})`);

  console.log("\n==================================================================================");
  console.log("PROMPT 2 SECURITY FIXES: ALL TESTS PASSED [PASS-LOCAL]");
  console.log("==================================================================================");
}

run().catch((err) => {
  console.error("FATAL ERROR in test-prompt2-security-fixes:", err);
  process.exit(1);
});
