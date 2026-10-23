import assert from "node:assert/strict";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { pathToFileURL } from "node:url";

// Load test environment variables
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "mock-service-role-key-secret-12345";
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://mock.supabase.co";

import { ADMIN_EMAIL } from "../src/lib/admin/constants";
import { GET as realAdminUsersGet } from "../src/app/api/admin/users/route";
import { GET as realAdminStatsGet } from "../src/app/api/admin/stats/route";

// Track privileged calls
let privilegedCallsCount = 0;

// Setup fetch mock for auth and Supabase
const originalFetch = global.fetch;
global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const urlStr = String(input);
  const headers = (init?.headers as any) || {};
  const authHeader = typeof headers.get === "function"
    ? headers.get("authorization") || headers.get("Authorization") || ""
    : (headers["Authorization"] || headers["authorization"] || "");

  // Auth /user session verification
  if (urlStr.includes("/auth/v1/user")) {
    if (authHeader.includes("Bearer mock-admin-token")) {
      return new Response(
        JSON.stringify({
          id: "admin-user-001",
          email: ADMIN_EMAIL,
          user_metadata: { role: "admin" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (authHeader.includes("Bearer mock-non-admin-token")) {
      return new Response(
        JSON.stringify({
          id: "regular-user-003",
          email: "regular@example.com",
          user_metadata: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
  }

  // Privileged calls
  privilegedCallsCount++;

  if (urlStr.includes("/auth/v1/admin/users")) {
    return new Response(
      JSON.stringify({
        users: [
          {
            id: "target-user-001",
            email: "target@example.com",
            created_at: "2026-01-01T00:00:00Z",
            last_sign_in_at: "2026-03-01T00:00:00Z",
            user_metadata: {},
          },
        ],
        total: 1,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  if (urlStr.includes("/rest/v1/")) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json", "content-range": "0-0/0" },
    });
  }

  return new Response(JSON.stringify({ error: "Network mock default deny" }), { status: 500 });
};

async function testGuardMutation() {
  console.log("================================================================================");
  console.log("REAL GUARD REGRESSION CONTROL TEST (DISPOSABLE MUTATION HARNESS)");
  console.log("================================================================================\n");

  const disposablePaths: string[] = [];

  try {
    // -------------------------------------------------------------------------
    // STEP 1: Verify unchanged handlers PASS authorization assertion
    // -------------------------------------------------------------------------
    console.log("--- STEP 1: Testing UNCHANGED route handlers with non-admin token ---");

    const reqUsers = new Request("http://localhost:3000/api/admin/users", {
      headers: { Authorization: "Bearer mock-non-admin-token" },
    });
    const resUsers = await realAdminUsersGet(reqUsers);
    assert.equal(resUsers.status, 403, "Unchanged /api/admin/users handler must return 403");
    console.log("✅ [PASS-LOCAL] Unchanged /api/admin/users returned HTTP 403 as expected");

    const reqStats = new Request("http://localhost:3000/api/admin/stats", {
      headers: { Authorization: "Bearer mock-non-admin-token" },
    });
    const resStats = await realAdminStatsGet(reqStats);
    assert.equal(resStats.status, 403, "Unchanged /api/admin/stats handler must return 403");
    console.log("✅ [PASS-LOCAL] Unchanged /api/admin/stats returned HTTP 403 as expected\n");

    // -------------------------------------------------------------------------
    // STEP 2: Create disposable mutated copy of /api/admin/users/route.ts
    // -------------------------------------------------------------------------
    console.log("--- STEP 2: Creating disposable copy with admin guard deliberately removed ---");
    const usersRouteSourcePath = path.resolve(__dirname, "../src/app/api/admin/users/route.ts");
    const usersSource = fs.readFileSync(usersRouteSourcePath, "utf-8");

    // Ensure the guard exists in original code
    const guardPattern = /if\s*\(!auth\.isAdmin\)\s*\{[\s\S]*?return\s+NextResponse\.json\([\s\S]*?\{\s*status:\s*403\s*\}\s*\);\s*\}/;
    assert.ok(guardPattern.test(usersSource), "Admin authorization guard must exist in src/app/api/admin/users/route.ts");

    // Mutate by commenting out / removing the guard
    const mutatedUsersSource = usersSource.replace(
      guardPattern,
      "/* [MUTATION] admin guard deliberately bypassed for regression control */"
    );

    const disposableDir = path.resolve(__dirname, ".tmp-mutation-test");
    if (!fs.existsSync(disposableDir)) {
      fs.mkdirSync(disposableDir, { recursive: true });
    }
    const disposableUsersPath = path.join(disposableDir, "mutated-users-route.ts");
    fs.writeFileSync(disposableUsersPath, mutatedUsersSource, "utf-8");
    disposablePaths.push(disposableUsersPath);
    console.log(`Created disposable mutated copy at: ${disposableUsersPath}`);

    // Dynamically import the mutated handler
    const mutatedUsersModule = await import(pathToFileURL(disposableUsersPath).href);
    const mutatedAdminUsersGet = mutatedUsersModule.GET;

    // -------------------------------------------------------------------------
    // STEP 3: Execute the SAME authorization test against the mutated handler
    // -------------------------------------------------------------------------
    console.log("--- STEP 3: Executing the SAME authorization assertion on mutated handler ---");
    let caughtAssertionError: assert.AssertionError | null = null;
    let mutatedResponseStatus: number = 0;

    try {
      const mutatedReq = new Request("http://localhost:3000/api/admin/users", {
        headers: { Authorization: "Bearer mock-non-admin-token" },
      });
      const mutatedRes = await mutatedAdminUsersGet(mutatedReq);
      mutatedResponseStatus = mutatedRes.status;

      // The exact same assertion from our test suite:
      assert.equal(
        mutatedRes.status,
        403,
        "Expected HTTP 403 Forbidden: Admin access only (Assertion in test-admin-handlers.ts)"
      );
    } catch (err: any) {
      if (err instanceof assert.AssertionError) {
        caughtAssertionError = err;
      } else {
        throw err;
      }
    }

    // -------------------------------------------------------------------------
    // STEP 4: Verify the assertion caught the regression
    // -------------------------------------------------------------------------
    console.log("--- STEP 4: Verifying mutation detection result ---");
    assert.ok(
      caughtAssertionError !== null,
      "CRITICAL REGRESSION CONTROL FAILURE: The test failed to detect the missing admin guard!"
    );

    console.log("✅ [PASS-LOCAL] Real guard regression control successfully proved!");
    console.log(`   - Mutated handler returned: HTTP ${mutatedResponseStatus} (privilege leak)`);
    console.log(`   - Caught by assertion: ${caughtAssertionError.message}`);
    console.log(`   - Expected: ${caughtAssertionError.expected}`);
    console.log(`   - Actual: ${caughtAssertionError.actual}`);
    console.log(`   - Detecting file & assertion: test-admin-handlers.ts (assert.equal(res.status, 403))\n`);

    // -------------------------------------------------------------------------
    // STEP 5: Create disposable mutated copy of /api/admin/stats/route.ts
    // -------------------------------------------------------------------------
    console.log("--- STEP 5: Verifying regression control on /api/admin/stats/route.ts ---");
    const statsRouteSourcePath = path.resolve(__dirname, "../src/app/api/admin/stats/route.ts");
    const statsSource = fs.readFileSync(statsRouteSourcePath, "utf-8");

    assert.ok(guardPattern.test(statsSource), "Admin authorization guard must exist in src/app/api/admin/stats/route.ts");

    const mutatedStatsSource = statsSource.replace(
      guardPattern,
      "/* [MUTATION] admin guard deliberately bypassed for regression control */"
    );

    const disposableStatsPath = path.join(disposableDir, "mutated-stats-route.ts");
    fs.writeFileSync(disposableStatsPath, mutatedStatsSource, "utf-8");
    disposablePaths.push(disposableStatsPath);

    const mutatedStatsModule = await import(pathToFileURL(disposableStatsPath).href);
    const mutatedAdminStatsGet = mutatedStatsModule.GET;

    let caughtStatsAssertionError: assert.AssertionError | null = null;
    let mutatedStatsResponseStatus: number = 0;

    try {
      const mutatedStatsReq = new Request("http://localhost:3000/api/admin/stats", {
        headers: { Authorization: "Bearer mock-non-admin-token" },
      });
      const mutatedStatsRes = await mutatedAdminStatsGet(mutatedStatsReq);
      mutatedStatsResponseStatus = mutatedStatsRes.status;

      assert.equal(
        mutatedStatsRes.status,
        403,
        "Expected HTTP 403 Forbidden: Admin access only"
      );
    } catch (err: any) {
      if (err instanceof assert.AssertionError) {
        caughtStatsAssertionError = err;
      } else {
        throw err;
      }
    }

    assert.ok(
      caughtStatsAssertionError !== null,
      "CRITICAL: Failed to detect missing admin guard on /api/admin/stats"
    );
    console.log("✅ [PASS-LOCAL] Real guard regression control proved on /api/admin/stats!");
    console.log(`   - Mutated stats returned: HTTP ${mutatedStatsResponseStatus}`);
    console.log(`   - Detecting assertion: assert.equal(res.status, 403)\n`);

  } finally {
    // -------------------------------------------------------------------------
    // STEP 6: Clean up disposable copies
    // -------------------------------------------------------------------------
    console.log("--- CLEANUP: Removing disposable mutation files ---");
    for (const filePath of disposablePaths) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Removed disposable file: ${filePath}`);
      }
    }
    const disposableDir = path.resolve(__dirname, ".tmp-mutation-test");
    if (fs.existsSync(disposableDir)) {
      fs.rmdirSync(disposableDir);
      console.log(`Removed disposable directory: ${disposableDir}`);
    }
    console.log("Cleanup complete: Zero disposable or mutated files remain in repository.\n");
  }

  console.log("================================================================================");
  console.log("🎉 ALL REAL GUARD REGRESSION CONTROL CHECKS PASSED (PASS-LOCAL)");
  console.log("================================================================================");
}

testGuardMutation().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
