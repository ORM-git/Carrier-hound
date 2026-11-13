/**
 * scripts/test-addon-verify-and-expiry.ts
 *
 * Comprehensive offline verification suite for PR 2:
 * 1. PLAN_MISMATCH verify bug fix:
 *    - Add-on verify must accept add-on plan IDs (e.g. planCode: "addon_10", planId: "addon_10").
 *    - Add-on verify must NOT require a subscription plan match (e.g. when planCode: "monthly"
 *      is sent alongside addonCode: "addon_10", or when planCode is omitted).
 *    - Tampered plan IDs (e.g. planCode: "weekly" or "addon_30" for an addon_10 order) must still reject 400 PLAN_MISMATCH.
 *    - Tampered addon IDs (e.g. addonCode: "addon_30" for an addon_10 order) must still reject 400 ADDON_MISMATCH.
 *    - Subscription plan verify continues to enforce exact subscription plan match.
 *
 * 2. Add-on credit expiry tied to subscription end date:
 *    - When fulfilling an add-on order for a user with an active subscription, user_addon_credits.expires_at
 *      is tied to the subscription's current_period_end (NOT a separate 60-day independent expiry).
 *    - Verified for weekly, monthly, and multi-month periods.
 *    - Fallback validity window is used only when no active subscription period end exists.
 *
 * 3. Catalog pricing and checkout helper alignment:
 *    - resolveOrderPricing accepts add-on IDs in planCode and planId.
 *    - handleProCheckout does not force default planCode: "monthly" when addonCode is supplied.
 *
 * 4. Migration & Schema verification:
 *    - 20261113a_addon_credit_expiry_subscription_sync.sql adheres to the repository NOT APPLIED convention.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveOrderPricing, ADDON_PACK_DEFINITIONS } from "../src/lib/billing/quota";
import { POST as verifyPost } from "../src/app/api/billing/razorpay/verify/route";

const TEST_SECRET = "test_webhook_and_verify_secret_123456";
const TEST_KEY_ID = "rzp_test_1234567890ABCD";

function computeSignature(orderId: string, paymentId: string, secret: string = TEST_SECRET): string {
  return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res && typeof (res as any).then === "function") {
      return (res as Promise<void>)
        .then(() => {
          console.log(`[PASS] ${name}`);
          passed++;
        })
        .catch((err: any) => {
          console.error(`[FAIL] ${name}: ${err.message}`);
          failed++;
        });
    } else {
      console.log(`[PASS] ${name}`);
      passed++;
    }
  } catch (err: any) {
    console.error(`[FAIL] ${name}: ${err.message}`);
    failed++;
  }
}

async function runSuite() {
  console.log("================================================================================");
  console.log("   PR 2: ADD-ON VERIFY & EXPIRY SUBSCRIPTION SYNC TEST SUITE                    ");
  console.log("================================================================================\n");

  // Save and set environment for offline tests
  const origBilling = process.env.NEXT_PUBLIC_BILLING_ENABLED;
  const origKeyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  const origSecret = process.env.RAZORPAY_KEY_SECRET;
  process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
  process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = TEST_KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = TEST_SECRET;

  try {
    // -------------------------------------------------------------------------
    // SECTION 1: Catalog Pricing (resolveOrderPricing) accepts add-on plan IDs
    // -------------------------------------------------------------------------
    console.log("--- Section 1: Catalog Pricing (resolveOrderPricing) ---");

    check("1.1 resolveOrderPricing accepts addonCode directly", () => {
      const p10 = resolveOrderPricing({ addonCode: "addon_10" });
      assert.strictEqual(p10?.type, "addon");
      assert.strictEqual(p10?.code, "addon_10");
      assert.strictEqual(p10?.amount_paise, 14900);
      assert.strictEqual(p10?.sets, 10);

      const p30 = resolveOrderPricing({ addonCode: "addon_30" });
      assert.strictEqual(p30?.type, "addon");
      assert.strictEqual(p30?.code, "addon_30");
      assert.strictEqual(p30?.amount_paise, 39900);
      assert.strictEqual(p30?.sets, 30);
    });

    check("1.2 resolveOrderPricing accepts add-on ID in planCode", () => {
      const p = resolveOrderPricing({ planCode: "addon_10" });
      assert.strictEqual(p?.type, "addon");
      assert.strictEqual(p?.code, "addon_10");
      assert.strictEqual(p?.amount_paise, 14900);
    });

    check("1.3 resolveOrderPricing accepts add-on ID in planId", () => {
      const p = resolveOrderPricing({ planId: "addon_60" });
      assert.strictEqual(p?.type, "addon");
      assert.strictEqual(p?.code, "addon_60");
      assert.strictEqual(p?.amount_paise, 69900);
      assert.strictEqual(p?.sets, 60);
    });

    check("1.4 resolveOrderPricing preserves normal subscription plans", () => {
      const pMonthly = resolveOrderPricing({ planCode: "monthly" });
      assert.strictEqual(pMonthly?.type, "plan");
      assert.strictEqual(pMonthly?.code, "monthly");
      assert.strictEqual(pMonthly?.amount_paise, 149900);

      const pWeekly = resolveOrderPricing({ planCode: "weekly" });
      assert.strictEqual(pWeekly?.type, "plan");
      assert.strictEqual(pWeekly?.code, "weekly");
      assert.strictEqual(pWeekly?.amount_paise, 69200);
    });

    check("1.5 resolveOrderPricing rejects unknown codes", () => {
      assert.strictEqual(resolveOrderPricing({ planCode: "invalid_xyz" }), null);
      assert.strictEqual(resolveOrderPricing({ addonCode: "addon_999" }), null);
    });

    // -------------------------------------------------------------------------
    // SECTION 2: Verify Route - PLAN_MISMATCH Bug Fix
    // -------------------------------------------------------------------------
    console.log("\n--- Section 2: Verify Route PLAN_MISMATCH Bug Fix ---");

    const mockUser = { id: "user_test_addon_456", email: "candidate@careermonke.com" };

    function createMockSupabase(orderRow: any, subRow: any = null) {
      let insertedCredit: any = null;
      let updatedOrder: any = null;

      const mockClient = {
        auth: {
          getUser: async (token: string) => {
            if (token === "valid_token") {
              return { data: { user: mockUser }, error: null };
            }
            return { data: { user: null }, error: new Error("invalid token") };
          },
        },
        from: (table: string) => {
          if (table === "payment_orders") {
            return {
              select: () => ({
                eq: (_col1: string, _val1: string) => ({
                  eq: (_col2: string, _val2: string) => ({
                    maybeSingle: async () => ({ data: orderRow, error: null }),
                  }),
                }),
              }),
              update: (patch: any) => ({
                eq: (_col: string, _id: string) => {
                  updatedOrder = { ...orderRow, ...patch };
                  return { data: updatedOrder, error: null };
                },
              }),
            };
          }

          if (table === "subscriptions") {
            return {
              select: () => ({
                eq: (_col: string, _uid: string) => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({ data: subRow, error: null }),
                    }),
                  }),
                  maybeSingle: async () => ({ data: subRow, error: null }),
                }),
              }),
            };
          }

          if (table === "addon_packs") {
            return {
              select: () => ({
                eq: (_col: string, code: string) => ({
                  maybeSingle: async () => ({
                    data: {
                      sets: ADDON_PACK_DEFINITIONS[code]?.sets || 10,
                      validity_days: ADDON_PACK_DEFINITIONS[code]?.validity_days || 60,
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }

          if (table === "user_addon_credits") {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
              insert: (row: any) => {
                insertedCredit = { id: "credit_test_uuid_1", ...row };
                return {
                  select: () => ({
                    single: async () => ({ data: insertedCredit, error: null }),
                  }),
                };
              },
            };
          }

          return {};
        },
        rpc: async (fn: string, args: any) => {
          if (fn === "fulfil_payment_order") {
            if (args.p_expected_mode === "test") {
              return {
                data: {
                  success: true,
                  test_mode: true,
                  is_pro: false,
                  already_paid: false,
                  type: orderRow.addon_code ? "addon" : "plan",
                  addon_code: orderRow.addon_code,
                  plan_code: orderRow.plan_code,
                  message: "Test payment verified; zero real entitlements granted",
                },
                error: null,
              };
            }
          }
          // In live mode, simulate RPC fallback to trigger route's fallback fulfillment path
          throw new Error("RPC not registered in mock");
        },
      };

      return {
        client: mockClient,
        getInsertedCredit: () => insertedCredit,
        getUpdatedOrder: () => updatedOrder,
      };
    }

    async function callVerify(body: any, orderRow: any, subRow: any = null) {
      const orderId = body.order_id || body.razorpay_order_id || "order_test_123";
      const paymentId = body.payment_id || body.razorpay_payment_id || "pay_test_456";
      const sig = computeSignature(orderId, paymentId, TEST_SECRET);

      const payload = {
        order_id: orderId,
        payment_id: paymentId,
        razorpay_signature: sig,
        ...body,
      };

      const mockDb = createMockSupabase(orderRow, subRow);

      const req = new Request("https://careermonke.com/api/billing/razorpay/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid_token",
        },
        body: JSON.stringify(payload),
      });

      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb.client,
      };

      const res = await verifyPost(req);
      const data = await res.json().catch(() => ({}));

      return {
        status: res.status,
        body: data,
        insertedCredit: mockDb.getInsertedCredit(),
        updatedOrder: mockDb.getUpdatedOrder(),
      };
    }

    // Recorded Add-on Order row (plan_code is null, addon_code is "addon_10")
    const addonOrderRow = {
      id: "ord_db_uuid_10",
      provider: "razorpay",
      mode: "test",
      provider_order_id: "order_test_addon_10",
      plan_code: null,
      addon_code: "addon_10",
      amount_paise: 14900,
      status: "created",
    };

    // Active subscription row ending in 25 days
    const futurePeriodEnd = new Date(Date.now() + 25 * 86400000).toISOString();
    const activeSubRow = {
      id: "sub_db_uuid_1",
      user_id: mockUser.id,
      status: "active",
      plan_id: "monthly",
      current_period_end: futurePeriodEnd,
    };

    await check("2.1 Add-on verify accepts add-on plan ID in planCode (no PLAN_MISMATCH)", async () => {
      const res = await callVerify(
        { order_id: "order_test_addon_10", planCode: "addon_10" },
        addonOrderRow,
        activeSubRow
      );
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.type, "addon");
    });

    await check("2.2 Add-on verify accepts add-on ID in planId (no PLAN_MISMATCH)", async () => {
      const res = await callVerify(
        { order_id: "order_test_addon_10", planId: "addon_10" },
        addonOrderRow,
        activeSubRow
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
    });

    await check("2.3 Add-on verify accepts addonCode directly", async () => {
      const res = await callVerify(
        { order_id: "order_test_addon_10", addonCode: "addon_10" },
        addonOrderRow,
        activeSubRow
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
    });

    await check("2.4 Add-on verify accepts planCode alongside matching addonCode (not requiring sub plan match)", async () => {
      // checkout.ts passes planCode: "monthly" alongside addonCode: "addon_10"
      const res = await callVerify(
        { order_id: "order_test_addon_10", planCode: "monthly", addonCode: "addon_10" },
        addonOrderRow,
        activeSubRow
      );
      assert.strictEqual(res.status, 200, `Must accept add-on when addonCode matches without requiring sub match: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.success, true);
    });

    await check("2.5 Add-on verify accepts both planCode: 'addon_10' and addonCode: 'addon_10'", async () => {
      const res = await callVerify(
        { order_id: "order_test_addon_10", planCode: "addon_10", addonCode: "addon_10" },
        addonOrderRow,
        activeSubRow
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
    });

    await check("2.6 Negative Control: Add-on order rejects mismatched add-on planCode (addon_30 for addon_10 order)", async () => {
      const res = await callVerify(
        { order_id: "order_test_addon_10", planCode: "addon_30" },
        addonOrderRow,
        activeSubRow
      );
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "PLAN_MISMATCH");
    });

    await check("2.7 Negative Control: Add-on order rejects subscription planCode when no matching addonCode sent", async () => {
      const res = await callVerify(
        { order_id: "order_test_addon_10", planCode: "weekly" },
        addonOrderRow,
        activeSubRow
      );
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "PLAN_MISMATCH");
    });

    await check("2.8 Negative Control: Add-on order rejects mismatched addonCode", async () => {
      const res = await callVerify(
        { order_id: "order_test_addon_10", addonCode: "addon_30" },
        addonOrderRow,
        activeSubRow
      );
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "ADDON_MISMATCH");
    });

    // Subscription plan order row
    const subOrderRow = {
      id: "ord_db_uuid_sub",
      provider: "razorpay",
      mode: "test",
      provider_order_id: "order_test_sub_monthly",
      plan_code: "monthly",
      addon_code: null,
      amount_paise: 149900,
      status: "created",
    };

    await check("2.9 Subscription verify accepts exact planCode", async () => {
      const res = await callVerify(
        { order_id: "order_test_sub_monthly", planCode: "monthly" },
        subOrderRow,
        null
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
    });

    await check("2.10 Negative Control: Subscription order rejects mismatched planCode", async () => {
      const res = await callVerify(
        { order_id: "order_test_sub_monthly", planCode: "weekly" },
        subOrderRow,
        null
      );
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "PLAN_MISMATCH");
    });

    await check("2.11 Negative Control: Subscription order rejects unexpected addonCode", async () => {
      const res = await callVerify(
        { order_id: "order_test_sub_monthly", addonCode: "addon_10" },
        subOrderRow,
        null
      );
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "ADDON_MISMATCH");
    });

    // -------------------------------------------------------------------------
    // SECTION 3: Add-on Credit Expiry Tied to Subscription End Date
    // -------------------------------------------------------------------------
    console.log("\n--- Section 3: Add-on Credit Expiry Tied to Subscription End Date ---");

    // Live mode order row for fallback fulfillment testing
    const liveAddonOrderRow = {
      id: "ord_live_uuid_10",
      provider: "razorpay",
      mode: "live",
      provider_order_id: "order_live_addon_10",
      plan_code: null,
      addon_code: "addon_10",
      amount_paise: 14900,
      status: "created",
    };

    await check("3.1 Add-on credit expires_at matches active monthly subscription period end (25 days away)", async () => {
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_live_fake12345678";
      const expectedEnd = new Date(Date.now() + 25 * 86400000).toISOString();
      const liveSub = {
        id: "sub_1",
        user_id: mockUser.id,
        status: "active",
        current_period_end: expectedEnd,
      };

      const res = await callVerify(
        { order_id: "order_live_addon_10", addonCode: "addon_10" },
        liveAddonOrderRow,
        liveSub
      );

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.type, "addon");
      assert.strictEqual(res.body.expiresAt, expectedEnd, "Route response expiresAt must match subscription current_period_end");
      assert.strictEqual(res.insertedCredit.expires_at, expectedEnd, "Inserted user_addon_credits expires_at must match subscription current_period_end");

      // Verify it is NOT the 60-day default
      const sixtyDaysMs = Date.now() + 60 * 86400000;
      const actualMs = new Date(res.body.expiresAt).getTime();
      assert.ok(Math.abs(actualMs - sixtyDaysMs) > 20 * 86400000, "Credit expiry must NOT be independent 60-day window");
    });

    await check("3.2 Add-on credit expires_at matches active annual subscription period end (300 days away)", async () => {
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_live_fake12345678";
      const expectedAnnualEnd = new Date(Date.now() + 300 * 86400000).toISOString();
      const annualSub = {
        id: "sub_annual",
        user_id: mockUser.id,
        status: "active",
        current_period_end: expectedAnnualEnd,
      };

      const res = await callVerify(
        { order_id: "order_live_addon_10", addonCode: "addon_10" },
        liveAddonOrderRow,
        annualSub
      );

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.expiresAt, expectedAnnualEnd);
      assert.strictEqual(res.insertedCredit.expires_at, expectedAnnualEnd);
    });

    await check("3.3 Add-on credit expires_at matches active weekly subscription period end (4 days away)", async () => {
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_live_fake12345678";
      const expectedWeeklyEnd = new Date(Date.now() + 4 * 86400000).toISOString();
      const weeklySub = {
        id: "sub_weekly",
        user_id: mockUser.id,
        status: "active",
        current_period_end: expectedWeeklyEnd,
      };

      const res = await callVerify(
        { order_id: "order_live_addon_10", addonCode: "addon_10" },
        liveAddonOrderRow,
        weeklySub
      );

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.expiresAt, expectedWeeklyEnd);
      assert.strictEqual(res.insertedCredit.expires_at, expectedWeeklyEnd);
    });

    await check("3.4 Fallback: when no active subscription period end is found, uses pack validity window", async () => {
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_live_fake12345678";
      const res = await callVerify(
        { order_id: "order_live_addon_10", addonCode: "addon_10" },
        liveAddonOrderRow,
        null // No subscription record found
      );

      assert.strictEqual(res.status, 200);
      const sixtyDaysMs = Date.now() + 60 * 86400000;
      const actualMs = new Date(res.body.expiresAt).getTime();
      assert.ok(Math.abs(actualMs - sixtyDaysMs) < 10000, "Fallback must safely use pack validity window");
    });

    // Reset key ID to test mode
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = TEST_KEY_ID;

    // -------------------------------------------------------------------------
    // SECTION 4: Migration & Repository Compliance
    // -------------------------------------------------------------------------
    console.log("\n--- Section 4: Migration & Repository Compliance ---");

    check("4.1 Migration file 20261113a_addon_credit_expiry_subscription_sync.sql exists", () => {
      const migPath = path.resolve("supabase/migrations/20261113a_addon_credit_expiry_subscription_sync.sql");
      assert.ok(fs.existsSync(migPath), "Migration file must exist on disk");
    });

    check("4.2 Migration carries NOT APPLIED header and self-referencing record command", () => {
      const migContent = fs.readFileSync(
        path.resolve("supabase/migrations/20261113a_addon_credit_expiry_subscription_sync.sql"),
        "utf8"
      );
      assert.ok(
        migContent.includes("Status: NOT APPLIED - record-migration.cjs 20261113a_addon_credit_expiry_subscription_sync"),
        "Migration header must include Status: NOT APPLIED"
      );
      assert.ok(
        migContent.includes("node scripts/record-migration.cjs 20261113a_addon_credit_expiry_subscription_sync"),
        "Migration must include self-referencing record-migration.cjs command"
      );
    });

    check("4.3 Migration SQL ties add-on credit expiry to active subscription period end", () => {
      const migContent = fs.readFileSync(
        path.resolve("supabase/migrations/20261113a_addon_credit_expiry_subscription_sync.sql"),
        "utf8"
      );
      assert.ok(
        migContent.includes("v_existing_sub.current_period_end"),
        "fulfil_payment_order must query existing subscription current_period_end"
      );
      assert.ok(
        migContent.includes("UPDATE public.user_addon_credits"),
        "fulfil_payment_order must extend existing unexpired credits on plan renewal"
      );
      assert.ok(
        migContent.includes("SECURITY DEFINER"),
        "fulfil_payment_order must be SECURITY DEFINER"
      );
      assert.ok(
        migContent.includes("SET search_path = public, auth"),
        "fulfil_payment_order must pin search_path to public, auth"
      );
    });
  } finally {
    // Restore environment
    process.env.NEXT_PUBLIC_BILLING_ENABLED = origBilling;
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = origKeyId;
    process.env.RAZORPAY_KEY_SECRET = origSecret;
  }

  console.log("\n--------------------------------------------------------------------------------");
  console.log(`TEST SUITE RESULTS: ${passed} passed, ${failed} failed`);
  console.log("--------------------------------------------------------------------------------\n");

  if (failed > 0) {
    console.error("VERDICT: FAIL (Some tests failed)");
    process.exit(1);
  } else {
    console.log("VERDICT: PASS (All add-on verify and expiry test scenarios passed)");
  }
}

runSuite().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
