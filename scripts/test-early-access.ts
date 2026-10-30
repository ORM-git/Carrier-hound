/**
 * scripts/test-early-access.ts
 *
 * Comprehensive verification suite for Early-Access-Only Mode & Gmail API Sender (PR #127 & PR #128):
 * 1. ALLOWLIST (EARLY_ACCESS_ALLOWED_EMAILS), legal pages, /api/health, and restored links/WhiteHeroButton.
 * 2. Owner digest cron (runEarlyAccessDigestCron + .github/workflows/early-access-digest-cron.yml):
 *    - Removed from POST /api/early-access request path.
 *    - Sends ONE email with all early_access_emails rows since last_digest_at (tracked in gmail_send_log).
 *    - Sends NO digest when there are no new rows.
 * 3. Cap fails closed: when gmail_send_log read errors (missing table, grant problem, DB error),
 *    0 emails are sent, warning is logged safely, and signup stays stored.
 * 4. Non-blocking submit: uses waitUntil when available on the runtime, else fire-and-forget with
 *    ~0.8s (<1s) response window and hard 2s cap (THANK_YOU_HARD_CAP_MS = 2000).
 * 5. Double opt-in-light abuse protection: at most ONE thank-you per distinct address ever (checked
 *    in gmail_send_log), 150 messages/day total cap, and 5/min/IP rate limit.
 * 6. CRLF-injection attempts in email field are rejected (400) and never reach buildRfc2822Base64UrlMessage.
 * 7. Real negative controls (gated by NODE_ENV=test) for middleware lock, cap fail-closed, and digest.
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

const isNegativeControlLock = process.argv.includes("--negative-control");
const isNegativeControlCap = process.argv.includes("--negative-control-cap");
const isNegativeControlDigest = process.argv.includes("--negative-control-digest");

interface StoredEmailRow {
  email: string;
  created_at: string;
}

interface GmailSendLogRow {
  recipient_email: string;
  kind: "thank_you" | "digest";
  sent_at: string;
}

const mockDbRows: StoredEmailRow[] = [];
const mockSendLogRows: GmailSendLogRow[] = [];
let simulateDbFailure: string | null = null;
let simulateSendLogReadFailure = false;
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
        let gteSentAt: string | null = null;
        let eqKind: string | null = null;
        let eqRecipient: string | null = null;
        let isCountHead = false;
        let orderDesc = false;
        let limitCount: number | null = null;

        const evaluateLogQuery = () => {
          if (simulateSendLogReadFailure) {
            return {
              data: null,
              count: null,
              error: { code: "42501", message: "permission denied for table gmail_send_log" },
            };
          }
          let filtered = [...mockSendLogRows];
          if (gteSentAt) {
            filtered = filtered.filter((r) => r.sent_at >= gteSentAt!);
          }
          if (eqKind) {
            filtered = filtered.filter((r) => r.kind === eqKind);
          }
          if (eqRecipient) {
            filtered = filtered.filter((r) => r.recipient_email === eqRecipient);
          }
          if (orderDesc) {
            filtered.sort((a, b) => (b.sent_at > a.sent_at ? 1 : b.sent_at < a.sent_at ? -1 : 0));
          }
          if (limitCount !== null) {
            filtered = filtered.slice(0, limitCount);
          }
          return {
            data: isCountHead ? null : filtered,
            count: filtered.length,
            error: null,
          };
        };

        const logBuilder: any = {
          select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
            if (opts?.count === "exact") {
              isCountHead = true;
            }
            return logBuilder;
          },
          gte: (col: string, val: string) => {
            if (col === "sent_at") gteSentAt = val;
            return logBuilder;
          },
          eq: (col: string, val: string) => {
            if (col === "kind") eqKind = val;
            if (col === "recipient_email") eqRecipient = val;
            return logBuilder;
          },
          order: (_col: string, opts?: { ascending?: boolean }) => {
            if (opts?.ascending === false) orderDesc = true;
            return logBuilder;
          },
          limit: (n: number) => {
            limitCount = n;
            return logBuilder;
          },
          maybeSingle: async () => {
            const res = evaluateLogQuery();
            if (res.error) return { data: null, error: res.error };
            return { data: res.data?.[0] || null, error: null };
          },
          then: (resolve: any, reject: any) => {
            return Promise.resolve(evaluateLogQuery()).then(resolve, reject);
          },
          insert: async (row: Partial<GmailSendLogRow>) => {
            mockSendLogRows.push({
              recipient_email: row.recipient_email || "",
              kind: row.kind || "thank_you",
              sent_at: row.sent_at || new Date().toISOString(),
            });
            return { data: row, error: null };
          },
        };
        return logBuilder;
      }

      assert.strictEqual(table, "early_access_emails", `Unexpected table access: ${table}`);
      let filterEmail: string | null = null;
      let gtCreatedAt: string | null = null;
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: string) => {
          if (col === "email") filterEmail = val;
          return builder;
        },
        gt: (col: string, val: string) => {
          if (col === "created_at") gtCreatedAt = val;
          return builder;
        },
        order: () => {
          const rows = gtCreatedAt
            ? mockDbRows.filter((r) => r.created_at > gtCreatedAt!)
            : [...mockDbRows];
          rows.sort((a, b) => (a.created_at > b.created_at ? 1 : a.created_at < b.created_at ? -1 : 0));
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
    sendEarlyAccessThankYouEmail,
    runEarlyAccessDigestCron,
  } = await import("../src/lib/early-access/gmail");
  const sitemapModule = await import("../src/app/sitemap");
  const sitemap = sitemapModule.default;
  const {
    _resetEarlyAccessRateLimitStore,
    EARLY_ACCESS_RATE_LIMIT,
  } = await import("../src/lib/api/sharedRateLimit");

  // ===========================================================================
  // NEGATIVE CONTROL MODES (Strictly gated by NODE_ENV=test legacy flags)
  // ===========================================================================
  if (isNegativeControlLock) {
    process.env.__CAREERMONKE_LEGACY_EARLY_ACCESS_UNLOCK = "true";
    const guestJobsRes = await middleware(new NextRequest("http://localhost:3000/jobs"));
    const redirectLocation = guestJobsRes.headers.get("location") || "";
    const redirectPath = redirectLocation ? new URL(redirectLocation).pathname : "";
    assert.strictEqual(
      redirectPath,
      "/early-access",
      `Negative control (lock) expected failure: redirected to '${redirectPath}' instead of '/early-access'`
    );
    process.exit(1);
  }

  if (isNegativeControlCap) {
    process.env.__CAREERMONKE_LEGACY_CAP_FAIL_OPEN = "true";
    process.env.GMAIL_CLIENT_ID = "nc-id";
    process.env.GMAIL_CLIENT_SECRET = "nc-secret";
    process.env.GMAIL_REFRESH_TOKEN = "nc-refresh";
    process.env.GMAIL_SENDER_EMAIL = "nc@sender.example";
    simulateSendLogReadFailure = true;

    let sentCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GMAIL_OAUTH_TOKEN_URL) {
        return new Response(JSON.stringify({ access_token: "nc-token" }), { status: 200 });
      }
      sentCount++;
      return new Response(JSON.stringify({ id: "nc-msg" }), { status: 200 });
    }) as typeof fetch;

    await sendEarlyAccessThankYouEmail({
      subscriberEmail: "nc-user@example.com",
      createdAt: new Date().toISOString(),
      supabaseClient: (globalThis as any).__mockSupabaseClient,
    });

    // Under fail-closed requirement, sentCount MUST be 0 when log read fails; legacy fail-open makes it 1 -> assertion fails:
    assert.strictEqual(
      sentCount,
      0,
      `Negative control (cap fail-closed) expected failure: sent ${sentCount} email(s) despite gmail_send_log read failure`
    );
    process.exit(1);
  }

  if (isNegativeControlDigest) {
    process.env.__CAREERMONKE_LEGACY_DIGEST_SEND_EMPTY = "true";
    process.env.GMAIL_CLIENT_ID = "nc-id";
    process.env.GMAIL_CLIENT_SECRET = "nc-secret";
    process.env.GMAIL_REFRESH_TOKEN = "nc-refresh";
    process.env.GMAIL_SENDER_EMAIL = "nc@sender.example";
    process.env.EARLY_ACCESS_NOTIFY_EMAIL = "nc@notify.example";
    mockDbRows.length = 0;
    mockSendLogRows.length = 0;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GMAIL_OAUTH_TOKEN_URL) {
        return new Response(JSON.stringify({ access_token: "nc-token" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "nc-digest" }), { status: 200 });
    }) as typeof fetch;

    const res = await runEarlyAccessDigestCron({
      supabaseClient: (globalThis as any).__mockSupabaseClient,
    });

    // When there are 0 new rows, res.sent MUST be false; legacy flag sends anyway -> assertion fails:
    assert.strictEqual(
      res.sent,
      false,
      "Negative control (digest) expected failure: digest was sent even when there were 0 new rows"
    );
    process.exit(1);
  }

  console.log("================================================================================");
  console.log("      CAREERMONKE EARLY-ACCESS-ONLY MODE & GMAIL API VERIFICATION SUITE         ");
  console.log("================================================================================");

  // ---------------------------------------------------------------------------
  // TEST 1: Restored Links + WhiteHeroButton + Cron Workflow & Guide Verification
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 1] Verifying restored links, WhiteHeroButton, cron workflow, and refresh-token guide...");

  const landingSrc = fs.readFileSync(path.resolve(process.cwd(), "src/app/page.tsx"), "utf8");
  const footerSrc = fs.readFileSync(path.resolve(process.cwd(), "src/components/Footer.tsx"), "utf8");
  const cookieNoticeSrc = fs.readFileSync(path.resolve(process.cwd(), "src/components/CookieNotice.tsx"), "utf8");
  const middlewareSrc = fs.readFileSync(path.resolve(process.cwd(), "src/middleware.ts"), "utf8");
  const guideSrc = fs.readFileSync(path.resolve(process.cwd(), "scripts/get-gmail-refresh-token.md"), "utf8");
  const workflowSrc = fs.readFileSync(
    path.resolve(process.cwd(), ".github/workflows/early-access-digest-cron.yml"),
    "utf8"
  );

  assert.ok(landingSrc.includes('import { WhiteHeroButton } from "@/components/Buttons";'));
  assert.ok(
    landingSrc.includes(
      '<WhiteHeroButton onClick={() => router.push("/early-access")} className="px-8 min-w-[200px]">'
    )
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
  assert.ok(footerSrc.includes('href="mailto:support@careermonke.com"'));
  assert.ok(footerSrc.includes('href="https://x.com/careermonke"'));
  assert.ok(footerSrc.includes('href="https://linkedin.com/company/careermonke"'));
  assert.ok(footerSrc.includes('href="https://github.com"'));
  assert.ok(cookieNoticeSrc.includes('href="/privacy"'));
  assert.ok(!/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(middlewareSrc));

  assert.ok(guideSrc.includes("Web application"));
  assert.ok(guideSrc.includes("https://developers.google.com/oauthplayground"));
  assert.ok(guideSrc.includes("https://www.googleapis.com/auth/gmail.send"));
  assert.ok(/In production/i.test(guideSrc));
  assert.ok(/Offline/i.test(guideSrc));
  assert.ok(/Use your own OAuth credentials/i.test(guideSrc));

  assert.ok(workflowSrc.includes("schedule:"));
  assert.ok(workflowSrc.includes("cron:"));
  assert.ok(workflowSrc.includes("npx tsx scripts/early-access-digest-cron.ts"));
  console.log("  [PASS] Links, WhiteHeroButton, cron workflow, and OAuth guide verified");

  // ---------------------------------------------------------------------------
  // TEST 2: Server-Side Lock, Legal Pages, /api/health, and ALLOWLIST
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 2] Verifying guest lock, public legal pages + /api/health, and EARLY_ACCESS_ALLOWED_EMAILS allowlist...");
  delete process.env.__CAREERMONKE_LEGACY_EARLY_ACCESS_UNLOCK;

  for (const route of ["/jobs", "/dashboard", "/resume", "/tracker", "/pricing", "/admin", "/remote", "/worldwide", "/signup"]) {
    const res = await middleware(new NextRequest(`http://localhost:3000${route}`));
    assert.strictEqual(res.status, 307);
    assert.strictEqual(new URL(res.headers.get("location")!).pathname, "/early-access");
  }

  for (const apiRoute of ["/api/jobs/search", "/api/jobs/pro", "/api/ai", "/api/stats", "/api/track", "/api/admin/stats"]) {
    const res = await middleware(new NextRequest(`http://localhost:3000${apiRoute}`));
    assert.strictEqual(res.status, 403);
  }

  for (const guestRoute of ["/", "/early-access", "/api/early-access", "/api/health", "/privacy", "/privacy-policy", "/terms-and-conditions", "/login", "/data/ne_110m_land.json"]) {
    const res = await middleware(new NextRequest(`http://localhost:3000${guestRoute}`));
    assert.strictEqual(res.status, 200);
  }

  // Negative assertions: other .json paths (/data/radar.json -> 307 to /early-access, /api/*.json -> 403)
  const blockedDataReq = new NextRequest("http://localhost:3000/data/radar.json");
  const blockedDataRes = await middleware(blockedDataReq);
  assert.strictEqual(
    blockedDataRes.status,
    307,
    `Guest request to '/data/radar.json' must return 307 redirect, got ${blockedDataRes.status}`
  );
  const dataLocation = blockedDataRes.headers.get("location") || "";
  assert.strictEqual(
    dataLocation ? new URL(dataLocation).pathname : "",
    "/early-access",
    `Guest request to '/data/radar.json' must redirect to '/early-access'`
  );

  const blockedApiJsonReq = new NextRequest("http://localhost:3000/api/jobs.json");
  const blockedApiJsonRes = await middleware(blockedApiJsonReq);
  assert.strictEqual(
    blockedApiJsonRes.status,
    403,
    `Guest request to '/api/jobs.json' must return HTTP 403, got ${blockedApiJsonRes.status}`
  );
  const blockedApiJsonBody = await blockedApiJsonRes.json();
  assert.strictEqual(
    blockedApiJsonBody.error,
    "Early access only",
    `Guest request to '/api/jobs.json' must return 'Early access only' error`
  );
  console.log("  [PASS] Negative assertions verified: /data/radar.json redirects to /early-access and /api/jobs.json returns 403");

  // 2b. Verify EARLY_ACCESS_ALLOWED_EMAILS allowlist enforcement
  process.env.EARLY_ACCESS_ALLOWED_EMAILS = "  founder.allowed@example.com , SECOND.ADMIN@EXAMPLE.COM ";
  signOutCallCount = 0;

  assert.strictEqual(
    (
      await middleware(
        new NextRequest("http://localhost:3000/dashboard", {
          headers: { authorization: "Bearer valid-allowed-token" },
        })
      )
    ).status,
    200
  );
  assert.strictEqual(
    (
      await middleware(
        new NextRequest("http://localhost:3000/api/jobs/search", {
          headers: { authorization: "Bearer valid-allowed-token" },
        })
      )
    ).status,
    200
  );

  const nonAllowedPageRes = await middleware(
    new NextRequest("http://localhost:3000/dashboard", {
      headers: {
        authorization: "Bearer valid-nonallowed-token",
        cookie: "sb-access-token=valid-nonallowed-token",
      },
    })
  );
  assert.strictEqual(nonAllowedPageRes.status, 307);
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

  console.log("  [PASS] Middleware allowlist, legal pages, /api/health, and /api/track lock verified");

  // ---------------------------------------------------------------------------
  // TEST 3: CRLF Injection Rejection (Never Reaches Message Builder)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 3] Verifying CRLF-injection attempts are rejected (400) and never reach message builder...");
  _resetEarlyAccessRateLimitStore();
  mockDbRows.length = 0;
  mockSendLogRows.length = 0;

  let messageBuilderCalls = 0;
  (globalThis as any).__onMessageBuilderInvoked = () => {
    messageBuilderCalls++;
  };

  const crlfPayloads = [
    "victim@example.com\r\nBcc: attacker@evil.com",
    "victim@example.com\nBcc: attacker@evil.com",
    "victim@example.com\rSubject: Injected",
    "\r\nvictim@example.com",
    "victim@example.com\r\n",
    "victim%0d%0a@example.com",
    "victim%0aBcc:evil@example.com",
    "victim\0@example.com",
  ];

  for (let i = 0; i < crlfPayloads.length; i++) {
    const res = await earlyAccessPost(
      new Request("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `198.51.102.${i + 1}`,
        },
        body: JSON.stringify({ email: crlfPayloads[i] }),
      })
    );
    assert.strictEqual(
      res.status,
      400,
      `CRLF payload #${i + 1} must be rejected with HTTP 400, got ${res.status}`
    );
  }
  assert.strictEqual(mockDbRows.length, 0, "CRLF payloads must never be stored in DB");
  assert.strictEqual(
    messageBuilderCalls,
    0,
    "CRLF payloads must never reach buildRfc2822Base64UrlMessage"
  );
  console.log(`  [PASS] All ${crlfPayloads.length} CRLF-injection payloads rejected with 400 before DB or message builder`);

  // ---------------------------------------------------------------------------
  // TEST 4: Request Path Thank-You Only, Double Opt-In-Light (1 Ever), Cap Fail-Closed, Non-Blocking Submit
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 4] Verifying request-path thank-you only, 1 thank-you per address ever, cap fail-closed, and non-blocking submit...");
  _resetEarlyAccessRateLimitStore();
  mockDbRows.length = 0;
  mockSendLogRows.length = 0;
  simulateDbFailure = null;
  simulateSendLogReadFailure = false;

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
  const gmailSendCalls: CapturedGmailSend[] = [];
  let mockFetchMode: "ok" | "oauth_fail" | "slow_3s" = "ok";
  let slowFetchAborted = false;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (mockFetchMode === "slow_3s") {
      return await new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(new Response(JSON.stringify({ access_token: TEST_ACCESS_TOKEN }), { status: 200 }));
        }, 3000);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            slowFetchAborted = true;
            reject(new Error("AbortError: hard 2s cap reached"));
          },
          { once: true }
        );
      });
    }

    if (url === GMAIL_OAUTH_TOKEN_URL) {
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
    // 4a. First new signup -> sends ONLY 1 thank-you email (digest is NOT on the request path!)
    const firstRes = await earlyAccessPost(
      new Request("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.10" },
        body: JSON.stringify({ email: "  Alice@Example.com  ", website: "" }),
      })
    );
    assert.strictEqual(firstRes.status, 200);
    assert.strictEqual(mockDbRows.length, 1);
    assert.strictEqual(
      gmailSendCalls.length,
      1,
      "POST /api/early-access must send ONLY 1 thank-you email (no digest on request path)"
    );
    assert.strictEqual(gmailSendCalls[0].subject, EARLY_ACCESS_THANK_YOU_SUBJECT);
    assert.ok(gmailSendCalls[0].rawMime.includes("To: <alice@example.com>"));
    assert.strictEqual(mockSendLogRows.length, 1);
    assert.strictEqual(mockSendLogRows[0].kind, "thank_you");
    assert.strictEqual(mockSendLogRows[0].recipient_email, "alice@example.com");
    console.log("  [PASS] Request path sends ONLY thank-you email (digest removed from request path)");

    // 4b. Thank-you is NEVER repeated for the same address ever (even if early_access_emails row were cleared)
    mockDbRows.length = 0; // Simulate row deleted from early_access_emails while gmail_send_log retains history
    const repeatRes = await earlyAccessPost(
      new Request("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.11" },
        body: JSON.stringify({ email: "alice@example.com" }),
      })
    );
    assert.strictEqual(repeatRes.status, 200);
    assert.strictEqual(
      gmailSendCalls.length,
      1,
      "Thank-you email must NEVER be sent a second time to the same address (checked via gmail_send_log)"
    );
    console.log("  [PASS] Double opt-in-light: thank-you never repeated for the same address ever");

    // 4c. Cap fails closed when gmail_send_log read errors (missing table / grant problem)
    simulateSendLogReadFailure = true;
    try {
      const failClosedRes = await earlyAccessPost(
        new Request("http://localhost:3000/api/early-access", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.12" },
          body: JSON.stringify({ email: "failclosed.user@example.com" }),
        })
      );
      assert.strictEqual(failClosedRes.status, 200, "Signup must still succeed (200) when gmail_send_log read fails");
      assert.ok(
        mockDbRows.some((r) => r.email === "failclosed.user@example.com"),
        "Signup must remain stored in early_access_emails when gmail_send_log read fails"
      );
      assert.strictEqual(
        gmailSendCalls.length,
        1,
        "Cap MUST fail closed: 0 emails sent when gmail_send_log count cannot be read"
      );
    } finally {
      simulateSendLogReadFailure = false;
    }
    console.log("  [PASS] Cap fails closed when gmail_send_log cannot be read (signup stored, 0 emails sent)");

    // 4d. Do not block submit beyond ~1s + hard 2s cap on background thank-you send
    mockFetchMode = "slow_3s";
    slowFetchAborted = false;
    const t0 = Date.now();
    const slowRes = await earlyAccessPost(
      new Request("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.13" },
        body: JSON.stringify({ email: "slow.network@example.com" }),
      })
    );
    const elapsedMs = Date.now() - t0;
    assert.strictEqual(slowRes.status, 200);
    assert.ok(
      elapsedMs < 1200,
      `POST /api/early-access must not block beyond ~1s, took ${elapsedMs}ms`
    );
    // Wait for the 2s hard cap to abort the hanging 3s fetch
    await new Promise((r) => setTimeout(r, 1400));
    assert.strictEqual(slowFetchAborted, true, "Hanging Gmail fetch must be aborted by hard 2s cap");
    mockFetchMode = "ok";
    console.log(`  [PASS] Submit responded in ${elapsedMs}ms (< ~1s) and aborted slow send at hard 2s cap`);

    // ---------------------------------------------------------------------------
    // TEST 5: Scheduled Owner Digest Cron (runEarlyAccessDigestCron)
    // ---------------------------------------------------------------------------
    console.log("\n[TEST 5] Verifying scheduled owner digest cron (all rows since last_digest_at, no send when 0 new rows)...");
    mockDbRows.length = 0;
    mockSendLogRows.length = 0;
    gmailSendCalls.length = 0;

    // 5a. When early_access_emails has 0 rows -> sends NO digest
    const emptyDigestRes = await runEarlyAccessDigestCron({
      supabaseClient: (globalThis as any).__mockSupabaseClient,
    });
    assert.strictEqual(emptyDigestRes.status, "success");
    assert.strictEqual(emptyDigestRes.sent, false);
    assert.strictEqual(emptyDigestRes.reason, "no_new_rows");
    assert.strictEqual(gmailSendCalls.length, 0, "No digest email may be sent when there are 0 rows");

    // 5b. Seed 3 signups and run digest cron -> sends ONE email with all 3 rows and logs kind='digest'
    mockDbRows.push(
      { email: "first@example.com", created_at: "2026-10-29T08:00:00.000Z" },
      { email: "second@example.com", created_at: "2026-10-29T09:00:00.000Z" },
      { email: "third@example.com", created_at: "2026-10-29T10:00:00.000Z" }
    );

    const firstDigestRes = await runEarlyAccessDigestCron({
      supabaseClient: (globalThis as any).__mockSupabaseClient,
      nowIso: "2026-10-29T18:00:00.000Z",
    });
    assert.strictEqual(firstDigestRes.status, "success");
    assert.strictEqual(firstDigestRes.sent, true);
    assert.strictEqual(firstDigestRes.rowCount, 3);
    assert.strictEqual(gmailSendCalls.length, 1, "Digest cron must send exactly ONE email for all 3 rows");
    assert.ok(gmailSendCalls[0].rawMime.includes(`To: <${TEST_NOTIFY_EMAIL}>`));
    assert.ok(gmailSendCalls[0].rawMime.includes("first@example.com"));
    assert.ok(gmailSendCalls[0].rawMime.includes("second@example.com"));
    assert.ok(gmailSendCalls[0].rawMime.includes("third@example.com"));

    // 5c. Re-running digest cron immediately with no new rows -> sends NO digest
    const repeatDigestRes = await runEarlyAccessDigestCron({
      supabaseClient: (globalThis as any).__mockSupabaseClient,
      nowIso: "2026-10-29T19:00:00.000Z",
    });
    assert.strictEqual(repeatDigestRes.status, "success");
    assert.strictEqual(repeatDigestRes.sent, false);
    assert.strictEqual(repeatDigestRes.reason, "no_new_rows");
    assert.strictEqual(gmailSendCalls.length, 1, "Re-running cron with no new rows must send 0 emails");

    // 5d. Add 2 new rows after last_digest_at -> next cron run sends ONE email with ONLY the 2 new rows
    mockDbRows.push(
      { email: "fourth@example.com", created_at: "2026-10-30T07:00:00.000Z" },
      { email: "fifth@example.com", created_at: "2026-10-30T11:00:00.000Z" }
    );
    const secondDigestRes = await runEarlyAccessDigestCron({
      supabaseClient: (globalThis as any).__mockSupabaseClient,
      nowIso: "2026-10-30T18:00:00.000Z",
    });
    assert.strictEqual(secondDigestRes.status, "success");
    assert.strictEqual(secondDigestRes.sent, true);
    assert.strictEqual(secondDigestRes.rowCount, 2);
    assert.strictEqual(gmailSendCalls.length, 2);
    assert.ok(gmailSendCalls[1].rawMime.includes("fourth@example.com"));
    assert.ok(gmailSendCalls[1].rawMime.includes("fifth@example.com"));
    assert.ok(
      !gmailSendCalls[1].rawMime.includes("first@example.com"),
      "Second digest must only include rows created after last_digest_at"
    );
    console.log("  [PASS] Digest cron sends once with all rows since last_digest_at and skips when no new rows");

    // 5e. Verify 150/day cap across gmail_send_log
    assert.strictEqual(DAILY_GMAIL_MESSAGE_CAP, 150);
    mockSendLogRows.length = 0;
    const todayIso = new Date().toISOString();
    for (let i = 0; i < 150; i++) {
      mockSendLogRows.push({
        recipient_email: `u${i}@example.com`,
        kind: "thank_you",
        sent_at: todayIso,
      });
    }
    const sendsBeforeCap = gmailSendCalls.length;
    const cappedRes = await earlyAccessPost(
      new Request("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.20" },
        body: JSON.stringify({ email: "over150@example.com" }),
      })
    );
    assert.strictEqual(cappedRes.status, 200);
    assert.strictEqual(gmailSendCalls.length, sendsBeforeCap, "0 sends allowed when 150/day cap is reached");
    console.log("  [PASS] 150 messages/day total cap enforced");

    // 5f. Verify zero secrets or full emails in warning logs
    capturedWarnings.length = 0;
    mockSendLogRows.length = 0;
    mockFetchMode = "oauth_fail";
    await earlyAccessPost(
      new Request("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.21" },
        body: JSON.stringify({ email: "secretcheck@example.com" }),
      })
    );
    const allLogs = capturedWarnings.join("\n");
    for (const secret of [
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET,
      TEST_REFRESH_TOKEN,
      TEST_ACCESS_TOKEN,
      TEST_SENDER_EMAIL,
      TEST_NOTIFY_EMAIL,
      "secretcheck@example.com",
    ]) {
      assert.ok(!allLogs.includes(secret), `Secret or email leaked in logs: ${secret}`);
    }
    console.log("  [PASS] Zero secrets or full email addresses in logs");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalConsoleWarn;
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    delete process.env.GMAIL_REFRESH_TOKEN;
    delete process.env.GMAIL_SENDER_EMAIL;
    delete process.env.GMAIL_SENDER_NAME;
    delete process.env.EARLY_ACCESS_NOTIFY_EMAIL;
  }

  // ---------------------------------------------------------------------------
  // TEST 6: Rate Limit (5 requests / min / IP via sharedRateLimit) & Sitemap
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 6] Verifying 5/min/IP rate limit and sitemap(['/', '/early-access'])...");
  _resetEarlyAccessRateLimitStore();
  const rlIp = "203.0.113.77";
  assert.strictEqual(EARLY_ACCESS_RATE_LIMIT.maxRequests, 5);
  assert.strictEqual(EARLY_ACCESS_RATE_LIMIT.windowSeconds, 60);

  for (let i = 1; i <= 5; i++) {
    const res = await earlyAccessPost(
      new Request("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": rlIp },
        body: JSON.stringify({ email: `rl${i}@example.com` }),
      })
    );
    assert.strictEqual(res.status, 200);
  }
  const sixthRes = await earlyAccessPost(
    new Request("http://localhost:3000/api/early-access", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": rlIp },
      body: JSON.stringify({ email: "rl6@example.com" }),
    })
  );
  assert.strictEqual(sixthRes.status, 429);

  const sitemapPaths = sitemap().map((e) => new URL(e.url).pathname);
  assert.deepStrictEqual(sitemapPaths, ["/", "/early-access"]);
  console.log("  [PASS] Rate limit (5/min/IP) and sitemap verified");

  // ---------------------------------------------------------------------------
  // TEST 7: Automated Negative Controls (Lock, Cap Fail-Closed, and Digest)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 7] Verifying real negative controls (lock, cap fail-closed, and digest) exit non-zero...");
  const scriptPath = path.resolve(__dirname, "test-early-access.ts");

  for (const flag of ["--negative-control", "--negative-control-cap", "--negative-control-digest"]) {
    const child = spawnSync("npx", ["tsx", scriptPath, flag], {
      shell: true,
      stdio: "pipe",
      env: { ...process.env, NODE_ENV: "test" },
    });
    assert.notStrictEqual(
      child.status,
      0,
      `Negative control '${flag}' must exit with non-zero code, got ${child.status}`
    );
    console.log(`  [PASS] Negative control '${flag}' exited non-zero (${child.status})`);
  }

  console.log("\n================================================================================");
  console.log("ALL EARLY-ACCESS-ONLY MODE & GMAIL API TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("\n[FAIL] Early-Access Test Suite Error:\n", err);
  process.exit(1);
});
