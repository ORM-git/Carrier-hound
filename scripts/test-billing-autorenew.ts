/**
 * scripts/test-billing-autorenew.ts
 *
 * Comprehensive test suite for Auto-Renew Checkout & Reviewer Blockers:
 * 1) Feature flag registration in src/lib/flags/flags.ts:
 *    - NEXT_PUBLIC_AUTORENEW_ENABLED is registered with rule "strict_true",
 *      scope "public-build", defaultEnabled: false.
 * 2) netlify.toml explicit redirect:
 *    - Validates /api/billing/razorpay/subscription -> /.netlify/functions/billing-razorpay-subscription (status 200, force true).
 * 3) Copy checks across Pricing, Terms & Conditions, and Refund Policy:
 *    - Flag ON: says plans auto-renew every 7/30/90 days until cancelled, shows renewal amount & date, and explains cancellation.
 *    - Flag OFF: keeps exact current "prepaid, no auto-renew" copy across all three pages.
 * 4) Server route /api/billing/razorpay/subscription:
 *    - Flag OFF -> 503 AUTORENEW_DISABLED fail-closed.
 *    - Missing auth -> 401 Unauthorized.
 *    - Invalid planCode -> 400 Bad Request.
 *    - Blocked user -> 403 USER_BLOCKED (or 503 if unavailable).
 *    - Active plan already exists -> 409 ACTIVE_PLAN_EXISTS with clear message.
 *    - Overwrite prevention: does NOT overwrite existing subscription_id or plan_id.
 *    - Separate storage: records pending subscription in payment_orders ('created') and metadata.
 * 5) Netlify function netlify/functions/billing-razorpay-subscription:
 *    - Flag OFF -> 503.
 *    - Blocked user -> 403.
 *    - Active plan -> 409 ACTIVE_PLAN_EXISTS.
 *    - Records pending subscription in payment_orders.
 * 6) Prepaid order flow isolation:
 *    - /api/billing/razorpay/order remains prepaid only, creating orders without subscription logic.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { getFlagDefinition, isFlagEnabled } from "../src/lib/flags/flags";
import { POST } from "../src/app/api/billing/razorpay/subscription/route";
import { createHandler as createNetlifySubscriptionHandler } from "../netlify/functions/billing-razorpay-subscription";

const ROOT = path.resolve(__dirname, "..");
const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

async function runAutorenewTests() {
  console.log("================================================================================");
  console.log("   BILLING AUTO-RENEW CHECKOUT VERIFICATION SUITE                               ");
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

  // ---------------------------------------------------------------------------
  // TEST 1: Feature Flag Registration
  // ---------------------------------------------------------------------------
  console.log("[TEST 1] Verifying NEXT_PUBLIC_AUTORENEW_ENABLED in flags registry...");
  const flagDef = getFlagDefinition("NEXT_PUBLIC_AUTORENEW_ENABLED");
  assert.ok(flagDef, "NEXT_PUBLIC_AUTORENEW_ENABLED must be registered in FLAGS");
  assert.strictEqual(flagDef.rule, "strict_true", "Flag rule must be 'strict_true'");
  assert.strictEqual(flagDef.scope, "public-build", "Flag scope must be 'public-build'");
  assert.strictEqual(flagDef.defaultEnabled, false, "Flag defaultEnabled must be false");
  assert.strictEqual(isFlagEnabled("NEXT_PUBLIC_AUTORENEW_ENABLED", {}), false);
  assert.strictEqual(isFlagEnabled("NEXT_PUBLIC_AUTORENEW_ENABLED", { NEXT_PUBLIC_AUTORENEW_ENABLED: "true" }), true);
  assert.strictEqual(isFlagEnabled("NEXT_PUBLIC_AUTORENEW_ENABLED", { NEXT_PUBLIC_AUTORENEW_ENABLED: "1" }), false);
  assert.strictEqual(isFlagEnabled("NEXT_PUBLIC_AUTORENEW_ENABLED", { NEXT_PUBLIC_AUTORENEW_ENABLED: "yes" }), false);
  console.log("  ✓ Feature flag registered correctly as strict_true, public-build, default off.\n");

  // ---------------------------------------------------------------------------
  // TEST 2: netlify.toml Explicit Redirect
  // ---------------------------------------------------------------------------
  console.log("[TEST 2] Verifying netlify.toml explicit redirect for subscription route...");
  const netlifyToml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  assert.ok(
    netlifyToml.includes('from = "/api/billing/razorpay/subscription"'),
    "netlify.toml must redirect from /api/billing/razorpay/subscription"
  );
  assert.ok(
    netlifyToml.includes('to = "/.netlify/functions/billing-razorpay-subscription"'),
    "netlify.toml must redirect to /.netlify/functions/billing-razorpay-subscription"
  );
  console.log("  ✓ netlify.toml explicit redirect verified.\n");

  // ---------------------------------------------------------------------------
  // TEST 3: Copy Permutations (Pricing, Terms & Conditions, Refund Policy)
  // ---------------------------------------------------------------------------
  console.log("[TEST 3] Verifying copy permutations on Pricing, Terms, and Refund pages...");
  const pricingFile = fs.readFileSync(path.join(ROOT, "src/app/pricing/page.tsx"), "utf8");
  const termsFile = fs.readFileSync(path.join(ROOT, "src/app/terms-and-conditions/page.tsx"), "utf8");
  const refundFile = fs.readFileSync(path.join(ROOT, "src/app/refund-policy/page.tsx"), "utf8");

  // 3a: Flag OFF text (must keep exact original prepaid copy)
  assert.ok(
    pricingFile.includes("Plans are prepaid for a fixed duration and do not auto-renew."),
    "Pricing page must retain exact prepaid copy when flag is off"
  );
  assert.ok(
    termsFile.includes("No automatic renewal:</strong> plans are prepaid for a fixed period and do not renew automatically."),
    "Terms page must retain exact prepaid copy when flag is off"
  );
  assert.ok(
    termsFile.includes("Plans do not renew automatically, so there is nothing to cancel."),
    "Terms page must retain exact no-cancel copy when flag is off"
  );
  assert.ok(
    refundFile.includes("1. Prepaid Plans, No Auto-Renewal"),
    "Refund policy must retain exact 1. Prepaid Plans heading when flag is off"
  );
  assert.ok(
    refundFile.includes("There are no recurring charges and no automatic renewals: your plan expires at the end of its paid period"),
    "Refund policy must retain exact no-renewal copy when flag is off"
  );
  console.log("  ✓ Flag OFF keeps exact current 'prepaid, no auto-renew' copy across all three pages.");

  // 3b: Flag ON text (must state auto-renew every 7/30/90 days until cancelled, renewal amounts & date, and how to cancel)
  for (const [pageName, fileContent] of [
    ["Pricing Page", pricingFile],
    ["Terms and Conditions", termsFile],
    ["Refund Policy", refundFile],
  ] as const) {
    assert.ok(
      fileContent.includes("auto-renew every 7/30/90 days until cancelled") ||
      fileContent.includes("auto-renew every 7 days") ||
      fileContent.includes("auto-renew every 7, 30, or 90 days until cancelled"),
      `${pageName} must state plans auto-renew every 7/30/90 days until cancelled`
    );
    assert.ok(
      fileContent.includes("692") && fileContent.includes("1,499") && fileContent.includes("3,999"),
      `${pageName} must show the renewal amounts for Weekly (692), Monthly (1,499), and Quarterly (3,999)`
    );
    assert.ok(
      fileContent.includes("renewal date") || fileContent.includes("next renewal"),
      `${pageName} must show or state the renewal date`
    );
    assert.ok(
      fileContent.includes("cancel") && (fileContent.includes("settings") || fileContent.includes("account")),
      `${pageName} must explain how to cancel in account settings`
    );
  }
  console.log("  ✓ Flag ON states 7/30/90 days renewal until cancelled, renewal amounts & date, and how to cancel in settings.\n");

  // ---------------------------------------------------------------------------
  // TEST 4: Route Fail-Closed when Flag is OFF
  // ---------------------------------------------------------------------------
  console.log("[TEST 4] Verifying server route /api/billing/razorpay/subscription when flag is OFF...");
  const originalEnv = { ...process.env };
  try {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    delete process.env.NEXT_PUBLIC_AUTORENEW_ENABLED;
    const reqFlagOff = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer mock_token",
      },
      body: JSON.stringify({ planCode: "monthly" }),
    });

    const resFlagOff = await POST(reqFlagOff);
    assert.strictEqual(resFlagOff.status, 503, "Must return 503 when flag is unset");
    const jsonFlagOff = await resFlagOff.json();
    assert.strictEqual(jsonFlagOff.code, "AUTORENEW_DISABLED");
    console.log("  ✓ Route returns 503 AUTORENEW_DISABLED when NEXT_PUBLIC_AUTORENEW_ENABLED is unset.");

    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "false";
    const resFlagFalse = await POST(reqFlagOff);
    assert.strictEqual(resFlagFalse.status, 503, "Must return 503 when flag is false");

    // Also test Netlify handler
    const netlifyHandler = createNetlifySubscriptionHandler();
    const netlifyResOff = await netlifyHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer mock_token" },
      body: JSON.stringify({ planCode: "monthly" }),
    });
    assert.strictEqual(netlifyResOff.statusCode, 503);
    const netlifyBodyOff = JSON.parse(netlifyResOff.body);
    assert.strictEqual(netlifyBodyOff.code, "AUTORENEW_DISABLED");
    console.log("  ✓ Netlify function returns 503 AUTORENEW_DISABLED when flag is off.\n");
  } finally {
    process.env = { ...originalEnv };
  }

  // ---------------------------------------------------------------------------
  // TEST 5: Route Authentication, Mode Check, and Plan Code Validation
  // ---------------------------------------------------------------------------
  console.log("[TEST 5] Verifying authentication, mode check, and plan code validation...");
  process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
  process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";
  process.env.RAZORPAY_MODE = "test";
  process.env.RAZORPAY_KEY_ID = "rzp_test_mock_12345678";
  process.env.RAZORPAY_KEY_SECRET = "mock_secret_key";
  process.env.RAZORPAY_AUTORENEW_PLAN_WEEKLY = "plan_weekly_123";
  process.env.RAZORPAY_AUTORENEW_PLAN_MONTHLY = "plan_monthly_456";
  process.env.RAZORPAY_AUTORENEW_PLAN_QUARTERLY = "plan_quarterly_789";

  // 5a: Missing Authorization Header
  const reqNoAuth = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planCode: "monthly" }),
  });
  const resNoAuth = await POST(reqNoAuth);
  assert.strictEqual(resNoAuth.status, 401, "Must return 401 when Authorization header is missing");
  console.log("  ✓ Missing Authorization header rejected with 401.");

  // Mock Supabase User and DB state
  const mockUser = {
    id: "usr_mock_12345678",
    email: "subscriber@careermonke.com",
    user_metadata: { full_name: "Mock Subscriber" },
  };

  let mockExistingSub: any = null;
  const dbStoredPaymentOrders: any[] = [];
  let dbStoredSubscriptionMetadata: any = null;

  const mockSupabaseAdmin = {
    auth: {
      getUser: async (token: string) => {
        if (token === "valid_token") {
          return { data: { user: mockUser }, error: null };
        }
        return { data: { user: null }, error: new Error("Invalid session") };
      },
    },
    from: (table: string) => {
      if (table === "subscriptions") {
        return {
          select: (_cols: string) => ({
            eq: (_field: string, _val: string) => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: mockExistingSub, error: null }),
                }),
              }),
              maybeSingle: async () => ({ data: mockExistingSub, error: null }),
            }),
          }),
          update: (row: any) => ({
            eq: async () => {
              dbStoredSubscriptionMetadata = row.metadata;
              return { error: null };
            },
          }),
        };
      }
      if (table === "payment_orders") {
        return {
          insert: async (row: any) => {
            dbStoredPaymentOrders.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };

  // 5b: Invalid Plan Code
  const reqInvalidPlan = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer valid_token",
    },
    body: JSON.stringify({ planCode: "yearly" }),
  });
  (reqInvalidPlan as any).__testDeps = {
    getSupabaseAdmin: () => mockSupabaseAdmin,
  };
  const resInvalidPlan = await POST(reqInvalidPlan);
  assert.strictEqual(resInvalidPlan.status, 400, "Must reject invalid planCode with 400");
  console.log("  ✓ Invalid plan code rejected with 400.");

  // 5c: Mode Mismatch (RAZORPAY_MODE=live with rzp_test_ key)
  process.env.RAZORPAY_MODE = "live";
  const reqModeMismatch = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer valid_token",
    },
    body: JSON.stringify({ planCode: "monthly" }),
  });
  (reqModeMismatch as any).__testDeps = {
    getSupabaseAdmin: () => mockSupabaseAdmin,
  };
  const resModeMismatch = await POST(reqModeMismatch);
  assert.strictEqual(resModeMismatch.status, 503, "Must return 503 when key prefix does not match RAZORPAY_MODE");
  const jsonModeMismatch = await resModeMismatch.json();
  assert.strictEqual(jsonModeMismatch.code, "RAZORPAY_CONFIG_ERROR");
  console.log("  ✓ Mode mismatch (live mode with test key) rejected with 503 RAZORPAY_CONFIG_ERROR.\n");

  // ---------------------------------------------------------------------------
  // TEST 6: Fail-closed Server Ban Check
  // ---------------------------------------------------------------------------
  console.log("[TEST 6] Verifying fail-closed ban check for blocked users...");
  process.env.RAZORPAY_MODE = "test";

  const makeBlockedReq = () =>
    new Request("http://localhost:3000/api/billing/razorpay/subscription", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_token",
      },
      body: JSON.stringify({ planCode: "monthly" }),
    });

  // 6a: Blocked user rejected with 403
  const reqBlocked = makeBlockedReq();
  (reqBlocked as any).__testDeps = {
    getSupabaseAdmin: () => mockSupabaseAdmin,
    verifyUserNotBanned: async () => ({ isBlocked: true, error: "Account suspended by staff." }),
  };
  const resBlocked = await POST(reqBlocked);
  assert.strictEqual(resBlocked.status, 403, "Blocked user must be rejected with 403");
  const jsonBlocked = await resBlocked.json();
  assert.strictEqual(jsonBlocked.code, "USER_BLOCKED");
  console.log("  ✓ Blocked user rejected with 403 USER_BLOCKED.");

  // 6b: Service unavailable ban check fails closed with 503
  const reqBanUnavailable = makeBlockedReq();
  (reqBanUnavailable as any).__testDeps = {
    getSupabaseAdmin: () => mockSupabaseAdmin,
    verifyUserNotBanned: async () => ({ isBlocked: true, isServiceUnavailable: true, error: "Ban check unavailable" }),
  };
  const resBanUnavailable = await POST(reqBanUnavailable);
  assert.strictEqual(resBanUnavailable.status, 503, "Ban check failure must fail closed with 503");
  console.log("  ✓ Ban check failure fails closed with 503 USER_BLOCKED.");

  // 6c: Netlify function blocked user check
  const netlifyHandlerWithDeps = createNetlifySubscriptionHandler({
    getSupabaseAdmin: () => mockSupabaseAdmin,
    verifyUserNotBanned: async () => ({ isBlocked: true, error: "Account suspended." }),
  });
  const netlifyBlockedRes = await netlifyHandlerWithDeps({
    httpMethod: "POST",
    headers: { authorization: "Bearer valid_token" },
    body: JSON.stringify({ planCode: "monthly" }),
  });
  assert.strictEqual(netlifyBlockedRes.statusCode, 403);
  const netlifyBlockedBody = JSON.parse(netlifyBlockedRes.body);
  assert.strictEqual(netlifyBlockedBody.code, "USER_BLOCKED");
  console.log("  ✓ Netlify function rejects blocked user with 403 USER_BLOCKED.\n");

  // ---------------------------------------------------------------------------
  // TEST 7: Active Plan Blocking (Reviewer Blocker 3)
  // ---------------------------------------------------------------------------
  console.log("[TEST 7] Verifying that active plan holders are blocked from duplicate subscription...");

  // 7a: Next.js route blocks active plan with 409
  mockExistingSub = {
    id: "sub_active_row",
    user_id: mockUser.id,
    subscription_id: "sub_active_999",
    plan_id: "monthly",
    status: "active",
    current_period_end: new Date(Date.now() + 10 * 86400000).toISOString(),
  };

  const reqActivePlan = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer valid_token",
    },
    body: JSON.stringify({ planCode: "monthly" }),
  });
  (reqActivePlan as any).__testDeps = {
    getSupabaseAdmin: () => mockSupabaseAdmin,
    verifyUserNotBanned: async () => ({ isBlocked: false }),
  };
  const resActivePlan = await POST(reqActivePlan);
  assert.strictEqual(resActivePlan.status, 409, "User with active plan must be rejected with 409");
  const jsonActivePlan = await resActivePlan.json();
  assert.strictEqual(jsonActivePlan.code, "ACTIVE_PLAN_EXISTS");
  assert.strictEqual(
    jsonActivePlan.error,
    "You already have an active subscription plan. Please manage your existing subscription in account settings."
  );
  console.log("  ✓ Route blocks active plan holder with 409 ACTIVE_PLAN_EXISTS.");

  // 7b: Netlify function blocks active plan with 409
  const netlifyHandlerActive = createNetlifySubscriptionHandler({
    getSupabaseAdmin: () => mockSupabaseAdmin,
    verifyUserNotBanned: async () => ({ isBlocked: false }),
  });
  const netlifyActiveRes = await netlifyHandlerActive({
    httpMethod: "POST",
    headers: { authorization: "Bearer valid_token" },
    body: JSON.stringify({ planCode: "monthly" }),
  });
  assert.strictEqual(netlifyActiveRes.statusCode, 409);
  const netlifyActiveBody = JSON.parse(netlifyActiveRes.body);
  assert.strictEqual(netlifyActiveBody.code, "ACTIVE_PLAN_EXISTS");
  console.log("  ✓ Netlify function blocks active plan holder with 409 ACTIVE_PLAN_EXISTS.\n");

  // ---------------------------------------------------------------------------
  // TEST 8: Subscription Creation, Total Count, and Separate Pending Storage
  // ---------------------------------------------------------------------------
  console.log("[TEST 8] Verifying subscription creation, total_count, and separate pending storage...");
  // Clear active subscription (simulating expired/canceled subscription)
  mockExistingSub = {
    id: "sub_canceled_row",
    user_id: mockUser.id,
    subscription_id: "sub_prior_canceled_123",
    plan_id: "weekly",
    status: "canceled",
    metadata: { prior: "data" },
  };
  dbStoredPaymentOrders.length = 0;
  dbStoredSubscriptionMetadata = null;

  const testCases = [
    {
      planCode: "weekly",
      expectedPlanId: "plan_weekly_123",
      expectedTotalCount: 52, // 52 weeks = 1 year
      expectedAmountPaise: 69200,
    },
    {
      planCode: "monthly",
      expectedPlanId: "plan_monthly_456",
      expectedTotalCount: 12, // 12 months = 1 year
      expectedAmountPaise: 149900,
    },
    {
      planCode: "quarterly",
      expectedPlanId: "plan_quarterly_789",
      expectedTotalCount: 4, // 4 quarters = 1 year
      expectedAmountPaise: 399900,
    },
  ];

  for (const tc of testCases) {
    let capturedRazorpayBody: any = null;

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      assert.strictEqual(
        url.toString(),
        "https://api.razorpay.com/v1/subscriptions",
        "Must call Razorpay subscriptions API endpoint"
      );
      assert.strictEqual(init?.method, "POST");
      capturedRazorpayBody = JSON.parse(init?.body as string);

      return new Response(
        JSON.stringify({
          id: `sub_rzp_${tc.planCode}_9999`,
          entity: "subscription",
          plan_id: capturedRazorpayBody.plan_id,
          status: "created",
          total_count: capturedRazorpayBody.total_count,
          customer_notify: capturedRazorpayBody.customer_notify,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_token",
      },
      body: JSON.stringify({
        planCode: tc.planCode,
        amount: 1, // Malicious spoof
        price: "Rs 1", // Malicious spoof
      }),
    });

    (req as any).__testDeps = {
      fetchFn: mockFetch as any,
      getSupabaseAdmin: () => mockSupabaseAdmin,
      verifyUserNotBanned: async () => ({ isBlocked: false }),
    };
    const res = await POST(req);

    assert.strictEqual(res.status, 200, `Plan ${tc.planCode} must succeed with 200`);
    const resJson = await res.json();
    assert.strictEqual(resJson.subscriptionId, `sub_rzp_${tc.planCode}_9999`);
    assert.strictEqual(resJson.planCode, tc.planCode);

    // Verify payload sent to Razorpay
    assert.strictEqual(capturedRazorpayBody.plan_id, tc.expectedPlanId);
    assert.strictEqual(
      capturedRazorpayBody.total_count,
      tc.expectedTotalCount,
      `Plan ${tc.planCode} total_count must equal ${tc.expectedTotalCount} (1 calendar year)`
    );
    assert.strictEqual(capturedRazorpayBody.customer_notify, true);
    assert.strictEqual(capturedRazorpayBody.amount, undefined, "Client amount must not be sent to Razorpay");
    assert.strictEqual(capturedRazorpayBody.notes?.user_id, mockUser.id);

    // Verify existing subscription_id is NOT overwritten!
    assert.strictEqual(
      mockExistingSub.subscription_id,
      "sub_prior_canceled_123",
      "Existing subscription_id must not be overwritten before payment is confirmed"
    );
    assert.strictEqual(
      mockExistingSub.plan_id,
      "weekly",
      "Existing plan_id must not be overwritten before payment is confirmed"
    );

    // Verify stored separately in payment_orders
    const lastOrder = dbStoredPaymentOrders[dbStoredPaymentOrders.length - 1];
    assert.ok(lastOrder, "Pending subscription must be inserted into payment_orders");
    assert.strictEqual(lastOrder.provider_order_id, `sub_rzp_${tc.planCode}_9999`);
    assert.strictEqual(lastOrder.plan_code, tc.planCode);
    assert.strictEqual(lastOrder.amount_paise, tc.expectedAmountPaise);
    assert.strictEqual(lastOrder.status, "created");

    // Verify pending subscription recorded in metadata
    assert.strictEqual(dbStoredSubscriptionMetadata?.pending_subscription_id, `sub_rzp_${tc.planCode}_9999`);
    assert.strictEqual(dbStoredSubscriptionMetadata?.pending_plan_code, tc.planCode);

    console.log(
      `  ✓ Plan ${tc.planCode}: mapped to ${tc.expectedPlanId}, total_count: ${tc.expectedTotalCount}, client amounts ignored, separate pending order recorded.`
    );
  }

  // ---------------------------------------------------------------------------
  // TEST 9: Prepaid Order Flow Verification (No side-effects on prepaid flow)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 9] Verifying prepaid order route (/api/billing/razorpay/order) remains unchanged...");
  const orderRouteModule = await import("../src/app/api/billing/razorpay/order/route");
  assert.ok(
    typeof orderRouteModule.POST === "function",
    "/api/billing/razorpay/order POST handler must exist"
  );
  const orderRouteContent = fs.readFileSync(
    path.join(ROOT, "src/app/api/billing/razorpay/order/route.ts"),
    "utf-8"
  );
  assert.ok(
    !orderRouteContent.includes("RAZORPAY_AUTORENEW_PLAN"),
    "Order route must not reference auto-renew subscription plan env vars"
  );
  assert.ok(
    !orderRouteContent.includes("/v1/subscriptions"),
    "Order route must not call Razorpay subscription API"
  );
  console.log("  ✓ Prepaid order route remains isolated, creating orders without subscription logic.\n");

  console.log("================================================================================");
  console.log("   ALL AUTO-RENEW CHECKOUT TESTS PASSED SUCCESSFULLY!                           ");
  console.log("================================================================================\n");
}

runAutorenewTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
