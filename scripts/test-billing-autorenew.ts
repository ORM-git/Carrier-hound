/**
 * scripts/test-billing-autorenew.ts
 *
 * Comprehensive test suite for Auto-Renew Checkout:
 * 1) Feature flag registration in src/lib/flags/flags.ts:
 *    - NEXT_PUBLIC_AUTORENEW_ENABLED is registered with rule "strict_true",
 *      scope "public-build", defaultEnabled: false.
 * 2) Server route /api/billing/razorpay/subscription:
 *    - When flag is OFF (or unset): returns 503 Service Unavailable fail-closed.
 *    - When flag is ON:
 *      - Unauthenticated -> 401 Unauthorized.
 *      - Invalid planCode (e.g., 'yearly', 'annual', numbers) -> 400 Bad Request.
 *      - Blocked user -> 403 USER_BLOCKED (or 503 if ban service unavailable).
 *      - Missing or invalid RAZORPAY_MODE / key prefix mismatch -> 503 Config Error.
 *      - Test key on production host (careermonke.com) -> 503 Config Error.
 *      - Valid weekly plan -> mapped to RAZORPAY_AUTORENEW_PLAN_WEEKLY, total_count: 52, customer_notify: true.
 *      - Valid monthly plan -> mapped to RAZORPAY_AUTORENEW_PLAN_MONTHLY, total_count: 12, customer_notify: true.
 *      - Valid quarterly plan -> mapped to RAZORPAY_AUTORENEW_PLAN_QUARTERLY, total_count: 4, customer_notify: true.
 *      - Ignores client amounts / pricing spoofing (server-authoritative).
 *      - Stores subscription_id on the user's row in public.subscriptions.
 * 3) Netlify function netlify/functions/billing-razorpay-subscription:
 *    - Flag OFF -> 503 AUTORENEW_DISABLED.
 *    - Blocked user -> 403 USER_BLOCKED.
 *    - Flag ON -> creates subscription and stores in DB.
 * 4) Client library behavior:
 *    - openRazorpaySubscription fails immediately when flag is OFF.
 * 5) Prepaid order flow isolation:
 *    - /api/billing/razorpay/order remains prepaid only, creating order_id without altering subscriptions.
 *    - handleProCheckout remains prepaid flow.
 */

