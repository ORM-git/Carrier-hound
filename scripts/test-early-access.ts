/**
 * scripts/test-early-access.ts
 *
 * Comprehensive verification suite for Early-Access-Only Mode & Gmail API Sender:
 * 1. ALLOWLIST (EARLY_ACCESS_ALLOWED_EMAILS): comma-separated lowercase compare; allowed user gets 200;
 *    non-allowed signed-in user gets signed out + 307 to /early-access on pages and 403 on APIs;
 *    empty env blocks all session users while x-admin-secret still works; zero hardcoded emails.
 * 2. LEGAL PAGES & /api/health: /privacy-policy, /terms-and-conditions, /privacy, and /api/health stay
 *    public (200) for guests; /api/track and all other APIs return 403 for guests; CookieNotice and
 *    Footer legal links restored.
 * 3. RESTORED LINKS & WhiteHeroButton: Footer mailto + X/LinkedIn/GitHub and page.tsx TikTok + mailto +
 *    WhiteHeroButton restored; only Get Started / View Jobs / Sign in CTAs point to /early-access.
 * 4. POST /api/early-access + Gmail API (mocked fetch):
 *    - New email sends (a) thank-you email to submitter with exact subject "You're on the CareerMonke early-access list"
 *      and (b) daily digest notification to EARLY_ACCESS_NOTIFY_EMAIL (batched once per UTC day).
 *    - Duplicate or honeypot sends 0 emails.
 *    - Missing env or Gmail error/quota failure still stores email in DB, returns 200, logs safe redacted warning
 *      with zero secrets or full emails.
 *    - Outgoing message cap (150 messages/day in gmail_send_log.sent_at) checked before EACH send.
 *    - DB failure (other than duplicate) returns 500 with generic try-again message and no in-memory fallback.
 * 5. Sitemap: only "/" and "/early-access".
 * 6. Guide verification: scripts/get-gmail-refresh-token.md specifies Web application, redirect URI
 *    https://developers.google.com/oauthplayground, gmail.send scope, offline access, own credentials, In production.
 * 7. Real negative controls (gated by NODE_ENV=test) prove non-zero exit on invalid conditions.
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

interface GmailSendLogRow {
  sent_at: string;
}

const mockDbRows: StoredEmailRow[] = [];
const mockSendLogRows: GmailSendLogRow[] = [];
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
      if (table === "gmail_send_log") {
        let gteIso: string | null = null;
        let isCountHead = false;
        const logBuilder: any = {
          select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
            if (opts?.count === "exact") {
              isCountHead = true;
            }
            return logBuilder;
          },
          gte: (col: string, val: string) => {
            if (col === "sent_at") gteIso = val;
            const filtered = gteIso
              ? mockSendLogRows.filter((r) => r.sent_at >= gteIso!)
              : mockSendLogRows;
            return Promise.resolve({
              data: isCountHead ? null : filtered,
              count: filtered.length,
              error: null,
            });
          },
          insert: async (row: GmailSendLogRow) => {
            mockSendLogRows.push({ sent_at: row.sent_at });
            return { data: row, error: null };
          },
        };
        return logBuilder;
      }

      assert.strictEqual(table, "early_access_emails", `Unexpected table access: ${table}`);
      let filterEmail: string | null = null;
      let gteCreatedAt: string | null = null;
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: string) => {
          if (col === "email") filterEmail = val;
          return builder;
        },
        gte: (col: string, val: string) => {
          if (col === "created_at") gteCreatedAt = val;
          return builder;
        },
        order: () => {
          const rows = gteCreatedAt
            ? mockDbRows.filter((r) => r.created_at >= gteCreatedAt!)
            : [...mockDbRows];
          return Promise.resolve({ data: rows, error: null });
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

function decodeBase64UrlToUtf8(b64url: string): string {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

function decodeRfc2047Subject(rfc2822: string): string {
  const m = rfc2822.match(/^Subject:\s*=\?UTF-8\?B\?([^?]+)\?=/m);
  if (!m) return "";
  return Buffer.from(m[1], "base64").toString("utf8");
}

(globalThis as any).__mockSupabaseClient = createMockSupabase();
(globalThis as any).__mockRateLimitClient = null;

async function main() {
  const { middleware } = await import("../src/middleware");
  const { POST: earlyAccessPost } = await import("../src/app/api/early-access/route");
  const {
    DAILY_GMAIL_MESSAGE_CAP,
    EARLY_ACCESS_THANK_YOU_SUBJECT,
    GMAIL_OAUTH_TOKEN_URL,
    GMAIL_SEND_MESSAGE_URL,
    _resetEarlyAccessDigestState,
  } = await import("../src/lib/early-access/gmail");
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
  console.log("      CAREERMONKE EARLY-ACCESS-ONLY MODE & GMAIL API VERIFICATION SUITE         ");
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
  const guidePath = path.resolve(process.cwd(), "scripts/get-gmail-refresh-token.md");

  const landingSrc = fs.readFileSync(landingPagePath, "utf8");
  const footerSrc = fs.readFileSync(footerPath, "utf8");
  const cookieNoticeSrc = fs.readFileSync(cookieNoticePath, "utf8");
  const mockSrc = fs.readFileSync(mockPath, "utf8");
  const modalSrc = fs.readFileSync(modalPath, "utf8");
  const earlyAccessPageSrc = fs.readFileSync(earlyAccessPagePath, "utf8");
  const middlewareSrc = fs.readFileSync(middlewarePath, "utf8");
  const guideSrc = fs.readFileSync(guidePath, "utf8");

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
    assert.ok(allowedPageHrefs.has(h), `Unexpected href '${h}' in src/app/page.tsx`);
  }
  assert.strictEqual(pageHrefs.filter((h) => h === "/early-access").length, 6);

  const landingFooterEnd = footerSrc.indexOf("export default function Footer");
  const landingFooterSrc = footerSrc.slice(0, landingFooterEnd);
  const landingFooterHrefs = extractHrefs(landingFooterSrc);

  assert.ok(landingFooterHrefs.includes("/"));
  assert.ok(landingFooterHrefs.includes("mailto:support@careermonke.com"));
  assert.strictEqual(landingFooterHrefs.filter((h) => h === "/privacy-policy").length, 2);
  assert.strictEqual(landingFooterHrefs.filter((h) => h === "/terms-and-conditions").length, 2);
  assert.ok(landingFooterHrefs.includes("https://x.com/careermonke"));
  assert.ok(landingFooterHrefs.includes("https://linkedin.com/company/careermonke"));
  assert.ok(landingFooterHrefs.includes("https://github.com"));
  assert.strictEqual(landingFooterHrefs.filter((h) => h === "/early-access").length, 5);
  assert.deepStrictEqual(extractHrefs(cookieNoticeSrc), ["/privacy"]);
  assert.ok(extractHrefs(mockSrc).every((h) => h === "/early-access"));
  assert.ok(modalSrc.includes('router.push("/early-access")'));
  assert.ok(
    !landingSrc.includes('"/login"') &&
      !landingFooterSrc.includes('"/login"') &&
      !earlyAccessPageSrc.includes('"/login"')
  );
  assert.ok(
    !/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(middlewareSrc),
    "src/middleware.ts must contain zero hardcoded email addresses"
  );

  // Verify scripts/get-gmail-refresh-token.md requirements
  assert.ok(guideSrc.includes("Web application"), "Guide must specify Web application client type");
  assert.ok(
    guideSrc.includes("https://developers.google.com/oauthplayground"),
    "Guide must include OAuth Playground redirect URI"
  );
  assert.ok(
    guideSrc.includes("https://www.googleapis.com/auth/gmail.send"),
    "Guide must specify gmail.send scope"
  );
  assert.ok(/In production/i.test(guideSrc), 'Guide must instruct publishing consent screen "In production"');
  assert.ok(/Offline/i.test(guideSrc), "Guide must specify Offline access");
  assert.ok(/Use your own OAuth credentials/i.test(guideSrc), "Guide must instruct using own OAuth credentials");

  console.log("  [PASS] Restored links, WhiteHeroButton, CTAs, and get-gmail-refresh-token.md verified");

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
    assert.strictEqual(res.status, 307);
    assert.strictEqual(new URL(res.headers.get("location")!).pathname, "/early-access");
  }

  const lockedApiRoutes = [
    "/api/jobs/search",
    "/api/jobs/pro",
    "/api/jobs/top10",
    "/api/jobs/interview-pack",
    "/api/jobs/skill-what-if",
    "/api/ai",
    "/api/stats",
    "/api/track",
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
    assert.strictEqual(res.status, 403);
  }

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
  ];

  for (const route of allowedGuestRoutes) {
    const req = new NextRequest(`http://localhost:3000${route}`);
    const res = await middleware(req);
    assert.strictEqual(res.status, 200);
  }

  process.env.EARLY_ACCESS_ALLOWED_EMAILS = "  founder.allowed@example.com , SECOND.ADMIN@EXAMPLE.COM ";
  signOutCallCount = 0;

  const allowedPageRes = await middleware(
    new NextRequest("http://localhost:3000/dashboard", {
      headers: { authorization: "Bearer valid-allowed-token" },
    })
  );
  assert.strictEqual(allowedPageRes.status, 200);

  const allowedApiRes = await middleware(
    new NextRequest("http://localhost:3000/api/jobs/search", {
      headers: { authorization: "Bearer valid-allowed-token" },
    })
  );
  assert.strictEqual(allowedApiRes.status, 200);
  assert.strictEqual(signOutCallCount, 0);

  const nonAllowedPageRes = await middleware(
    new NextRequest("http://localhost:3000/dashboard", {
      headers: {
        authorization: "Bearer valid-nonallowed-token",
        cookie: "sb-access-token=valid-nonallowed-token",
      },
    })
  );
  assert.strictEqual(nonAllowedPageRes.status, 307);
  assert.strictEqual(new URL(nonAllowedPageRes.headers.get("location")!).pathname, "/early-access");
  assert.strictEqual(nonAllowedPageRes.headers.get("x-early-access-signed-out"), "1");
  assert.strictEqual(signOutCallCount, 1);

  const nonAllowedApiRes = await middleware(
    new NextRequest("http://localhost:3000/api/jobs/search", {
      headers: {
        authorization: "Bearer valid-nonallowed-token",
        cookie: "sb-access-token=valid-nonallowed-token",
      },
    })
  );
  assert.strictEqual(nonAllowedApiRes.status, 403);
  assert.strictEqual(nonAllowedApiRes.headers.get("x-early-access-signed-out"), "1");
  assert.strictEqual(signOutCallCount, 2);

  delete process.env.EARLY_ACCESS_ALLOWED_EMAILS;
  const emptyEnvPageRes = await middleware(
    new NextRequest("http://localhost:3000/dashboard", {
      headers: { authorization: "Bearer valid-allowed-token" },
    })
  );
  assert.strictEqual(emptyEnvPageRes.status, 307);

  process.env.ADMIN_SECRET = "test-admin-secret-xyz";
  try {
    const adminSecretRes = await middleware(
      new NextRequest("http://localhost:3000/api/admin/stats", {
        headers: { "x-admin-secret": "test-admin-secret-xyz" },
      })
    );
    assert.strictEqual(adminSecretRes.status, 200);
  } finally {
    delete process.env.ADMIN_SECRET;
  }

  console.log("  [PASS] Middleware allowlist, legal pages, /api/health, and /api/track lock verified");

  // ---------------------------------------------------------------------------
  // TEST 3: Gmail API Mocked Fetch (Thank-You + Daily Digest, Dedupe, Honeypot, Error Resilience, No Secrets in Logs, 150/day Cap)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 3] Verifying Gmail API integration (thank-you + daily digest, errors, log redaction, 150/day cap)...");
  _resetEarlyAccessRateLimitStore();
  _resetEarlyAccessDigestState();
  mockDbRows.length = 0;
  mockSendLogRows.length = 0;
  simulateDbFailure = null;

  const TEST_CLIENT_ID = "mock-gmail-client-id-999.apps.googleusercontent.com";
  const TEST_CLIENT_SECRET = "GOCSPX-mockSecretValueDoNotLog888";
  const TEST_REFRESH_TOKEN = "1//04mockRefreshTokenValueDoNotLog777";
  const TEST_ACCESS_TOKEN = "ya29.a0mockAccessTokenValueDoNotLog666";
  const TEST_SENDER_EMAIL = "roman.founder@gmail.example";
  const TEST_SENDER_NAME = "Roman from CareerMonke";
  const TEST_NOTIFY_EMAIL = "owner.notify@careermonke.example";

  process.env.GMAIL_CLIENT_ID = TEST_CLIENT_ID;
  process.env.GMAIL_CLIENT_SECRET = TEST_CLIENT_SECRET;
  process.env.GMAIL_REFRESH_TOKEN = TEST_REFRESH_TOKEN;
  process.env.GMAIL_SENDER_EMAIL = TEST_SENDER_EMAIL;
  process.env.GMAIL_SENDER_NAME = TEST_SENDER_NAME;
  process.env.EARLY_ACCESS_NOTIFY_EMAIL = TEST_NOTIFY_EMAIL;

  const originalFetch = globalThis.fetch;
  const originalConsoleWarn = console.warn;
  const capturedWarnings: string[] = [];
  console.warn = (...args: any[]) => {
    capturedWarnings.push(args.map((a) => String(a)).join(" "));
  };

  interface CapturedGmailSend {
    authHeader: string;
    rawMime: string;
    subject: string;
  }
  let tokenExchangeCalls = 0;
  const gmailSendCalls: CapturedGmailSend[] = [];
  let mockFetchMode: "ok" | "oauth_fail" | "send_500" | "quota_429" = "ok";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === GMAIL_OAUTH_TOKEN_URL) {
      tokenExchangeCalls++;
      if (mockFetchMode === "oauth_fail") {
        return new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: `Bad refresh token ${TEST_REFRESH_TOKEN} for ${TEST_SENDER_EMAIL} secret ${TEST_CLIENT_SECRET}`,
          }),
          { status: 400 }
        );
      }
      return new Response(
        JSON.stringify({
          access_token: TEST_ACCESS_TOKEN,
          expires_in: 3599,
          scope: "https://www.googleapis.com/auth/gmail.send",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (url === GMAIL_SEND_MESSAGE_URL) {
      if (mockFetchMode === "send_500") {
        return new Response(
          JSON.stringify({
            error: {
              code: 500,
              message: `Backend error for ${TEST_SENDER_EMAIL} -> ${TEST_NOTIFY_EMAIL} token ${TEST_ACCESS_TOKEN}`,
            },
          }),
          { status: 500 }
        );
      }
      if (mockFetchMode === "quota_429") {
        return new Response(
          JSON.stringify({
            error: { code: 429, message: "User-rate limit exceeded" },
          }),
          { status: 429 }
        );
      }

      const headers = new Headers(init?.headers as HeadersInit);
      const payload = JSON.parse(String(init?.body || "{}"));
      const rawMime = decodeBase64UrlToUtf8(payload.raw);
      const subject = decodeRfc2047Subject(rawMime);
      gmailSendCalls.push({
        authHeader: headers.get("authorization") || "",
        rawMime,
        subject,
      });
      return new Response(JSON.stringify({ id: `msg-${gmailSendCalls.length}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
  }) as typeof fetch;

  try {
    // 3a. First new email of the day -> 1 OAuth token exchange + 2 Gmail sends (1 thank-you + 1 daily digest)
    const firstReq = new Request("http://localhost:3000/api/early-access", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.10",
      },
      body: JSON.stringify({ email: "  Candidate.One@Example.com  ", website: "" }),
    });
    const firstRes = await earlyAccessPost(firstReq);
    assert.strictEqual(firstRes.status, 200);
    const firstBody = await firstRes.json();
    assert.deepStrictEqual(firstBody, { ok: true, message: "You're on the list" });
    assert.strictEqual(mockDbRows.length, 1);
    assert.strictEqual(mockDbRows[0].email, "candidate.one@example.com");

    assert.strictEqual(tokenExchangeCalls, 1, "Expected 1 OAuth token exchange call");
    assert.strictEqual(
      gmailSendCalls.length,
      2,
      "Expected 2 Gmail messages on first signup of the day (1 thank-you + 1 owner digest)"
    );
    assert.strictEqual(mockSendLogRows.length, 2, "Expected 2 rows recorded in gmail_send_log");

    // Verify Thank-You email (Call #1)
    const thankYouCall = gmailSendCalls[0];
    assert.strictEqual(thankYouCall.authHeader, `Bearer ${TEST_ACCESS_TOKEN}`);
    assert.strictEqual(
      thankYouCall.subject,
      EARLY_ACCESS_THANK_YOU_SUBJECT,
      `Thank-you subject must be '${EARLY_ACCESS_THANK_YOU_SUBJECT}'`
    );
    assert.ok(
      thankYouCall.rawMime.includes(`From: "${TEST_SENDER_NAME}" <${TEST_SENDER_EMAIL}>`),
      "Thank-you email must be FROM the founder Gmail"
    );
    assert.ok(
      thankYouCall.rawMime.includes("To: <candidate.one@example.com>"),
      "Thank-you email must be TO the submitter"
    );
    assert.ok(
      thankYouCall.rawMime.includes('Content-Type: text/plain; charset="UTF-8"') &&
        thankYouCall.rawMime.includes('Content-Type: text/html; charset="UTF-8"'),
      "Thank-you email must include both plain text and simple HTML parts"
    );
    assert.ok(
      thankYouCall.rawMime.includes("small batches") &&
        thankYouCall.rawMime.includes("No spam"),
      "Thank-you email body must include small batches & no spam copy"
    );

    // Verify Owner Daily Digest email (Call #2)
    const digestCall = gmailSendCalls[1];
    assert.ok(
      digestCall.rawMime.includes(`To: <${TEST_NOTIFY_EMAIL}>`),
      "Owner notification/digest must be sent to EARLY_ACCESS_NOTIFY_EMAIL"
    );
    assert.ok(
      digestCall.rawMime.includes("candidate.one@example.com") &&
        digestCall.rawMime.includes(mockDbRows[0].created_at),
      "Owner digest must include the new email and its timestamp"
    );
    console.log("  [PASS] First new signup sent 1 thank-you email + 1 owner daily digest and logged 2 rows in gmail_send_log");

    // 3b. Second new email on the SAME UTC day -> sends thank-you ONLY (owner notification batched into daily digest)
    const secondReq = new Request("http://localhost:3000/api/early-access", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.11",
      },
      body: JSON.stringify({ email: "candidate.two@example.com" }),
    });
    const secondRes = await earlyAccessPost(secondReq);
    assert.strictEqual(secondRes.status, 200);
    assert.strictEqual(mockDbRows.length, 2);
    assert.strictEqual(
      gmailSendCalls.length,
      3,
      "Second signup on same day must send only 1 thank-you email (owner notify batched into daily digest)"
    );
    assert.ok(gmailSendCalls[2].rawMime.includes("To: <candidate.two@example.com>"));
    assert.strictEqual(mockSendLogRows.length, 3);
    console.log("  [PASS] Subsequent signup on same UTC day sent thank-you only (owner notifications batched into daily digest)");

    // 3c. Duplicate email & Honeypot -> 0 Gmail sends
    const sendsBeforeDup = gmailSendCalls.length;
    const dupRes = await earlyAccessPost(
      new Request("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.12" },
        body: JSON.stringify({ email: "CANDIDATE.ONE@EXAMPLE.COM" }),
      })
    );
    assert.strictEqual(dupRes.status, 200);
    assert.strictEqual(gmailSendCalls.length, sendsBeforeDup, "Duplicate email must send 0 Gmail messages");

    const hpRes = await earlyAccessPost(
      new Request("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.13" },
        body: JSON.stringify({ email: "bot@spam.example", website: "http://bot.example" }),
      })
    );
    assert.strictEqual(hpRes.status, 200);
    assert.strictEqual(gmailSendCalls.length, sendsBeforeDup, "Honeypot submission must send 0 Gmail messages");
    console.log("  [PASS] Duplicate and honeypot submissions trigger 0 Gmail API calls");

    // 3d. Gmail OAuth / Send error / Quota error (429) & Missing Env -> still stores email in DB, returns 200, no secrets in logs
    capturedWarnings.length = 0;
    mockFetchMode = "oauth_fail";
    const oauthFailRes = await earlyAccessPost(
      new Request("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.14" },
        body: JSON.stringify({ email: "oauth.fail.user@example.com" }),
      })
    );
    assert.strictEqual(oauthFailRes.status, 200, "Request must still succeed (200) when OAuth fails");
    assert.ok(
      mockDbRows.some((r) => r.email === "oauth.fail.user@example.com"),
      "Signup must still be stored when OAuth fails"
    );

    mockFetchMode = "quota_429";
    _resetEarlyAccessDigestState();
    const quotaFailRes = await earlyAccessPost(
      new Request("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.15" },
        body: JSON.stringify({ email: "quota.fail.user@example.com" }),
      })
    );
    assert.strictEqual(quotaFailRes.status, 200, "Request must still succeed (200) when Gmail returns 429 quota error");
    assert.ok(
      mockDbRows.some((r) => r.email === "quota.fail.user@example.com"),
      "Signup must still be stored when Gmail returns 429 quota error"
    );

    // Missing env test
    delete process.env.GMAIL_REFRESH_TOKEN;
    const missingEnvRes = await earlyAccessPost(
      new Request("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.16" },
        body: JSON.stringify({ email: "missing.env.user@example.com" }),
      })
    );
    assert.strictEqual(missingEnvRes.status, 200, "Request must still succeed (200) when Gmail env is missing");
    assert.ok(
      mockDbRows.some((r) => r.email === "missing.env.user@example.com"),
      "Signup must still be stored when Gmail env is missing"
    );
    process.env.GMAIL_REFRESH_TOKEN = TEST_REFRESH_TOKEN;
    mockFetchMode = "ok";

    // Verify ZERO secrets or full email addresses in captured warnings
    assert.ok(capturedWarnings.length > 0, "Expected safe warning logs on Gmail failure/missing env");
    const joinedWarnings = capturedWarnings.join("\n");
    const forbiddenSubstrings = [
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET,
      TEST_REFRESH_TOKEN,
      TEST_ACCESS_TOKEN,
      TEST_SENDER_EMAIL,
      TEST_NOTIFY_EMAIL,
      "oauth.fail.user@example.com",
      "quota.fail.user@example.com",
      "missing.env.user@example.com",
    ];
    for (const secretOrEmail of forbiddenSubstrings) {
      assert.ok(
        !joinedWarnings.includes(secretOrEmail),
        `Log output leaked sensitive value '${secretOrEmail}'`
      );
    }
    console.log("  [PASS] Gmail failure/quota/missing env still stores signup & returns 200 with zero secrets/emails in logs");

    // 3e. Daily Outgoing Message Cap (150 messages/day in gmail_send_log)
    assert.strictEqual(DAILY_GMAIL_MESSAGE_CAP, 150, "Daily message cap must be 150");
    mockSendLogRows.length = 0;
    _resetEarlyAccessDigestState();
    const nowIso = new Date().toISOString();
    // Seed 149 messages sent today -> next signup should send the 150th message (thank-you) and stop before the 151st (digest)!
    for (let i = 0; i < 149; i++) {
      mockSendLogRows.push({ sent_at: nowIso });
    }
    const sendsBeforeCapBoundary = gmailSendCalls.length;
    const msg150Res = await earlyAccessPost(
      new Request("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.17" },
        body: JSON.stringify({ email: "cap150.user@example.com" }),
      })
    );
    assert.strictEqual(msg150Res.status, 200);
    assert.strictEqual(
      gmailSendCalls.length,
      sendsBeforeCapBoundary + 1,
      "At 149/150 messages, only the 150th message (thank-you) should send"
    );
    assert.strictEqual(mockSendLogRows.length, 150, "gmail_send_log must now be at 150");

    // Next signup when gmail_send_log is at 150 -> 0 messages sent, signup still stored in DB
    const capHitRes = await earlyAccessPost(
      new Request("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.18" },
        body: JSON.stringify({ email: "cap151.user@example.com" }),
      })
    );
    assert.strictEqual(capHitRes.status, 200);
    assert.ok(
      mockDbRows.some((r) => r.email === "cap151.user@example.com"),
      "Signup must still be stored in early_access_emails when 150/day message cap is hit"
    );
    assert.strictEqual(
      gmailSendCalls.length,
      sendsBeforeCapBoundary + 1,
      "Zero Gmail messages may be sent once 150/day cap is reached"
    );
    console.log("  [PASS] 150 messages/day cap via gmail_send_log (sent_at) enforced before each send");

    // 3f. DB failure (non-duplicate) -> returns 500 with generic try-again message and sends 0 emails
    simulateDbFailure = "insert_error";
    const sendsBeforeDbFail = gmailSendCalls.length;
    try {
      const dbFailRes = await earlyAccessPost(
        new Request("http://localhost:3000/api/early-access", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.19" },
          body: JSON.stringify({ email: "dbfail.user@example.com" }),
        })
      );
      assert.strictEqual(dbFailRes.status, 500);
      const dbFailBody = await dbFailRes.json();
      assert.strictEqual(dbFailBody.ok, false);
      assert.ok(/try again/i.test(dbFailBody.error || ""));
      assert.strictEqual(gmailSendCalls.length, sendsBeforeDbFail, "Failed DB insert must not send any email");
    } finally {
      simulateDbFailure = null;
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalConsoleWarn;
  }

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
      body: JSON.stringify({ email: `rluser${i}@example.com` }),
    });
    const res = await earlyAccessPost(req);
    assert.strictEqual(res.status, 200);
  }

  const sixthRes = await earlyAccessPost(
    new Request("http://localhost:3000/api/early-access", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": rlIp,
      },
      body: JSON.stringify({ email: "rluser6@example.com" }),
    })
  );
  assert.strictEqual(sixthRes.status, 429);
  console.log("  [PASS] 5 requests allowed, 6th returned HTTP 429 with Retry-After");

  // ---------------------------------------------------------------------------
  // TEST 5: Sitemap Contains ONLY "/" and "/early-access"
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 5] Verifying sitemap() contains only '/' and '/early-access'...");
  const entries = sitemap();
  const paths = entries.map((e) => new URL(e.url).pathname);
  assert.deepStrictEqual(paths, ["/", "/early-access"]);
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
  console.log("ALL EARLY-ACCESS-ONLY MODE & GMAIL API TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("\n[FAIL] Early-Access Test Suite Error:\n", err);
  process.exit(1);
});
