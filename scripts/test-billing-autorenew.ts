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
  assert.ok(
    pricingFile.includes("renews every 7/30/90 days from purchase"),
    "Pricing footer must state 'renews every 7/30/90 days from purchase'"
  );
  assert.ok(
    !pricingFile.includes("getRenewalDateString"),
    "Pricing page must not use getRenewalDateString or Date.now in static export"
  );
  assert.ok(
    refundFile.includes("CareerMonke is operated by Olive Ridley Media Private Limited. Plans auto-renew every 7/30/90 days until cancelled (renews every 7/30/90 days from purchase)"),
    "Refund policy intro must be conditional on flag when ON"
  );
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
    rpc: async (fn: string, params: any) => {
      if (fn === "cancel_autorenew_subscription") {
        if (mockExistingSub && mockExistingSub.user_id === params.p_user_id) {
          mockExistingSub.cancel_at_period_end = true;
          mockExistingSub.metadata = { ...(mockExistingSub.metadata || {}), ...(params.p_metadata || {}) };
        }
        for (const order of dbStoredPaymentOrders) {
          if (order.user_id === params.p_user_id && order.provider_order_id === params.p_mandate_id) {
            order.status = "cancelled";
          }
        }
        return { data: true, error: null };
      }
      return { data: true, error: null };
    },
    from: (table: string) => {
      let filters: Record<string, any> = {};
      let neqFilters: Record<string, any> = {};
      let likeFilters: Record<string, string> = {};
      let gteFilters: Record<string, any> = {};
      let ltFilters: Record<string, any> = {};
      let inFilters: Record<string, any[]> = {};

      const matchesFilters = (rawO: any) => {
        const o = {
          recurring_kind: rawO.recurring_kind || (rawO.provider_order_id?.startsWith("sub_") ? "recurring" : "none"),
          ...rawO,
        };
        for (const [k, v] of Object.entries(filters)) {
          if (o[k] !== v) return false;
        }
        for (const [k, v] of Object.entries(neqFilters)) {
          if (o[k] === v) return false;
        }
        for (const [k, pat] of Object.entries(likeFilters)) {
          const val = String(o[k] || "");
          const prefix = pat.replace(/%/g, "");
          if (!val.startsWith(prefix)) return false;
        }
        for (const [k, v] of Object.entries(gteFilters)) {
          if (o[k] < v) return false;
        }
        for (const [k, v] of Object.entries(ltFilters)) {
          if (o[k] >= v) return false;
        }
        for (const [k, vals] of Object.entries(inFilters)) {
          if (!vals.includes(o[k])) return false;
        }
        return true;
      };

      const getMatchingRows = () => {
        if (table === "payment_orders") {
          return dbStoredPaymentOrders.filter(matchesFilters);
        }
        if (table === "subscriptions") {
          const subs = mockExistingSub ? [mockExistingSub] : [];
          return subs.filter(matchesFilters);
        }
        return [];
      };

      const query: any = {
        select: () => query,
        order: () => query,
        limit: () => query,
        eq: (col: string, val: any) => {
          filters[col] = val;
          return query;
        },
        neq: (col: string, val: any) => {
          neqFilters[col] = val;
          return query;
        },
        like: (col: string, pat: string) => {
          likeFilters[col] = pat;
          return query;
        },
        gte: (col: string, val: any) => {
          gteFilters[col] = val;
          return query;
        },
        lt: (col: string, val: any) => {
          ltFilters[col] = val;
          return query;
        },
        in: (col: string, vals: any[]) => {
          inFilters[col] = vals;
          return query;
        },
        maybeSingle: async () => {
          const rows = getMatchingRows();
          return { data: rows[0] || null, error: null };
        },
        then: (resolve: (val: any) => void) => {
          resolve({ data: getMatchingRows(), error: null });
        },
        insert: async (row: any) => {
          if (table === "payment_orders") {
            dbStoredPaymentOrders.push({ ...row });
          } else if (table === "subscriptions") {
            mockExistingSub = { ...row };
          }
          return { error: null };
        },
        update: (updates: any) => {
          let updateFilters: Record<string, any> = {};
          let updateInFilters: Record<string, any[]> = {};
          let updateLtFilters: Record<string, any> = {};
          let updateGteFilters: Record<string, any> = {};

          const updateBuilder: any = {
            eq: (col: string, val: any) => {
              updateFilters[col] = val;
              return updateBuilder;
            },
            in: (col: string, vals: any[]) => {
              updateInFilters[col] = vals;
              return updateBuilder;
            },
            lt: (col: string, val: any) => {
              updateLtFilters[col] = val;
              return updateBuilder;
            },
            gte: (col: string, val: any) => {
              updateGteFilters[col] = val;
              return updateBuilder;
            },
            select: () => updateBuilder,
            then: (resolve: (val: any) => void) => {
              const updatedList: any[] = [];
              if (table === "payment_orders") {
                for (const order of dbStoredPaymentOrders) {
                  let match = true;
                  for (const [k, v] of Object.entries(updateFilters)) {
                    if (order[k] !== v) match = false;
                  }
                  for (const [k, vals] of Object.entries(updateInFilters)) {
                    if (!vals.includes(order[k])) match = false;
                  }
                  for (const [k, v] of Object.entries(updateLtFilters)) {
                    if (order[k] >= v) match = false;
                  }
                  for (const [k, v] of Object.entries(updateGteFilters)) {
                    if (order[k] < v) match = false;
                  }
                  if (match) {
                    Object.assign(order, updates);
                    updatedList.push(order);
                  }
                }
              } else if (table === "subscriptions") {
                if (mockExistingSub) {
                  let match = true;
                  for (const [k, v] of Object.entries(updateFilters)) {
                    if (mockExistingSub[k] !== v) match = false;
                  }
                  if (match) {
                    Object.assign(mockExistingSub, updates);
                    dbStoredSubscriptionMetadata = updates.metadata;
                    updatedList.push(mockExistingSub);
                  }
                }
              }
              resolve({ data: updatedList, error: null });
            },
          };
          return updateBuilder;
        },
      };
      return query;
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
  console.log("  ✓ Netlify function blocks active plan holder with 409 ACTIVE_PLAN_EXISTS.");

  // 7c: Fail-closed on subscription lookup error (503 before Razorpay call)
  const reqLookupErr = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
    body: JSON.stringify({ planCode: "monthly" }),
  });
  let rzpCalledOnLookupErr = false;
  (reqLookupErr as any).__testDeps = {
    getSupabaseAdmin: () => ({
      ...mockSupabaseAdmin,
      from: () => {
        const errQuery: any = {
          select: () => errQuery,
          eq: () => errQuery,
          order: () => errQuery,
          limit: () => errQuery,
          maybeSingle: async () => ({ data: null, error: new Error("DB read connection lost") }),
        };
        return errQuery;
      },
    }),
    fetchFn: async () => {
      rzpCalledOnLookupErr = true;
      return new Response();
    },
    verifyUserNotBanned: async () => ({ isBlocked: false }),
  };
  const resLookupErr = await POST(reqLookupErr);
  assert.strictEqual(resLookupErr.status, 503, "Lookup failure must fail closed with 503");
  const jsonLookupErr = await resLookupErr.json();
  assert.strictEqual(jsonLookupErr.code, "SERVICE_UNAVAILABLE");
  assert.strictEqual(rzpCalledOnLookupErr, false, "Razorpay must never be called on lookup failure");
  console.log("  ✓ Subscription lookup error fails closed with 503 before any Razorpay call.");

  // 7d: Idempotent pending attempts: reuses pending payment_orders row for same plan
  dbStoredPaymentOrders.push({
    id: "existing_pending_monthly_1",
    user_id: mockUser.id,
    provider: "razorpay",
    provider_order_id: "sub_rzp_reused_monthly_999",
    plan_code: "monthly",
    amount_paise: 149900,
    status: "created",
    mode: "test",
    created_at: new Date().toISOString(),
  });
  let rzpCreateCalledOnReuse = false;
  const reqReuse = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
    body: JSON.stringify({ planCode: "monthly" }),
  });
  mockExistingSub = null;
  (reqReuse as any).__testDeps = {
    getSupabaseAdmin: () => mockSupabaseAdmin,
    verifyUserNotBanned: async () => ({ isBlocked: false }),
    fetchFn: async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/plans/")) {
        return new Response(
          JSON.stringify({
            id: "plan_monthly_456",
            item: { amount: 149900, currency: "INR" },
            period: "monthly",
            interval: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (urlStr.includes("/v1/subscriptions/sub_rzp_reused_monthly_999")) {
        return new Response(
          JSON.stringify({
            id: "sub_rzp_reused_monthly_999",
            plan_id: "plan_monthly_456",
            status: "created",
            created_at: Math.floor(Date.now() / 1000),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (init?.method === "POST" && urlStr.endsWith("/v1/subscriptions")) {
        rzpCreateCalledOnReuse = true;
      }
      return new Response();
    },
  };
  const resReuse = await POST(reqReuse);
  assert.strictEqual(resReuse.status, 200, "Reusing pending order must return 200");
  const jsonReuse = await resReuse.json();
  assert.strictEqual(jsonReuse.subscriptionId, "sub_rzp_reused_monthly_999");
  assert.strictEqual(jsonReuse.reused, true);
  assert.strictEqual(rzpCreateCalledOnReuse, false, "Razorpay creation must not be called when reusing pending mandate");
  console.log("  ✓ Idempotent check reuses existing pending payment_orders row without creating second mandate.");

  // 7e: Pending order for different plan returns 409
  dbStoredPaymentOrders.length = 0;
  dbStoredPaymentOrders.push({
    id: "existing_pending_weekly_diff",
    user_id: mockUser.id,
    provider: "razorpay",
    provider_order_id: "sub_rzp_pending_weekly_diff",
    plan_code: "weekly",
    amount_paise: 69200,
    status: "created",
    mode: "test",
    created_at: new Date().toISOString(),
  });
  let rzpCalledOnDiffPlan = false;
  const reqDiffPlan = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
    body: JSON.stringify({ planCode: "monthly" }),
  });
  (reqDiffPlan as any).__testDeps = {
    getSupabaseAdmin: () => mockSupabaseAdmin,
    verifyUserNotBanned: async () => ({ isBlocked: false }),
    fetchFn: async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/plans/")) {
        return new Response(
          JSON.stringify({
            id: "plan_monthly_456",
            item: { amount: 149900, currency: "INR" },
            period: "monthly",
            interval: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (init?.method === "POST" && urlStr.endsWith("/v1/subscriptions")) {
        rzpCalledOnDiffPlan = true;
      }
      return new Response();
    },
  };
  const resDiffPlan = await POST(reqDiffPlan);
  assert.strictEqual(resDiffPlan.status, 409, "Pending order for different plan must return 409");
  const jsonDiffPlan = await resDiffPlan.json();
  assert.strictEqual(jsonDiffPlan.code, "PENDING_SUBSCRIPTION_EXISTS");
  assert.strictEqual(rzpCalledOnDiffPlan, false);
  console.log("  ✓ Pending order for different plan returns 409 PENDING_SUBSCRIPTION_EXISTS without calling Razorpay.\n");

  // Clean up stored pending orders for test 8
  dbStoredPaymentOrders.length = 0;

  // ---------------------------------------------------------------------------
  // TEST 8: Subscription Creation, Total Count, and Separate Pending Storage
  // ---------------------------------------------------------------------------
  console.log("[TEST 8] Verifying subscription creation, total_count, and separate pending storage...");
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
      period: "weekly",
      interval: 1,
    },
    {
      planCode: "monthly",
      expectedPlanId: "plan_monthly_456",
      expectedTotalCount: 12, // 12 months = 1 year
      expectedAmountPaise: 149900,
      period: "monthly",
      interval: 1,
    },
    {
      planCode: "quarterly",
      expectedPlanId: "plan_quarterly_789",
      expectedTotalCount: 4, // 4 quarters = 1 year
      expectedAmountPaise: 399900,
      period: "monthly",
      interval: 3,
    },
  ];

  for (const tc of testCases) {
    dbStoredPaymentOrders.length = 0;
    dbStoredSubscriptionMetadata = null;
    mockExistingSub.metadata = { prior: "data" };
    let capturedRazorpayBody: any = null;

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/plans/")) {
        return new Response(
          JSON.stringify({
            id: tc.expectedPlanId,
            item: { amount: tc.expectedAmountPaise, currency: "INR" },
            period: tc.period,
            interval: tc.interval,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      assert.strictEqual(
        urlStr,
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
          current_start: Math.floor(Date.now() / 1000),
          current_end: Math.floor(Date.now() / 1000) + 30 * 86400,
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

    // Verify stored in payment_orders
    const createdOrder = dbStoredPaymentOrders.find((o) => o.provider_order_id === `sub_rzp_${tc.planCode}_9999`);
    assert.ok(createdOrder, "Pending subscription must be inserted into payment_orders");
    assert.strictEqual(createdOrder.plan_code, tc.planCode);
    assert.strictEqual(createdOrder.amount_paise, tc.expectedAmountPaise);
    assert.strictEqual(createdOrder.status, "created");

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

  // ---------------------------------------------------------------------------
  // TEST 10: Item 1 - Provider Plan Verification Failure Handling
  // ---------------------------------------------------------------------------
  console.log("[TEST 10] Verifying provider plan verification fails closed on mismatch...");
  dbStoredPaymentOrders.length = 0;
  mockExistingSub = null;
  const reqPlanMismatch = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
    body: JSON.stringify({ planCode: "monthly" }),
  });
  (reqPlanMismatch as any).__testDeps = {
    getSupabaseAdmin: () => mockSupabaseAdmin,
    verifyUserNotBanned: async () => ({ isBlocked: false }),
    fetchFn: async (url: string) => {
      if (url.includes("/v1/plans/")) {
        return new Response(
          JSON.stringify({
            id: "plan_monthly_456",
            item: { amount: 50000, currency: "INR" }, // Mismatched amount
            period: "monthly",
            interval: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response();
    },
  };
  const resPlanMismatch = await POST(reqPlanMismatch);
  assert.strictEqual(resPlanMismatch.status, 502, "Mismatched amount must return 502");
  const jsonPlanMismatch = await resPlanMismatch.json();
  assert.strictEqual(jsonPlanMismatch.code, "PLAN_VERIFICATION_MISMATCH");
  console.log("  ✓ Mismatched plan amount fails closed with 502 PLAN_VERIFICATION_MISMATCH.\n");

  // ---------------------------------------------------------------------------
  // TEST 11: Item 2 - Durable Mandate Reservation & Failure Rollback
  // ---------------------------------------------------------------------------
  console.log("[TEST 11] Verifying durable mandate reservation and failure rollback...");
  dbStoredPaymentOrders.length = 0;
  mockExistingSub = null;
  const reqGateFail = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
    body: JSON.stringify({ planCode: "monthly" }),
  });
  (reqGateFail as any).__testDeps = {
    getSupabaseAdmin: () => mockSupabaseAdmin,
    verifyUserNotBanned: async () => ({ isBlocked: false }),
    fetchFn: async (url: string) => {
      if (url.includes("/v1/plans/")) {
        return new Response(
          JSON.stringify({
            id: "plan_monthly_456",
            item: { amount: 149900, currency: "INR" },
            period: "monthly",
            interval: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ error: { description: "Gateway error" } }), { status: 500 });
    },
  };
  const resGateFail = await POST(reqGateFail);
  assert.strictEqual(resGateFail.status, 500);
  const failedReservation = dbStoredPaymentOrders.find((o) => o.provider_order_id.startsWith(`sub_pending_${mockUser.id}`));
  assert.ok(failedReservation, "Reservation row must exist in DB");
  assert.strictEqual(failedReservation.status, "failed", "Reservation status must be marked failed");
  console.log("  ✓ Gateway failure rolls back reservation row to failed status.\n");

  // ---------------------------------------------------------------------------
  // TEST 12: Item 4 - Customer Cancellation via DELETE endpoint
  // ---------------------------------------------------------------------------
  console.log("[TEST 12] Verifying customer cancellation via DELETE endpoint...");
  const { DELETE: deleteHandler } = await import("../src/app/api/billing/razorpay/subscription/route");
  mockExistingSub = {
    id: "sub_active_to_cancel",
    user_id: mockUser.id,
    provider: "razorpay",
    subscription_id: "sub_rzp_to_cancel_123",
    status: "active",
    current_period_end: new Date(Date.now() + 10 * 86400000).toISOString(),
    cancel_at_period_end: false,
    metadata: {},
  };

  let cancelApiCalled = false;
  let cancelCycleEndVal = -1;
  const reqCancel = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Authorization: "Bearer valid_token" },
  });
  (reqCancel as any).__testDeps = {
    getSupabaseAdmin: () => mockSupabaseAdmin,
    fetchFn: async (url: string, init: any) => {
      if (url.includes("/cancel")) {
        cancelApiCalled = true;
        const b = JSON.parse(init.body);
        cancelCycleEndVal = b.cancel_at_cycle_end;
        return new Response(JSON.stringify({ id: "sub_rzp_to_cancel_123", status: "active", cancel_at_cycle_end: 1 }), { status: 200 });
      }
      return new Response();
    },
  };

  const resCancel = await deleteHandler(reqCancel);
  assert.strictEqual(resCancel.status, 200);
  const jsonCancel = await resCancel.json();
  assert.strictEqual(jsonCancel.success, true);
  assert.strictEqual(jsonCancel.cancelAtPeriodEnd, true);
  assert.strictEqual(cancelApiCalled, true, "Razorpay cancel API must be called");
  assert.strictEqual(cancelCycleEndVal, 1, "cancel_at_cycle_end must be 1 (cycle end)");
  assert.strictEqual(mockExistingSub.cancel_at_period_end, true, "DB subscription must be updated with cancel_at_period_end: true");
  console.log("  ✓ Customer cancellation successfully calls Razorpay cancel at cycle end and updates DB.\n");

  console.log("================================================================================");
  console.log("   ALL AUTO-RENEW CHECKOUT TESTS PASSED SUCCESSFULLY!                           ");
  console.log("================================================================================\n");
}

runAutorenewTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
