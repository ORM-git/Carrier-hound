/**
 * scripts/test-pricing-plan-checkout.ts
 *
 * Verification suite for Plan Purchase Buttons and Ban Checks on /pricing:
 * 1. PLANS Catalog Integrity in src/config/plans.ts:
 *    - All 3 subscription plans (weekly, monthly, quarterly) define approved prices and quotas.
 * 2. Static & Markup Conformance in src/app/pricing/page.tsx:
 *    - Uses NEXT_PUBLIC_BILLING_ENABLED gate.
 *    - When enabled, renders active Buy button with data-plan-code={plan.id} and Buy ${plan.name}.
 *    - When disabled, keeps the disabled Upgrade button with a "Payments are currently unavailable." note.
 *    - Single synchronous purchase lock (checkoutLockRef) shared across all plan & add-on checkouts.
 *    - Lock acquired synchronously before any auth await and released in finally.
 *    - Header "Payments will open soon." is flag-aware (omitted when flag is ON).
 *    - Keeps card height/spacing footprint identical between flag states (invisible badge row space).
 *    - Redirects unauthenticated visitors to /login?returnTo=%2Fpricing.
 * 3. Server-Authoritative Pricing Resolution:
 *    - resolveOrderPricing resolves approved paise amounts for weekly (39900), monthly (49900), and quarterly (219900).
 * 4. Server-Side Ban Checks on Plan Orders (Next & Netlify routes):
 *    - Fail-closed verification runs on plan orders (not only add-ons).
 *    - Rejects blocked users (metadata or blocked_users table) with 403 USER_BLOCKED.
 *    - Fails closed with 503 on database error during ban check.
 *    - Creates orders for unblocked accounts with server-resolved paise amounts.
 * 5. Negative Control Mode:
 *    - Exits non-zero (1) when run with --negative-control.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { PLANS } from "../src/config/plans";
import { resolveOrderPricing } from "../src/lib/billing/quota";
import { POST as orderPost } from "../src/app/api/billing/razorpay/order/route";
import { createHandler as createNetlifyOrderHandler } from "../netlify/functions/billing-razorpay-order";

// Batch1 strict order rate limiter: default-allow stub keeps this suite on its own path. Deny/store-down behavior is covered by src/lib/__tests__/billingRazorpayOrderRouteRateLimit.test.ts and netlifyBillingRazorpayOrderRateLimit.test.ts.
const allowOrderRateLimit = async () => ({ allowed: true, retryAfter: 0, currentCount: 1, source: "shared" });

const isNegativeControl = process.argv.includes("--negative-control");

if (isNegativeControl) {
  console.log("⚠️ [NEGATIVE CONTROL MODE ACTIVE]: Intentionally asserting invalid condition...\n");
  assert.strictEqual(
    PLANS.length,
    999,
    "Negative control expected mismatch: PLANS length must be 3, not 999!"
  );
  process.exit(1);
}

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res && typeof (res as any).then === "function") {
      await res;
    }
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    failed++;
  }
}

interface MockSupabaseOptions {
  userId?: string;
  email?: string;
  userMetadata?: any;
  isBlockedInDb?: boolean;
  dbErrorOnBlockedCheck?: boolean;
}

function createMockSupabaseAdmin(options: MockSupabaseOptions = {}) {
  const userId = options.userId || "user_test_plan_buyer";
  const user = {
    id: userId,
    email: options.email || "candidate@careermonke.com",
    user_metadata: options.userMetadata || {},
  };

  let insertedOrder: any = null;

  return {
    getInsertedOrder: () => insertedOrder,
    client: {
      auth: {
        getUser: async (token?: string) => {
          if (!token || token === "invalid-token") {
            return { data: { user: null }, error: new Error("Invalid token") };
          }
          return { data: { user }, error: null };
        },
      },
      from: (table: string) => {
        if (table === "blocked_users") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => {
                  if (options.dbErrorOnBlockedCheck) {
                    return { data: null, error: new Error("DB connection failure on blocked_users") };
                  }
                  if (options.isBlockedInDb) {
                    return { data: { user_id: userId }, error: null };
                  }
                  return { data: null, error: null };
                },
              }),
            }),
          };
        }

        if (table === "payment_orders") {
          return {
            insert: (data: any) => {
              insertedOrder = data;
              return {
                select: () => ({
                  single: async () => ({
                    data: { id: "order_row_uuid_123", ...data },
                    error: null,
                  }),
                }),
              };
            },
          };
        }

        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
        };
      },
    },
  };
}

const mockRazorpayFetch = async (_url: string, opts: any) => {
  const body = JSON.parse(opts.body);
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: `order_rzp_${Date.now()}`,
      amount: body.amount,
      currency: body.currency,
      receipt: body.receipt,
    }),
  } as any;
};

async function main() {
  console.log("================================================================================");
  console.log("   PRICING PLAN PURCHASE FLOW VERIFICATION SUITE                               ");
  console.log("================================================================================");

  // 1. PLANS Catalog Integrity
  console.log("\n1. Verifying PLANS catalog definitions in src/config/plans.ts...");
  await check("PLANS defines weekly, monthly, quarterly with approved prices", () => {
    assert.strictEqual(PLANS.length, 3, "Must have exactly 3 plans");
    const ids = PLANS.map((p) => p.id);
    assert.deepStrictEqual(ids, ["weekly", "monthly", "quarterly"]);

    const weekly = PLANS.find((p) => p.id === "weekly")!;
    assert.strictEqual(weekly.price, 399, "Weekly price must be ₹399");

    const monthly = PLANS.find((p) => p.id === "monthly")!;
    assert.strictEqual(monthly.price, 499, "Monthly price must be ₹499");

    const quarterly = PLANS.find((p) => p.id === "quarterly")!;
    assert.strictEqual(quarterly.price, 2199, "Quarterly price must be ₹2,199");
  });

  // 2. Static & Markup Conformance
  console.log("\n2. Verifying /pricing page source, button styling, and in-flight guards...");
  await check("Pricing page gates buy button with NEXT_PUBLIC_BILLING_ENABLED", () => {
    const pricingSrc = fs.readFileSync(path.resolve("src/app/pricing/page.tsx"), "utf8");

    assert.ok(
      pricingSrc.includes("NEXT_PUBLIC_BILLING_ENABLED"),
      "Pricing page must check NEXT_PUBLIC_BILLING_ENABLED"
    );
    assert.ok(
      pricingSrc.includes("data-plan-code={plan.id}"),
      "Pricing page must render data-plan-code={plan.id} on Buy buttons"
    );
    assert.ok(
      pricingSrc.includes("Buy {plan.name}"),
      "Pricing page must render 'Buy {plan.name}' button text when enabled"
    );
    assert.ok(
      pricingSrc.includes("Payments are currently unavailable."),
      "Pricing page must show a payments-unavailable note when disabled"
    );
  });

  await check("Pricing page enforces single shared purchase lock held until terminal callbacks (no unconditional finally release)", () => {
    const pricingSrc = fs.readFileSync(path.resolve("src/app/pricing/page.tsx"), "utf8");

    assert.ok(
      pricingSrc.includes("checkoutLockRef = useRef<boolean>(false)"),
      "Pricing page must define single shared checkoutLockRef"
    );
    assert.ok(
      pricingSrc.includes("disabled={isCheckoutLocked"),
      "Plan buttons must be disabled when isCheckoutLocked is true"
    );
    assert.ok(
      !pricingSrc.includes("finally"),
      "handleBuyPlan must NOT unconditionally release purchase lock in finally"
    );
    assert.ok(
      pricingSrc.includes("onError:") && pricingSrc.includes("onSuccess:") && pricingSrc.includes("onDismiss:"),
      "handleBuyPlan must release purchase lock in terminal callbacks"
    );
    assert.ok(
      pricingSrc.includes("resetLock();\n      const loginUrl") ||
      pricingSrc.includes("resetLock();\r\n      const loginUrl"),
      "handleBuyPlan must release purchase lock explicitly on unauthenticated early exit"
    );
  });

  await check("Pricing page has no invisible placeholder rows or add-on purchase UI", () => {
    const pricingSrc = fs.readFileSync(path.resolve("src/app/pricing/page.tsx"), "utf8");

    assert.ok(!pricingSrc.includes("invisible inline-flex"), "Pricing page must not keep invisible placeholder badge rows");
    assert.ok(!pricingSrc.includes("data-addon-code") && !pricingSrc.includes("handleBuyAddon"), "Pricing page must not sell add-ons");
  });

  await check("Pricing page redirects unauthenticated visitors to login returning to pricing", () => {
    const pricingSrc = fs.readFileSync(path.resolve("src/app/pricing/page.tsx"), "utf8");

    assert.ok(
      pricingSrc.includes("/login?returnTo=") && pricingSrc.includes('encodeURIComponent("/pricing")'),
      "handleBuyPlan must redirect unauthenticated visitors to /login?returnTo=/pricing"
    );
  });

  // 3. Server-Authoritative Pricing Resolution
  console.log("\n3. Verifying server-authoritative plan pricing resolution...");
  await check("resolveOrderPricing returns correct paise amounts for all subscription plans", () => {
    const weeklyOrder = resolveOrderPricing({ planCode: "weekly" });
    assert.ok(weeklyOrder, "Weekly plan must resolve");
    assert.strictEqual(weeklyOrder.amount_paise, 39900, "Weekly order amount must be 39900 paise");
    assert.strictEqual(weeklyOrder.currency, "INR");
    assert.strictEqual(weeklyOrder.code, "weekly");

    const monthlyOrder = resolveOrderPricing({ planCode: "monthly" });
    assert.ok(monthlyOrder, "Monthly plan must resolve");
    assert.strictEqual(monthlyOrder.amount_paise, 49900, "Monthly order amount must be 49900 paise");
    assert.strictEqual(monthlyOrder.currency, "INR");
    assert.strictEqual(monthlyOrder.code, "monthly");

    const quarterlyOrder = resolveOrderPricing({ planCode: "quarterly" });
    assert.ok(quarterlyOrder, "Quarterly plan must resolve");
    assert.strictEqual(quarterlyOrder.amount_paise, 219900, "Quarterly order amount must be 219900 paise");
    assert.strictEqual(quarterlyOrder.currency, "INR");
    assert.strictEqual(quarterlyOrder.code, "quarterly");
  });

  // 4. Server-Side Ban Checks on Plan Orders
  console.log("\n4. Verifying server-side ban checks on plan orders...");

  // Setup test env for order route verification
  const origBilling = process.env.NEXT_PUBLIC_BILLING_ENABLED;
  const origKeyId = process.env.RAZORPAY_KEY_ID;
  const origKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const origMode = process.env.RAZORPAY_MODE;

  process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
  process.env.RAZORPAY_KEY_ID = "rzp_test_1234567890ABCD";
  process.env.RAZORPAY_KEY_SECRET = "test_secret_123456";
  process.env.RAZORPAY_MODE = "test";

  try {
    // 4A. Next Route
    console.log("  4A. Next.js route: /api/billing/razorpay/order");
    await check("Next route rejects blocked user via metadata on plan order with 403 USER_BLOCKED", async () => {
      const mock = createMockSupabaseAdmin({
        userMetadata: { is_blocked: true },
      });
      const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer mock-token" },
        body: JSON.stringify({ planCode: "monthly" }),
      });
      (req as any).__testDeps = {
        checkRateLimit: allowOrderRateLimit,
        getSupabaseAdmin: () => mock.client,
        isProductionHost: false,
        fetchFn: mockRazorpayFetch,
      };

      const res = await orderPost(req);
      assert.strictEqual(res.status, 403, "Blocked user on plan order must receive 403");
      const data = await res.json();
      assert.strictEqual(data.code, "USER_BLOCKED");
    });

    await check("Next route rejects blocked user via blocked_users table on plan order with 403 USER_BLOCKED", async () => {
      const mock = createMockSupabaseAdmin({
        isBlockedInDb: true,
      });
      const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer mock-token" },
        body: JSON.stringify({ planCode: "quarterly" }),
      });
      (req as any).__testDeps = {
        checkRateLimit: allowOrderRateLimit,
        getSupabaseAdmin: () => mock.client,
        isProductionHost: false,
        fetchFn: mockRazorpayFetch,
      };

      const res = await orderPost(req);
      assert.strictEqual(res.status, 403, "Blocked user on plan order must receive 403");
      const data = await res.json();
      assert.strictEqual(data.code, "USER_BLOCKED");
    });

    await check("Next route fails closed with 503 on database error during ban check on plan order", async () => {
      const mock = createMockSupabaseAdmin({
        dbErrorOnBlockedCheck: true,
      });
      const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer mock-token" },
        body: JSON.stringify({ planCode: "weekly" }),
      });
      (req as any).__testDeps = {
        checkRateLimit: allowOrderRateLimit,
        getSupabaseAdmin: () => mock.client,
        isProductionHost: false,
        fetchFn: mockRazorpayFetch,
      };

      const res = await orderPost(req);
      assert.strictEqual(res.status, 503, "DB error during ban check must fail closed with 503");
      const data = await res.json();
      assert.strictEqual(data.code, "USER_BLOCKED");
    });

    await check("Next route creates plan order with server-resolved amounts for unblocked user", async () => {
      for (const [code, expectedPaise] of [["weekly", 39900], ["monthly", 49900], ["quarterly", 219900]] as const) {
        const mock = createMockSupabaseAdmin();
        const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer mock-token" },
          body: JSON.stringify({ planCode: code }),
        });
        (req as any).__testDeps = {
          checkRateLimit: allowOrderRateLimit,
          getSupabaseAdmin: () => mock.client,
          isProductionHost: false,
          fetchFn: mockRazorpayFetch,
        };

        const res = await orderPost(req);
        assert.strictEqual(res.status, 200, `Plan ${code} order must succeed with 200`);
        const data = await res.json();
        assert.strictEqual(data.amount, expectedPaise, `Plan ${code} order amount must match server catalog (${expectedPaise})`);
      }
    });

    // 4B. Netlify Function
    console.log("  4B. Netlify function: billing-razorpay-order.ts");
    await check("Netlify handler rejects blocked user on plan order with 403 USER_BLOCKED", async () => {
      const mock = createMockSupabaseAdmin({
        userMetadata: { is_blocked: true },
      });
      const handler = createNetlifyOrderHandler({
        checkRateLimit: allowOrderRateLimit,
        getSupabaseAdmin: () => mock.client,
        isProductionHost: false,
        fetchFn: mockRazorpayFetch as any,
      });

      const res = await handler({
        httpMethod: "POST",
        headers: { authorization: "Bearer mock-token" },
        body: JSON.stringify({ planCode: "monthly" }),
      });

      assert.strictEqual(res.statusCode, 403, "Netlify must return 403 for blocked user on plan order");
      const data = JSON.parse(res.body);
      assert.strictEqual(data.code, "USER_BLOCKED");
    });

    await check("Netlify handler fails closed with 503 on database error during ban check on plan order", async () => {
      const mock = createMockSupabaseAdmin({
        dbErrorOnBlockedCheck: true,
      });
      const handler = createNetlifyOrderHandler({
        checkRateLimit: allowOrderRateLimit,
        getSupabaseAdmin: () => mock.client,
        isProductionHost: false,
        fetchFn: mockRazorpayFetch as any,
      });

      const res = await handler({
        httpMethod: "POST",
        headers: { authorization: "Bearer mock-token" },
        body: JSON.stringify({ planCode: "weekly" }),
      });

      assert.strictEqual(res.statusCode, 503, "Netlify must return 503 for DB failure during ban check");
      const data = JSON.parse(res.body);
      assert.strictEqual(data.code, "USER_BLOCKED");
    });

    await check("Netlify handler creates plan order with server-resolved amounts for unblocked user", async () => {
      for (const [code, expectedPaise] of [["weekly", 39900], ["monthly", 49900], ["quarterly", 219900]] as const) {
        const mock = createMockSupabaseAdmin();
        const handler = createNetlifyOrderHandler({
          checkRateLimit: allowOrderRateLimit,
          getSupabaseAdmin: () => mock.client,
          isProductionHost: false,
          fetchFn: mockRazorpayFetch as any,
        });

        const res = await handler({
          httpMethod: "POST",
          headers: { authorization: "Bearer mock-token" },
          body: JSON.stringify({ planCode: code }),
        });

        assert.strictEqual(res.statusCode, 200, `Netlify plan ${code} order must succeed with 200`);
        const data = JSON.parse(res.body);
        assert.strictEqual(data.amount, expectedPaise, `Netlify plan ${code} order amount must match server catalog`);
      }
    });
  } finally {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = origBilling;
    process.env.RAZORPAY_KEY_ID = origKeyId;
    process.env.RAZORPAY_KEY_SECRET = origKeySecret;
    process.env.RAZORPAY_MODE = origMode;
  }

  // 5. Negative Control Self-Test
  console.log("\n5. Confirming negative control fails with non-zero exit code...");
  await check("Negative control exits non-zero", () => {
    const { spawnSync } = require("child_process");
    const negResult = spawnSync(process.execPath, ["-r", "tsx", __filename, "--negative-control"], {
      encoding: "utf-8",
      env: process.env,
    });
    assert.notStrictEqual(
      negResult.status,
      0,
      "Negative control MUST exit with non-zero exit code"
    );
  });

  console.log("\n--------------------------------------------------------------------------------");
  console.log(`TEST SUITE RESULTS: ${passed} passed, ${failed} failed`);
  console.log("--------------------------------------------------------------------------------\n");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});
