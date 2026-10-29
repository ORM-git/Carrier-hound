/**
 * scripts/test-auth-guard.ts
 *
 * Offline verification suite for CareerMonke Server-Side & Client-Side Auth Guards:
 * 1. Guest hitting each protected route (/dashboard, /jobs, /resume, /tracker, /profile, /radar, /pricing) is redirected.
 * 2. Public routes (/, /remote, /remote/engineering, /login, /signup, /privacy, /privacy-policy, /terms-and-conditions, /worldwide) stay 200.
 * 3. return-to parameter is validated (safe same-site relative paths allowed; open redirects / external URLs blocked).
 * 4. Expired sessions do not create infinite redirect loops.
 * 5. Negative control proves non-zero exit on invalid conditions.
 */

import assert from "assert";
import { NextRequest } from "next/server";
import { middleware, isProtectedRoute, PROTECTED_ROUTES, PUBLIC_ROUTES } from "../src/middleware";
import { getValidReturnUrl } from "../src/lib/auth/session";
import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");
process.env.NODE_ENV = "test";
process.env.__CAREERMONKE_LEGACY_EARLY_ACCESS_UNLOCK = "true";


async function runAuthGuardSuite() {
  console.log("================================================================================");
  console.log("             CAREERMONKE AUTH GUARD & OPEN REDIRECT VERIFICATION                ");
  console.log("================================================================================\n");

  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL MODE] Proving assertions fail with non-zero exit on invalid condition...");
    // Deliberately assert that an evil external URL is accepted as a valid return URL
    const evilResult = getValidReturnUrl("https://evil.com/phishing", "/dashboard");
    assert.strictEqual(
      evilResult,
      "https://evil.com/phishing",
      "Negative control expected mismatch: 'https://evil.com/phishing' must NEVER equal valid return URL."
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // TEST 1: Protected Routes Classification & Server-Side Middleware Redirection
  // ---------------------------------------------------------------------------
  console.log("Test 1: Verifying guest requests to protected routes are redirected server-side...");

  const protectedTestCases = [
    { path: "/dashboard", expectedReturnTo: "/dashboard" },
    { path: "/jobs", expectedReturnTo: "/jobs" },
    { path: "/resume", expectedReturnTo: "/resume" },
    { path: "/tracker", expectedReturnTo: "/tracker" },
    { path: "/profile", expectedReturnTo: "/profile" },
    { path: "/radar", expectedReturnTo: "/radar" },
    { path: "/pricing", expectedReturnTo: "/pricing" },
    { path: "/settings", expectedReturnTo: "/settings" },
    { path: "/jobs?location=Remote&level=Senior", expectedReturnTo: "/jobs?location=Remote&level=Senior" },
    { path: "/tracker?stage=saved", expectedReturnTo: "/tracker?stage=saved" },
  ];

  for (const tc of protectedTestCases) {
    const rawPath = tc.path.split("?")[0];
    assert.strictEqual(
      isProtectedRoute(rawPath),
      true,
      `Route '${rawPath}' must be recognized as protected by isProtectedRoute()`
    );

    const req = new NextRequest(`http://localhost:3000${tc.path}`);
    const res = await middleware(req);

    assert.strictEqual(
      res.status,
      307,
      `Unauthenticated request to protected route '${tc.path}' must return HTTP 307 redirect, got ${res.status}`
    );

    const locationHeader = res.headers.get("location");
    assert.ok(
      locationHeader,
      `Redirect response for '${tc.path}' must include a Location header`
    );

    const parsedRedirect = new URL(locationHeader);
    assert.strictEqual(
      parsedRedirect.pathname,
      "/login",
      `Redirect target path for '${tc.path}' must be '/login', got '${parsedRedirect.pathname}'`
    );

    const returnToParam = parsedRedirect.searchParams.get("returnTo");
    assert.strictEqual(
      returnToParam,
      tc.expectedReturnTo,
      `returnTo query parameter for '${tc.path}' must match '${tc.expectedReturnTo}', got '${returnToParam}'`
    );

    console.log(`  -> [PASS-LOCAL] Protected route '${tc.path}' redirected to: ${parsedRedirect.pathname}?returnTo=${encodeURIComponent(returnToParam || "")}`);
  }

  // ---------------------------------------------------------------------------
  // TEST 2: Public Routes Stay HTTP 200 (No Redirection)
  // ---------------------------------------------------------------------------
  console.log("\nTest 2: Verifying guest-facing public routes stay HTTP 200 (not redirected)...");

  const publicTestCases = [
    "/",
    "/remote",
    "/remote/jobs/engineering",
    "/remote/hidden-job-market-guide",
    "/remote/product-designer/titles",
    "/login",
    "/signup",
    "/privacy",
    "/privacy-policy",
    "/terms-and-conditions",
    "/worldwide",
  ];

  for (const route of publicTestCases) {
    const rawPath = route.split("?")[0];
    assert.strictEqual(
      isProtectedRoute(rawPath),
      false,
      `Public route '${rawPath}' must NOT be flagged as protected by isProtectedRoute()`
    );

    const req = new NextRequest(`http://localhost:3000${route}`);
    const res = await middleware(req);

    assert.strictEqual(
      res.status,
      200,
      `Public route '${route}' must return HTTP 200 without redirection, got ${res.status}`
    );

    const locationHeader = res.headers.get("location");
    assert.strictEqual(
      locationHeader,
      null,
      `Public route '${route}' must not have a Location redirect header`
    );

    console.log(`  -> [PASS-LOCAL] Public route '${route}' returned HTTP 200`);
  }

  // ---------------------------------------------------------------------------
  // TEST 3: Expired Session Handling & Redirect Loop Prevention
  // ---------------------------------------------------------------------------
  console.log("\nTest 3: Verifying expired sessions do not trigger infinite redirect loops...");

  // Request to /dashboard with an invalid/expired cookie must redirect to /login
  const expiredReq = new NextRequest("http://localhost:3000/dashboard", {
    headers: {
      cookie: "sb-szakevhxhwpeskidvtfs-auth-token=expired-invalid-token; Path=/;",
    },
  });
  const expiredRes = await middleware(expiredReq);
  assert.strictEqual(expiredRes.status, 307, "Expired session on /dashboard must redirect to /login");
  const expiredLocation = expiredRes.headers.get("location") || "";
  assert.ok(expiredLocation.includes("/login?returnTo=%2Fdashboard"), "Redirect location must contain /login?returnTo=%2Fdashboard");

  // Request to /login with that same expired cookie must NOT redirect (must return HTTP 200)
  const loginWithExpiredReq = new NextRequest("http://localhost:3000/login?returnTo=%2Fdashboard", {
    headers: {
      cookie: "sb-szakevhxhwpeskidvtfs-auth-token=expired-invalid-token; Path=/;",
    },
  });
  const loginRes = await middleware(loginWithExpiredReq);
  assert.strictEqual(loginRes.status, 200, "Request to /login with expired token must return HTTP 200 (no loop)");
  assert.strictEqual(loginRes.headers.get("location"), null, "/login must never redirect to itself");
  console.log("  -> [PASS-LOCAL] Expired session correctly routed to /login without redirect loop.");

  // ---------------------------------------------------------------------------
  // TEST 4: Return-To Parameter & Open Redirect Attack Mitigation
  // ---------------------------------------------------------------------------
  console.log("\nTest 4: Verifying return-to parameter sanitization and open redirect protection...");

  const safeReturnCases = [
    { input: "/dashboard", expected: "/dashboard" },
    { input: "/jobs", expected: "/jobs" },
    { input: "/jobs?search=frontend&location=Remote", expected: "/jobs?search=frontend&location=Remote" },
    { input: "/tracker", expected: "/tracker" },
    { input: "/resume", expected: "/resume" },
    { input: "/profile", expected: "/profile" },
    { input: "/radar", expected: "/radar" },
    { input: "/pricing", expected: "/pricing" },
    { input: "/settings", expected: "/settings" },
  ];

  for (const sc of safeReturnCases) {
    const validated = getValidReturnUrl(sc.input, "/dashboard");
    assert.strictEqual(
      validated,
      sc.expected,
      `Safe relative URL '${sc.input}' must be preserved`
    );
  }
  console.log("  -> [PASS-LOCAL] All legitimate internal relative paths safely preserved.");

  const openRedirectAttacks = [
    "https://evil.com",
    "http://evil.com/login",
    "//evil.com",
    "//evil.com/dashboard",
    "//careermonke.com@evil.com",
    "/\\evil.com",
    "\\evil.com",
    "\\/evil.com",
    "javascript:alert(document.cookie)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "/%2fevil.com",
    "/%5cevil.com",
    "///evil.com",
    "https://careermonke.com.attacker.com",
    "ftp://evil.com/payload",
    "",
    "   ",
    null as any,
    undefined as any,
    // Loop prevention targets
    "/login",
    "/login?returnTo=/dashboard",
    "/signup",
    "/auth/callback",
    // ASCII control character injection attacks (codes 0 to 31 and 127 in raw or percent-encoded forms)
    "/%09/evil.com", // Exact user specification: encoded tab
    "/%00/evil.com",
    "/%0a/evil.com",
    "/%0d/evil.com",
    "/%1f/evil.com",
    "/%7f/evil.com",
    "/%7F/evil.com",
    "/%2509/evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "/\r/evil.com",
    "/\x00/evil.com",
    "/\x1f/evil.com",
    "/\x7f/evil.com",
    "/dashboard\x00extra",
    "/jobs%09",
    "/resume%0a",
    "/tracker%0d",
  ];

  for (const attack of openRedirectAttacks) {
    const validated = getValidReturnUrl(attack, "/dashboard");
    assert.strictEqual(
      validated,
      "/dashboard",
      `Attack string '${String(attack)}' must be rejected and fallback to '/dashboard', got '${validated}'`
    );
  }
  console.log(`  -> [PASS-LOCAL] All ${openRedirectAttacks.length} open redirect attack vectors neutralized and defaulted to safe fallback.`);

  // ---------------------------------------------------------------------------
  // TEST 4b: Exhaustive ASCII Control Character Rejection (Codes 0-31 and 127)
  // ---------------------------------------------------------------------------
  console.log("\nTest 4b: Exhaustive ASCII control character rejection (codes 0-31 and 127, raw & decoded)...");

  // Verify codes 0 to 31
  for (let code = 0; code <= 31; code++) {
    const hexLower = code.toString(16).padStart(2, "0");
    const hexUpper = hexLower.toUpperCase();
    const rawChar = String.fromCharCode(code);

    // 1. Raw control character embedded in path
    const rawTarget = `/${rawChar}/evil.com`;
    const resRaw = getValidReturnUrl(rawTarget, "/dashboard");
    assert.strictEqual(
      resRaw,
      "/dashboard",
      `Raw ASCII control code ${code} (${JSON.stringify(rawChar)}) must be rejected and return '/dashboard', got '${resRaw}'`
    );

    // 2. Percent-encoded lowercase
    const encodedLower = `/%${hexLower}/evil.com`;
    const resLower = getValidReturnUrl(encodedLower, "/dashboard");
    assert.strictEqual(
      resLower,
      "/dashboard",
      `Percent-encoded ASCII control code %${hexLower} must be rejected and return '/dashboard', got '${resLower}'`
    );

    // 3. Percent-encoded uppercase
    const encodedUpper = `/%${hexUpper}/evil.com`;
    const resUpper = getValidReturnUrl(encodedUpper, "/dashboard");
    assert.strictEqual(
      resUpper,
      "/dashboard",
      `Percent-encoded ASCII control code %${hexUpper} must be rejected and return '/dashboard', got '${resUpper}'`
    );
  }

  // Verify code 127 (DEL)
  const delRaw = String.fromCharCode(127);
  assert.strictEqual(getValidReturnUrl(`/${delRaw}/evil.com`, "/dashboard"), "/dashboard", "Raw DEL (127) must be rejected");
  assert.strictEqual(getValidReturnUrl("/%7f/evil.com", "/dashboard"), "/dashboard", "Encoded %7f (127) must be rejected");
  assert.strictEqual(getValidReturnUrl("/%7F/evil.com", "/dashboard"), "/dashboard", "Encoded %7F (127) must be rejected");
  assert.strictEqual(getValidReturnUrl("/%2509/evil.com", "/dashboard"), "/dashboard", "Double-encoded tab %2509 must be rejected");
  console.log("  -> [PASS-LOCAL] All 33 ASCII control character codes (0-31, 127) verified rejected across raw and decoded forms.");

  // ---------------------------------------------------------------------------
  // TEST 5: No Fake or LocalStorage Login Flags
  // ---------------------------------------------------------------------------
  console.log("\nTest 5: Verifying no fake or localStorage login flags exist in production source code...");

  const srcDir = path.resolve(process.cwd(), "src");
  function scanFiles(dir: string, fileList: string[] = []): string[] {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const fullPath = path.join(dir, f);
      if (fs.statSync(fullPath).isDirectory()) {
        scanFiles(fullPath, fileList);
      } else if (f.endsWith(".ts") || f.endsWith(".tsx")) {
        fileList.push(fullPath);
      }
    }
    return fileList;
  }

  const allSrcFiles = scanFiles(srcDir);
  for (const file of allSrcFiles) {
    const content = fs.readFileSync(file, "utf8");
    assert.ok(
      !content.includes('localStorage.getItem("careermonke_auth_user")'),
      `File ${file} contains disallowed fake login flag 'localStorage.getItem("careermonke_auth_user")'`
    );
  }
  console.log("  -> [PASS-LOCAL] Verified 0 instances of 'careermonke_auth_user' across all src/ files.");

  console.log("\n================================================================================");
  console.log("            ALL AUTH GUARD & OPEN REDIRECT TESTS PASSED (PASS-LOCAL)            ");
  console.log("================================================================================");
}

runAuthGuardSuite().catch((err) => {
  console.error("\n[FAIL] Auth Guard Test Suite Error:\n", err);
  process.exit(1);
});
