/**
 * scripts/test-pricing-addon-checkout.ts
 *
 * Verification suite for Add-on Pack "Buy" Buttons on /pricing:
 * 1. ADD_ON_PACKS Catalog Integrity in src/config/plans.ts:
 *    - All 3 add-on packs (addon_10, addon_30, addon_60) define exact codes, prices, and sets.
 * 2. Static & Markup Conformance:
 *    - Each add-on card renders an active "Buy" button with data-addon-code and min-h-[48px].
 *    - Plan upgrade buttons remain disabled Upgrade buttons with UPGRADE_BUTTON_LABEL.
 *    - Single unified in-flight guard across ALL add-on pack buttons (disabled={loadingAddon !== null}).
 *    - Re-entrancy guard in handleBuyAddon (if loadingAddon !== null return).
 *    - Dismiss, error, and success lifecycle handlers clear loadingAddon.
 *    - Amount is server-side authoritative only (client sends addonCode only).
 * 3. Functional Checkout & Auth Redirection:
 *    - Clicking Buy sends the exact addonCode to /api/billing/razorpay/order.
 * 4. Server-Side Pre-Charge Gating & Order Creation (Next.js route & Netlify function):
 *    - Fail-closed server ban check (verifyUserNotBanned / blocked_users):
 *      * Blocks user when user_metadata.is_blocked is true (403 USER_BLOCKED).
 *      * Blocks user when present in blocked_users table (403 USER_BLOCKED).
 *      * Fails closed with 503 when ban check service/DB encounters an error.
 *    - Pre-charge eligibility check aligned with fulfillment SQL:
 *      * Rejects non-Pro users (403 PRO_REQUIRED).
 *      * Rejects users in in_grace_period (403 PRO_REQUIRED).
 *      * Rejects active users with null current_period_end (403 PRO_REQUIRED).
 *      * Rejects active users with expired/past current_period_end (403 PRO_REQUIRED).
 *      * Accepts active or trialing users with future current_period_end (200 OK).
 * 5. Verify Route Conformance:
 *    - /api/billing/razorpay/verify accepts matching addonCode.
 *    - Mismatched addonCode is rejected with 400 ADDON_MISMATCH.
 * 6. Negative Control Mode:
 *    - Exits non-zero (1) when run with --negative-control.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ADD_ON_PACKS, formatPriceINR, UPGRADE_BUTTON_LABEL } from "../src/config/plans";
import { resolveOrderPricing, ADDON_PACK_DEFINITIONS } from "../src/lib/billing/quota";
import { openRazorpayCheckout } from "../src/lib/billing/razorpay";
import { POST as orderPost } from "../src/app/api/billing/razorpay/order/route";
import { POST as verifyPost } from "../src/app/api/billing/razorpay/verify/route";
import { createHandler as createNetlifyOrderHandler } from "../netlify/functions/billing-razorpay-order";

const isNegativeControl = process.argv.includes("--negative-control");

if (isNegativeControl) {
  console.log("⚠️ [NEGATIVE CONTROL MODE ACTIVE]: Intentionally asserting invalid condition...\n");
  assert.strictEqual(
    ADD_ON_PACKS.length,
    999,
    "Negative control expected mismatch: ADD_ON_PACKS length must be 3, not 999!"
  );
  process.exit(1);
}

function setEnv(key: string, val: string | undefined) {
  if (val === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = val;
  }
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
  subscription?: {
    status: string;
    current_period_end: string | null;
  } | null;
  dbErrorOnSubscription?: boolean;
}

function createMockSupabaseAdmin(options: MockSupabaseOptions = {}) {
  const userId = options.userId || "user_test_pro_123";
  const user = {
    id: userId,
    email: options.email || "pro@careermonke.com",
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

        if (table === "subscriptions") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => {
                      if (options.dbErrorOnSubscription) {
                        return { data: null, error: new Error("DB error on subscriptions") };
                      }
                      return { data: options.subscription ?? null, error: null };
                    },
                  }),
                }),
              }),
            }),
          };
        }

        if (table === "payment_orders") {
          return {
            insert: (row: any) => {
              insertedOrder = row;
              return {
                select: () => ({
                  single: async () => ({ data: row, error: null }),
                }),
              };
            },
          };
        }

        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        };
      },
    },
  };
}

async function runSuite() {
  console.log("================================================================================");
  console.log("   PRICING ADD-ON PACK BUY FLOW VERIFICATION SUITE                             ");
  console.log("================================================================================\n");

  // ---------------------------------------------------------------------------
  // 1. ADD_ON_PACKS Catalog Integrity
  // ---------------------------------------------------------------------------
  console.log("1. Verifying ADD_ON_PACKS catalog definitions in plans.ts and quota.ts...");
  await check("ADD_ON_PACKS defines addon_10, addon_30, addon_60 with exact prices & sets", () => {
    assert.strictEqual(ADD_ON_PACKS.length, 3, "ADD_ON_PACKS must have 3 packs");

    const expected = [
      { code: "addon_10", price: 149, sets: 10 },
      { code: "addon_30", price: 399, sets: 30 },
      { code: "addon_60", price: 699, sets: 60 },
    ];

    for (let i = 0; i < expected.length; i++) {
      const actual = ADD_ON_PACKS[i];
      const exp = expected[i];
      assert.strictEqual(actual.code, exp.code, `Pack ${i} code mismatch`);
      assert.strictEqual(actual.price, exp.price, `Pack ${i} price mismatch`);
      assert.strictEqual(actual.sets, exp.sets, `Pack ${i} sets mismatch`);

      const quotaDef = ADDON_PACK_DEFINITIONS[actual.code];
      assert.ok(quotaDef, `ADDON_PACK_DEFINITIONS must include ${actual.code}`);
      assert.strictEqual(actual.price * 100, quotaDef.price_paise, `Paise mismatch for ${actual.code}`);
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Pricing Page Source Code, Button Styling, and In-Flight Lifecycle Guards
  // ---------------------------------------------------------------------------
  console.log("\n2. Verifying /pricing page source, button styling, and in-flight guards...");
  await check("Pricing page renders Buy button on each add-on card with plan button styling", () => {
    const pricingSrc = fs.readFileSync(path.resolve("src/app/pricing/page.tsx"), "utf8");

    // Must import handleProCheckout
    assert.ok(
      pricingSrc.includes("handleProCheckout"),
      "Pricing page must import and use handleProCheckout"
    );

    // Buy button text and data attribute
    assert.ok(
      pricingSrc.includes("data-addon-code"),
      "Pricing page must render data-addon-code on add-on Buy buttons"
    );
    assert.ok(
      pricingSrc.includes(">Buy<") || pricingSrc.includes(">\n                      Buy\n"),
      "Add-on cards must render 'Buy' buttons"
    );

    // Button styling matches plan buttons (w-full, min-h-[48px], h-11, rounded-lg, font-semibold, text-sm, bg-[#2563EB], text-white)
    assert.ok(
      pricingSrc.includes("min-h-[48px]"),
      "Buy button must include min-h-[48px] for WCAG touch target conformity"
    );
    assert.ok(
      pricingSrc.includes("bg-[#2563EB]"),
      "Buy button must use #2563EB primary brand color"
    );
    assert.ok(
      pricingSrc.includes("text-white"),
      "Buy button must have text-white"
    );

    // Plan Upgrade buttons remain disabled
    assert.ok(
      pricingSrc.includes("disabled"),
      "Plan Upgrade buttons must remain disabled"
    );
    assert.ok(
      pricingSrc.includes("UPGRADE_BUTTON_LABEL"),
      "Pricing page must retain UPGRADE_BUTTON_LABEL"
    );
  });

  await check("Pricing page and checkout orchestrator enforce single in-flight guard across all pack buttons", () => {
    const pricingSrc = fs.readFileSync(path.resolve("src/app/pricing/page.tsx"), "utf8");
    const checkoutSrc = fs.readFileSync(path.resolve("src/lib/billing/checkout.ts"), "utf8");
    const razorpaySrc = fs.readFileSync(path.resolve("src/lib/billing/razorpay.ts"), "utf8");

    // Unified in-flight guard on pricing page
    assert.ok(
      pricingSrc.includes("disabled={loadingAddon !== null}"),
      "All add-on pack buttons must be disabled when any checkout is in flight"
    );
    assert.ok(
      pricingSrc.includes("addonCheckoutLockRef.current") &&
      pricingSrc.includes("loadingAddon !== null"),
      "handleBuyAddon must guard synchronously with addonCheckoutLockRef and loadingAddon"
    );
    assert.ok(
      pricingSrc.includes("onDismiss") && pricingSrc.includes("setLoadingAddon(null)"),
      "handleBuyAddon must forward onDismiss callback to clear loadingAddon"
    );

    // Amount remains server-side only: client passes only addonCode
    assert.ok(
      pricingSrc.includes("handleSelectPlan(addonCode") && pricingSrc.includes("handleProCheckout"),
      "Pricing page passes addonCode through handleSelectPlan to handleProCheckout"
    );
    assert.ok(
      !pricingSrc.includes("amount: pack.price") && !pricingSrc.includes("amount_paise"),
      "Pricing page must NOT send client-specified amount to order creation"
    );

    // Checkout orchestrator forwards onDismiss to openRazorpayCheckout
    assert.ok(
      checkoutSrc.includes("onDismiss?: () => void;"),
      "CheckoutOptions must support onDismiss callback"
    );
    assert.ok(
      checkoutSrc.includes("onDismiss") && checkoutSrc.includes("onDismiss?.()"),
      "handleProCheckout must forward onDismiss to openRazorpayCheckout"
    );

    // Razorpay wrapper handles modal ondismiss and payment.failed
    assert.ok(
      razorpaySrc.includes("ondismiss") && razorpaySrc.includes("modal:"),
      "Razorpay SDK options must configure modal ondismiss"
    );
    assert.ok(
      razorpaySrc.includes('rzp.on("payment.failed"'),
      "Razorpay SDK must listen for payment.failed events"
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Functional Checkout & Sending addonCode
  // ---------------------------------------------------------------------------
  console.log("\n3. Verifying openRazorpayCheckout and addonCode forwarding...");
  await check("openRazorpayCheckout sends exact addonCode to /api/billing/razorpay/order", async () => {
    const origBilling = process.env.NEXT_PUBLIC_BILLING_ENABLED;
    const origKey = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
    const origFetch = global.fetch;

    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_mockKeyId123";

    const capturedBodies: any[] = [];
    (global as any).fetch = async (url: string, init?: RequestInit) => {
      if (url.includes("/api/billing/razorpay/order")) {
        const body = JSON.parse((init?.body as string) || "{}");
        capturedBodies.push(body);
        return {
          ok: true,
          json: async () => ({
            orderId: `order_mock_${body.addonCode}`,
            amount: 39900,
            currency: "INR",
            keyId: "rzp_test_mockKeyId123",
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    };

    // Mock window and script loading
    (global as any).window = {
      Razorpay: function () {
        return {
          open: () => {},
          on: () => {},
        };
      },
      document: {
        querySelector: () => ({ remove: () => {} }),
        body: { appendChild: (el: any) => { setTimeout(() => el.onload?.(), 10); } },
        createElement: () => ({}),
      },
    };

    try {
      // Test sending addon_10
      await openRazorpayCheckout({
        addonCode: "addon_10",
        authToken: "mock-valid-token",
      });

      // Test sending addon_30
      await openRazorpayCheckout({
        addonCode: "addon_30",
        authToken: "mock-valid-token",
      });

      // Test sending addon_60
      await openRazorpayCheckout({
        addonCode: "addon_60",
        authToken: "mock-valid-token",
      });

      assert.strictEqual(capturedBodies.length, 3, "Expected 3 order requests");
      assert.strictEqual(capturedBodies[0].addonCode, "addon_10", "First request must have addon_10");
      assert.strictEqual(capturedBodies[0].planCode, undefined, "First request must have undefined planCode");

      assert.strictEqual(capturedBodies[1].addonCode, "addon_30", "Second request must have addon_30");
      assert.strictEqual(capturedBodies[1].planCode, undefined, "Second request must have undefined planCode");

      assert.strictEqual(capturedBodies[2].addonCode, "addon_60", "Third request must have addon_60");
      assert.strictEqual(capturedBodies[2].planCode, undefined, "Third request must have undefined planCode");
    } finally {
      setEnv("NEXT_PUBLIC_BILLING_ENABLED", origBilling);
      setEnv("NEXT_PUBLIC_RAZORPAY_KEY_ID", origKey);
      global.fetch = origFetch;
      delete (global as any).window;
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Server-Authoritative Price Resolution, Ban Check & Pre-charge Eligibility
  // ---------------------------------------------------------------------------
  console.log("\n4. Verifying server-authoritative order pricing, ban checks, and pre-charge eligibility...");
  await check("resolveOrderPricing correctly calculates amounts for all add-ons", () => {
    const p10 = resolveOrderPricing({ addonCode: "addon_10" });
    assert.strictEqual(p10?.type, "addon");
    assert.strictEqual(p10?.code, "addon_10");
    assert.strictEqual(p10?.amount_paise, 14900);
    assert.strictEqual(p10?.currency, "INR");
    assert.strictEqual(p10?.sets, 10);

    const p30 = resolveOrderPricing({ addonCode: "addon_30" });
    assert.strictEqual(p30?.type, "addon");
    assert.strictEqual(p30?.code, "addon_30");
    assert.strictEqual(p30?.amount_paise, 39900);
    assert.strictEqual(p30?.currency, "INR");
    assert.strictEqual(p30?.sets, 30);

    const p60 = resolveOrderPricing({ addonCode: "addon_60" });
    assert.strictEqual(p60?.type, "addon");
    assert.strictEqual(p60?.code, "addon_60");
    assert.strictEqual(p60?.amount_paise, 69900);
    assert.strictEqual(p60?.currency, "INR");
    assert.strictEqual(p60?.sets, 60);
  });

  const mockRazorpayFetch = async () => ({
    ok: true,
    json: async () => ({
      id: "order_test_addon_30_xyz",
      amount: 39900,
      currency: "INR",
    }),
  });

  const futurePeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const pastPeriodEnd = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

  // Setup common test env
  const origBilling = process.env.NEXT_PUBLIC_BILLING_ENABLED;
  const origKeyId = process.env.RAZORPAY_KEY_ID;
  const origKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const origMode = process.env.RAZORPAY_MODE;

  process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
  process.env.RAZORPAY_KEY_ID = "rzp_test_1234567890ABCD";
  process.env.RAZORPAY_KEY_SECRET = "test_secret_123456";
  process.env.RAZORPAY_MODE = "test";

  try {
    // -------------------------------------------------------------------------
    // 4A. Next.js Route (/api/billing/razorpay/order) Tests
    // -------------------------------------------------------------------------
    console.log("  4A. Next.js route: /api/billing/razorpay/order");

    await check("Next route rejects non-Pro user (no subscription) with 403 PRO_REQUIRED", async () => {
      const mock = createMockSupabaseAdmin({ subscription: null });
      const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer mock-token" },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mock.client,
        getServerEntitlement: async () => ({ isPro: false }),
        isProductionHost: false,
        fetchFn: mockRazorpayFetch,
      };

      const res = await orderPost(req);
      assert.strictEqual(res.status, 403, "Non-pro user must receive 403");
      const data = await res.json();
      assert.strictEqual(data.code, "PRO_REQUIRED");
    });

    await check("Next route rejects user in in_grace_period with 403 PRO_REQUIRED", async () => {
      const mock = createMockSupabaseAdmin({
        subscription: { status: "in_grace_period", current_period_end: pastPeriodEnd },
      });
      const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer mock-token" },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mock.client,
        getServerEntitlement: async () => ({ isPro: true, inGracePeriod: true, status: "in_grace_period" }),
        isProductionHost: false,
        fetchFn: mockRazorpayFetch,
      };

      const res = await orderPost(req);
      assert.strictEqual(res.status, 403, "User in grace period must receive 403");
      const data = await res.json();
      assert.strictEqual(data.code, "PRO_REQUIRED");
    });

    await check("Next route rejects active subscription with null current_period_end with 403 PRO_REQUIRED", async () => {
      const mock = createMockSupabaseAdmin({
        subscription: { status: "active", current_period_end: null },
      });
      const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer mock-token" },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mock.client,
        getServerEntitlement: async () => ({ isPro: true, status: "active", expirationDate: null }),
        isProductionHost: false,
        fetchFn: mockRazorpayFetch,
      };

      const res = await orderPost(req);
      assert.strictEqual(res.status, 403, "Active with null period end must receive 403");
      const data = await res.json();
      assert.strictEqual(data.code, "PRO_REQUIRED");
    });

    await check("Next route rejects active subscription with past current_period_end with 403 PRO_REQUIRED", async () => {
      const mock = createMockSupabaseAdmin({
        subscription: { status: "active", current_period_end: pastPeriodEnd },
      });
      const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer mock-token" },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mock.client,
        getServerEntitlement: async () => ({ isPro: true, status: "active", expirationDate: pastPeriodEnd }),
        isProductionHost: false,
        fetchFn: mockRazorpayFetch,
      };

      const res = await orderPost(req);
      assert.strictEqual(res.status, 403, "Active with expired period end must receive 403");
      const data = await res.json();
      assert.strictEqual(data.code, "PRO_REQUIRED");
    });

    await check("Next route rejects blocked user via metadata with 403 USER_BLOCKED", async () => {
      const mock = createMockSupabaseAdmin({
        userMetadata: { is_blocked: true },
        subscription: { status: "active", current_period_end: futurePeriodEnd },
      });
      const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer mock-token" },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mock.client,
        isProductionHost: false,
        fetchFn: mockRazorpayFetch,
      };

      const res = await orderPost(req);
      assert.strictEqual(res.status, 403, "Blocked user must receive 403");
      const data = await res.json();
      assert.strictEqual(data.code, "USER_BLOCKED");
    });

    await check("Next route rejects blocked user via blocked_users table with 403 USER_BLOCKED", async () => {
      const mock = createMockSupabaseAdmin({
        isBlockedInDb: true,
        subscription: { status: "active", current_period_end: futurePeriodEnd },
      });
      const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer mock-token" },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mock.client,
        isProductionHost: false,
        fetchFn: mockRazorpayFetch,
      };

      const res = await orderPost(req);
      assert.strictEqual(res.status, 403, "Blocked user must receive 403");
      const data = await res.json();
      assert.strictEqual(data.code, "USER_BLOCKED");
    });

    await check("Next route fails closed with 503 on database error during ban check", async () => {
      const mock = createMockSupabaseAdmin({
        dbErrorOnBlockedCheck: true,
        subscription: { status: "active", current_period_end: futurePeriodEnd },
      });
      const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer mock-token" },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mock.client,
        isProductionHost: false,
        fetchFn: mockRazorpayFetch,
      };

      const res = await orderPost(req);
      assert.strictEqual(res.status, 503, "Ban check failure must fail closed with 503");
      const data = await res.json();
      assert.strictEqual(data.code, "USER_BLOCKED");
    });

    await check("Next route creates order for active Pro user with future period end", async () => {
      const mock = createMockSupabaseAdmin({
        subscription: { status: "active", current_period_end: futurePeriodEnd },
      });
      const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer mock-token" },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mock.client,
        isProductionHost: false,
        fetchFn: mockRazorpayFetch,
      };

      const res = await orderPost(req);
      assert.strictEqual(res.status, 200, "Eligible Pro user must receive 200");
      const data = await res.json();
      assert.strictEqual(data.orderId, "order_test_addon_30_xyz");
      assert.strictEqual(data.amount, 39900);
      assert.strictEqual(data.currency, "INR");
      const inserted = mock.getInsertedOrder();
      assert.strictEqual(inserted?.addon_code, "addon_30");
      assert.strictEqual(inserted?.plan_code, null);
      assert.strictEqual(inserted?.amount_paise, 39900);
    });

    await check("Next route creates order for trialing user with future period end", async () => {
      const mock = createMockSupabaseAdmin({
        subscription: { status: "trialing", current_period_end: futurePeriodEnd },
      });
      const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer mock-token" },
        body: JSON.stringify({ addonCode: "addon_10" }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mock.client,
        isProductionHost: false,
        fetchFn: async () => ({
          ok: true,
          json: async () => ({
            id: "order_test_addon_10_abc",
            amount: 14900,
            currency: "INR",
          }),
        }),
      };

      const res = await orderPost(req);
      assert.strictEqual(res.status, 200, "Trialing Pro user must receive 200");
      const data = await res.json();
      assert.strictEqual(data.orderId, "order_test_addon_10_abc");
      assert.strictEqual(data.amount, 14900);
      const inserted = mock.getInsertedOrder();
      assert.strictEqual(inserted?.addon_code, "addon_10");
    });

    // -------------------------------------------------------------------------
    // 4B. Netlify Handler (netlify/functions/billing-razorpay-order) Parity Tests
    // -------------------------------------------------------------------------
    console.log("  4B. Netlify function: billing-razorpay-order.ts");

    await check("Netlify handler rejects non-Pro user (no subscription) with 403 PRO_REQUIRED", async () => {
      const mock = createMockSupabaseAdmin({ subscription: null });
      const handler = createNetlifyOrderHandler({
        getSupabaseAdmin: () => mock.client,
        getServerEntitlement: async () => ({ isPro: false }),
        isProductionHost: false,
        fetchFn: mockRazorpayFetch as any,
      });

      const res = await handler({
        httpMethod: "POST",
        headers: { authorization: "Bearer mock-token" },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });

      assert.strictEqual(res.statusCode, 403, "Netlify must return 403 for non-Pro");
      const data = JSON.parse(res.body);
      assert.strictEqual(data.code, "PRO_REQUIRED");
    });

    await check("Netlify handler rejects user in in_grace_period with 403 PRO_REQUIRED", async () => {
      const mock = createMockSupabaseAdmin({
        subscription: { status: "in_grace_period", current_period_end: pastPeriodEnd },
      });
      const handler = createNetlifyOrderHandler({
        getSupabaseAdmin: () => mock.client,
        getServerEntitlement: async () => ({ isPro: true, inGracePeriod: true, status: "in_grace_period" }),
        isProductionHost: false,
        fetchFn: mockRazorpayFetch as any,
      });

      const res = await handler({
        httpMethod: "POST",
        headers: { authorization: "Bearer mock-token" },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });

      assert.strictEqual(res.statusCode, 403, "Netlify must return 403 for grace period");
      const data = JSON.parse(res.body);
      assert.strictEqual(data.code, "PRO_REQUIRED");
    });

    await check("Netlify handler rejects active subscription with null current_period_end with 403 PRO_REQUIRED", async () => {
      const mock = createMockSupabaseAdmin({
        subscription: { status: "active", current_period_end: null },
      });
      const handler = createNetlifyOrderHandler({
        getSupabaseAdmin: () => mock.client,
        getServerEntitlement: async () => ({ isPro: true, status: "active", expirationDate: null }),
        isProductionHost: false,
        fetchFn: mockRazorpayFetch as any,
      });

      const res = await handler({
        httpMethod: "POST",
        headers: { authorization: "Bearer mock-token" },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });

      assert.strictEqual(res.statusCode, 403, "Netlify must return 403 for null period end");
      const data = JSON.parse(res.body);
      assert.strictEqual(data.code, "PRO_REQUIRED");
    });

    await check("Netlify handler rejects active subscription with past current_period_end with 403 PRO_REQUIRED", async () => {
      const mock = createMockSupabaseAdmin({
        subscription: { status: "active", current_period_end: pastPeriodEnd },
      });
      const handler = createNetlifyOrderHandler({
        getSupabaseAdmin: () => mock.client,
        getServerEntitlement: async () => ({ isPro: true, status: "active", expirationDate: pastPeriodEnd }),
        isProductionHost: false,
        fetchFn: mockRazorpayFetch as any,
      });

      const res = await handler({
        httpMethod: "POST",
        headers: { authorization: "Bearer mock-token" },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });

      assert.strictEqual(res.statusCode, 403, "Netlify must return 403 for expired period end");
      const data = JSON.parse(res.body);
      assert.strictEqual(data.code, "PRO_REQUIRED");
    });

    await check("Netlify handler rejects blocked user with 403 USER_BLOCKED", async () => {
      const mock = createMockSupabaseAdmin({
        userMetadata: { is_blocked: true },
        subscription: { status: "active", current_period_end: futurePeriodEnd },
      });
      const handler = createNetlifyOrderHandler({
        getSupabaseAdmin: () => mock.client,
        isProductionHost: false,
        fetchFn: mockRazorpayFetch as any,
      });

      const res = await handler({
        httpMethod: "POST",
        headers: { authorization: "Bearer mock-token" },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });

      assert.strictEqual(res.statusCode, 403, "Netlify must return 403 for blocked user");
      const data = JSON.parse(res.body);
      assert.strictEqual(data.code, "USER_BLOCKED");
    });

    await check("Netlify handler fails closed with 503 on database error during ban check", async () => {
      const mock = createMockSupabaseAdmin({
        dbErrorOnBlockedCheck: true,
        subscription: { status: "active", current_period_end: futurePeriodEnd },
      });
      const handler = createNetlifyOrderHandler({
        getSupabaseAdmin: () => mock.client,
        isProductionHost: false,
        fetchFn: mockRazorpayFetch as any,
      });

      const res = await handler({
        httpMethod: "POST",
        headers: { authorization: "Bearer mock-token" },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });

      assert.strictEqual(res.statusCode, 503, "Netlify ban check failure must fail closed with 503");
      const data = JSON.parse(res.body);
      assert.strictEqual(data.code, "USER_BLOCKED");
    });

    await check("Netlify handler creates order for active Pro user with future period end", async () => {
      const mock = createMockSupabaseAdmin({
        subscription: { status: "active", current_period_end: futurePeriodEnd },
      });
      const handler = createNetlifyOrderHandler({
        getSupabaseAdmin: () => mock.client,
        isProductionHost: false,
        fetchFn: mockRazorpayFetch as any,
      });

      const res = await handler({
        httpMethod: "POST",
        headers: { authorization: "Bearer mock-token" },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });

      assert.strictEqual(res.statusCode, 200, "Netlify must return 200 for eligible Pro user");
      const data = JSON.parse(res.body);
      assert.strictEqual(data.orderId, "order_test_addon_30_xyz");
      assert.strictEqual(data.amount, 39900);
      assert.strictEqual(data.currency, "INR");
      const inserted = mock.getInsertedOrder();
      assert.strictEqual(inserted?.addon_code, "addon_30");
      assert.strictEqual(inserted?.plan_code, null);
      assert.strictEqual(inserted?.amount_paise, 39900);
    });
  } finally {
    setEnv("NEXT_PUBLIC_BILLING_ENABLED", origBilling);
    setEnv("RAZORPAY_KEY_ID", origKeyId);
    setEnv("RAZORPAY_KEY_SECRET", origKeySecret);
    setEnv("RAZORPAY_MODE", origMode);
  }

  // ---------------------------------------------------------------------------
  // 5. Verify Route Validation with addonCode
  // ---------------------------------------------------------------------------
  console.log("\n5. Verifying /api/billing/razorpay/verify with addonCode...");
  await check("Verify route succeeds with matching addonCode and rejects mismatched addonCode", async () => {
    const origBilling = process.env.NEXT_PUBLIC_BILLING_ENABLED;
    const origKeyId = process.env.RAZORPAY_KEY_ID;
    const origKeySecret = process.env.RAZORPAY_KEY_SECRET;
    const origMode = process.env.RAZORPAY_MODE;

    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.RAZORPAY_KEY_ID = "rzp_test_1234567890ABCD";
    process.env.RAZORPAY_KEY_SECRET = "test_secret_123456";
    process.env.RAZORPAY_MODE = "test";

    const secret = "test_secret_123456";
    const orderId = "order_test_addon_30_xyz";
    const paymentId = "pay_test_payment_123";
    const validSignature = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    try {
      const mockOrderRow = {
        id: "internal-order-id-123",
        provider_order_id: orderId,
        user_id: "pro-user-id",
        amount_paise: 39900,
        currency: "INR",
        addon_code: "addon_30",
        plan_code: null,
        status: "created",
        mode: "test",
      };

      const mockUser = { id: "pro-user-id", email: "pro@test.com" };
      const mockSupabase = {
        auth: {
          getUser: async () => ({ data: { user: mockUser }, error: null }),
        },
        from: (table: string) => {
          if (table === "payment_orders") {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({ data: mockOrderRow, error: null }),
                  }),
                }),
              }),
            };
          }
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          };
        },
        rpc: async (func: string, params: any) => {
          return {
            data: {
              success: true,
              order_id: params.p_order_id,
              granted_sets: 30,
            },
            error: null,
          };
        },
      };

      // 1. Success case: matching addonCode: "addon_30"
      const validReq = new Request("http://localhost:3000/api/billing/razorpay/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer mock-token",
        },
        body: JSON.stringify({
          razorpay_order_id: orderId,
          razorpay_payment_id: paymentId,
          razorpay_signature: validSignature,
          addonCode: "addon_30",
        }),
      });

      (validReq as any).__testDeps = {
        getSupabaseAdmin: () => mockSupabase,
        isProductionHost: false,
      };

      const validRes = await verifyPost(validReq);
      assert.strictEqual(validRes.status, 200, "Matching addonCode must verify with 200");
      const validData = await validRes.json();
      assert.strictEqual(validData.success, true);

      // 2. Failure case: mismatched addonCode: "addon_60"
      const mismatchedReq = new Request("http://localhost:3000/api/billing/razorpay/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer mock-token",
        },
        body: JSON.stringify({
          razorpay_order_id: orderId,
          razorpay_payment_id: paymentId,
          razorpay_signature: validSignature,
          addonCode: "addon_60",
        }),
      });

      (mismatchedReq as any).__testDeps = {
        getSupabaseAdmin: () => mockSupabase,
        isProductionHost: false,
      };

      const mismatchedRes = await verifyPost(mismatchedReq);
      assert.strictEqual(mismatchedRes.status, 400, "Mismatched addonCode must return 400");
      const mismatchedData = await mismatchedRes.json();
      assert.strictEqual(mismatchedData.code, "ADDON_MISMATCH");
    } finally {
      setEnv("NEXT_PUBLIC_BILLING_ENABLED", origBilling);
      setEnv("RAZORPAY_KEY_ID", origKeyId);
      setEnv("RAZORPAY_KEY_SECRET", origKeySecret);
      setEnv("RAZORPAY_MODE", origMode);
    }
  });

  console.log("--------------------------------------------------------------------------------");
  console.log(`TEST SUITE RESULTS: ${passed} passed, ${failed} failed`);
  console.log("--------------------------------------------------------------------------------");

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("Fatal error running test suite:", err);
  process.exit(1);
});
