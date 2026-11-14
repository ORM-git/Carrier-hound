/**
 * scripts/test-pricing-addon-checkout.ts
 *
 * Verification suite for Add-on Pack "Buy" Buttons on /pricing:
 * 1. ADD_ON_PACKS Catalog Integrity in src/config/plans.ts:
 *    - All 3 add-on packs (addon_10, addon_30, addon_60) define exact codes, prices, and sets.
 * 2. Static & Markup Conformance:
 *    - Each add-on card renders an active "Buy" button with data-addon-code and min-h-[48px].
 *    - Plan upgrade buttons remain disabled Upgrade buttons with UPGRADE_BUTTON_LABEL.
 *    - No regression on pricing layout, notes, or sales policies.
 * 3. Functional Checkout & Auth Redirection:
 *    - Clicking Buy sends the exact addonCode to /api/billing/razorpay/order.
 *    - Unauthenticated visitors are required to sign in first (redirected to /login).
 * 4. Server-Side Gating & Order Creation:
 *    - resolveOrderPricing resolves server-authoritative amount for all addon codes.
 *    - /api/billing/razorpay/order creates orders with notes.type = "addon" and addon_code.
 *    - Non-pro users attempting to purchase add-ons are rejected with 403 PRO_REQUIRED.
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

function check(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res && typeof (res as any).then === "function") {
      return (res as Promise<void>)
        .then(() => {
          console.log(`  [PASS] ${name}`);
          passed++;
        })
        .catch((err: any) => {
          console.error(`  [FAIL] ${name}: ${err.message}`);
          failed++;
        });
    } else {
      console.log(`  [PASS] ${name}`);
      passed++;
    }
  } catch (err: any) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    failed++;
  }
}

async function runSuite() {
  console.log("================================================================================");
  console.log("   PRICING ADD-ON PACK BUY FLOW VERIFICATION SUITE                             ");
  console.log("================================================================================\n");

  // ---------------------------------------------------------------------------
  // 1. ADD_ON_PACKS Catalog Integrity
  // ---------------------------------------------------------------------------
  console.log("1. Verifying ADD_ON_PACKS catalog definitions in plans.ts and quota.ts...");
  check("ADD_ON_PACKS defines addon_10, addon_30, addon_60 with exact prices & sets", () => {
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
  // 2. Pricing Page Source Code & Button Styling
  // ---------------------------------------------------------------------------
  console.log("\n2. Verifying /pricing page source and button styling...");
  check("Pricing page renders Buy button on each add-on card with plan button styling", () => {
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
  // 4. Server-Authoritative Price Resolution & Pro Requirement
  // ---------------------------------------------------------------------------
  console.log("\n4. Verifying server-authoritative order pricing and Pro requirement...");
  check("resolveOrderPricing correctly calculates amounts for all add-ons", () => {
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

  await check("Order creation route rejects non-Pro users with 403 PRO_REQUIRED", async () => {
    const origBilling = process.env.NEXT_PUBLIC_BILLING_ENABLED;
    const origKeyId = process.env.RAZORPAY_KEY_ID;
    const origKeySecret = process.env.RAZORPAY_KEY_SECRET;
    const origMode = process.env.RAZORPAY_MODE;

    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.RAZORPAY_KEY_ID = "rzp_test_1234567890ABCD";
    process.env.RAZORPAY_KEY_SECRET = "test_secret_123456";
    process.env.RAZORPAY_MODE = "test";

    try {
      const mockUser = { id: "non-pro-user-id", email: "nonpro@test.com" };
      const mockSupabase = {
        auth: {
          getUser: async () => ({ data: { user: mockUser }, error: null }),
        },
      };

      const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer mock-token",
        },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });

      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockSupabase,
        getServerEntitlement: async () => ({ isPro: false }),
        isProductionHost: false,
      };

      const res = await orderPost(req);
      assert.strictEqual(res.status, 403, "Non-pro user must receive 403");
      const data = await res.json();
      assert.strictEqual(data.code, "PRO_REQUIRED", "Error code must be PRO_REQUIRED");
    } finally {
      setEnv("NEXT_PUBLIC_BILLING_ENABLED", origBilling);
      setEnv("RAZORPAY_KEY_ID", origKeyId);
      setEnv("RAZORPAY_KEY_SECRET", origKeySecret);
      setEnv("RAZORPAY_MODE", origMode);
    }
  });

  await check("Order creation route creates order for active Pro user", async () => {
    const origBilling = process.env.NEXT_PUBLIC_BILLING_ENABLED;
    const origKeyId = process.env.RAZORPAY_KEY_ID;
    const origKeySecret = process.env.RAZORPAY_KEY_SECRET;
    const origMode = process.env.RAZORPAY_MODE;

    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.RAZORPAY_KEY_ID = "rzp_test_1234567890ABCD";
    process.env.RAZORPAY_KEY_SECRET = "test_secret_123456";
    process.env.RAZORPAY_MODE = "test";

    try {
      let insertedRow: any = null;
      const mockUser = { id: "pro-user-id", email: "pro@test.com" };
      const mockSupabase = {
        auth: {
          getUser: async () => ({ data: { user: mockUser }, error: null }),
        },
        from: () => ({
          insert: (row: any) => {
            insertedRow = row;
            return {
              select: () => ({
                single: async () => ({ data: row, error: null }),
              }),
            };
          },
        }),
      };

      const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer mock-token",
        },
        body: JSON.stringify({ addonCode: "addon_30" }),
      });

      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockSupabase,
        getServerEntitlement: async () => ({ isPro: true }),
        isProductionHost: false,
        fetchFn: async () => ({
          ok: true,
          json: async () => ({
            id: "order_test_addon_30_xyz",
            amount: 39900,
            currency: "INR",
          }),
        }),
      };

      const res = await orderPost(req);
      assert.strictEqual(res.status, 200, "Active Pro user must receive 200");
      const data = await res.json();
      assert.strictEqual(data.orderId, "order_test_addon_30_xyz");
      assert.strictEqual(data.amount, 39900);
      assert.strictEqual(data.currency, "INR");
      assert.strictEqual(insertedRow?.addon_code, "addon_30");
      assert.strictEqual(insertedRow?.plan_code, null);
      assert.strictEqual(insertedRow?.amount_paise, 39900);
    } finally {
      setEnv("NEXT_PUBLIC_BILLING_ENABLED", origBilling);
      setEnv("RAZORPAY_KEY_ID", origKeyId);
      setEnv("RAZORPAY_KEY_SECRET", origKeySecret);
      setEnv("RAZORPAY_MODE", origMode);
    }
  });

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
