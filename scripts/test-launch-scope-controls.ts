/**
 * scripts/test-launch-scope-controls.ts
 *
 * Verification suite for the product restore after the #644 launch-scope gates:
 * 1. Restored routes (/api/ai, /api/ai/stream, /api/jobs/top10, /api/me/quota, Netlify ai & jobs-top10)
 *    require auth and never return FEATURE_COMING_SOON; radar / interview-pack / skill-what-if carry no gate.
 *    The daily AI matching digest cron intentionally stays gated. Profile save is restored and keyed on
 *    the verified session user.
 * 2. Billing verify fail-closed on both hosts (unchanged).
 * 3. Free vs Pro handlers: see src/lib/__tests__/launchFreeVsProHandlers.test.ts (vitest).
 * 4. Real RLS in PGlite: 20261116c gates then the 20261120a restore proposal (idempotent): anon blocked,
 *    owner-only access, no cross-user read/write/delete, user_id not re-pointable, tailored_resumes
 *    still blocked, service role intact.
 * 5. Restored pages are real, /dashboard only redirects to /jobs, and no AI tool entry points remain.
 * 6. Negative control included.
 *
 * Run: npx tsx scripts/test-launch-scope-controls.ts
 * Negative control mode: npx tsx scripts/test-launch-scope-controls.ts --negative-control
 */

import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import Module from "module";

// @cloudflare/next-on-pages has no Node entry; restored /api/ai routes import it statically.
// Same in-test shim as scripts/test-env-guards.ts (registered before those routes load below).
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, parent: any, isMain: boolean, options: any) {
  if (request === "@cloudflare/next-on-pages") return "virtual:@cloudflare/next-on-pages";
  return originalResolve.call(this, request, parent, isMain, options);
};
require.cache["virtual:@cloudflare/next-on-pages"] = {
  id: "virtual:@cloudflare/next-on-pages",
  filename: "virtual:@cloudflare/next-on-pages",
  loaded: true,
  exports: { getRequestContext: () => (globalThis as any)[Symbol.for("__cloudflare-request-context__")] },
} as any;

// Next.js API Routes under test
import { POST as postTop10 } from "../src/app/api/jobs/top10/route";
import { GET as getQuota } from "../src/app/api/me/quota/route";
import { POST as verifyNextPost } from "../src/app/api/billing/razorpay/verify/route";
type RouteHandler = (req: Request) => Promise<Response>;
let postAi: RouteHandler;
let postAiStream: RouteHandler;

// Netlify serverless functions under test
import { handler as netlifyAiHandler } from "../netlify/functions/ai";
import { handler as netlifyTop10Handler } from "../netlify/functions/jobs-top10";
import { createHandler as createNetlifyVerifyHandler } from "../netlify/functions/billing-razorpay-verify";

// Libs under test
import { runDailyDigestCron } from "../src/lib/cron/dailyDigestCron";

const TEST_SECRET = "test_webhook_and_verify_secret_123456";
const TEST_KEY_ID = "rzp_test_key_1234567890";

