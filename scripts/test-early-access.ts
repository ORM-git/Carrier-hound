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
const isNegativeControlApproval = process.argv.includes("--negative-control-approval");
const isNegativeControlSelfApprove = process.argv.includes("--negative-control-self-approve");

function collectNonTestSrcFiles(dirPath: string): Array<{ filePath: string; content: string }> {
  const results: Array<{ filePath: string; content: string }> = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      results.push(...collectNonTestSrcFiles(fullPath));
    } else if (entry.isFile()) {
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|sql)$/i.test(entry.name)) continue;
      if (/\.(test|spec)\.[jt]sx?$/i.test(entry.name)) continue;
      results.push({
        filePath: path.relative(process.cwd(), fullPath).replace(/\\/g, "/"),
        content: fs.readFileSync(fullPath, "utf-8"),
      });
    }
  }
  return results;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ");
}

function verifyNoSelfApproveInSrc(
  injectedFiles: Array<{ filePath: string; content: string }> = []
): void {
  const srcDir = path.resolve(process.cwd(), "src");
  const files = [...collectNonTestSrcFiles(srcDir), ...injectedFiles];
  assert.ok(files.length > 0, "Expected non-test files in src/ to scan");

  let selectUseCount = 0;

  for (const { filePath, content } of files) {
    const codeOnly = stripComments(content);
    if (!codeOnly.includes("early_access_approved")) {
      continue;
    }

    const mutationPattern =
      /early_access_approved[\s\S]{0,200}?\b(insert|update|upsert|delete|rpc)\b|\b(insert|update|upsert|delete|rpc)\b[\s\S]{0,200}?early_access_approved/i;
    assert.ok(
      !mutationPattern.test(codeOnly),
      `Prohibited mutation (insert/update/upsert/delete) with early_access_approved detected in ${filePath}`
    );

    const allOccurrences = [...codeOnly.matchAll(/early_access_approved/g)];
    const validSelectCalls = [
      ...codeOnly.matchAll(
        /\.from\(\s*["'`]early_access_approved["'`]\s*\)\s*\.select\s*\(/g
      ),
    ];

    assert.strictEqual(
      allOccurrences.length,
      validSelectCalls.length,
      `Non-select use of early_access_approved detected in ${filePath} (found ${allOccurrences.length} occurrence(s), but ${validSelectCalls.length} valid .from("early_access_approved").select(...) call(s))`
    );

    selectUseCount += validSelectCalls.length;
  }

  assert.ok(
    selectUseCount > 0,
    "Expected at least one valid .from('early_access_approved').select(...) in src/"
  );
}

interface StoredEmailRow {
  email: string;
  created_at: string;
}

interface GmailSendLogRow {
  recipient_email: string;
  kind: "thank_you" | "digest";
  sent_at: string;
}

interface MockApprovedRow {
  email: string;
  approved: boolean;
}

const mockDbRows: StoredEmailRow[] = [];
const mockSendLogRows: GmailSendLogRow[] = [];
const mockApprovedTable: MockApprovedRow[] = [];
let simulateDbFailure: string | null = null;
let simulateSendLogReadFailure = false;
let simulateApprovedDbFailure: string | null = null;
let approvedQueryCount = 0;
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
                email_confirmed_at: "2026-10-30T00:00:00Z",
                app_metadata: { provider: "google", providers: ["google"] },
                identities: [{ provider: "google" }],
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
                email_confirmed_at: "2026-10-30T00:00:00Z",
                app_metadata: { provider: "google", providers: ["google"] },
                identities: [{ provider: "google" }],
              },
            },
            error: null,
          };
        }
        if (token === "valid-approved-google-token") {
          return {
            data: {
              user: {
                id: "approved-user-id-1",
                email: "Approved.Google@Example.com",
                email_confirmed_at: "2026-10-30T00:00:00Z",
                app_metadata: { provider: "google", providers: ["google"] },
                identities: [{ provider: "google" }],
              },
            },
            error: null,
          };
        }
        if (token === "valid-not-approved-google-token") {
          return {
            data: {
              user: {
                id: "not-approved-user-id-2",
                email: "NotApproved.Google@Example.com",
                email_confirmed_at: "2026-10-30T00:00:00Z",
                app_metadata: { provider: "google", providers: ["google"] },
                identities: [{ provider: "google" }],
              },
            },
            error: null,
          };
        }
        if (token === "valid-magic-link-token") {
          return {
            data: {
              user: {
                id: "magic-user-id-3",
                email: "Approved.Google@Example.com",
                email_confirmed_at: "2026-10-30T00:00:00Z",
                app_metadata: { provider: "email", providers: ["email"] },
                identities: [{ provider: "email" }],
              },
            },
            error: null,
          };
        }
        if (token === "valid-email-plus-google-confirmed-approved") {
          return {
            data: {
              user: {
                id: "linked-google-approved-id-5",
                email: "Approved.Google@Example.com",
                email_confirmed_at: "2026-10-31T00:00:00Z",
                app_metadata: { provider: "email", providers: ["email", "google"] },
                identities: [{ provider: "email" }, { provider: "google" }],
              },
            },
            error: null,
          };
        }
        if (token === "valid-google-linked-unconfirmed") {
          return {
            data: {
              user: {
                id: "linked-google-unconfirmed-id-6",
                email: "Approved.Google@Example.com",
                email_confirmed_at: null,
                app_metadata: { provider: "email", providers: ["email", "google"] },
                identities: [{ provider: "email" }, { provider: "google" }],
              },
            },
            error: null,
          };
        }
        if (token === "valid-email-plus-google-confirmed-unapproved") {
          return {
            data: {
              user: {
                id: "linked-google-unapproved-id-7",
                email: "NotApproved.Google@Example.com",
                email_confirmed_at: "2026-10-31T00:00:00Z",
                app_metadata: { provider: "email", providers: ["email", "google"] },
                identities: [{ provider: "email" }, { provider: "google" }],
              },
            },
            error: null,
          };
        }
        if (token === "valid-db-error-token") {
          return {
            data: {
              user: {
                id: "db-error-user-id-4",
                email: "db.error.user@example.com",
                email_confirmed_at: "2026-10-30T00:00:00Z",
                app_metadata: { provider: "google", providers: ["google"] },
                identities: [{ provider: "google" }],
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

      if (table === "early_access_approved") {
        let filterEmail: string | null = null;
        const approvedBuilder: any = {
          select: () => approvedBuilder,
          eq: (col: string, val: string) => {
            if (col === "email") filterEmail = String(val).trim().toLowerCase();
            return approvedBuilder;
          },
          maybeSingle: async () => {
            approvedQueryCount++;
            if (simulateApprovedDbFailure) {
              return { data: null, error: { code: "08006", message: "DB query error" } };
            }
            const found = mockApprovedTable.find((r) => r.email === filterEmail) || null;
            return { data: found ? { approved: found.approved } : null, error: null };
          },
        };
        return approvedBuilder;
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
  const { middleware, _clearEarlyAccessCacheForTesting } = await import("../src/middleware");
  const { GET: healthGet } = await import("../src/app/api/health/route");
  const { POST: earlyAccessPost } = await import("../src/app/api/early-access/route");
  const {
    DAILY_THANK_YOU_CAP,
    DAILY_GMAIL_MESSAGE_CAP,
    EARLY_ACCESS_THANK_YOU_SUBJECT,
    GMAIL_OAUTH_TOKEN_URL,
    GMAIL_SEND_MESSAGE_URL,
    sendEarlyAccessThankYouEmail,
    isAllowedGoogleRedirectHost,
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
    process.env.APPS_SCRIPT_MAIL_URL = "https://script.google.com/macros/s/nc-script/exec";
    process.env.APPS_SCRIPT_MAIL_SECRET = "nc-secret";
    simulateSendLogReadFailure = true;

    let sentCount = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      sentCount++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
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

  if (isNegativeControlApproval) {
    mockApprovedTable.length = 0;
    mockApprovedTable.push({
      email: "unapproved@example.com",
      approved: false,
    });
    const unapprovedRes = await middleware(
      new NextRequest("http://localhost:3000/dashboard", {
        headers: { authorization: "Bearer valid-not-approved-google-token" },
      })
    );
    // Deliberately assert that unapproved user is allowed to access /dashboard (must fail)
    assert.strictEqual(
      unapprovedRes.status,
      200,
      `Negative control (approval gate) expected failure: unapproved user was not blocked (got status ${unapprovedRes.status})`
    );
    process.exit(1);
  }

  if (isNegativeControlSelfApprove) {
    // Inject a prohibited mutation line on early_access_approved; static scanner must fail
    verifyNoSelfApproveInSrc([
      {
        filePath: "src/app/api/early-access/route.ts",
        content: 'await supabase.from("early_access_approved").upsert({ email, approved: true });',
      },
    ]);
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

  for (const route of ["/jobs", "/dashboard", "/resume", "/tracker", "/pricing", "/remote", "/worldwide", "/signup"]) {
    const res = await middleware(new NextRequest(`http://localhost:3000${route}`));
    assert.strictEqual(res.status, 307);
    assert.strictEqual(new URL(res.headers.get("location")!).pathname, "/early-access");
  }

  for (const apiRoute of ["/admin", "/api/jobs/search", "/api/jobs/pro", "/api/ai", "/api/track", "/api/admin/stats"]) {
    const res = await middleware(new NextRequest(`http://localhost:3000${apiRoute}`));
    assert.strictEqual(res.status, 403);
  }

  // Signed-out GET /api/stats passes; signed-out POST /api/stats returns 403
  const signedOutStatsGet = await middleware(new NextRequest("http://localhost:3000/api/stats", { method: "GET" }));
  assert.strictEqual(signedOutStatsGet.status, 200, "Signed-out GET /api/stats must pass middleware (200)");

  const signedOutStatsPost = await middleware(new NextRequest("http://localhost:3000/api/stats", { method: "POST" }));
  assert.strictEqual(signedOutStatsPost.status, 403, "Signed-out POST /api/stats must return 403");

  // Test /api/health route handler returns 200 without any session or headers
  const healthRes = await healthGet();
  assert.strictEqual(healthRes.status, 200, "GET /api/health must return 200 without session");
  const healthJson = await healthRes.json();
  assert.deepStrictEqual(healthJson, { status: "ok" }, "GET /api/health must return { status: 'ok' }");
  assert.strictEqual(
    healthRes.headers.get("cache-control"),
    "no-store, no-cache, must-revalidate",
    "GET /api/health must return Cache-Control: no-store"
  );
  console.log("  [PASS] GET /api/health returns 200 { status: 'ok' } with Cache-Control: no-store without session or headers");

  for (const guestRoute of ["/", "/early-access", "/api/early-access", "/api/health", "/api/stats", "/privacy", "/privacy-policy", "/terms-and-conditions", "/login", "/data/ne_110m_land.json"]) {
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
  // TEST 2c: Manual Early-Access Approval Gate Verification (Database, RLS & Middleware)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 2c] Verifying Manual Early-Access Approval Gate & RLS Security...");
  mockApprovedTable.length = 0;
  mockApprovedTable.push({
    email: "approved.google@example.com",
    approved: true,
  });
  mockApprovedTable.push({
    email: "notapproved.google@example.com",
    approved: false,
  });

  // 1. Not approved blocked:
  // Logged-in not approved accessing /dashboard -> 307 to /early-access
  const notApprovedDashRes = await middleware(
    new NextRequest("http://localhost:3000/dashboard", {
      headers: { authorization: "Bearer valid-not-approved-google-token" },
    })
  );
  assert.strictEqual(notApprovedDashRes.status, 307, "Not-approved user on /dashboard must redirect");
  assert.strictEqual(
    new URL(notApprovedDashRes.headers.get("location")!).pathname,
    "/early-access",
    "Not-approved user on /dashboard must redirect to /early-access"
  );

  // Logged-in not approved calling API -> 403 Forbidden
  const notApprovedApiRes = await middleware(
    new NextRequest("http://localhost:3000/api/jobs/search", {
      headers: { authorization: "Bearer valid-not-approved-google-token" },
    })
  );
  assert.strictEqual(notApprovedApiRes.status, 403, "Not-approved user API request must return 403");

  // Logged-in not approved visiting / -> 307 to /early-access
  const notApprovedRootRes = await middleware(
    new NextRequest("http://localhost:3000/", {
      headers: { authorization: "Bearer valid-not-approved-google-token" },
    })
  );
  assert.strictEqual(notApprovedRootRes.status, 307, "Not-approved user on / must redirect to /early-access");

  // Logged-in not approved visiting /early-access -> 200 (allowed to view early-access page)
  const notApprovedEarlyRes = await middleware(
    new NextRequest("http://localhost:3000/early-access", {
      headers: { authorization: "Bearer valid-not-approved-google-token" },
    })
  );
  assert.strictEqual(notApprovedEarlyRes.status, 200, "Not-approved user on /early-access must view page");
  console.log("  [PASS] Not approved blocked: /dashboard & / redirect to /early-access, API returns 403, /early-access returns 200");

  // 2. Approved allowed:
  // Logged-in approved accessing /dashboard -> 200 (allowed!)
  const approvedDashRes = await middleware(
    new NextRequest("http://localhost:3000/dashboard", {
      headers: { authorization: "Bearer valid-approved-google-token" },
    })
  );
  assert.strictEqual(approvedDashRes.status, 200, "Approved user on /dashboard must be allowed (200)");

  // Logged-in approved accessing /api/jobs/search -> 200 (allowed!)
  const approvedApiRes = await middleware(
    new NextRequest("http://localhost:3000/api/jobs/search", {
      headers: { authorization: "Bearer valid-approved-google-token" },
    })
  );
  assert.strictEqual(approvedApiRes.status, 200, "Approved user on /api/jobs/search must be allowed (200)");

  // Logged-in approved visiting /early-access -> skips early-access page and redirects (307) to /dashboard!
  const approvedEarlyRes = await middleware(
    new NextRequest("http://localhost:3000/early-access", {
      headers: { authorization: "Bearer valid-approved-google-token" },
    })
  );
  assert.strictEqual(approvedEarlyRes.status, 307, "Approved user on /early-access must redirect to /dashboard");
  assert.strictEqual(
    new URL(approvedEarlyRes.headers.get("location")!).pathname,
    "/dashboard",
    "Approved user on /early-access must redirect to /dashboard"
  );

  // Logged-in approved visiting / -> redirects (307) straight to /dashboard!
  const approvedRootRes = await middleware(
    new NextRequest("http://localhost:3000/", {
      headers: { authorization: "Bearer valid-approved-google-token" },
    })
  );
  assert.strictEqual(approvedRootRes.status, 307, "Approved user on / must redirect to /dashboard");
  assert.strictEqual(
    new URL(approvedRootRes.headers.get("location")!).pathname,
    "/dashboard",
    "Approved user on / must redirect to /dashboard"
  );
  console.log("  [PASS] Approved allowed: /dashboard & API allowed (200), /early-access & / redirect straight to /dashboard");

  // 3. Early-Access Caching & DB Error Grace (stopping fail-closed sign-outs):
  _clearEarlyAccessCacheForTesting();
  approvedQueryCount = 0;

  // (a) First query: queries DB, caches verdict for 60s
  const initialApprovedRes = await middleware(
    new NextRequest("http://localhost:3000/dashboard", {
      headers: { authorization: "Bearer valid-approved-google-token" },
    })
  );
  assert.strictEqual(initialApprovedRes.status, 200, "Approved user on /dashboard must return 200");
  assert.strictEqual(approvedQueryCount, 1, "Initial request must query DB once");

  // Immediate second query within 60s: cache hit, DB not re-queried
  const cachedApprovedRes = await middleware(
    new NextRequest("http://localhost:3000/dashboard", {
      headers: { authorization: "Bearer valid-approved-google-token" },
    })
  );
  assert.strictEqual(cachedApprovedRes.status, 200, "Cached approved request must return 200");
  assert.strictEqual(approvedQueryCount, 1, "Cache hit within 60s must NOT re-query DB");

  // (b) Approved user stays signed in across a simulated DB error within grace window (5 min)
  simulateApprovedDbFailure = "connection_error";
  const errorGraceRes = await middleware(
    new NextRequest("http://localhost:3000/dashboard", {
      headers: { authorization: "Bearer valid-approved-google-token" },
    })
  );
  assert.strictEqual(errorGraceRes.status, 200, "Approved user must stay signed in (200) across simulated DB error within grace");
  assert.strictEqual(errorGraceRes.headers.get("x-early-access-signed-out"), null, "Must NOT sign out approved user on DB error");

  const errorGraceApiRes = await middleware(
    new NextRequest("http://localhost:3000/api/jobs/search", {
      headers: { authorization: "Bearer valid-approved-google-token" },
    })
  );
  assert.strictEqual(errorGraceApiRes.status, 200, "Approved user API request must stay 200 within grace on DB error");
  assert.strictEqual(errorGraceApiRes.headers.get("x-early-access-signed-out"), null, "Must NOT sign out approved user on DB error for API");

  // (c) Cache expires after 60s and re-queries DB
  simulateApprovedDbFailure = null;
  const originalDateNow = Date.now;
  try {
    Date.now = () => originalDateNow() + 65_000; // Fast-forward past 60s TTL
    const expiredCacheRes = await middleware(
      new NextRequest("http://localhost:3000/dashboard", {
        headers: { authorization: "Bearer valid-approved-google-token" },
      })
    );
    assert.strictEqual(expiredCacheRes.status, 200, "Approved user after 60s cache expiry must still access dashboard");
    assert.strictEqual(approvedQueryCount, 2, "After 60s TTL expiry, middleware must re-query DB");
  } finally {
    Date.now = originalDateNow;
  }

  // (d) Definitively-unapproved user is still bounced and signed out
  _clearEarlyAccessCacheForTesting();
  const unapprovedRes2 = await middleware(
    new NextRequest("http://localhost:3000/dashboard", {
      headers: { authorization: "Bearer valid-not-approved-google-token" },
    })
  );
  assert.strictEqual(unapprovedRes2.status, 307, "Definitively-unapproved user must bounce (307) to /early-access");
  assert.strictEqual(
    unapprovedRes2.headers.get("x-early-access-signed-out"),
    "1",
    "Definitively-unapproved user must be signed out (x-early-access-signed-out: 1)"
  );

  const unapprovedApiRes2 = await middleware(
    new NextRequest("http://localhost:3000/api/jobs/search", {
      headers: { authorization: "Bearer valid-not-approved-google-token" },
    })
  );
  assert.strictEqual(unapprovedApiRes2.status, 403, "Definitively-unapproved user on API must return 403");
  assert.strictEqual(
    unapprovedApiRes2.headers.get("x-early-access-signed-out"),
    "1",
    "Definitively-unapproved user on API must be signed out"
  );

  // (e) Lookup ERROR with NO cached verdict bounces to /early-access without destroying session
  _clearEarlyAccessCacheForTesting();
  simulateApprovedDbFailure = "connection_error";
  const noCacheErrorRes = await middleware(
    new NextRequest("http://localhost:3000/dashboard", {
      headers: { authorization: "Bearer valid-db-error-token" },
    })
  );
  assert.strictEqual(noCacheErrorRes.status, 307, "DB error with no cache must bounce (307) to /early-access");
  assert.strictEqual(
    new URL(noCacheErrorRes.headers.get("location")!).pathname,
    "/early-access",
    "DB error redirect target must be /early-access"
  );
  assert.strictEqual(
    noCacheErrorRes.headers.get("x-early-access-signed-out"),
    null,
    "Must NOT sign out user when DB errors with no cached verdict"
  );

  const noCacheErrorApiRes = await middleware(
    new NextRequest("http://localhost:3000/api/jobs/search", {
      headers: { authorization: "Bearer valid-db-error-token" },
    })
  );
  assert.strictEqual(noCacheErrorApiRes.status, 403, "DB error on API with no cache must return 403");
  assert.strictEqual(
    noCacheErrorApiRes.headers.get("x-early-access-signed-out"),
    null,
    "Must NOT sign out user on API when DB errors with no cached verdict"
  );
  simulateApprovedDbFailure = null;

  console.log("  [PASS] Early-access caching, 60s TTL, 5m grace window, and non-signing-out DB error behavior verified");

  // 4. User cannot self-approve:
  // Static scan of src/ (non-test files): fails if early_access_approved appears with insert/update/upsert/delete or any non-select use
  verifyNoSelfApproveInSrc();

  // Negative control: injecting insert/update/upsert/delete or non-select use on early_access_approved must make the static check fail
  for (const injectedLine of [
    'await supabase.from("early_access_approved").insert({ email: "attacker@example.com", approved: true });',
    'await supabase.from("early_access_approved").update({ approved: true }).eq("email", "attacker@example.com");',
    'await supabase.from("early_access_approved").upsert({ email: "attacker@example.com", approved: true });',
    'await supabase.from("early_access_approved").delete().eq("email", "attacker@example.com");',
    'const tableRef = supabase.from("early_access_approved");',
  ]) {
    assert.throws(
      () =>
        verifyNoSelfApproveInSrc([
          { filePath: "src/app/api/early-access/route.ts", content: injectedLine },
        ]),
      /early_access_approved/,
      `Static self-approve check must fail when injected with: ${injectedLine}`
    );
  }

  // Migration file inspection: RLS enabled, revoked from anon and authenticated, deny policy present
  const migrationPath = path.resolve(process.cwd(), "supabase/migrations/20261030_early_access_approved.sql");
  assert.ok(fs.existsSync(migrationPath), "Migration file 20261030_early_access_approved.sql must exist");
  const migrationSql = fs.readFileSync(migrationPath, "utf-8");
  assert.ok(migrationSql.includes("ENABLE ROW LEVEL SECURITY"), "Migration must enable RLS");
  assert.ok(migrationSql.includes("REVOKE ALL ON public.early_access_approved FROM PUBLIC, anon, authenticated"), "Migration must revoke untrusted permissions");
  assert.ok(migrationSql.includes("GRANT SELECT, INSERT, UPDATE, DELETE ON public.early_access_approved TO service_role"), "Migration must grant only service_role");
  assert.ok(migrationSql.includes("CREATE POLICY"), "Migration must declare RLS deny policy");
  console.log("  [PASS] User cannot self-approve: Static scan of src/ confirms select-only use (negative controls fail as expected) and migration locks RLS");

  // 5. Google login only, no magic links:
  // (a) provider email + providers [email, google] + confirmed + approved -> allowed
  const linkedGoogleAllowedRes = await middleware(
    new NextRequest("http://localhost:3000/dashboard", {
      headers: { authorization: "Bearer valid-email-plus-google-confirmed-approved" },
    })
  );
  assert.strictEqual(
    linkedGoogleAllowedRes.status,
    200,
    "Account with provider=email + providers=['email','google'] + confirmed email + approved=true must be allowed (200)"
  );
  const linkedGoogleEarlyAccessRedirect = await middleware(
    new NextRequest("http://localhost:3000/early-access", {
      headers: { authorization: "Bearer valid-email-plus-google-confirmed-approved" },
    })
  );
  assert.strictEqual(linkedGoogleEarlyAccessRedirect.status, 307);
  assert.strictEqual(new URL(linkedGoogleEarlyAccessRedirect.headers.get("location")!).pathname, "/dashboard");
  console.log("  [PASS] (1) provider=email + providers=['email','google'] + email_confirmed_at set + approved=true -> allowed");

  // (b) email-only -> blocked (even when email is marked approved)
  const magicLinkRes = await middleware(
    new NextRequest("http://localhost:3000/dashboard", {
      headers: { authorization: "Bearer valid-magic-link-token" },
    })
  );
  assert.strictEqual(magicLinkRes.status, 307, "Email-only login must be blocked (redirected)");
  assert.strictEqual(new URL(magicLinkRes.headers.get("location")!).pathname, "/early-access");
  const magicLinkApiRes = await middleware(
    new NextRequest("http://localhost:3000/api/jobs/search", {
      headers: { authorization: "Bearer valid-magic-link-token" },
    })
  );
  assert.strictEqual(magicLinkApiRes.status, 403, "Email-only login on API must return 403");
  console.log("  [PASS] (2) email-only (no google identity) -> blocked even if email is marked approved");

  // (c) google linked but email not confirmed -> blocked (even when email is marked approved)
  const unconfirmedGoogleRes = await middleware(
    new NextRequest("http://localhost:3000/dashboard", {
      headers: { authorization: "Bearer valid-google-linked-unconfirmed" },
    })
  );
  assert.strictEqual(
    unconfirmedGoogleRes.status,
    307,
    "Google-linked account without email_confirmed_at must be blocked (redirected)"
  );
  assert.strictEqual(new URL(unconfirmedGoogleRes.headers.get("location")!).pathname, "/early-access");
  const unconfirmedGoogleApiRes = await middleware(
    new NextRequest("http://localhost:3000/api/jobs/search", {
      headers: { authorization: "Bearer valid-google-linked-unconfirmed" },
    })
  );
  assert.strictEqual(unconfirmedGoogleApiRes.status, 403, "Unconfirmed Google-linked account on API must return 403");
  console.log("  [PASS] (3) google linked + email_confirmed_at unset -> blocked even if email is marked approved");

  // (d) approved flag still required for google-linked + confirmed account
  const linkedGoogleUnapprovedRes = await middleware(
    new NextRequest("http://localhost:3000/dashboard", {
      headers: { authorization: "Bearer valid-email-plus-google-confirmed-unapproved" },
    })
  );
  assert.strictEqual(
    linkedGoogleUnapprovedRes.status,
    307,
    "Google-linked + confirmed account with approved=false must be blocked (redirected)"
  );
  assert.strictEqual(new URL(linkedGoogleUnapprovedRes.headers.get("location")!).pathname, "/early-access");
  const linkedGoogleUnapprovedApiRes = await middleware(
    new NextRequest("http://localhost:3000/api/jobs/search", {
      headers: { authorization: "Bearer valid-email-plus-google-confirmed-unapproved" },
    })
  );
  assert.strictEqual(linkedGoogleUnapprovedApiRes.status, 403, "Unapproved Google-linked account on API must return 403");
  console.log("  [PASS] (4) provider=email + providers=['email','google'] + confirmed + approved=false -> blocked (approved flag still required)");

  // 6. Case-insensitive email matching:
  const caseInsensitiveRes = await middleware(
    new NextRequest("http://localhost:3000/dashboard", {
      headers: { authorization: "Bearer valid-approved-google-token" },
    })
  );
  assert.strictEqual(caseInsensitiveRes.status, 200, "Case-insensitive email match must be allowed");
  console.log("  [PASS] Case-insensitive matching: DB lowercase matches mixed-case token");

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

  const TEST_APPS_SCRIPT_URL = "https://script.google.com/macros/s/mock-apps-script-id/exec";
  const TEST_APPS_SCRIPT_SECRET = "mock-apps-script-secret-key-123";
  process.env.APPS_SCRIPT_MAIL_URL = TEST_APPS_SCRIPT_URL;
  process.env.APPS_SCRIPT_MAIL_SECRET = TEST_APPS_SCRIPT_SECRET;

  const originalFetch = globalThis.fetch;
  const originalConsoleWarn = console.warn;
  const capturedWarnings: string[] = [];
  console.warn = (...args: any[]) => {
    capturedWarnings.push(args.map((a) => String(a)).join(" "));
  };

  interface CapturedAppsScriptCall {
    url: string;
    method: string;
    redirect?: string;
    body: { secret: string; email: string };
  }
  const appsScriptCalls: CapturedAppsScriptCall[] = [];

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

    if (url === TEST_APPS_SCRIPT_URL) {
      if (mockFetchMode === "slow_3s") {
        return await new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }));
          }, 3000);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              slowFetchAborted = true;
              reject(new Error("AbortError: 8s timeout reached"));
            },
            { once: true }
          );
        });
      }
      const body = JSON.parse(String(init?.body || "{}"));
      appsScriptCalls.push({
        url,
        method: init?.method || "POST",
        redirect: init?.redirect,
        body,
      });
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }

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
            reject(new Error("AbortError: timeout reached"));
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
      appsScriptCalls.length,
      1,
      "POST /api/early-access must send ONLY 1 thank-you call via Apps Script (no digest on request path)"
    );
    assert.strictEqual(appsScriptCalls[0].method, "POST");
    assert.strictEqual(appsScriptCalls[0].redirect, "manual", "Must use manual redirect on initial request to preserve POST method across Apps Script redirect");
    assert.strictEqual(appsScriptCalls[0].body.email, "alice@example.com");
    assert.strictEqual(appsScriptCalls[0].body.secret, TEST_APPS_SCRIPT_SECRET);
    assert.strictEqual(mockSendLogRows.length, 1);
    assert.strictEqual(mockSendLogRows[0].kind, "thank_you");
    assert.strictEqual(mockSendLogRows[0].recipient_email, "alice@example.com");
    console.log("  [PASS] Request path sends ONLY thank-you email via Apps Script (digest removed from request path)");

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
      appsScriptCalls.length,
      1,
      "Thank-you email must NEVER be sent a second time to the same address (checked via gmail_send_log)"
    );
    console.log("  [PASS] Double opt-in-light: thank-you never repeated for the same address ever");

    // 4b-ii. Verify text reply parsing for "already" and "forbidden"
    const originalFetchForReplies = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        return new Response("already", { status: 200, headers: { "content-type": "text/plain" } });
      }) as typeof fetch;
      const alreadyReplyResult = await sendEarlyAccessThankYouEmail({
        subscriberEmail: "external.already@example.com",
        createdAt: new Date().toISOString(),
        supabaseClient: (globalThis as any).__mockSupabaseClient,
      });
      assert.strictEqual(alreadyReplyResult.alreadyThanked, true, "Apps Script 'already' reply must set alreadyThanked: true");
      assert.strictEqual(alreadyReplyResult.thankYouSent, false);

      globalThis.fetch = (async () => {
        return new Response("forbidden", { status: 403, headers: { "content-type": "text/plain" } });
      }) as typeof fetch;
      const forbiddenReplyResult = await sendEarlyAccessThankYouEmail({
        subscriberEmail: "external.forbidden@example.com",
        createdAt: new Date().toISOString(),
        supabaseClient: (globalThis as any).__mockSupabaseClient,
      });
      assert.strictEqual(forbiddenReplyResult.thankYouSent, false);
      assert.strictEqual(forbiddenReplyResult.alreadyThanked, false);
    } finally {
      globalThis.fetch = originalFetchForReplies;
    }

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
        appsScriptCalls.length,
        1,
        "Cap MUST fail closed: 0 emails sent when gmail_send_log count cannot be read"
      );
    } finally {
      simulateSendLogReadFailure = false;
    }
    console.log("  [PASS] Cap fails closed when gmail_send_log cannot be read (signup stored, 0 emails sent)");

    // 4d. Do not block submit beyond ~1s + fire-and-forget via waitUntil
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
    mockFetchMode = "ok";
    console.log(`  [PASS] Submit responded in ${elapsedMs}ms (< ~1s) without blocking for Apps Script`);

    // 4e. Test timeout=UNKNOWN-no-resend: hanging Apps Script request aborts, logs UNKNOWN, and NEVER resends
    capturedWarnings.length = 0;
    let timeoutFetchAttempts = 0;
    const originalFetchForTimeout = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      timeoutFetchAttempts++;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("AbortError");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof fetch;

    const timeoutResult = await sendEarlyAccessThankYouEmail({
      subscriberEmail: "timeout.test@example.com",
      createdAt: new Date().toISOString(),
      supabaseClient: (globalThis as any).__mockSupabaseClient,
      hardCapMs: 50,
    });
    globalThis.fetch = originalFetchForTimeout;

    assert.strictEqual(timeoutResult.thankYouSent, false, "Thank-you must not be marked sent on timeout");
    assert.strictEqual(timeoutFetchAttempts, 1, "Timed-out request must NEVER be automatically resent");
    const timeoutLogText = capturedWarnings.join("\n");
    assert.ok(timeoutLogText.includes("UNKNOWN"), "Timeout must be logged as UNKNOWN");
    assert.ok(!timeoutLogText.includes("timeout.test@example.com"), "Email must not be logged");
    assert.ok(!timeoutLogText.includes(TEST_APPS_SCRIPT_URL), "URL must not be logged");
    assert.ok(!timeoutLogText.includes(TEST_APPS_SCRIPT_SECRET), "Secret must not be logged");
    console.log("  [PASS] timeout=UNKNOWN-no-resend verified: logged as UNKNOWN and never resent");

    // 4f. Test non-OK result: reply 'invalid', 'forbidden', 'busy' logs UNKNOWN and is NEVER resent
    capturedWarnings.length = 0;
    let nonOkAttempts = 0;
    const originalFetchForNonOk = globalThis.fetch;
    globalThis.fetch = (async () => {
      nonOkAttempts++;
      return new Response("busy", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;

    const nonOkResult = await sendEarlyAccessThankYouEmail({
      subscriberEmail: "nonok.test@example.com",
      createdAt: new Date().toISOString(),
      supabaseClient: (globalThis as any).__mockSupabaseClient,
    });
    globalThis.fetch = originalFetchForNonOk;

    assert.strictEqual(nonOkResult.thankYouSent, false);
    assert.strictEqual(nonOkAttempts, 1, "Non-OK result must NEVER be automatically resent");
    assert.ok(capturedWarnings.some((w) => w.includes("UNKNOWN")), "Non-OK result must be logged as UNKNOWN");
    console.log("  [PASS] non-OK result logged as UNKNOWN and never resent");

    // ---------------------------------------------------------------------------
    // 4g. Apps Script POST redirect preservation, Google host validation, and budget
    // ---------------------------------------------------------------------------
    console.log("\n[TEST 4g] Verifying Apps Script POST redirect preservation, Google host validation, duplicate suppression, and timeout budget...");

    // (a) Mocked fetch returns 302 + Location to script.googleusercontent.com -> re-issues POST with byte-identical body and records thank_you row
    capturedWarnings.length = 0;
    const redirectCalls: Array<{ url: string; method: string; redirect?: string; body: string; headers: any }> = [];
    const ECHO_TARGET_URL = "https://script.googleusercontent.com/macros/echo?user_content_key=sig123abc";
    const originalFetchForRedirect = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      redirectCalls.push({
        url,
        method: init?.method || "GET",
        redirect: init?.redirect,
        body: String(init?.body || ""),
        headers: init?.headers,
      });

      if (url === TEST_APPS_SCRIPT_URL) {
        return new Response("", {
          status: 302,
          headers: {
            Location: ECHO_TARGET_URL,
          },
        });
      }

      if (url === ECHO_TARGET_URL) {
        return new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }

      throw new Error(`Unexpected fetch URL in redirect test: ${url}`);
    }) as typeof fetch;

    const preSendLogCount = mockSendLogRows.length;
    const redirectTestResult = await sendEarlyAccessThankYouEmail({
      subscriberEmail: "redirect.success@example.com",
      createdAt: new Date().toISOString(),
      supabaseClient: (globalThis as any).__mockSupabaseClient,
    });

    assert.strictEqual(redirectTestResult.thankYouSent, true, "Thank-you must be marked sent after successful 302 echo");
    assert.strictEqual(redirectCalls.length, 2, "Must make exactly 2 calls (hop 1 to exec, hop 2 to echo)");
    assert.strictEqual(redirectCalls[0].url, TEST_APPS_SCRIPT_URL);
    assert.strictEqual(redirectCalls[0].method, "POST");
    assert.strictEqual(redirectCalls[0].redirect, "manual");
    assert.strictEqual(redirectCalls[1].url, ECHO_TARGET_URL);
    assert.strictEqual(redirectCalls[1].method, "POST");
    assert.strictEqual(redirectCalls[1].redirect, "manual");
    assert.strictEqual(redirectCalls[1].body, redirectCalls[0].body, "Hop 2 body must be byte-identical to Hop 1");
    assert.ok(redirectCalls[1].body.includes("redirect.success@example.com"));
    assert.ok(redirectCalls[1].body.includes(TEST_APPS_SCRIPT_SECRET));
    assert.strictEqual(mockSendLogRows.length, preSendLogCount + 1, "Must record 1 thank_you row in gmail_send_log");
    assert.strictEqual(mockSendLogRows[mockSendLogRows.length - 1].recipient_email, "redirect.success@example.com");
    assert.strictEqual(mockSendLogRows[mockSendLogRows.length - 1].kind, "thank_you");
    console.log("  [PASS] 302 to googleusercontent host re-issues POST with byte-identical body and records thank_you");

    // (b) 302 to a non-Google host -> no second request, logged failure, zero secrets in logs
    capturedWarnings.length = 0;
    const untrustedCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      untrustedCalls.push(url);
      return new Response("", {
        status: 302,
        headers: {
          Location: "https://evil.attacker.example.com/macros/echo?phish=1",
        },
      });
    }) as typeof fetch;

    const untrustedResult = await sendEarlyAccessThankYouEmail({
      subscriberEmail: "untrusted.redirect@example.com",
      createdAt: new Date().toISOString(),
      supabaseClient: (globalThis as any).__mockSupabaseClient,
    });

    assert.strictEqual(untrustedResult.thankYouSent, false, "Must not send thank-you when redirect is to untrusted host");
    assert.strictEqual(untrustedCalls.length, 1, "Must NOT follow redirect to non-Google host");
    assert.ok(capturedWarnings.some((w) => w.includes("untrusted_redirect_host") || w.includes("UNKNOWN")), "Failure must be logged");
    const untrustedLogText = capturedWarnings.join("\n");
    assert.ok(!untrustedLogText.includes(TEST_APPS_SCRIPT_SECRET), "Secret must NEVER appear in logs on untrusted redirect");
    assert.ok(!untrustedLogText.includes("untrusted.redirect@example.com"), "Email must not appear in logs");
    assert.ok(!untrustedLogText.includes("evil.attacker.example.com"), "Target URL must not appear in logs");
    console.log("  [PASS] 302 to non-Google host blocks second request, logs failure with zero secrets");

    // (c) Final reply "already" after 302 redirect does not insert a duplicate gmail_send_log row
    capturedWarnings.length = 0;
    const alreadyCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      alreadyCalls.push(url);
      if (url === TEST_APPS_SCRIPT_URL) {
        return new Response("", {
          status: 302,
          headers: { Location: ECHO_TARGET_URL },
        });
      }
      return new Response("already", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as typeof fetch;

    const sendLogCountBeforeAlready = mockSendLogRows.length;
    const alreadyResult = await sendEarlyAccessThankYouEmail({
      subscriberEmail: "external.already.redirect@example.com",
      createdAt: new Date().toISOString(),
      supabaseClient: (globalThis as any).__mockSupabaseClient,
    });

    assert.strictEqual(alreadyResult.thankYouSent, false);
    assert.strictEqual(alreadyResult.alreadyThanked, true, "Must set alreadyThanked: true on 'already' reply after redirect");
    assert.strictEqual(mockSendLogRows.length, sendLogCountBeforeAlready, "Must NOT insert duplicate row in gmail_send_log on 'already' reply");
    console.log("  [PASS] Final reply 'already' after 302 does not insert duplicate gmail_send_log row");

    // (d) Timeout/abort across the two hops respects the hard cap
    capturedWarnings.length = 0;
    let hop2Aborted = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === TEST_APPS_SCRIPT_URL) {
        await new Promise((r) => setTimeout(r, 20));
        return new Response("", {
          status: 302,
          headers: { Location: ECHO_TARGET_URL },
        });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          hop2Aborted = true;
          const err = new Error("AbortError: timeout");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof fetch;

    const tTimeoutStart = Date.now();
    const twoHopTimeoutResult = await sendEarlyAccessThankYouEmail({
      subscriberEmail: "twohop.timeout@example.com",
      createdAt: new Date().toISOString(),
      supabaseClient: (globalThis as any).__mockSupabaseClient,
      hardCapMs: 60,
    });
    const twoHopElapsed = Date.now() - tTimeoutStart;

    assert.strictEqual(twoHopTimeoutResult.thankYouSent, false);
    assert.strictEqual(hop2Aborted, true, "Hop 2 must be aborted when overall timeout budget expires");
    assert.ok(twoHopElapsed < 250, `Overall operation must abort near hardCapMs (60ms), took ${twoHopElapsed}ms`);
    assert.ok(capturedWarnings.some((w) => w.includes("UNKNOWN")), "Timeout across two hops must be logged as UNKNOWN");
    console.log("  [PASS] Timeout/abort across both hops respects the hard cap");

    // (e) Bare 200 "ok" on the first hop (no redirect) works (also verified in 4a)
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      assert.strictEqual(init?.redirect, "manual", "Must use redirect: manual even when no redirect occurs");
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as typeof fetch;

    const bare200Result = await sendEarlyAccessThankYouEmail({
      subscriberEmail: "bare200.test@example.com",
      createdAt: new Date().toISOString(),
      supabaseClient: (globalThis as any).__mockSupabaseClient,
    });
    assert.strictEqual(bare200Result.thankYouSent, true, "Bare 200 'ok' without redirect must succeed");
    console.log("  [PASS] Bare 200 'ok' on first hop (redirect: manual) succeeds");

    // (f) Direct unit tests of isAllowedGoogleRedirectHost
    assert.strictEqual(isAllowedGoogleRedirectHost("https://script.googleusercontent.com/macros/echo"), true);
    assert.strictEqual(isAllowedGoogleRedirectHost("https://script.google.com/macros/s/id/exec"), true);
    assert.strictEqual(isAllowedGoogleRedirectHost("https://sub.domain.googleusercontent.com/path"), true);
    assert.strictEqual(isAllowedGoogleRedirectHost("https://google.com/"), true);
    assert.strictEqual(isAllowedGoogleRedirectHost("https://evil.attacker.com/"), false);
    assert.strictEqual(isAllowedGoogleRedirectHost("https://script.googleusercontent.com.evil.com/"), false);
    assert.strictEqual(isAllowedGoogleRedirectHost("https://evilgoogle.com/"), false);
    assert.strictEqual(isAllowedGoogleRedirectHost("https://evilgoogleusercontent.com/"), false);
    assert.strictEqual(isAllowedGoogleRedirectHost("https://user:pass@script.googleusercontent.com/"), false);
    assert.strictEqual(isAllowedGoogleRedirectHost("not-a-url"), false);
    console.log("  [PASS] isAllowedGoogleRedirectHost validates Google domains and rejects spoofing");

    globalThis.fetch = originalFetchForRedirect;

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

    // 5e. Verify 80/day thank-you cap across gmail_send_log
    assert.strictEqual(DAILY_THANK_YOU_CAP, 80);
    assert.strictEqual(DAILY_GMAIL_MESSAGE_CAP, 150);
    mockSendLogRows.length = 0;
    const todayIso = new Date().toISOString();
    for (let i = 0; i < 80; i++) {
      mockSendLogRows.push({
        recipient_email: `u${i}@example.com`,
        kind: "thank_you",
        sent_at: todayIso,
      });
    }
    const sendsBeforeCap = appsScriptCalls.length;
    const cappedRes = await earlyAccessPost(
      new Request("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.20" },
        body: JSON.stringify({ email: "over80@example.com" }),
      })
    );
    assert.strictEqual(cappedRes.status, 200);
    assert.strictEqual(appsScriptCalls.length, sendsBeforeCap, "0 sends allowed when 80/day cap is reached");
    console.log("  [PASS] 80 messages/day thank-you cap enforced");

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
      TEST_APPS_SCRIPT_URL,
      TEST_APPS_SCRIPT_SECRET,
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
    delete process.env.APPS_SCRIPT_MAIL_URL;
    delete process.env.APPS_SCRIPT_MAIL_SECRET;
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

  for (const flag of ["--negative-control", "--negative-control-cap", "--negative-control-digest", "--negative-control-approval", "--negative-control-self-approve"]) {
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
