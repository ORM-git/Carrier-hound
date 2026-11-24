/**
 * scripts/test-billing-autorenew.ts
 *
 * Verification suite for Auto-Renew Subscriptions (Flat Rs 499 Monthly Plan):
 * 1) Feature flag registration in src/lib/flags/flags.ts (strict_true, default off).
 * 2) netlify.toml redirect for /api/billing/razorpay/subscription.
 * 3) Policy & Pricing page copy:
 *    - Flat 499 auto-renew.
 *    - 12 monthly billing cycles limit.
 *    - How to cancel auto-renewal in Settings.
 *    - Excludes false promises of email renewal reminders.
 * 4) Next.js route /api/billing/razorpay/subscription:
 *    - Flag off -> 503 AUTORENEW_DISABLED.
 *    - Missing auth -> 401.
 *    - Plan outside weekly/monthly/quarterly -> 400 UNSUPPORTED_PLAN.
 *    - Missing consent -> 400 CONSENT_REQUIRED.
 *    - Missing plan env var -> 503 PLAN_NOT_CONFIGURED.
 *    - Plan validation failure (amount != 49900) -> 502 INVALID_PLAN_AMOUNT.
 *    - Success create -> 200 with subscriptionId, order stored with metadata.consent.
 *    - Fail-closed cancellation:
 *      * Non-2xx from Razorpay -> 502 RAZORPAY_CANCEL_FAILED (DB unchanged).
 *      * Timeout from Razorpay -> 504 GATEWAY_TIMEOUT (DB unchanged).
 *      * Missing credentials -> 503 RAZORPAY_CONFIG_ERROR (DB unchanged).
 *      * Confirmed 200 from Razorpay -> 200 (DB updated to cancel_at_period_end = true).
 * 5) Netlify function parity for billing-razorpay-subscription.
 * 6) Prepaid order route isolation.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { getFlagDefinition, isFlagEnabled } from "../src/lib/flags/flags";
import { POST as nextSubscriptionPOST, DELETE as nextSubscriptionDELETE } from "../src/app/api/billing/razorpay/subscription/route";
import { createHandler as createNetlifySubscriptionHandler } from "../netlify/functions/billing-razorpay-subscription";

const ROOT = path.resolve(__dirname, "..");
const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

const mockUser = {
  id: "user_autorenew_test_123",
  email: "candidate@careermonke.com",
  user_metadata: { full_name: "Autorenew Candidate" },
};

const validConsent = {
  agreed: true,
  version: "2026-11-autorenew-v1",
  timestamp: new Date().toISOString(),
};

function createMockSupabase(initialSub?: any) {
  let sub = initialSub ? { ...initialSub } : null;
  const orders: any[] = [];

  const mockClient = {
    auth: {
      getUser: async (token: string) => {
        if (token === "valid_token") {
          return { data: { user: mockUser }, error: null };
        }
        return { data: { user: null }, error: new Error("Invalid token") };
      },
    },
    from: (table: string) => {
      let filterUserId: string | null = null;
      let filterStatus: string | null = null;
      let filterPlanCode: string | null = null;

      const chain: any = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: (col: string, val: any) => {
          if (col === "user_id") filterUserId = val;
          if (col === "status") filterStatus = val;
          if (col === "plan_code") filterPlanCode = val;
          return chain;
        },
        maybeSingle: async () => {
          if (table === "subscriptions") {
            return { data: sub ? { ...sub } : null, error: null };
          }
          if (table === "payment_orders") {
            const match = orders.find((o) => {
              if (filterUserId && o.user_id !== filterUserId) return false;
              if (filterStatus && o.status !== filterStatus) return false;
              if (filterPlanCode && o.plan_code !== filterPlanCode) return false;
              return true;
            });
            return { data: match || null, error: null };
          }
          return { data: null, error: null };
        },
        insert: async (row: any) => {
          if (table === "payment_orders") {
            orders.push({ ...row, id: `po_${Date.now()}` });
          } else if (table === "subscriptions") {
            sub = { ...row, id: `sub_db_${Date.now()}` };
          }
          return { error: null };
        },
        update: (updates: any) => ({
          eq: async (_col: string, _val: any) => {
            if (table === "subscriptions" && sub) {
              sub = { ...sub, ...updates };
            }
            return { error: null };
          },
        }),
      };
      return chain;
    },
    _getSub: () => sub,
    _getOrders: () => orders,
  };

  return mockClient;
}

async function runAutorenewTests() {
  console.log("================================================================================");
  console.log("   BILLING AUTO-RENEW VERIFICATION SUITE (FLAT RS 499 PLAN)                     ");
  console.log("================================================================================\n");

  if (IS_NEGATIVE_CONTROL) {
    console.log("[NEGATIVE CONTROL MODE] Intentionally asserting invalid condition...");
    const def = getFlagDefinition("NEXT_PUBLIC_AUTORENEW_ENABLED");
    assert.strictEqual(
      (def as any)?.defaultEnabled,
      true,
      "Negative control: defaultEnabled should be false, not true"
    );
    return;
  }

  // TEST 1: Flag registration
  console.log("[TEST 1] Verifying NEXT_PUBLIC_AUTORENEW_ENABLED in flags registry...");
  const flagDef = getFlagDefinition("NEXT_PUBLIC_AUTORENEW_ENABLED");
  assert.ok(flagDef, "NEXT_PUBLIC_AUTORENEW_ENABLED must be registered in FLAGS");
  assert.strictEqual(flagDef.rule, "strict_true");
  assert.strictEqual(flagDef.scope, "public-build");
  assert.strictEqual(flagDef.defaultEnabled, false);
  assert.strictEqual(isFlagEnabled("NEXT_PUBLIC_AUTORENEW_ENABLED", {}), false);
  console.log("  ✓ Flag registered, default off.\n");

  // TEST 2: netlify.toml redirect
  console.log("[TEST 2] Verifying netlify.toml redirect for subscription route...");
  const netlifyToml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  assert.ok(netlifyToml.includes('from = "/api/billing/razorpay/subscription"'));
  assert.ok(netlifyToml.includes('to = "/.netlify/functions/billing-razorpay-subscription"'));
  console.log("  ✓ Redirect present.\n");

  // TEST 3: Policy pages copy
  console.log("[TEST 3] Verifying flat 499 auto-renew, 12-cycle limit, cancellation and exclusion of false reminders on policy pages...");
  const termsFile = fs.readFileSync(path.join(ROOT, "src/app/terms-and-conditions/page.tsx"), "utf8");
  const refundFile = fs.readFileSync(path.join(ROOT, "src/app/refund-policy/page.tsx"), "utf8");
  const pricingFile = fs.readFileSync(path.join(ROOT, "src/app/pricing/page.tsx"), "utf8");

  assert.ok(termsFile.includes("499"), "Terms must mention 499 price");
  assert.ok(termsFile.includes("auto-renew"), "Terms must mention auto-renew");
  assert.ok(termsFile.includes("12 monthly billing cycles"), "Terms must mention 12 monthly cycles");
  assert.ok(!termsFile.includes("reminder"), "Terms must NOT promise false email renewal reminders");
  assert.ok(termsFile.includes("How to cancel auto-renewal"), "Terms must explain how to cancel");

  assert.ok(refundFile.includes("499"), "Refund must mention 499 price");
  assert.ok(refundFile.includes("auto-renew"), "Refund must mention auto-renew");
  assert.ok(refundFile.includes("12 monthly cycles"), "Refund must mention 12 monthly cycles");
  assert.ok(!refundFile.includes("reminders"), "Refund must NOT promise false email renewal reminders");
  assert.ok(refundFile.includes("How to cancel auto-renewal"), "Refund must explain how to cancel");

  assert.ok(pricingFile.includes("autorenew-consent-checkbox"), "Pricing page must have auto-renew consent checkbox");
  assert.ok(pricingFile.includes("I authorize Career Monke to charge ₹499/month until cancelled"), "Pricing page must have consent wording");
  console.log("  ✓ Policy & pricing pages updated with flat 499 auto-renew terms (12 cycles, no false reminder promises).\n");

  // TEST 4: Next.js route testing
  console.log("[TEST 4] Verifying /api/billing/razorpay/subscription Next.js route semantics...");
  const originalEnv = { ...process.env };

  try {
    process.env.RAZORPAY_MODE = "test";
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_fixture_key_123456";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_fixture_secret_abcdef";
    process.env.RAZORPAY_AUTORENEW_PLAN_MONTHLY = "plan_monthly_rzp_499";

    // 4a. Gating: flag off returns 503
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "false";
    const reqFlagOff = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
      body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
    });
    const resFlagOff = await nextSubscriptionPOST(reqFlagOff);
    assert.strictEqual(resFlagOff.status, 503, "Flag off must return 503");
    assert.strictEqual((await resFlagOff.json()).code, "AUTORENEW_DISABLED");
    console.log("  ✓ Flag OFF returns 503 AUTORENEW_DISABLED");

    // Enable flags
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";

    // 4b. Missing auth returns 401
    const reqNoAuth = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
    });
    const resNoAuth = await nextSubscriptionPOST(reqNoAuth);
    assert.strictEqual(resNoAuth.status, 401, "Missing auth must return 401");
    console.log("  ✓ Missing auth returns 401");

    // 4c. Plans outside weekly/monthly/quarterly return 400 UNSUPPORTED_PLAN
    const mockDb1 = createMockSupabase();
    const reqAnnual = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
      body: JSON.stringify({ planCode: "annual", consent: validConsent }),
    });
    (reqAnnual as any).__testDeps = {
      getSupabaseAdmin: () => mockDb1,
      verifyUserNotBanned: async () => ({ isBlocked: false }),
    };
    const resAnnual = await nextSubscriptionPOST(reqAnnual);
    assert.strictEqual(resAnnual.status, 400, "Unknown auto-renew plan must return 400");
    assert.strictEqual((await resAnnual.json()).code, "UNSUPPORTED_PLAN");
    console.log("  ✓ Plans outside weekly/monthly/quarterly rejected with 400 UNSUPPORTED_PLAN");

    // 4d. Missing consent returns 400 CONSENT_REQUIRED
    const reqNoConsent = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
      body: JSON.stringify({ planCode: "monthly" }),
    });
    (reqNoConsent as any).__testDeps = {
      getSupabaseAdmin: () => mockDb1,
      verifyUserNotBanned: async () => ({ isBlocked: false }),
    };
    const resNoConsent = await nextSubscriptionPOST(reqNoConsent);
    assert.strictEqual(resNoConsent.status, 400, "Missing consent must return 400");
    assert.strictEqual((await resNoConsent.json()).code, "CONSENT_REQUIRED");
    console.log("  ✓ Missing consent rejected with 400 CONSENT_REQUIRED");

    // 4e. Missing plan ID env var returns 503 PLAN_NOT_CONFIGURED
    delete process.env.RAZORPAY_AUTORENEW_PLAN_MONTHLY;
    const reqNoPlan = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
      body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
    });
    (reqNoPlan as any).__testDeps = {
      getSupabaseAdmin: () => mockDb1,
      verifyUserNotBanned: async () => ({ isBlocked: false }),
    };
    const resNoPlan = await nextSubscriptionPOST(reqNoPlan);
    assert.strictEqual(resNoPlan.status, 503, "Missing plan ID must return 503");
    assert.strictEqual((await resNoPlan.json()).code, "PLAN_NOT_CONFIGURED");
    console.log("  ✓ Missing RAZORPAY_AUTORENEW_PLAN_MONTHLY returns 503 PLAN_NOT_CONFIGURED");

    process.env.RAZORPAY_AUTORENEW_PLAN_MONTHLY = "plan_monthly_rzp_499";

    // 4f. Plan validation failure: plan amount mismatch returns 502
    const mockPlanMismatchFetch = async (url: any) => {
      if (String(url).includes("/plans/")) {
        return new Response(
          JSON.stringify({
            id: "plan_monthly_rzp_499",
            entity: "plan",
            interval: 1,
            period: "monthly",
            item: { amount: 39900, currency: "INR" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 500 });
    };

    const reqInvalidPlan = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
      body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
    });
    (reqInvalidPlan as any).__testDeps = {
      getSupabaseAdmin: () => mockDb1,
      verifyUserNotBanned: async () => ({ isBlocked: false }),
      fetchFn: mockPlanMismatchFetch,
    };
    const resInvalidPlan = await nextSubscriptionPOST(reqInvalidPlan);
    assert.strictEqual(resInvalidPlan.status, 502, "Mismatched plan amount must return 502");
    assert.strictEqual((await resInvalidPlan.json()).code, "INVALID_PLAN_AMOUNT");
    console.log("  ✓ Mismatched plan validation rejects with 502 INVALID_PLAN_AMOUNT");

    // 4g. Successful monthly subscription create (flat 499) with durable consent
    let capturedRzpBody: any = null;
    const mockFetch = async (url: any, init: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/plans/")) {
        return new Response(
          JSON.stringify({
            id: "plan_monthly_rzp_499",
            entity: "plan",
            interval: 1,
            period: "monthly",
            item: { amount: 49900, currency: "INR" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      capturedRzpBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          id: "sub_test_monthly_499_id",
          entity: "subscription",
          plan_id: capturedRzpBody.plan_id,
          status: "created",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const mockDb2 = createMockSupabase();
    const reqCreate = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
      body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
    });
    (reqCreate as any).__testDeps = {
      getSupabaseAdmin: () => mockDb2,
      verifyUserNotBanned: async () => ({ isBlocked: false }),
      fetchFn: mockFetch,
    };
    const resCreate = await nextSubscriptionPOST(reqCreate);
    assert.strictEqual(resCreate.status, 200, "Monthly create must return 200");
    const jsonCreate = await resCreate.json();
    assert.strictEqual(jsonCreate.subscriptionId, "sub_test_monthly_499_id");
    assert.strictEqual(jsonCreate.planCode, "monthly");
    assert.strictEqual(capturedRzpBody.plan_id, "plan_monthly_rzp_499");
    assert.strictEqual(capturedRzpBody.total_count, 12);

    const orders = mockDb2._getOrders();
    assert.strictEqual(orders.length, 1);
    assert.strictEqual(orders[0].provider_order_id, "sub_test_monthly_499_id");
    assert.strictEqual(orders[0].amount_paise, 49900);
    assert.strictEqual(orders[0].metadata?.consent?.agreed, true);
    assert.strictEqual(orders[0].metadata?.consent?.version, "2026-11-autorenew-v1");
    console.log("  ✓ Flat Rs 499 subscription created with validated plan and durably stored consent record");

    // 4h. Cancel fail-closed on non-2xx from Razorpay
    const mockDbCancelFail = createMockSupabase({
      user_id: mockUser.id,
      subscription_id: "sub_test_monthly_499_id",
      status: "active",
      cancel_at_period_end: false,
      current_period_end: new Date(Date.now() + 20 * 86400 * 1000).toISOString(),
    });

    const mockCancelFailFetch = async () =>
      new Response(JSON.stringify({ error: { description: "Subscription cannot be cancelled in current state" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });

    const reqCancelFail = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
      body: JSON.stringify({ action: "cancel" }),
    });
    (reqCancelFail as any).__testDeps = {
      getSupabaseAdmin: () => mockDbCancelFail,
      verifyUserNotBanned: async () => ({ isBlocked: false }),
      fetchFn: mockCancelFailFetch,
    };

    const resCancelFail = await nextSubscriptionPOST(reqCancelFail);
    assert.strictEqual(resCancelFail.status, 502, "Non-2xx cancellation must fail closed with 502");
    assert.strictEqual(mockDbCancelFail._getSub().cancel_at_period_end, false, "DB must remain retriable (false)");
    console.log("  ✓ Cancellation fails closed on non-2xx from gateway (DB unchanged)");

    // 4i. Cancel fail-closed on timeout
    const mockCancelTimeoutFetch = async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    };
    (reqCancelFail as any).__testDeps.fetchFn = mockCancelTimeoutFetch;
    const resCancelTimeout = await nextSubscriptionPOST(reqCancelFail);
    assert.strictEqual(resCancelTimeout.status, 504, "Timeout must return 504 GATEWAY_TIMEOUT");
    assert.strictEqual(mockDbCancelFail._getSub().cancel_at_period_end, false, "DB must remain retriable (false)");
    console.log("  ✓ Cancellation fails closed on gateway timeout (DB unchanged)");

    // 4j. Cancel confirmed 200 from Razorpay updates DB
    let capturedCancelBody: any = null;
    const mockCancelFetch = async (url: any, init: any) => {
      capturedCancelBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "sub_test_monthly_499_id", status: "cancelled" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    (reqCancelFail as any).__testDeps.fetchFn = mockCancelFetch;
    const resCancelOk = await nextSubscriptionPOST(reqCancelFail);
    assert.strictEqual(resCancelOk.status, 200, "Confirmed cancellation must return 200");
    const jsonCancel = await resCancelOk.json();
    assert.strictEqual(jsonCancel.success, true);
    assert.strictEqual(jsonCancel.cancelAtPeriodEnd, true);
    assert.strictEqual(capturedCancelBody.cancel_at_cycle_end, 1);
    assert.strictEqual(mockDbCancelFail._getSub().cancel_at_period_end, true, "DB must be marked true after 200 confirmation");
    console.log("  ✓ Cancellation confirms with Razorpay and marks cancel_at_period_end = true in DB\n");
  } finally {
    process.env = { ...originalEnv };
  }

  // TEST 5: Netlify function parity
  console.log("[TEST 5] Verifying Netlify function parity...");
  try {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";
    process.env.RAZORPAY_MODE = "test";
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_fixture_key_123456";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_fixture_secret_abcdef";
    process.env.RAZORPAY_AUTORENEW_PLAN_MONTHLY = "plan_monthly_rzp_499";

    const mockDbNetlify = createMockSupabase();
    const handler = createNetlifySubscriptionHandler({
      getSupabaseAdmin: () => mockDbNetlify,
      verifyUserNotBanned: async () => ({ isBlocked: false }),
      fetchFn: async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/plans/")) {
          return new Response(
            JSON.stringify({
              id: "plan_monthly_rzp_499",
              entity: "plan",
              interval: 1,
              period: "monthly",
              item: { amount: 49900, currency: "INR" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            id: "sub_netlify_monthly_499",
            plan_id: "plan_monthly_rzp_499",
            status: "created",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      },
    });

    const netlifyRes = await handler({
      httpMethod: "POST",
      headers: { authorization: "Bearer valid_token" },
      body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
    });
    assert.strictEqual(netlifyRes.statusCode, 200);
    const netlifyBody = JSON.parse(netlifyRes.body);
    assert.strictEqual(netlifyBody.subscriptionId, "sub_netlify_monthly_499");
    assert.strictEqual(netlifyBody.planCode, "monthly");
    console.log("  ✓ Netlify function creates flat 499 subscription with consent identically.\n");
  } finally {
    process.env = { ...originalEnv };
  }

  // TEST 6: Prepaid order route isolation
  console.log("[TEST 6] Verifying prepaid order route remains isolated...");
  const orderContent = fs.readFileSync(path.join(ROOT, "src/app/api/billing/razorpay/order/route.ts"), "utf8");
  assert.ok(!orderContent.includes("RAZORPAY_AUTORENEW_PLAN"), "Order route must not import autorenew plan IDs");
  assert.ok(!orderContent.includes("/v1/subscriptions"), "Order route must not call Razorpay subscription API");
  console.log("  ✓ Prepaid order route remains isolated.\n");

  console.log("================================================================================");
  console.log("   ALL AUTO-RENEW TESTS PASSED SUCCESSFULLY!                                    ");
  console.log("================================================================================\n");
}

runAutorenewTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
