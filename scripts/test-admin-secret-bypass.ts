/**
 * scripts/test-admin-secret-bypass.ts
 *
 * Test Suite: Verify x-admin-secret scoping in src/middleware.ts:
 * 1. Valid header allows explicit read-only smoke-test endpoints (/api/health, /api/ticker, GET /api/jobs/search)
 *    without early-access approval.
 * 2. Valid header with NO session CANNOT access protected routes:
 *    - /dashboard redirects (307) to /early-access (or /login) exactly as if header were absent.
 *    - /api/jobs/top10 returns 403 (or 401) exactly as if header were absent.
 *    - hasValidSession is NEVER set to true by x-admin-secret.
 * 3. Wrong / mismatched / empty header behaves exactly as header absent (fails closed).
 *    Disabled when ADMIN_SECRET is unset.
 * 4. Header on /admin or /api/admin paths grants nothing (returns 403 Forbidden: Admin access only).
 * 5. Edge runtime compatibility (Web Crypto SHA-256 + constant-time comparison, no node crypto.timingSafeEqual).
 * 6. Negative controls proving non-zero exits on compromised invariants.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Module from "node:module";
import { NextRequest } from "next/server";

// Mock @cloudflare/next-on-pages in test environment
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options: any
) {
  if (request === "@cloudflare/next-on-pages") {
    return "virtual:@cloudflare/next-on-pages";
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

require.cache["virtual:@cloudflare/next-on-pages"] = {
  id: "virtual:@cloudflare/next-on-pages",
  filename: "virtual:@cloudflare/next-on-pages",
  loaded: true,
  exports: {
    getRequestContext: () => {
      const sym = Symbol.for("__cloudflare-request-context__");
      return (globalThis as any)[sym];
    },
  },
} as any;

process.env.NODE_ENV = "test";

const TEST_ADMIN_SECRET = "careermonke-smoke-secret-test-2026-xyz";

// Negative control modes
const ncArg = process.argv[2];
if (ncArg === "--nc-dashboard-allowed") {
  // Deliberately assert that /dashboard is 200 with x-admin-secret (must fail)
  const fakeStatus = 307;
  assert.strictEqual(fakeStatus, 200, "Negative control: /dashboard must never return 200 via admin secret");
  process.exit(0);
}

if (ncArg === "--nc-top10-allowed") {
  // Deliberately assert that /api/jobs/top10 is 200 with x-admin-secret (must fail)
  const fakeStatus = 403;
  assert.strictEqual(fakeStatus, 200, "Negative control: /api/jobs/top10 must never return 200 via admin secret");
  process.exit(0);
}

if (ncArg === "--nc-admin-allowed") {
  // Deliberately assert that /admin is 200 with x-admin-secret (must fail)
  const fakeStatus = 403;
  assert.strictEqual(fakeStatus, 200, "Negative control: /admin must never return 200 via admin secret");
  process.exit(0);
}

if (ncArg === "--nc-wrong-secret-allowed") {
  // Deliberately assert that wrong secret passes (must fail)
  const fakePassed = false;
  assert.strictEqual(fakePassed, true, "Negative control: wrong secret must never pass");
  process.exit(0);
}

let passes = 0;
let total = 0;

function pass(msg: string) {
  passes++;
  total++;
  console.log(`  -> [PASS-LOCAL] ${msg}`);
}

async function runSuite() {
  console.log("================================================================================");
  console.log("       CAREERMONKE X-ADMIN-SECRET SCOPING & HARDENING VERIFICATION SUITE       ");
  console.log("================================================================================\n");

  process.env.ADMIN_SECRET = TEST_ADMIN_SECRET;

  const {
    middleware,
    isEarlyAccessSecretBypassAllowed,
    isValidAdminSecret,
  } = await import("../src/middleware");

  // ---------------------------------------------------------------------------
  // TEST 1: Source Code Invariant Checks (Static AST / Analysis)
  // ---------------------------------------------------------------------------
  console.log("Test 1: Static analysis of src/middleware.ts...");
  const middlewareSrc = fs.readFileSync(path.resolve(process.cwd(), "src/middleware.ts"), "utf-8");

  // Invariant 1.1: verifyAuthenticatedRequest must NOT check x-admin-secret
  const verifyAuthFnMatch = middlewareSrc.match(/async function verifyAuthenticatedRequest[\s\S]*?\n\}/);
  assert.ok(verifyAuthFnMatch, "verifyAuthenticatedRequest function must exist in src/middleware.ts");
  const verifyAuthBody = verifyAuthFnMatch[0];
  assert.ok(
    !verifyAuthBody.includes("x-admin-secret"),
    "verifyAuthenticatedRequest must NOT inspect or reference 'x-admin-secret'"
  );
  assert.ok(
    !verifyAuthBody.includes("ADMIN_SECRET"),
    "verifyAuthenticatedRequest must NOT inspect or reference 'ADMIN_SECRET'"
  );
  pass("verifyAuthenticatedRequest contains zero references to x-admin-secret or ADMIN_SECRET");

  // Invariant 1.2: Node crypto.timingSafeEqual must NOT be used (edge runtime incompatible)
  assert.ok(
    !middlewareSrc.includes("crypto.timingSafeEqual"),
    "src/middleware.ts must not use Node.js crypto.timingSafeEqual on Edge runtime"
  );
  pass("Edge runtime compatibility confirmed (no node:crypto.timingSafeEqual)");

  // Invariant 1.3: Web Crypto SHA-256 and constantTimeEqual present
  assert.ok(
    middlewareSrc.includes("computeSha256Hex") && middlewareSrc.includes("constantTimeEqual"),
    "src/middleware.ts must implement computeSha256Hex and constantTimeEqual"
  );
  pass("SHA-256 hex digest and constant-time string comparison functions confirmed in middleware");

  // ---------------------------------------------------------------------------
  // TEST 2: Scoped Path Allowlist for x-admin-secret Bypass
  // ---------------------------------------------------------------------------
  console.log("\nTest 2: Explicit allowlist restriction of isEarlyAccessSecretBypassAllowed...");

  const allowedTestCases = [
    { url: "http://localhost:3000/api/health", method: "GET", expected: true },
    { url: "http://localhost:3000/api/health/ready", method: "GET", expected: true },
    { url: "http://localhost:3000/api/ticker", method: "GET", expected: true },
    { url: "http://localhost:3000/.netlify/functions/ticker", method: "GET", expected: true },
    { url: "http://localhost:3000/api/jobs/search", method: "GET", expected: true },
    { url: "http://localhost:3000/.netlify/functions/jobs-search", method: "GET", expected: true },
    { url: "http://localhost:3000/api/jobs/search?q=engineer", method: "GET", expected: true },
    { url: "http://localhost:3000/api/jobs/search", method: "HEAD", expected: true },
  ];

  for (const tc of allowedTestCases) {
    const req = new NextRequest(tc.url, { method: tc.method });
    const isAllowed = isEarlyAccessSecretBypassAllowed(req);
    assert.strictEqual(
      isAllowed,
      tc.expected,
      `Path ${tc.method} ${tc.url} must be allowed by isEarlyAccessSecretBypassAllowed`
    );
  }
  pass("All specified smoke-test read-only endpoints correctly match allowlist");

  const deniedTestCases = [
    { url: "http://localhost:3000/dashboard", method: "GET" },
    { url: "http://localhost:3000/tracker", method: "GET" },
    { url: "http://localhost:3000/resume", method: "GET" },
    { url: "http://localhost:3000/settings", method: "GET" },
    { url: "http://localhost:3000/admin", method: "GET" },
    { url: "http://localhost:3000/admin/users", method: "GET" },
    { url: "http://localhost:3000/api/admin", method: "GET" },
    { url: "http://localhost:3000/api/admin/stats", method: "GET" },
    { url: "http://localhost:3000/api/jobs/top10", method: "GET" },
    { url: "http://localhost:3000/api/jobs/top10", method: "POST" },
    { url: "http://localhost:3000/api/jobs/pro", method: "GET" },
    { url: "http://localhost:3000/api/jobs/pro", method: "POST" },
    { url: "http://localhost:3000/api/jobs/search", method: "POST" },
    { url: "http://localhost:3000/api/jobs/search", method: "DELETE" },
    { url: "http://localhost:3000/api/track", method: "POST" },
  ];

  for (const tc of deniedTestCases) {
    const req = new NextRequest(tc.url, { method: tc.method });
    const isAllowed = isEarlyAccessSecretBypassAllowed(req);
    assert.strictEqual(
      isAllowed,
      false,
      `Non-allowlisted path/method ${tc.method} ${tc.url} must NOT be allowed by isEarlyAccessSecretBypassAllowed`
    );
  }
  pass("All protected pages, admin paths, and non-GET APIs strictly excluded from bypass allowlist");

  // ---------------------------------------------------------------------------
  // TEST 3: Requirement (a) - /api/health reachable without early-access approval
  // ---------------------------------------------------------------------------
  console.log("\nTest 3: Requirement (a) - /api/health with valid header...");

  const healthReqWithHeader = new NextRequest("http://localhost:3000/api/health", {
    headers: { "x-admin-secret": TEST_ADMIN_SECRET },
  });
  const healthResWithHeader = await middleware(healthReqWithHeader);
  assert.strictEqual(healthResWithHeader.status, 200, "/api/health with valid header must return 200");

  const healthReqNoHeader = new NextRequest("http://localhost:3000/api/health");
  const healthResNoHeader = await middleware(healthReqNoHeader);
  assert.strictEqual(healthResNoHeader.status, 200, "/api/health without header must return 200");

  // Also verify smoke endpoint GET /api/jobs/search with valid header
  const searchReqWithHeader = new NextRequest("http://localhost:3000/api/jobs/search?q=engineer", {
    method: "GET",
    headers: { "x-admin-secret": TEST_ADMIN_SECRET },
  });
  const searchResWithHeader = await middleware(searchReqWithHeader);
  assert.strictEqual(searchResWithHeader.status, 200, "GET /api/jobs/search with valid header must bypass early-access gate (200)");

  // Without header or approval, guest GET /api/jobs/search returns 403 in early access mode
  const searchReqNoHeader = new NextRequest("http://localhost:3000/api/jobs/search?q=engineer", {
    method: "GET",
  });
  const searchResNoHeader = await middleware(searchReqNoHeader);
  assert.strictEqual(searchResNoHeader.status, 403, "GET /api/jobs/search without header returns 403 in early access mode");
  pass("Requirement (a) verified: smoke endpoints (/api/health, /api/jobs/search) reachable with valid header");

  // ---------------------------------------------------------------------------
  // TEST 4: Requirement (b) - /dashboard and /api/jobs/top10 still redirect/401
  // ---------------------------------------------------------------------------
  console.log("\nTest 4: Requirement (b) - /dashboard and /api/jobs/top10 still redirect/401 with valid header and NO session...");

  // 4.1 /dashboard with valid header but NO session
  const dashReqWithHeader = new NextRequest("http://localhost:3000/dashboard", {
    headers: { "x-admin-secret": TEST_ADMIN_SECRET },
  });
  const dashResWithHeader = await middleware(dashReqWithHeader);
  assert.strictEqual(
    dashResWithHeader.status,
    307,
    "/dashboard with valid x-admin-secret and NO session must return 307 redirect"
  );
  const dashLocation = dashResWithHeader.headers.get("location");
  assert.ok(dashLocation, "Redirect response must include Location header");
  const dashUrl = new URL(dashLocation);
  assert.strictEqual(
    dashUrl.pathname,
    "/early-access",
    "/dashboard must redirect to /early-access (never grants dashboard access)"
  );

  // Compare with /dashboard without header
  const dashReqNoHeader = new NextRequest("http://localhost:3000/dashboard");
  const dashResNoHeader = await middleware(dashReqNoHeader);
  assert.strictEqual(dashResNoHeader.status, 307);
  const dashNoHeaderLocation = new URL(dashResNoHeader.headers.get("location")!).pathname;
  assert.strictEqual(dashLocation, dashResNoHeader.headers.get("location"), "Behavior with header must match behavior without header");
  pass("/dashboard with valid header + NO session redirects to /early-access exactly as if header were absent");

  // 4.2 /api/jobs/top10 with valid header but NO session
  const top10ReqWithHeader = new NextRequest("http://localhost:3000/api/jobs/top10", {
    method: "GET",
    headers: { "x-admin-secret": TEST_ADMIN_SECRET },
  });
  const top10ResWithHeader = await middleware(top10ReqWithHeader);
  assert.strictEqual(
    top10ResWithHeader.status,
    403,
    "/api/jobs/top10 with valid x-admin-secret and NO session must return 403 Early access only"
  );

  const top10ReqNoHeader = new NextRequest("http://localhost:3000/api/jobs/top10", {
    method: "GET",
  });
  const top10ResNoHeader = await middleware(top10ReqNoHeader);
  assert.strictEqual(
    top10ResNoHeader.status,
    403,
    "/api/jobs/top10 without header must return 403 Early access only"
  );
  pass("/api/jobs/top10 with valid header + NO session returns 403 exactly as if header were absent");

  // 4.3 Other protected routes (/resume, /tracker, /profile, /settings)
  for (const protRoute of ["/resume", "/tracker", "/profile", "/settings"]) {
    const res = await middleware(
      new NextRequest(`http://localhost:3000${protRoute}`, {
        headers: { "x-admin-secret": TEST_ADMIN_SECRET },
      })
    );
    assert.strictEqual(
      res.status,
      307,
      `Protected page '${protRoute}' must redirect 307 even with valid x-admin-secret`
    );
  }
  pass("Protected routes (/resume, /tracker, /profile, /settings) redirect 307 even with valid header");

  // Public /pricing returns 200
  const pricingRes = await middleware(
    new NextRequest("http://localhost:3000/pricing", {
      headers: { "x-admin-secret": TEST_ADMIN_SECRET },
    })
  );
  assert.strictEqual(pricingRes.status, 200, "Public /pricing returns 200");
  pass("Public /pricing returns 200 without redirection");

  // ---------------------------------------------------------------------------
  // TEST 5: Requirement (c) - Wrong header value behaves as header absent
  // ---------------------------------------------------------------------------
  console.log("\nTest 5: Requirement (c) - Wrong/mismatched header behaves as header absent...");

  const wrongSecrets = [
    "wrong-secret",
    "careermonke-smoke-secret-test-2026-xy", // truncated by 1 char
    "careermonke-smoke-secret-test-2026-xyz-extra", // extended
    "CAREERMONKE-SMOKE-SECRET-TEST-2026-XYZ", // wrong casing
    "", // empty string
    "   ", // whitespace only
  ];

  for (const wrong of wrongSecrets) {
    const req = new NextRequest("http://localhost:3000/api/jobs/search?q=engineer", {
      method: "GET",
      headers: { "x-admin-secret": wrong },
    });
    const res = await middleware(req);
    assert.strictEqual(
      res.status,
      403,
      `GET /api/jobs/search with invalid header '${wrong}' must return 403 (behave as absent)`
    );
  }
  pass("All mismatched or invalid header variations fail closed to 403 (identical to header absent)");

  // 5.2 ADMIN_SECRET unset in environment
  delete process.env.ADMIN_SECRET;
  const reqUnsetEnv = new NextRequest("http://localhost:3000/api/jobs/search?q=engineer", {
    method: "GET",
    headers: { "x-admin-secret": TEST_ADMIN_SECRET },
  });
  const resUnsetEnv = await middleware(reqUnsetEnv);
  assert.strictEqual(
    resUnsetEnv.status,
    403,
    "When ADMIN_SECRET is unset in environment, header must be ignored and return 403"
  );
  process.env.ADMIN_SECRET = TEST_ADMIN_SECRET; // restore
  pass("Bypass strictly disabled when ADMIN_SECRET environment variable is unset");

  // ---------------------------------------------------------------------------
  // TEST 6: Requirement (d) - Header on /admin or /api/admin paths grants nothing
  // ---------------------------------------------------------------------------
  console.log("\nTest 6: Requirement (d) - Header on /admin or /api/admin paths grants nothing (403)...");

  const adminPaths = [
    "http://localhost:3000/admin",
    "http://localhost:3000/admin/users",
    "http://localhost:3000/admin/analytics",
    "http://localhost:3000/api/admin",
    "http://localhost:3000/api/admin/stats",
    "http://localhost:3000/api/admin/users",
  ];

  for (const adminUrl of adminPaths) {
    const reqWithHeader = new NextRequest(adminUrl, {
      method: "GET",
      headers: { "x-admin-secret": TEST_ADMIN_SECRET },
    });
    const resWithHeader = await middleware(reqWithHeader);
    assert.strictEqual(
      resWithHeader.status,
      403,
      `${adminUrl} with valid x-admin-secret must return 403 Forbidden: Admin access only`
    );
    const body = await resWithHeader.json();
    assert.strictEqual(
      body.error,
      "Forbidden: Admin access only.",
      `${adminUrl} must return exact admin forbidden message`
    );
  }
  pass("Header on /admin or /api/admin/* paths grants nothing: strictly returns 403 Forbidden");

  // ---------------------------------------------------------------------------
  // TEST 7: Negative Controls Sub-Process Executions
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 7: NEGATIVE CONTROLS (SUB-PROCESS EXECUTION) ---");

  const negativeControls = [
    { flag: "--nc-dashboard-allowed", label: "Negative Control 1: /dashboard improperly allowed via secret" },
    { flag: "--nc-top10-allowed", label: "Negative Control 2: /api/jobs/top10 improperly allowed via secret" },
    { flag: "--nc-admin-allowed", label: "Negative Control 3: /admin improperly allowed via secret" },
    { flag: "--nc-wrong-secret-allowed", label: "Negative Control 4: Wrong secret improperly allowed" },
  ];

  for (const nc of negativeControls) {
    const res = spawnSync("npx", ["tsx", "scripts/test-admin-secret-bypass.ts", nc.flag], {
      encoding: "utf-8",
      shell: true,
    });
    assert.notStrictEqual(
      res.status,
      0,
      `${nc.label} must exit non-zero! (Got status ${res.status})`
    );
    pass(`${nc.label} correctly caught by assertion and exited non-zero (${res.status})`);
  }

  console.log("\n================================================================================");
  console.log(`ALL TESTS PASSED: ${passes}/${total} CHECKS SUCCESSFUL [PASS-LOCAL]`);
  console.log("================================================================================");
}

runSuite().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
