import assert from "assert";
import { spawnSync } from "child_process";
import { ADMIN_EMAIL, verifyAdminSession } from "../src/lib/admin/auth";
import { GET as getAdminStats } from "../src/app/api/admin/stats/route";

async function runAdminBypassRemovalSuite() {
  console.log("================================================================================");
  console.log("          CAREERMONKE ADMIN_TEST_BYPASS REMOVAL SECURITY VERIFICATION         ");
  console.log("================================================================================");

  const isNegativeControl = process.argv.includes("--negative-control");

  if (isNegativeControl) {
    console.log("\n[NEGATIVE CONTROL MODE] Proving assertions fail with non-zero exit on invalid condition...\n");
    // Deliberate negative control: asserting that an unauthenticated request with bypass gets admin access
    const unauthenticatedIsAdmin = false;
    assert.strictEqual(
      unauthenticatedIsAdmin,
      true,
      "Negative control expected mismatch: Unauthenticated request must NEVER receive admin access."
    );
    return;
  }

  // Set ADMIN_TEST_BYPASS="true" explicitly to prove the bypass has been completely neutralized
  process.env.ADMIN_TEST_BYPASS = "true";

  // Mock Supabase admin credentials if not set for offline testing
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://mock-proj.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "mock-service-role-key";

  const originalFetch = global.fetch;

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Request with NO token while ADMIN_TEST_BYPASS="true" -> FAIL CLOSED
    // -------------------------------------------------------------------------
    console.log("Test 1: Verifying request with NO token gets rejected despite ADMIN_TEST_BYPASS='true'...");
    const noTokenReq = new Request("http://localhost:3000/api/admin/stats", {
      headers: {},
    });

    const noTokenAuth = await verifyAdminSession(noTokenReq);
    assert.strictEqual(noTokenAuth.isAdmin, false, "verifyAdminSession must return isAdmin: false when no token is provided");
    assert.strictEqual(noTokenAuth.user, null, "user must be null when no token is provided");
    assert.ok(noTokenAuth.error, "error message must be present");

    const noTokenResponse = await getAdminStats(noTokenReq);
    assert.strictEqual(noTokenResponse.status, 403, "Admin endpoint must return HTTP 403 Forbidden");
    const noTokenJson = await noTokenResponse.json();
    assert.ok(noTokenJson.error?.includes("Forbidden"), "Response must indicate Forbidden access");
    console.log("  -> [PASS-LOCAL] No token: Returned HTTP 403 Forbidden; ADMIN_TEST_BYPASS ignored.");

    // -------------------------------------------------------------------------
    // TEST 2: Request with INVALID token while ADMIN_TEST_BYPASS="true" -> FAIL CLOSED
    // -------------------------------------------------------------------------
    console.log("\nTest 2: Verifying request with INVALID token gets rejected despite ADMIN_TEST_BYPASS='true'...");
    global.fetch = async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) {
        return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
      }
      return new Response("Not found", { status: 404 });
    };

    const invalidTokenReq = new Request("http://localhost:3000/api/admin/stats", {
      headers: {
        Authorization: "Bearer invalid.fake.token",
      },
    });

    const invalidAuth = await verifyAdminSession(invalidTokenReq);
    assert.strictEqual(invalidAuth.isAdmin, false, "verifyAdminSession must return isAdmin: false on invalid token");

    const invalidResponse = await getAdminStats(invalidTokenReq);
    assert.strictEqual(invalidResponse.status, 403, "Admin endpoint must return HTTP 403 Forbidden on invalid token");
    console.log("  -> [PASS-LOCAL] Invalid token: Returned HTTP 403 Forbidden; zero bypass.");

    // -------------------------------------------------------------------------
    // TEST 3: Request from NON-ADMIN user token while ADMIN_TEST_BYPASS="true" -> FAIL CLOSED
    // -------------------------------------------------------------------------
    console.log("\nTest 3: Verifying non-admin user token gets rejected despite ADMIN_TEST_BYPASS='true'...");
    global.fetch = async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            id: "regular_user_123",
            email: "hacker@evil.com",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const nonAdminReq = new Request("http://localhost:3000/api/admin/stats", {
      headers: {
        Authorization: "Bearer non.admin.token",
      },
    });

    const nonAdminAuth = await verifyAdminSession(nonAdminReq);
    assert.strictEqual(nonAdminAuth.isAdmin, false, "verifyAdminSession must return isAdmin: false for non-admin email");

    const nonAdminResponse = await getAdminStats(nonAdminReq);
    assert.strictEqual(nonAdminResponse.status, 403, "Admin endpoint must return HTTP 403 Forbidden for non-admin email");
    console.log("  -> [PASS-LOCAL] Non-admin email: Returned HTTP 403 Forbidden.");

    // -------------------------------------------------------------------------
    // TEST 4: Request with VALID ADMIN token -> 200 OK
    // -------------------------------------------------------------------------
    console.log("\nTest 4: Verifying valid admin token succeeds...");
    global.fetch = async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            id: "admin_user_id",
            email: ADMIN_EMAIL,
            email_confirmed_at: "2026-10-30T00:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const validAdminReq = new Request("http://localhost:3000/api/admin/stats", {
      headers: {
        Authorization: "Bearer valid.admin.token",
      },
    });

    const validAuth = await verifyAdminSession(validAdminReq);
    assert.strictEqual(validAuth.isAdmin, true, "verifyAdminSession must return isAdmin: true for valid admin token");
    assert.strictEqual(validAuth.user?.email?.toLowerCase(), ADMIN_EMAIL.toLowerCase(), "Admin email must match");
    console.log("  -> [PASS-LOCAL] Valid admin token: Successfully verified as admin.");

    // -------------------------------------------------------------------------
    // TEST 5: Subprocess Negative Control Verification
    // -------------------------------------------------------------------------
    console.log("\nTest 5: Confirming negative control fails with non-zero exit code...");
    const negResult = spawnSync(process.execPath, ["-r", "tsx", __filename, "--negative-control"], {
      encoding: "utf-8",
      env: process.env,
    });

    assert.notStrictEqual(
      negResult.status,
      0,
      "Negative control MUST exit with non-zero exit code when invalid condition is asserted!"
    );
    console.log(`  -> [PASS-LOCAL] Negative control exited non-zero (${negResult.status}) as expected.`);

  } finally {
    delete process.env.ADMIN_TEST_BYPASS;
    global.fetch = originalFetch;
  }

  console.log("\n================================================================================");
  console.log("      ALL ADMIN_TEST_BYPASS REMOVAL SECURITY TESTS PASSED [PASS-LOCAL]          ");
  console.log("================================================================================");
}

runAdminBypassRemovalSuite().catch((err) => {
  console.error("\n[FAIL] Admin Bypass Removal Test Suite Error:\n", err);
  process.exit(1);
});