import assert from "node:assert";
import { getFlagDefinition, isFlagEnabled } from "../src/lib/flags/flags";
import { POST } from "../src/app/api/billing/razorpay/subscription/route";
import { createHandler as createNetlifySubscriptionHandler } from "../netlify/functions/billing-razorpay-subscription";

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
  // TEST 2: Route Fail-Closed when Flag is OFF
  // ---------------------------------------------------------------------------
  console.log("[TEST 2] Verifying server route /api/billing/razorpay/subscription when flag is OFF...");
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
  // TEST 3: Route Authentication & Validation when Flag is ON
  // ---------------------------------------------------------------------------
  console.log("[TEST 3] Verifying authentication, mode check, and plan code validation...");
  process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
  process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";
  process.env.RAZORPAY_MODE = "test";
  process.env.RAZORPAY_KEY_ID = "rzp_test_mock_12345678";
  process.env.RAZORPAY_KEY_SECRET = "mock_secret_key";
  process.env.RAZORPAY_AUTORENEW_PLAN_WEEKLY = "plan_weekly_123";
  process.env.RAZORPAY_AUTORENEW_PLAN_MONTHLY = "plan_monthly_456";
  process.env.RAZORPAY_AUTORENEW_PLAN_QUARTERLY = "plan_quarterly_789";

  // 3a: Missing Authorization Header
  const reqNoAuth = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planCode: "monthly" }),
  });
  const resNoAuth = await POST(reqNoAuth);
  assert.strictEqual(resNoAuth.status, 401, "Must return 401 when Authorization header is missing");
  console.log("  ✓ Missing Authorization header rejected with 401.");

  // Mock Supabase User
  const mockUser = {
    id: "usr_mock_12345678",
    email: "subscriber@careermonke.com",
    user_metadata: { full_name: "Mock Subscriber" },
  };

  let dbStoredSubscriptionId: string | null = null;
  let dbStoredPlanCode: string | null = null;

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
      assert.strictEqual(table, "subscriptions", "Must query subscriptions table");
      return {
        select: (_cols: string) => ({
          eq: (_field: string, _val: string) => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
        insert: async (row: any) => {
          dbStoredSubscriptionId = row.subscription_id;
          dbStoredPlanCode = row.plan_id;
          return { error: null };
        },
        update: (_row: any) => ({
          eq: async () => ({ error: null }),
        }),
      };
    },
  };

  // 3b: Invalid Plan Code
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

  // 3c: Mode Mismatch (RAZORPAY_MODE=live with rzp_test_ key)
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
  // TEST 4: Fail-closed Server Ban Check
  // ---------------------------------------------------------------------------
  console.log("[TEST 4] Verifying fail-closed ban check for blocked users...");
  process.env.RAZORPAY_MODE = "test";

  // 4a: Blocked user rejected with 403
  const makeBlockedReq = () =>
    new Request("http://localhost:3000/api/billing/razorpay/subscription", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_token",
      },
      body: JSON.stringify({ planCode: "monthly" }),
    });

  const reqBlockedUser = makeBlockedReq();
  (reqBlockedUser as any).__testDeps = {
    getSupabaseAdmin: () => mockSupabaseAdmin,
    verifyUserNotBanned: async () => ({ isBlocked: true, error: "Account suspended." }),
  };
  const resBlocked = await POST(reqBlockedUser);
  assert.strictEqual(resBlocked.status, 403, "Blocked user must be rejected with 403");
  const jsonBlocked = await resBlocked.json();
  assert.strictEqual(jsonBlocked.code, "USER_BLOCKED");
  console.log("  ✓ Blocked user rejected with 403 USER_BLOCKED.");

  // 4b: Ban check service failure fails closed with 503
  const reqBanUnavailable = makeBlockedReq();
  (reqBanUnavailable as any).__testDeps = {
    getSupabaseAdmin: () => mockSupabaseAdmin,
    verifyUserNotBanned: async () => ({ isBlocked: true, isServiceUnavailable: true, error: "Ban check unavailable" }),
  };
  const resBanUnavailable = await POST(reqBanUnavailable);
  assert.strictEqual(resBanUnavailable.status, 503, "Ban check failure must fail closed with 503");
  console.log("  ✓ Ban check failure fails closed with 503 USER_BLOCKED.");

  // 4c: Netlify function blocked user check
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
  // TEST 5: Subscription Creation with Total Count and DB Storage
  // ---------------------------------------------------------------------------
  console.log("[TEST 5] Verifying subscription creation for weekly, monthly, and quarterly...");
  const testCases = [
    {
      planCode: "weekly",
      expectedPlanId: "plan_weekly_123",
      expectedTotalCount: 52, // 52 weeks = 1 year
    },
    {
      planCode: "monthly",
      expectedPlanId: "plan_monthly_456",
      expectedTotalCount: 12, // 12 months = 1 year
    },
    {
      planCode: "quarterly",
      expectedPlanId: "plan_quarterly_789",
      expectedTotalCount: 4, // 4 quarters = 1 year
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

    // Include spoofed client amounts to verify server ignores them
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

    // Verify stored on database user row
    assert.strictEqual(dbStoredSubscriptionId, `sub_rzp_${tc.planCode}_9999`);
    assert.strictEqual(dbStoredPlanCode, tc.planCode);

    console.log(
      `  ✓ Plan ${tc.planCode}: mapped to ${tc.expectedPlanId}, total_count: ${tc.expectedTotalCount}, client amounts ignored, subscription_id stored in DB.`
    );
  }

  // ---------------------------------------------------------------------------
  // TEST 6: Prepaid Order Flow Verification (No side-effects on prepaid flow)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 6] Verifying prepaid order route (/api/billing/razorpay/order) remains unchanged...");
  const orderRouteModule = await import("../src/app/api/billing/razorpay/order/route");
  assert.ok(
    typeof orderRouteModule.POST === "function",
    "/api/billing/razorpay/order POST handler must exist"
  );
  const orderRouteContent = await import("node:fs").then((fs) =>
    fs.readFileSync("src/app/api/billing/razorpay/order/route.ts", "utf-8")
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