function computeSignature(orderId: string, paymentId: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

function createMockSupabaseForVerify(orderRow: any, subRow: any = null) {
  let fulfilled = false;
  let orderStatus = orderRow.status;
  return {
    client: {
      auth: {
        getUser: async () => ({
          data: { user: { id: orderRow.user_id, email: "user@example.com" } },
          error: null,
        }),
      },
      from: (table: string) => ({
        select: () => ({
          eq: (_col: string, val: any) => ({
            eq: (_col2: string, _val2: any) => ({
              maybeSingle: async () => ({
                data: table === "payment_orders" ? { ...orderRow, status: orderStatus } : subRow,
                error: null,
              }),
            }),
            maybeSingle: async () => ({
              data: table === "payment_orders" ? { ...orderRow, status: orderStatus } : subRow,
              error: null,
            }),
          }),
        }),
      }),
      rpc: async (fnName: string, args: any) => {
        if (fnName === "fulfil_payment_order") {
          fulfilled = true;
          orderStatus = "paid";
          return {
            data: {
              success: true,
              is_pro: true,
              expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
            },
            error: null,
          };
        }
        return { data: null, error: new Error(`Unknown RPC ${fnName}`) };
      },
    },
    wasFulfilled: () => fulfilled,
  };
}

async function runSuite() {
  const isNegativeControl = process.argv.includes("--negative-control");

  console.log("================================================================================");
  console.log("             LAUNCH SCOPE CONTROLS & SECURITY TEST SUITE                        ");
  console.log("================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Proving non-zero exit)" : "NORMAL VALIDATION"}\n`);

  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL MODE] Verifying negative control failure detection...");
    assert.strictEqual(
      1 + 1,
      3,
      "Negative control triggered: 1 + 1 must be 2, not 3."
    );
    return;
  }

  // Preserve env
  const origBilling = process.env.NEXT_PUBLIC_BILLING_ENABLED;
  const origKeyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  const origKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const origMode = process.env.RAZORPAY_MODE;
  const origServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const origGroqKey = process.env.GROQ_API_KEY;
  const origSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  try {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = TEST_KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = TEST_SECRET;
    process.env.RAZORPAY_MODE = "test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "mock_service_role_key";
    process.env.GROQ_API_KEY = "mock_groq_api_key";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";

    // =========================================================================
    // SECTION 1: Restored routes require auth/entitlement and are never Coming Soon
    // =========================================================================
    console.log("--- Section 1: Restored Routes (auth required, no Coming Soon gate) ---");
    // In-memory limiter so the shared (Supabase) rate-limit store is not needed offline.
    process.env.__CAREERMONKE_LEGACY_RATE_LIMIT = "true";
    postAi = (await import("../src/app/api/ai/route")).POST;
    postAiStream = (await import("../src/app/api/ai/stream/route")).POST;

    async function assertRestoredRouteRejectsAnonymous(
      name: string,
      handler: (req: Request) => Promise<Response>,
      url: string,
      method: "GET" | "POST",
      body?: any
    ) {
      const req = new Request(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const res = await handler(req);
      const data = await res.json().catch(() => ({}));
      assert.notStrictEqual(data?.code, "FEATURE_COMING_SOON", `${name} must no longer return FEATURE_COMING_SOON`);
      assert.ok(res.status === 401 || res.status === 403, `${name} ${method} without a session must be 401/403, got ${res.status}`);
      console.log(`  [PASS] ${name} (${method}) anonymous -> ${res.status} (restored, auth required)`);
    }

    await assertRestoredRouteRejectsAnonymous("/api/ai", postAi, "http://localhost:3000/api/ai", "POST", { action: "tailor" });
    await assertRestoredRouteRejectsAnonymous("/api/ai/stream", postAiStream, "http://localhost:3000/api/ai/stream", "POST", { action: "tailor" });
    await assertRestoredRouteRejectsAnonymous("/api/jobs/top10", postTop10, "http://localhost:3000/api/jobs/top10", "POST", {});
    await assertRestoredRouteRejectsAnonymous("/api/me/quota", getQuota, "http://localhost:3000/api/me/quota", "GET");

    const netAiRes = await netlifyAiHandler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "tailor" }) } as any);
    assert.notStrictEqual(JSON.parse(netAiRes.body || "{}").code, "FEATURE_COMING_SOON", "Netlify ai must not be Coming Soon");
    assert.ok(netAiRes.statusCode === 401 || netAiRes.statusCode === 403, `Netlify ai anonymous must be 401/403, got ${netAiRes.statusCode}`);
    console.log(`  [PASS] Netlify ai anonymous -> ${netAiRes.statusCode}`);

    const netTop10Res = await netlifyTop10Handler({ httpMethod: "GET", headers: {} } as any);
    assert.notStrictEqual(JSON.parse(netTop10Res.body || "{}").code, "FEATURE_COMING_SOON", "Netlify jobs-top10 must not be Coming Soon");
    assert.ok(netTop10Res.statusCode === 401 || netTop10Res.statusCode === 403, `Netlify jobs-top10 anonymous must be 401/403, got ${netTop10Res.statusCode}`);
    console.log(`  [PASS] Netlify jobs-top10 anonymous -> ${netTop10Res.statusCode}`);

    // Routes whose auth/entitlement paths are exercised by their own suites
    // (test-interview-pack, test-skill-what-if): no Coming Soon gate may remain in source.
    for (const rel of [
      "src/app/api/radar/route.ts",
      "src/app/api/jobs/interview-pack/route.ts",
      "src/app/api/jobs/skill-what-if/route.ts",
    ]) {
      const src = fs.readFileSync(path.resolve(__dirname, "..", rel), "utf-8");
      assert.ok(!src.includes("FEATURE_COMING_SOON"), `${rel} must not keep the #644 Coming Soon gate`);
    }
    console.log("  [PASS] radar / interview-pack / skill-what-if routes carry no Coming Soon gate");

    // 1.3 Daily matching/digest workflow stays gated (intentional exception: the AI digest is not restored)
    const digestStats = await runDailyDigestCron({ dryRun: true });
    assert.strictEqual(digestStats.status, "coming_soon", "runDailyDigestCron must stay gated");
    assert.strictEqual(digestStats.digestsQueuedCount, 0, "runDailyDigestCron must queue 0 digests");
    console.log("  [PASS] 1.3 Daily AI matching digest cron stays gated (no mail queued or sent)");

    // 1.4 Profile save restored, write-safe: no Coming Soon throw; DB write only for the session user
    const storageSrc = fs.readFileSync(path.resolve(__dirname, "../src/lib/resume/storage.ts"), "utf-8");
    const saveFn = storageSrc.slice(
      storageSrc.indexOf("export async function saveConfirmedCandidateProfile"),
      storageSrc.indexOf("export function getScopedTailoredResumeKey")
    );
    assert.ok(!/coming soon/i.test(saveFn), "saveConfirmedCandidateProfile must not throw Coming Soon");
    assert.ok(saveFn.includes("if (user)") && saveFn.includes("user_id: user.id"), "profile upsert must be keyed on the session user only");
    assert.ok(!saveFn.includes("user_id: profile."), "profile upsert must never take user_id from the payload");
    console.log("  [PASS] 1.4 Candidate profile save restored and keyed on the verified session user");

    // =========================================================================
    // SECTION 2: Billing Verify Server-Side Capture Checks (Fail Closed on Both Hosts)
    // =========================================================================
    console.log("\n--- Section 2: Billing Verify Fail-Closed & Capture Checks (Next & Netlify) ---");

    const testOrderId = "order_test_scope_101";
    const testPaymentId = "pay_test_scope_202";
    const testSig = computeSignature(testOrderId, testPaymentId, TEST_SECRET);
    const validOrderRow = {
      id: "po_123",
      user_id: "usr_scope_1",
      provider: "razorpay",
      provider_order_id: testOrderId,
      plan_code: "monthly",
      addon_code: null,
      amount_paise: 49900,
      currency: "INR",
      status: "created",
      mode: "test",
    };

    // 2.1 Next Verify: Uncaptured payment (status: "authorized") rejected with 400 PAYMENT_NOT_CAPTURED
    {
      const mockDb = createMockSupabaseForVerify(validOrderRow);
      const req = new Request("http://localhost:3000/api/billing/razorpay/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
        body: JSON.stringify({ order_id: testOrderId, payment_id: testPaymentId, razorpay_signature: testSig }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb.client,
        fetchRazorpayPayment: async () => ({
          id: testPaymentId,
          order_id: testOrderId,
          status: "authorized", // NOT captured
          amount: 49900,
          currency: "INR",
        }),
      };
      const res = await verifyNextPost(req);
      assert.strictEqual(res.status, 400);
      assert.strictEqual((await res.json()).code, "PAYMENT_NOT_CAPTURED");
      assert.strictEqual(mockDb.wasFulfilled(), false);
      console.log("  [PASS] 2.1 Next Verify: Uncaptured payment (authorized) rejected with 400 PAYMENT_NOT_CAPTURED");
    }

    // 2.2 Next Verify: Failed payment (status: "failed") rejected with 400 PAYMENT_NOT_CAPTURED
    {
      const mockDb = createMockSupabaseForVerify(validOrderRow);
      const req = new Request("http://localhost:3000/api/billing/razorpay/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
        body: JSON.stringify({ order_id: testOrderId, payment_id: testPaymentId, razorpay_signature: testSig }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb.client,
        fetchRazorpayPayment: async () => ({
          id: testPaymentId,
          order_id: testOrderId,
          status: "failed",
          amount: 49900,
          currency: "INR",
        }),
      };
      const res = await verifyNextPost(req);
      assert.strictEqual(res.status, 400);
      assert.strictEqual((await res.json()).code, "PAYMENT_NOT_CAPTURED");
      assert.strictEqual(mockDb.wasFulfilled(), false);
      console.log("  [PASS] 2.2 Next Verify: Failed payment rejected with 400 PAYMENT_NOT_CAPTURED");
    }

    // 2.3 Next Verify: Amount mismatch rejected with 400 AMOUNT_MISMATCH
    {
      const mockDb = createMockSupabaseForVerify(validOrderRow);
      const req = new Request("http://localhost:3000/api/billing/razorpay/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
        body: JSON.stringify({ order_id: testOrderId, payment_id: testPaymentId, razorpay_signature: testSig }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb.client,
        fetchRazorpayPayment: async () => ({
          id: testPaymentId,
          order_id: testOrderId,
          status: "captured",
          amount: 99900, // tampered amount
          currency: "INR",
        }),
      };
      const res = await verifyNextPost(req);
      assert.strictEqual(res.status, 400);
      assert.strictEqual((await res.json()).code, "AMOUNT_MISMATCH");
      assert.strictEqual(mockDb.wasFulfilled(), false);
      console.log("  [PASS] 2.3 Next Verify: Amount mismatch rejected with 400 AMOUNT_MISMATCH");
    }

    // 2.4 Incomplete / Tampered Provider Responses (Next Verify)
    {
      // Missing payment ID in provider response
      const mockDb1 = createMockSupabaseForVerify(validOrderRow);
      const req1 = new Request("http://localhost:3000/api/billing/razorpay/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
        body: JSON.stringify({ order_id: testOrderId, payment_id: testPaymentId, razorpay_signature: testSig }),
      });
      (req1 as any).__testDeps = {
        getSupabaseAdmin: () => mockDb1.client,
        fetchRazorpayPayment: async () => ({
          // missing id
          order_id: testOrderId,
          status: "captured",
          amount: 49900,
          currency: "INR",
        }),
      };
      const res1 = await verifyNextPost(req1);
      assert.strictEqual(res1.status, 400);
      assert.strictEqual((await res1.json()).code, "PAYMENT_ID_MISMATCH");
      assert.strictEqual(mockDb1.wasFulfilled(), false);

      // Missing order_id in provider response
      const mockDb2 = createMockSupabaseForVerify(validOrderRow);
      const req2 = new Request("http://localhost:3000/api/billing/razorpay/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
        body: JSON.stringify({ order_id: testOrderId, payment_id: testPaymentId, razorpay_signature: testSig }),
      });
      (req2 as any).__testDeps = {
        getSupabaseAdmin: () => mockDb2.client,
        fetchRazorpayPayment: async () => ({
          id: testPaymentId,
          // missing order_id
          status: "captured",
          amount: 49900,
          currency: "INR",
        }),
      };
      const res2 = await verifyNextPost(req2);
      assert.strictEqual(res2.status, 400);
      assert.strictEqual((await res2.json()).code, "ORDER_MISMATCH");
      assert.strictEqual(mockDb2.wasFulfilled(), false);

      // Missing currency in provider response
      const mockDb3 = createMockSupabaseForVerify(validOrderRow);
      const req3 = new Request("http://localhost:3000/api/billing/razorpay/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
        body: JSON.stringify({ order_id: testOrderId, payment_id: testPaymentId, razorpay_signature: testSig }),
      });
      (req3 as any).__testDeps = {
        getSupabaseAdmin: () => mockDb3.client,
        fetchRazorpayPayment: async () => ({
          id: testPaymentId,
          order_id: testOrderId,
          status: "captured",
          amount: 49900,
          // missing currency
        }),
      };
      const res3 = await verifyNextPost(req3);
      assert.strictEqual(res3.status, 400);
      assert.strictEqual((await res3.json()).code, "CURRENCY_MISMATCH");
      assert.strictEqual(mockDb3.wasFulfilled(), false);

      // Non-finite amount (NaN, null, 0, or negative)
      const mockDb4 = createMockSupabaseForVerify(validOrderRow);
      const req4 = new Request("http://localhost:3000/api/billing/razorpay/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
        body: JSON.stringify({ order_id: testOrderId, payment_id: testPaymentId, razorpay_signature: testSig }),
      });
      (req4 as any).__testDeps = {
        getSupabaseAdmin: () => mockDb4.client,
        fetchRazorpayPayment: async () => ({
          id: testPaymentId,
          order_id: testOrderId,
          status: "captured",
          amount: NaN,
          currency: "INR",
        }),
      };
      const res4 = await verifyNextPost(req4);
      assert.strictEqual(res4.status, 400);
      assert.strictEqual((await res4.json()).code, "AMOUNT_MISMATCH");
      assert.strictEqual(mockDb4.wasFulfilled(), false);

      // Incomplete provider response with ONLY status and amount
      const mockDb5 = createMockSupabaseForVerify(validOrderRow);
      const req5 = new Request("http://localhost:3000/api/billing/razorpay/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
        body: JSON.stringify({ order_id: testOrderId, payment_id: testPaymentId, razorpay_signature: testSig }),
      });
      (req5 as any).__testDeps = {
        getSupabaseAdmin: () => mockDb5.client,
        fetchRazorpayPayment: async () => ({
          status: "captured",
          amount: 49900,
        }),
      };
      const res5 = await verifyNextPost(req5);
      assert.strictEqual(res5.status, 400);
      assert.strictEqual((await res5.json()).code, "PAYMENT_ID_MISMATCH");
      assert.strictEqual(mockDb5.wasFulfilled(), false);

      console.log("  [PASS] 2.4 Next Verify: Missing provider id/order/currency & non-finite amount fail closed");
    }

    // 2.5 Netlify Verify: Incomplete / Tampered Provider Responses
    {
      const handler = createNetlifyVerifyHandler();

      // Netlify missing order_id
      const mockDb1 = createMockSupabaseForVerify(validOrderRow);
      const res1 = await createNetlifyVerifyHandler({
        getSupabaseAdmin: () => mockDb1.client,
        fetchRazorpayPayment: async () => ({
          id: testPaymentId,
          status: "captured",
          amount: 49900,
          currency: "INR",
        }),
      })({
        httpMethod: "POST",
        headers: { authorization: "Bearer valid_token" },
        body: JSON.stringify({ order_id: testOrderId, payment_id: testPaymentId, razorpay_signature: testSig }),
      });
      assert.strictEqual(res1.statusCode, 400);
      assert.strictEqual(JSON.parse(res1.body).code, "ORDER_MISMATCH");
      assert.strictEqual(mockDb1.wasFulfilled(), false);

      // Netlify missing currency
      const mockDb2 = createMockSupabaseForVerify(validOrderRow);
      const res2 = await createNetlifyVerifyHandler({
        getSupabaseAdmin: () => mockDb2.client,
        fetchRazorpayPayment: async () => ({
          id: testPaymentId,
          order_id: testOrderId,
          status: "captured",
          amount: 49900,
        }),
      })({
        httpMethod: "POST",
        headers: { authorization: "Bearer valid_token" },
        body: JSON.stringify({ order_id: testOrderId, payment_id: testPaymentId, razorpay_signature: testSig }),
      });
      assert.strictEqual(res2.statusCode, 400);
      assert.strictEqual(JSON.parse(res2.body).code, "CURRENCY_MISMATCH");
      assert.strictEqual(mockDb2.wasFulfilled(), false);

      // Netlify only status and amount
      const mockDb3 = createMockSupabaseForVerify(validOrderRow);
      const res3 = await createNetlifyVerifyHandler({
        getSupabaseAdmin: () => mockDb3.client,
        fetchRazorpayPayment: async () => ({
          status: "captured",
          amount: 49900,
        }),
      })({
        httpMethod: "POST",
        headers: { authorization: "Bearer valid_token" },
        body: JSON.stringify({ order_id: testOrderId, payment_id: testPaymentId, razorpay_signature: testSig }),
      });
      assert.strictEqual(res3.statusCode, 400);
      assert.strictEqual(JSON.parse(res3.body).code, "PAYMENT_ID_MISMATCH");
      assert.strictEqual(mockDb3.wasFulfilled(), false);

      console.log("  [PASS] 2.5 Netlify Verify: Missing provider id/order/currency & incomplete responses fail closed");
    }

    // 2.6 Removal of Mock DB Provider Fabrication
    {
      const mockDb = createMockSupabaseForVerify(validOrderRow);
      const req = new Request("http://localhost:3000/api/billing/razorpay/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
        body: JSON.stringify({ order_id: testOrderId, payment_id: testPaymentId, razorpay_signature: testSig }),
      });
      // Inject getSupabaseAdmin BUT NO fetch mock: must NOT fabricate captured payment
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb.client,
        // No fetchRazorpayPayment, no fetchFn
      };
      // Fetch will attempt real network call to Razorpay which will fail or 400/502
      const res = await verifyNextPost(req);
      assert.notStrictEqual(res.status, 200, "Must not fabricate captured payment when provider fetch is unmocked");
      assert.strictEqual(mockDb.wasFulfilled(), false, "Must not fulfill order without real provider verification");
      console.log("  [PASS] 2.6 Mock DB fallback removed: tests without explicit provider mock fail closed");
    }

    // 2.7 Happy Path (Next & Netlify): Captured payment activates plan
    {
      const mockDb = createMockSupabaseForVerify(validOrderRow);
      const req = new Request("http://localhost:3000/api/billing/razorpay/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
        body: JSON.stringify({ order_id: testOrderId, payment_id: testPaymentId, razorpay_signature: testSig }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb.client,
        fetchRazorpayPayment: async () => ({
          id: testPaymentId,
          order_id: testOrderId,
          status: "captured",
          amount: 49900,
          currency: "INR",
        }),
      };
      const res = await verifyNextPost(req);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(mockDb.wasFulfilled(), true, "Captured payment must trigger atomic RPC fulfillment");
      console.log("  [PASS] 2.7 Next Verify: Captured payment successfully activates plan");
    }

    // =========================================================================
    // SECTION 3: Free vs Pro detail and the payment -> unlock flow now run the REAL
    // handlers in src/lib/__tests__/launchFreeVsProHandlers.test.ts (vitest).
    // =========================================================================

    // =========================================================================
    // SECTION 4: Real Role-Based Database Operations via PGlite
    // =========================================================================
    console.log("\n--- Section 4: Real Role-Based DB Operations (PGlite) ---");

    const pg = new PGlite();
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role BYPASSRLS;
        ELSE
          ALTER ROLE service_role BYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
      END;
      $$;

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$ LANGUAGE SQL STABLE;

      CREATE TABLE IF NOT EXISTS public.applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL,
        title TEXT,
        company TEXT,
        stage TEXT DEFAULT 'saved',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS public.candidate_profiles (
        user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
        name TEXT,
        skills TEXT[],
        confirmed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS public.tailored_resumes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        job_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.candidate_profiles ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.tailored_resumes ENABLE ROW LEVEL SECURITY;

      CREATE SCHEMA IF NOT EXISTS storage;
      CREATE TABLE IF NOT EXISTS storage.objects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bucket_id TEXT,
        name TEXT,
        owner UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      GRANT ALL ON ALL TABLES IN SCHEMA storage TO service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA storage TO authenticated;
      GRANT SELECT ON ALL TABLES IN SCHEMA storage TO anon;

      CREATE OR REPLACE FUNCTION storage.foldername(name TEXT) RETURNS TEXT[] AS $$
        SELECT string_to_array(name, '/');
      $$ LANGUAGE SQL IMMUTABLE;

      GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated, anon, service_role;

      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
    `);

    // Apply the real #644 gate migration, then the restore proposal on top (as production would).
    for (const file of [
      "20261116c_launch_scope_coming_soon_gates.sql",
      "20261120a_restore_tracker_profile_owner_policies.sql",
    ]) {
      const p = path.resolve(__dirname, "../supabase/migrations", file);
      assert.ok(fs.existsSync(p), `Migration ${file} must exist`);
      await pg.exec(fs.readFileSync(p, "utf-8"));
      console.log(`  Migration ${file} executed successfully in PGlite.`);
    }
    // Idempotent: the restore proposal must be safe to run twice.
    await pg.exec(fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/20261120a_restore_tracker_profile_owner_policies.sql"), "utf-8"));
    console.log("  Migration 20261120a re-run (idempotent) succeeded.");

    const userA = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
    const userB = "b1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
    await pg.exec(`
      INSERT INTO auth.users (id, email) VALUES ('${userA}', 'a@test.com'), ('${userB}', 'b@test.com')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.applications (id, user_id, job_id, title, company) VALUES
        ('b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e', '${userA}', 'job_1', 'Software Engineer', 'Google'),
        ('c2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e', '${userB}', 'job_9', 'Designer', 'Figma');
      INSERT INTO public.tailored_resumes (user_id, job_id) VALUES ('${userA}', 'job_1');
    `);
    const asUser = async (uid: string) => {
      await pg.exec(`RESET ROLE;`);
      await pg.exec(`SET ROLE authenticated;`);
      await pg.exec(`SELECT set_config('request.jwt.claim.sub', '${uid}', false);`);
    };
    const fails = async (sql: string) => {
      try {
        await pg.exec(sql);
        return false;
      } catch {
        return true;
      }
    };

    // 4.1 anon: nothing visible, nothing writable
    await pg.exec(`RESET ROLE;`);
    await pg.exec(`SET ROLE anon;`);
    assert.strictEqual((await pg.query("SELECT * FROM public.applications;")).rows.length, 0, "Anon must see 0 rows");
    assert.ok(await fails(`INSERT INTO public.applications (user_id, job_id) VALUES ('${userA}', 'job_2');`), "Anon INSERT must be blocked");
    console.log("  [PASS] 4.1 Anon: SELECT 0 rows, INSERT blocked");

    // 4.2 owner A: own rows only; no cross-user read/write; cannot re-point user_id
    await asUser(userA);
    const aRows = await pg.query<{ user_id: string }>("SELECT user_id FROM public.applications;");
    assert.strictEqual(aRows.rows.length, 1, "Owner A must see exactly their own application");
    assert.strictEqual(aRows.rows[0].user_id, userA, "Owner A must never see B's row");
    assert.ok(!(await fails(`INSERT INTO public.applications (user_id, job_id) VALUES ('${userA}', 'job_3');`)), "Owner A INSERT for self must succeed");
    assert.ok(await fails(`INSERT INTO public.applications (user_id, job_id) VALUES ('${userB}', 'job_4');`), "Owner A INSERT for B must be rejected");
    assert.ok(
      await fails(`UPDATE public.applications SET user_id = '${userB}' WHERE job_id = 'job_1';`),
      "Owner A must not re-point their row to B (WITH CHECK)"
    );
    const crossUpdate: any = await pg.query(`UPDATE public.applications SET stage = 'offer' WHERE user_id = '${userB}';`);
    assert.strictEqual(crossUpdate.affectedRows ?? 0, 0, "Owner A UPDATE of B's row must affect 0 rows");
    assert.ok(!(await fails(`INSERT INTO public.candidate_profiles (user_id, name) VALUES ('${userA}', 'A');`)), "Owner A profile insert must succeed");
    assert.ok(await fails(`INSERT INTO public.candidate_profiles (user_id, name) VALUES ('${userB}', 'B');`), "Owner A profile insert for B must be rejected");
    // tailored_resumes stays blocked (AI tailoring is not restored)
    assert.strictEqual((await pg.query("SELECT * FROM public.tailored_resumes;")).rows.length, 0, "tailored_resumes must stay blocked");
    const ownDelete: any = await pg.query(`DELETE FROM public.applications WHERE job_id = 'job_3';`);
    assert.strictEqual(ownDelete.affectedRows ?? 0, 1, "Owner A must be able to delete their own row");
    const crossDelete: any = await pg.query(`DELETE FROM public.applications WHERE user_id = '${userB}';`);
    assert.strictEqual(crossDelete.affectedRows ?? 0, 0, "Owner A must not delete B's row");
    console.log("  [PASS] 4.2 Owner-only access: own rows only, no cross-user read/write/delete, user_id not re-pointable; tailored_resumes still blocked");

    // 4.3 service role (GDPR route) still bypasses RLS
    await pg.exec(`RESET ROLE;`);
    await pg.exec(`SET ROLE service_role;`);
    assert.strictEqual((await pg.query("SELECT * FROM public.applications;")).rows.length, 2, "Service role must see all rows");
    const serviceDeleteRes: any = await pg.query(`DELETE FROM public.applications WHERE user_id = '${userA}';`);
    assert.strictEqual(serviceDeleteRes.affectedRows ?? 0, 1, "Service role delete must purge A's row");
    console.log("  [PASS] 4.3 Service role (GDPR route): bypasses RLS and purges user records");
    await pg.exec(`RESET ROLE;`);

    // =========================================================================
    // SECTION 5: Restored pages are real; Dashboard retired; no AI tool entry points
    // =========================================================================
    console.log("\n--- Section 5: Restored Pages, Retired Dashboard, No AI Entry Points ---");
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf-8");

    const trackerSrc = read("src/app/tracker/page.tsx");
    assert.ok(!trackerSrc.includes("ComingSoonView"), "Tracker must not be a Coming Soon placeholder");
    assert.ok(trackerSrc.includes("getTrackedApplications(") && trackerSrc.includes("updateApplicationStage"), "Tracker board must load and update applications");
    assert.ok(!trackerSrc.includes("Run AI Scan") && !trackerSrc.includes("Daily AI Matching Digest"), "Tracker must not offer the AI digest scan");
    console.log("  [PASS] 5.1 /tracker: real board restored, no AI digest scan");

    for (const rel of ["src/app/jobs/[id]/interview-pack/InterviewPackClient.tsx", "src/app/jobs/[id]/skill-what-if/SkillWhatIfClient.tsx"]) {
      const src = read(rel);
      assert.ok(!src.includes("ComingSoonView"), `${rel} must be the restored client`);
      assert.ok(!src.includes('"/dashboard"'), `${rel} must not redirect to the retired Dashboard`);
      assert.ok(src.includes("getProAccessStatus"), `${rel} must keep its Pro entitlement check`);
    }
    console.log("  [PASS] 5.2 Interview Pack & Skill What-If clients restored with entitlement checks");

    const dashSrc = read("src/app/dashboard/page.tsx");
    assert.ok(dashSrc.includes('router.replace("/jobs")'), "/dashboard must redirect to /jobs");
    for (const forbidden of ["<ResumeUploadAndConfirm", "<TopTenCompatibleJobs", "getCandidateProfile", "getTrackedApplications"]) {
      assert.ok(!dashSrc.includes(forbidden), `/dashboard must not load or render ${forbidden}`);
    }
    console.log("  [PASS] 5.3 /dashboard: legacy redirect only, no Dashboard UI or data loading");

    const detailSrc = read("src/components/jobs/JobDetailView.tsx");
    for (const forbidden of ["TailorResumeModal", "setIsTailorOpen", "Open Interview Pack", "What if I add a skill?"]) {
      assert.ok(!detailSrc.includes(forbidden), `JobDetailView must not contain ${forbidden}`);
    }
    console.log("  [PASS] 5.4 JobDetailView: no AI tool entry points");

    const jobsSrc = read("src/app/jobs/page.tsx");
    assert.ok(jobsSrc.includes("getCandidateProfile()") && jobsSrc.includes("getTrackedApplications("), "/jobs must load profile and tracker state again");
    assert.ok(jobsSrc.includes("quickTrackJob(") && jobsSrc.includes("addApplicationToTracker("), "/jobs must save/track again");
    assert.ok(!jobsSrc.includes("Tailor resume for this job") && !jobsSrc.includes("dashboard:"), "/jobs must not offer Tailor Resume or write Dashboard caches");
    console.log("  [PASS] 5.5 /jobs: save/applied/tracker flows restored; no Tailor Resume, no Dashboard cache writes");

    const settingsSrc = read("src/app/settings/page.tsx");
    assert.ok(settingsSrc.includes("handleDeleteAccount") && settingsSrc.includes("handleExportData"), "Settings must keep delete/export");
    assert.ok(!settingsSrc.includes("Daily AI Matching Digest"), "Settings must not offer the AI digest opt-in");
    console.log("  [PASS] 5.6 Settings: delete/export preserved; no AI digest opt-in control");

    console.log("\n================================================================================");
    console.log("ALL RESTORE-SCOPE TESTS & NEGATIVE CONTROLS PASSED [PASS-LOCAL]");
    console.log("================================================================================");
  } finally {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = origBilling;
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = origKeyId;
    process.env.RAZORPAY_KEY_SECRET = origKeySecret;
    process.env.RAZORPAY_MODE = origMode;
    process.env.SUPABASE_SERVICE_ROLE_KEY = origServiceKey;
    process.env.GROQ_API_KEY = origGroqKey;
    process.env.NEXT_PUBLIC_SUPABASE_URL = origSupabaseUrl;
  }
}

runSuite().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
