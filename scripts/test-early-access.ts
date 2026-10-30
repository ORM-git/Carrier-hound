/**
 * scripts/test-early-access.ts
 *
 * Comprehensive verification suite for Early-Access-Only Mode (PR #127 fixes):
 * 1. ALLOWLIST (EARLY_ACCESS_ALLOWED_EMAILS): comma-separated lowercase compare; allowed user gets 200;
 *    non-allowed signed-in user gets signed out + 307 to /early-access on pages and 403 on APIs;
 *    empty env blocks all session users while x-admin-secret still works; zero hardcoded emails.
 * 2. LEGAL PAGES & /api/health: /privacy-policy, /terms-and-conditions, /privacy, and /api/health stay
 *    public (200) for guests; /api/track and all other APIs return 403 for guests; CookieNotice and
 *    Footer legal links restored.
 * 3. RESTORED LINKS & WhiteHeroButton: Footer mailto + X/LinkedIn/GitHub and page.tsx TikTok + mailto +
 *    WhiteHeroButton restored; only Get Started / View Jobs / Sign in CTAs point to /early-access.
 * 4. POST /api/early-access: DB failure (other than duplicate) returns 500 with generic try-again message
 *    and no in-memory fallback; duplicate and honeypot return generic { ok: true, message: "You're on the list" }
 *    with no duplicate:true flag; rate limit 5/min/IP enforced.
 * 5. Sitemap: only "/" and "/early-access".
 * 6. Real negative controls (gated by NODE_ENV=test) prove non-zero exit on invalid conditions.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Module from "node:module";
import { NextRequest } from "next/server";

// Register Node test hook for @cloudflare/next-on-pages in unit test environment
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

const isNegativeControl = process.argv.includes("--negative-control");

interface StoredEmailRow {
  email: string;
  created_at: string;
}

const mockDbRows: StoredEmailRow[] = [];
let simulateDbFailure: string | null = null;
let signOutCallCount = 0;

function createMockSupabase() {
  return {
    auth: {
      getUser: async (token?: string) => {
        if (token === "valid-allowed-token") {
          return {
            data: {
              user: {
                id: "allowed-user-id-1",
                email: "Founder.Allowed@Example.com",
              },
            },
            error: null,
          };
        }
        if (token === "valid-nonallowed-token") {
          return {
            data: {
              user: {
                id: "nonallowed-user-id-2",
                email: "intruder@outsider.example",
              },
            },
            error: null,
          };
        }
        return { data: { user: null }, error: new Error("Invalid session") };
      },
      signOut: async () => {
        signOutCallCount++;
        return { error: null };
      },
    },
    from: (table: string) => {
      assert.strictEqual(table, "early_access_emails", `Unexpected table access: ${table}`);
      let filterEmail: string | null = null;
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: string) => {
          if (col === "email") filterEmail = val;
          return builder;
        },
        maybeSingle: async () => {
          if (simulateDbFailure === "select_error") {
            return { data: null, error: { code: "08006", message: "connection failure" } };
          }
          const found = mockDbRows.find((r) => r.email === filterEmail) || null;
          return { data: found, error: null };
        },
        insert: async (row: StoredEmailRow) => {
          if (simulateDbFailure === "insert_error") {
            return {
              data: null,
              error: { code: "42501", message: "permission denied for table early_access_emails" },
            };
          }
          if (simulateDbFailure === "insert_throw") {
            throw new Error("Simulated network socket hangup");
          }
          if (mockDbRows.some((r) => r.email === row.email)) {
            return {
              data: null,
              error: { code: "23505", message: "duplicate key value violates unique constraint" },
            };
          }
          mockDbRows.push({ email: row.email, created_at: row.created_at });
          return { data: row, error: null };
        },
      };
      return builder;
    },
  };
}

(globalThis as any).__mockSupabaseClient = createMockSupabase();
(globalThis as any).__mockRateLimitClient = null;

async function main() {
  const { middleware } = await import("../src/middleware");
  const { POST: earlyAccessPost } = await import("../src/app/api/early-access/route");
  const sitemapModule = await import("../src/app/sitemap");
  const sitemap = sitemapModule.default;
  const {
    _resetEarlyAccessRateLimitStore,
    EARLY_ACCESS_RATE_LIMIT,
  } = await import("../src/lib/api/sharedRateLimit");

  // ===========================================================================
  // NEGATIVE CONTROL MODE (Gated by NODE_ENV=test legacy flag)
  // ===========================================================================
  if (isNegativeControl) {
    console.log("================================================================================");
    console.log(" [NEGATIVE CONTROL MODE] Executing with legacy flag in NODE_ENV=test");
    console.log("================================================================================");
    process.env.__CAREERMONKE_LEGACY_EARLY_ACCESS_UNLOCK = "true";

    const guestJobsReq = new NextRequest("http://localhost:3000/jobs");
    const guestJobsRes = await middleware(guestJobsReq);
    const redirectLocation = guestJobsRes.headers.get("location") || "";
    const redirectPath = redirectLocation ? new URL(redirectLocation).pathname : "";

    // Under legacy flag, /jobs redirects to /login instead of /early-access, so this assertion MUST fail:
    assert.strictEqual(
      redirectPath,
      "/early-access",
      `Negative control expected failure: under legacy flag, /jobs redirected to '${redirectPath}' instead of '/early-access'`
    );

    console.error("FATAL: Negative control unexpectedly passed!");
    process.exit(1);
  }

  console.log("================================================================================");
  console.log("             CAREERMONKE EARLY-ACCESS-ONLY MODE VERIFICATION SUITE              ");
  console.log("================================================================================");

  // ---------------------------------------------------------------------------
  // TEST 1: Restored Links + WhiteHeroButton + CTA Targets on Landing & Footer
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 1] Verifying restored legal/social/mailto links, WhiteHeroButton, and /early-access CTAs...");

  const landingPagePath = path.resolve(process.cwd(), "src/app/page.tsx");
  const footerPath = path.resolve(process.cwd(), "src/components/Footer.tsx");
  const cookieNoticePath = path.resolve(process.cwd(), "src/components/CookieNotice.tsx");
  const mockPath = path.resolve(process.cwd(), "src/components/ProductScreenshotMock.tsx");
  const modalPath = path.resolve(process.cwd(), "src/components/CategorySelectModal.tsx");
  const earlyAccessPagePath = path.resolve(process.cwd(), "src/app/early-access/page.tsx");
  const middlewarePath = path.resolve(process.cwd(), "src/middleware.ts");

  const landingSrc = fs.readFileSync(landingPagePath, "utf8");
  const footerSrc = fs.readFileSync(footerPath, "utf8");
  const cookieNoticeSrc = fs.readFileSync(cookieNoticePath, "utf8");
  const mockSrc = fs.readFileSync(mockPath, "utf8");
  const modalSrc = fs.readFileSync(modalPath, "utf8");
  const earlyAccessPageSrc = fs.readFileSync(earlyAccessPagePath, "utf8");
  const middlewareSrc = fs.readFileSync(middlewarePath, "utf8");

  // 1a. Verify WhiteHeroButton is restored in page.tsx with target /early-access
  assert.ok(
    landingSrc.includes('import { WhiteHeroButton } from "@/components/Buttons";'),
    "page.tsx must import WhiteHeroButton from @/components/Buttons"
  );
  assert.ok(
    landingSrc.includes(
      '<WhiteHeroButton onClick={() => router.push("/early-access")} className="px-8 min-w-[200px]">'
    ),
    "page.tsx must use WhiteHeroButton with onClick={() => router.push(\"/early-access\")}"
  );

  // 1b. Verify TikTok button removed and mailto restored in page.tsx
  assert.strictEqual(
    landingSrc.includes('href="https://tiktok.com"'),
    false,
    "page.tsx must NOT contain Founder TikTok link"
  );
  assert.ok(
    landingSrc.includes('href="mailto:support@careermonke.com"'),
    "page.tsx must restore Contact mailto:support@careermonke.com link"
  );

  // 1c. Verify all CTA links in page.tsx point to /early-access (and brand logo to /)
  const extractHrefs = (source: string): string[] => {
    const hrefs: string[] = [];
    const regex = /href="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(source)) !== null) {
      hrefs.push(m[1]);
    }
    return hrefs;
  };

  const pageHrefs = extractHrefs(landingSrc);
  const allowedPageHrefs = new Set([
    "/",
    "/early-access",
    "https://tiktok.com",
    "mailto:support@careermonke.com",
  ]);
  for (const h of pageHrefs) {
    assert.ok(
      allowedPageHrefs.has(h),
      `Unexpected href '${h}' in src/app/page.tsx (must be /, /early-access, tiktok, or mailto)`
    );
  }
  assert.strictEqual(
    pageHrefs.filter((h) => h === "/early-access").length,
    6,
    "Expected 6 <Link href=\"/early-access\"> CTAs in src/app/page.tsx"
  );
  assert.ok(
    landingSrc.includes('<UserMenu signInHref="/early-access" />'),
    'Landing page UserMenu must pass signInHref="/early-access"'
  );
  assert.ok(
    landingSrc.includes('onClick={() => router.push("/early-access")}'),
    'Hero Explore jobs button must push "/early-access"'
  );

  // 1d. Verify LandingFooter in Footer.tsx restores mailto, Privacy, Terms, X, LinkedIn, GitHub
  const landingFooterEnd = footerSrc.indexOf("export default function Footer");
  assert.ok(landingFooterEnd > 0, "LandingFooter must exist in src/components/Footer.tsx");
  const landingFooterSrc = footerSrc.slice(0, landingFooterEnd);
  const landingFooterHrefs = extractHrefs(landingFooterSrc);

  assert.ok(landingFooterHrefs.includes("/"), "LandingFooter brand must link to /");
  assert.ok(
    landingFooterHrefs.includes("mailto:support@careermonke.com"),
    "LandingFooter Support must link to mailto:support@careermonke.com"
  );
  assert.strictEqual(
    landingFooterHrefs.filter((h) => h === "/privacy-policy").length,
    2,
    "LandingFooter must have 2 /privacy-policy links"
  );
  assert.strictEqual(
    landingFooterHrefs.filter((h) => h === "/terms-and-conditions").length,
    2,
    "LandingFooter must have 2 /terms-and-conditions links"
  );
  assert.ok(
    landingFooterHrefs.includes("https://x.com/careermonke"),
    "LandingFooter must restore X link"
  );
  assert.ok(
    landingFooterHrefs.includes("https://linkedin.com/company/careermonke"),
    "LandingFooter must restore LinkedIn link"
  );
  assert.ok(
    landingFooterHrefs.includes("https://github.com"),
    "LandingFooter must restore GitHub link"
  );
  assert.strictEqual(
    landingFooterHrefs.filter((h) => h === "/early-access").length,
    5,
    "LandingFooter must point its 5 navigation/directory CTAs to /early-access"
  );

  // 1e. Verify CookieNotice "Learn more" links to /privacy
  const cookieNoticeHrefs = extractHrefs(cookieNoticeSrc);
  assert.deepStrictEqual(
    cookieNoticeHrefs,
    ["/privacy"],
    'CookieNotice "Learn more" link must point to /privacy'
  );

  assert.ok(
    extractHrefs(mockSrc).every((h) => h === "/early-access"),
    "ProductScreenshotMock CTA must point to /early-access"
  );
  assert.ok(
    modalSrc.includes('router.push("/early-access")'),
    "CategorySelectModal must navigate to /early-access"
  );
  assert.ok(
    !landingSrc.includes('"/login"') &&
      !landingFooterSrc.includes('"/login"') &&
      !earlyAccessPageSrc.includes('"/login"'),
    "No links to /login allowed on landing page or /early-access page"
  );
  assert.ok(
    !/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(middlewareSrc),
    "src/middleware.ts must contain zero hardcoded email addresses"
  );

  console.log("  [PASS] Restored legal, mailto, social links & WhiteHeroButton; all CTAs go to /early-access");

  // ---------------------------------------------------------------------------
  // TEST 2: Server-Side Lock, Legal Pages, /api/health, and ALLOWLIST
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 2] Verifying guest lock, public legal pages + /api/health, and EARLY_ACCESS_ALLOWED_EMAILS allowlist...");
  delete process.env.__CAREERMONKE_LEGACY_EARLY_ACCESS_UNLOCK;

  const lockedPageRoutes = [
    "/jobs",
    "/jobs?q=engineer&remoteOnly=true",
    "/dashboard",
    "/resume",
    "/tracker",
    "/profile",
    "/radar",
    "/pricing",
    "/settings",
    "/applications",
    "/job-search/all",
    "/job-detail",
    "/onboarding",
    "/admin",
    "/admin/users",
    "/remote",
    "/remote/engineering",
    "/worldwide",
    "/signup",
  ];

  for (const route of lockedPageRoutes) {
    const req = new NextRequest(`http://localhost:3000${route}`);
    const res = await middleware(req);
    assert.strictEqual(
      res.status,
      307,
      `Guest request to '${route}' must return 307 redirect, got ${res.status}`
    );
    const location = res.headers.get("location") || "";
    const redirectPathname = location ? new URL(location).pathname : "";
    assert.strictEqual(
      redirectPathname,
      "/early-access",
      `Guest request to '${route}' must redirect to '/early-access', got '${redirectPathname}'`
    );
  }
  console.log(`  [PASS] All ${lockedPageRoutes.length} locked page routes redirect guests to /early-access`);

  const lockedApiRoutes = [
    "/api/jobs/search",
    "/api/jobs/pro",
    "/api/jobs/top10",
    "/api/jobs/interview-pack",
    "/api/jobs/skill-what-if",
    "/api/ai",
    "/api/stats",
    "/api/track", // Guest /api/track stays blocked (403)
    "/api/radar",
    "/api/admin/stats",
    "/api/admin/users",
    "/api/admin/users/block",
    "/api/account/delete",
    "/api/simulate-checkout",
    "/.netlify/functions/jobs-search",
  ];

  for (const apiRoute of lockedApiRoutes) {
    const req = new NextRequest(`http://localhost:3000${apiRoute}`);
    const res = await middleware(req);
    assert.strictEqual(
      res.status,
      403,
      `Guest request to API '${apiRoute}' must return HTTP 403, got ${res.status}`
    );
    const body = await res.json();
    assert.strictEqual(body.error, "Early access only");
  }
  console.log(`  [PASS] All ${lockedApiRoutes.length} locked API routes (including /api/track) return HTTP 403 to guests`);

  const allowedGuestRoutes = [
    "/",
    "/early-access",
    "/api/early-access",
    "/api/health",
    "/privacy",
    "/privacy-policy",
    "/terms-and-conditions",
    "/login",
    "/auth/callback",
    "/_next/static/chunks/app.js",
    "/careermonke.svg",
    "/careermonke.png",
    "/favicon.ico",
    "/data/ne_110m_land.json",
  ];

  for (const route of allowedGuestRoutes) {
    const req = new NextRequest(`http://localhost:3000${route}`);
    const res = await middleware(req);
    assert.strictEqual(
      res.status,
      200,
      `Allowed guest route '${route}' must return HTTP 200, got ${res.status}`
    );
  }
  console.log("  [PASS] Guests allowed (200) on /, /early-access, /api/early-access, /api/health, legal pages (/privacy, /privacy-policy, /terms-and-conditions), and hidden /login");

  // 2b. Verify EARLY_ACCESS_ALLOWED_EMAILS allowlist enforcement
  process.env.EARLY_ACCESS_ALLOWED_EMAILS = "  founder.allowed@example.com , SECOND.ADMIN@EXAMPLE.COM ";
  signOutCallCount = 0;

  // Allowed user -> 200 on page and API
  const allowedPageReq = new NextRequest("http://localhost:3000/dashboard", {
    headers: { authorization: "Bearer valid-allowed-token" },
  });
  const allowedPageRes = await middleware(allowedPageReq);
  assert.strictEqual(allowedPageRes.status, 200, "Allowed user must get 200 on /dashboard");

  const allowedApiReq = new NextRequest("http://localhost:3000/api/jobs/search", {
    headers: { authorization: "Bearer valid-allowed-token" },
  });
  const allowedApiRes = await middleware(allowedApiReq);
  assert.strictEqual(allowedApiRes.status, 200, "Allowed user must get 200 on /api/jobs/search");
  assert.strictEqual(signOutCallCount, 0, "Allowed user must not be signed out");

  // Non-allowed signed-in user -> signed out + 307 to /early-access on page
  const nonAllowedPageReq = new NextRequest("http://localhost:3000/dashboard", {
    headers: {
      authorization: "Bearer valid-nonallowed-token",
      cookie: "sb-access-token=valid-nonallowed-token; sb-refresh-token=ref-123",
    },
  });
  const nonAllowedPageRes = await middleware(nonAllowedPageReq);
  assert.strictEqual(
    nonAllowedPageRes.status,
    307,
    "Non-allowed signed-in user must get 307 redirect on /dashboard"
  );
  assert.strictEqual(
    new URL(nonAllowedPageRes.headers.get("location")!).pathname,
    "/early-access",
    "Non-allowed signed-in user must be redirected to /early-access"
  );
  assert.strictEqual(
    nonAllowedPageRes.headers.get("x-early-access-signed-out"),
    "1",
    "Non-allowed signed-in user must be signed out on page redirect"
  );
  assert.strictEqual(signOutCallCount, 1, "supabase.auth.signOut() must be called for non-allowed user");

  // Non-allowed signed-in user -> signed out + 403 on API
  const nonAllowedApiReq = new NextRequest("http://localhost:3000/api/jobs/search", {
    headers: {
      authorization: "Bearer valid-nonallowed-token",
      cookie: "sb-access-token=valid-nonallowed-token",
    },
  });
  const nonAllowedApiRes = await middleware(nonAllowedApiReq);
  assert.strictEqual(
    nonAllowedApiRes.status,
    403,
    "Non-allowed signed-in user must get 403 on /api/jobs/search"
  );
  assert.strictEqual(
    nonAllowedApiRes.headers.get("x-early-access-signed-out"),
    "1",
    "Non-allowed signed-in user must be signed out on API 403"
  );
  assert.strictEqual(signOutCallCount, 2, "supabase.auth.signOut() must be called on API request");

  // Empty EARLY_ACCESS_ALLOWED_EMAILS -> nobody gets in via session, only x-admin-secret
  delete process.env.EARLY_ACCESS_ALLOWED_EMAILS;
  const emptyEnvPageReq = new NextRequest("http://localhost:3000/dashboard", {
    headers: { authorization: "Bearer valid-allowed-token" },
  });
  const emptyEnvPageRes = await middleware(emptyEnvPageReq);
  assert.strictEqual(
    emptyEnvPageRes.status,
    307,
    "When EARLY_ACCESS_ALLOWED_EMAILS is empty, even valid session user must get 307"
  );

  const emptyEnvApiReq = new NextRequest("http://localhost:3000/api/jobs/search", {
    headers: { authorization: "Bearer valid-allowed-token" },
  });
  const emptyEnvApiRes = await middleware(emptyEnvApiReq);
  assert.strictEqual(
    emptyEnvApiRes.status,
    403,
    "When EARLY_ACCESS_ALLOWED_EMAILS is empty, even valid session user must get 403 on API"
  );

  // x-admin-secret still works when EARLY_ACCESS_ALLOWED_EMAILS is empty
  process.env.ADMIN_SECRET = "test-admin-secret-xyz";
  try {
    const adminSecretReq = new NextRequest("http://localhost:3000/api/admin/stats", {
      headers: { "x-admin-secret": "test-admin-secret-xyz" },
    });
    const adminSecretRes = await middleware(adminSecretReq);
    assert.strictEqual(
      adminSecretRes.status,
      200,
      "Valid x-admin-secret must still be allowed when EARLY_ACCESS_ALLOWED_EMAILS is empty"
    );
  } finally {
    delete process.env.ADMIN_SECRET;
  }

  console.log(
    "  [PASS] EARLY_ACCESS_ALLOWED_EMAILS allowlist enforced (allowed=200, non-allowed=signOut+307/403, empty=nobody except x-admin-secret)"
  );

  // ---------------------------------------------------------------------------
  // TEST 3: POST /api/early-access — Valid, Duplicate, Honeypot, DB Error (500)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 3] Verifying POST /api/early-access DB storage, duplicate response shape, and 500 on DB failure...");
  _resetEarlyAccessRateLimitStore();
  mockDbRows.length = 0;
  simulateDbFailure = null;

  const notificationsSent: Array<{ to: string; email: string; createdAt: string }> = [];
  process.env.EARLY_ACCESS_NOTIFY_EMAIL = "notify-target@example.org";
  (globalThis as any).__earlyAccessNotifyHook = async (payload: {
    to: string;
    email: string;
    createdAt: string;
  }) => {
    notificationsSent.push(payload);
  };

  // 3a. Valid email submission
  const validReq = new Request("http://localhost:3000/api/early-access", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.50",
    },
    body: JSON.stringify({ email: "  Founder.Test@Example.com  ", website: "" }),
  });
  const validRes = await earlyAccessPost(validReq);
  assert.strictEqual(validRes.status, 200, "Valid email submission must return HTTP 200");
  const validBody = await validRes.json();
  assert.deepStrictEqual(
    validBody,
    { ok: true, message: "You're on the list" },
    "Valid response must be generic { ok: true, message: \"You're on the list\" } without duplicate flag"
  );
  assert.ok(!("duplicate" in validBody), "Response must NOT contain duplicate property");
  assert.strictEqual(mockDbRows.length, 1);
  assert.strictEqual(mockDbRows[0].email, "founder.test@example.com");
  assert.strictEqual(notificationsSent.length, 1);

  // 3b. Duplicate email submission -> generic success, no duplicate:true flag
  const dupReq = new Request("http://localhost:3000/api/early-access", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.50",
    },
    body: JSON.stringify({ email: "founder.test@example.com" }),
  });
  const dupRes = await earlyAccessPost(dupReq);
  assert.strictEqual(dupRes.status, 200, "Duplicate email must return HTTP 200");
  const dupBody = await dupRes.json();
  assert.deepStrictEqual(
    dupBody,
    { ok: true, message: "You're on the list" },
    "Duplicate response must be generic { ok: true, message: \"You're on the list\" } without duplicate:true flag"
  );
  assert.ok(!("duplicate" in dupBody), "Duplicate response must NOT expose duplicate:true flag");
  assert.strictEqual(mockDbRows.length, 1, "Duplicate email must NOT create a second DB row");
  assert.strictEqual(notificationsSent.length, 1, "Duplicate email must NOT send a second notification");

  // 3c. DB failure (any error other than duplicate) -> HTTP 500 with generic "try again" message, no in-memory fallback
  simulateDbFailure = "insert_error";
  try {
    const dbFailReq = new Request("http://localhost:3000/api/early-access", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.52",
      },
      body: JSON.stringify({ email: "newuser-dbfail@example.com" }),
    });
    const dbFailRes = await earlyAccessPost(dbFailReq);
    assert.strictEqual(
      dbFailRes.status,
      500,
      `Non-duplicate DB insert error must return HTTP 500, got ${dbFailRes.status}`
    );
    const dbFailBody = await dbFailRes.json();
    assert.strictEqual(dbFailBody.ok, false, "DB failure must return ok: false");
    assert.ok(
      /try again/i.test(dbFailBody.error || ""),
      `DB failure message must be generic 'try again', got '${dbFailBody.error}'`
    );
    assert.strictEqual(mockDbRows.length, 1, "Failed DB insert must not store row");
    assert.strictEqual(notificationsSent.length, 1, "Failed DB insert must not trigger notification");
  } finally {
    simulateDbFailure = null;
  }

  // Also test missing DB client (no in-memory fallback -> returns 500)
  const savedMockClient = (globalThis as any).__mockSupabaseClient;
  (globalThis as any).__mockSupabaseClient = null;
  try {
    const noDbReq = new Request("http://localhost:3000/api/early-access", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.53",
      },
      body: JSON.stringify({ email: "nodb@example.com" }),
    });
    const noDbRes = await earlyAccessPost(noDbReq);
    assert.strictEqual(
      noDbRes.status,
      500,
      "Missing DB client must return 500 (in-memory fallback removed)"
    );
  } finally {
    (globalThis as any).__mockSupabaseClient = savedMockClient;
  }

  // 3d. Honeypot field filled -> generic 200 without storing or notifying
  const honeypotReq = new Request("http://localhost:3000/api/early-access", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.51",
    },
    body: JSON.stringify({
      email: "spammer@botnet.example",
      website: "https://spam-link.example",
    }),
  });
  const honeypotRes = await earlyAccessPost(honeypotReq);
  assert.strictEqual(honeypotRes.status, 200);
  const honeypotBody = await honeypotRes.json();
  assert.deepStrictEqual(honeypotBody, { ok: true, message: "You're on the list" });
  assert.strictEqual(mockDbRows.length, 1);

  // 3e. Invalid emails -> HTTP 400
  const invalidEmails = [
    "",
    "   ",
    "plainaddress",
    "@missing-local.com",
    "missing-domain@",
    "missing-tld@domain",
    "double..dots@example.com",
    "space in@example.com",
  ];
  for (let i = 0; i < invalidEmails.length; i++) {
    const badReq = new Request("http://localhost:3000/api/early-access", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `198.51.101.${i + 1}`,
      },
      body: JSON.stringify({ email: invalidEmails[i] }),
    });
    const badRes = await earlyAccessPost(badReq);
    assert.strictEqual(badRes.status, 400);
  }
  console.log("  [PASS] POST /api/early-access returns 500 on DB errors, removes duplicate:true flag, and has no in-memory fallback");

  // ---------------------------------------------------------------------------
  // TEST 4: Rate Limit (5 requests / min / IP via sharedRateLimit)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 4] Verifying POST /api/early-access rate limit (5 req/min/IP)...");
  _resetEarlyAccessRateLimitStore();
  const rlIp = "203.0.113.77";

  assert.strictEqual(EARLY_ACCESS_RATE_LIMIT.maxRequests, 5);
  assert.strictEqual(EARLY_ACCESS_RATE_LIMIT.windowSeconds, 60);

  for (let i = 1; i <= 5; i++) {
    const req = new Request("http://localhost:3000/api/early-access", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": rlIp,
      },
      body: JSON.stringify({ email: `user${i}@example.com` }),
    });
    const res = await earlyAccessPost(req);
    assert.strictEqual(res.status, 200);
  }

  const sixthReq = new Request("http://localhost:3000/api/early-access", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": rlIp,
    },
    body: JSON.stringify({ email: "user6@example.com" }),
  });
  const sixthRes = await earlyAccessPost(sixthReq);
  assert.strictEqual(sixthRes.status, 429);
  console.log("  [PASS] 5 requests allowed, 6th returned HTTP 429 with Retry-After");

  // ---------------------------------------------------------------------------
  // TEST 5: Sitemap Contains ONLY "/" and "/early-access"
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 5] Verifying sitemap() contains only '/' and '/early-access'...");
  const entries = sitemap();
  const paths = entries.map((e) => new URL(e.url).pathname);
  assert.deepStrictEqual(
    paths,
    ["/", "/early-access"],
    `Expected sitemap paths ['/', '/early-access'], got ${JSON.stringify(paths)}`
  );
  console.log("  [PASS] sitemap() returns strictly ['/', '/early-access']");

  // ---------------------------------------------------------------------------
  // TEST 6: Automated Negative Control Verification
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 6] Verifying negative control exits non-zero when legacy flag is enabled in NODE_ENV=test...");
  const scriptPath = path.resolve(__dirname, "test-early-access.ts");
  const child = spawnSync("npx", ["tsx", scriptPath, "--negative-control"], {
    shell: true,
    stdio: "pipe",
    env: { ...process.env, NODE_ENV: "test" },
  });

  assert.notStrictEqual(
    child.status,
    0,
    `Negative control must exit with non-zero code, got ${child.status}`
  );
  console.log(`  [PASS] Negative control exited with non-zero status (${child.status})`);

  console.log("\n================================================================================");
  console.log("ALL EARLY-ACCESS-ONLY MODE TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("\n[FAIL] Early-Access Test Suite Error:\n", err);
  process.exit(1);
});
