/**
 * scripts/test-addon-verify-and-expiry.ts
 *
 * Comprehensive offline verification suite for PR 2:
 * 1. PLAN_MISMATCH verify bug fix:
 *    - Add-on verify accepts add-on plan IDs (e.g. planCode: "addon_10", planId: "addon_10").
 *    - Tampered plan IDs in Next and Netlify adapters (e.g. signed addon_10 with planId: "addon_60"
 *      or planCode: "addon_30" / "monthly") must be rejected with 400 PLAN_MISMATCH.
 *    - Tampered addon IDs (e.g. addonCode: "addon_30" for an addon_10 order) must reject 400 ADDON_MISMATCH.
 *    - Subscription plan verify enforces exact subscription plan match on both planCode and planId.
 *
 * 2. Add-on credit expiry tied to subscription end date:
 *    - Uses subscription end only if active/trialing and in the future.
 *    - Handles subscription that expired between order and verify (fails closed with 403 PRO_REQUIRED).
 *    - Handles inactive subscription status (e.g. canceled, past_due; fails closed with 403 PRO_REQUIRED).
 *    - Does not ignore subscription-read errors (fails closed with 500 DATABASE_ERROR).
 *
 * 3. Subscription renewal extends existing unexpired add-on credits:
 *    - Next verify fallback extends existing unexpired add-on credits like the SQL RPC.
 *    - Fails closed with 500 if credit extension fails instead of returning 200.
 *
 * 4. Catalog pricing and checkout helper alignment:
 *    - resolveOrderPricing accepts add-on IDs in planCode and planId.
 *    - handleProCheckout does not force default planCode: "monthly" when addonCode is supplied.
 *
 * 5. Migration & Schema verification:
 *    - 20261113a_addon_credit_expiry_subscription_sync.sql adheres to NOT APPLIED convention.
 *    - Pinned search_path = public inline on SECURITY DEFINER function.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveOrderPricing, ADDON_PACK_DEFINITIONS, PLAN_DEFINITIONS } from "../src/lib/billing/quota";
import { POST as verifyPost } from "../src/app/api/billing/razorpay/verify/route";
import { createHandler as createNetlifyVerifyHandler } from "../netlify/functions/billing-razorpay-verify";

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
    // SECTION 2: Verify Route - PLAN_MISMATCH Bug Fix & planId Validation
    // -------------------------------------------------------------------------
    console.log("\n--- Section 2: Verify Route PLAN_MISMATCH Bug Fix & planId Validation ---");

    const mockUser = { id: "user_test_addon_456", email: "candidate@careermonke.com" };

    function createMockSupabase(orderRow: any, subRow: any = null, creditOptions: any = {}) {
      let insertedCredit: any = null;
      let updatedOrder: any = null;
      let updatedCredits: any = null;
      let upsertedSub: any = null;

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
                      maybeSingle: async () => {
                        if (subRow?.__readError) {
                          return { data: null, error: subRow.__readError };
                        }
                        return { data: subRow, error: null };
                      },
                    }),
                  }),
                  maybeSingle: async () => {
                    if (subRow?.__readError) {
                      return { data: null, error: subRow.__readError };
                    }
                    return { data: subRow, error: null };
                  },
                }),
              }),
              upsert: (record: any) => {
                upsertedSub = record;
                return {
                  select: () => ({
                    single: async () => ({ data: record, error: null }),
                  }),
                };
              },
            };
          }

          if (table === "plans") {
            return {
              select: () => ({
                eq: (_col: string, code: string) => ({
                  maybeSingle: async () => ({
                    data: {
                      duration_days: PLAN_DEFINITIONS[code as keyof typeof PLAN_DEFINITIONS]?.duration_days || 30,
                      price_paise: PLAN_DEFINITIONS[code as keyof typeof PLAN_DEFINITIONS]?.price_paise || 149900,
                    },
                    error: null,
                  }),
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
              update: (patch: any) => {
                updatedCredits = patch;
                if (creditOptions.__updateError) {
                  return {
                    eq: () => ({
                      gte: () => ({
                        gt: async () => ({ data: null, error: creditOptions.__updateError }),
                      }),
                    }),
                  };
                }
                return {
                  eq: () => ({
                    gte: () => ({
                      gt: async () => ({ data: [updatedCredits], error: null }),
                    }),
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
        getUpdatedCredits: () => updatedCredits,
        getUpsertedSub: () => upsertedSub,
      };
    }

    async function callVerify(body: any, orderRow: any, subRow: any = null, creditOptions: any = {}) {
      const orderId = body.order_id || body.razorpay_order_id || "order_test_123";
      const paymentId = body.payment_id || body.razorpay_payment_id || "pay_test_456";
      const sig = computeSignature(orderId, paymentId, TEST_SECRET);

      const payload = {
        order_id: orderId,
        payment_id: paymentId,
        razorpay_signature: sig,
        ...body,
      };

      const mockDb = createMockSupabase(orderRow, subRow, creditOptions);

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
        updatedCredits: mockDb.getUpdatedCredits(),
        upsertedSub: mockDb.getUpsertedSub(),
      };
    }

    async function callNetlifyVerify(body: any, orderRow: any, subRow: any = null) {
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
      const handler = createNetlifyVerifyHandler({
        getSupabaseAdmin: () => mockDb.client,
      });

      const res = await handler({
        httpMethod: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer valid_token",
        },
        body: JSON.stringify(payload),
      } as any);

      return {
        status: res.statusCode,
        body: JSON.parse(res.body || "{}"),
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

    await check("2.4 Add-on verify accepts both planCode: 'addon_10' and addonCode: 'addon_10'", async () => {
      const res = await callVerify(
        { order_id: "order_test_addon_10", planCode: "addon_10", addonCode: "addon_10" },
        addonOrderRow,
        activeSubRow
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
    });

    await check("2.5 Add-on verify accepts both planId: 'addon_10' and addonCode: 'addon_10'", async () => {
      const res = await callVerify(
        { order_id: "order_test_addon_10", planId: "addon_10", addonCode: "addon_10" },
        addonOrderRow,
        activeSubRow
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
    });

    await check("2.6 Negative Control (Next): signed addon_10 with planId addon_60 must be rejected (PLAN_MISMATCH)", async () => {
      const res = await callVerify(
        { order_id: "order_test_addon_10", addonCode: "addon_10", planId: "addon_60" },
        addonOrderRow,
        activeSubRow
      );
      assert.strictEqual(res.status, 400, "Signed addon_10 with planId addon_60 must return 400");
      assert.strictEqual(res.body.code, "PLAN_MISMATCH");
    });

    await check("2.7 Negative Control (Next): signed addon_10 with planCode addon_30 must be rejected (PLAN_MISMATCH)", async () => {
      const res = await callVerify(
        { order_id: "order_test_addon_10", planCode: "addon_30" },
        addonOrderRow,
        activeSubRow
      );
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "PLAN_MISMATCH");
    });

    await check("2.8 Negative Control (Next): signed addon_10 with planCode monthly must be rejected (PLAN_MISMATCH)", async () => {
      const res = await callVerify(
        { order_id: "order_test_addon_10", planCode: "monthly" },
        addonOrderRow,
        activeSubRow
      );
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "PLAN_MISMATCH");
    });

    await check("2.9 Negative Control (Next): Add-on order rejects mismatched addonCode (ADDON_MISMATCH)", async () => {
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

    await check("2.10 Subscription verify accepts exact planCode", async () => {
      const res = await callVerify(
        { order_id: "order_test_sub_monthly", planCode: "monthly" },
        subOrderRow,
        null
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
    });

    await check("2.11 Subscription verify accepts exact planId", async () => {
      const res = await callVerify(
        { order_id: "order_test_sub_monthly", planId: "monthly" },
        subOrderRow,
        null
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
    });

    await check("2.12 Negative Control (Next): Subscription order rejects mismatched planId (annual)", async () => {
      const res = await callVerify(
        { order_id: "order_test_sub_monthly", planId: "annual" },
        subOrderRow,
        null
      );
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "PLAN_MISMATCH");
    });

    await check("2.13 Negative Control (Next): Subscription order rejects mismatched planCode (weekly)", async () => {
      const res = await callVerify(
        { order_id: "order_test_sub_monthly", planCode: "weekly" },
        subOrderRow,
        null
      );
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "PLAN_MISMATCH");
    });

    await check("2.14 Negative Control (Next): Subscription order rejects unexpected addonCode", async () => {
      const res = await callVerify(
        { order_id: "order_test_sub_monthly", addonCode: "addon_10" },
        subOrderRow,
        null
      );
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "ADDON_MISMATCH");
    });

    await check("2.15 Negative Control (Netlify): signed addon_10 with planId addon_60 must be rejected (PLAN_MISMATCH)", async () => {
      const res = await callNetlifyVerify(
        { order_id: "order_test_addon_10", addonCode: "addon_10", planId: "addon_60" },
        addonOrderRow,
        activeSubRow
      );
      assert.strictEqual(res.status, 400, `Netlify verify must return 400, got ${res.status}`);
      assert.strictEqual(res.body.code, "PLAN_MISMATCH");
    });

    await check("2.16 Netlify verify accepts matching planId (addon_10)", async () => {
      const res = await callNetlifyVerify(
        { order_id: "order_test_addon_10", planId: "addon_10" },
        addonOrderRow,
        activeSubRow
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
    });

    // -------------------------------------------------------------------------
    // SECTION 3: Credit Expiry Tied to Subscription End Date, Expired/Inactive & Renewal
    // -------------------------------------------------------------------------
    console.log("\n--- Section 3: Credit Expiry, Expired/Inactive, Read Error & Renewal Tests ---");

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
      assert.strictEqual(res.body.expiresAt, expectedEnd);
      assert.strictEqual(res.insertedCredit.expires_at, expectedEnd);
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

    await check("3.4 [expired/inactive] Add-on verify rejects when subscription expired between order and verify", async () => {
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_live_fake12345678";
      const pastEnd = new Date(Date.now() - 3600000).toISOString(); // Expired 1 hour ago
      const expiredSub = {
        id: "sub_expired",
        user_id: mockUser.id,
        status: "active",
        current_period_end: pastEnd,
      };

      const res = await callVerify(
        { order_id: "order_live_addon_10", addonCode: "addon_10" },
        liveAddonOrderRow,
        expiredSub
      );

      assert.strictEqual(res.status, 403, "Expired subscription must reject with 403");
      assert.strictEqual(res.body.code, "PRO_REQUIRED");
      assert.strictEqual(res.insertedCredit, null, "Must NOT insert add-on credit for expired subscription");
    });

    await check("3.5 [expired/inactive] Add-on verify rejects when subscription is canceled/inactive", async () => {
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_live_fake12345678";
      const futureEnd = new Date(Date.now() + 10 * 86400000).toISOString();
      const canceledSub = {
        id: "sub_canceled",
        user_id: mockUser.id,
        status: "canceled",
        current_period_end: futureEnd,
      };

      const res = await callVerify(
        { order_id: "order_live_addon_10", addonCode: "addon_10" },
        liveAddonOrderRow,
        canceledSub
      );

      assert.strictEqual(res.status, 403, "Canceled subscription must reject with 403");
      assert.strictEqual(res.body.code, "PRO_REQUIRED");
      assert.strictEqual(res.insertedCredit, null);
    });

    await check("3.6 [expired/inactive] Add-on verify rejects when user has no subscription record", async () => {
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_live_fake12345678";
      const res = await callVerify(
        { order_id: "order_live_addon_10", addonCode: "addon_10" },
        liveAddonOrderRow,
        null // No subscription
      );

      assert.strictEqual(res.status, 403, "Missing subscription must reject with 403");
      assert.strictEqual(res.body.code, "PRO_REQUIRED");
      assert.strictEqual(res.insertedCredit, null);
    });

    await check("3.7 [read-error] Add-on verify fails closed on subscription query error", async () => {
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_live_fake12345678";
      const subWithReadError = {
        __readError: new Error("Postgres connection timeout"),
      };

      const res = await callVerify(
        { order_id: "order_live_addon_10", addonCode: "addon_10" },
        liveAddonOrderRow,
        subWithReadError
      );

      assert.strictEqual(res.status, 500, "Subscription read error must return 500, not 200");
      assert.strictEqual(res.body.code, "DATABASE_ERROR");
      assert.strictEqual(res.insertedCredit, null, "Must NOT insert credit on read error");
    });

    // Live mode subscription order row for renewal testing
    const liveSubOrderRow = {
      id: "ord_live_uuid_sub",
      provider: "razorpay",
      mode: "live",
      provider_order_id: "order_live_sub_renewal",
      plan_code: "monthly",
      addon_code: null,
      amount_paise: 149900,
      status: "created",
    };

    await check("3.8 [renewal] Next verify fallback extends existing unexpired add-on credits on subscription renewal", async () => {
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_live_fake12345678";
      const existingPeriodEnd = new Date(Date.now() + 5 * 86400000).toISOString();
      const existingSub = {
        id: "sub_active_renewal",
        user_id: mockUser.id,
        status: "active",
        plan_id: "monthly",
        current_period_start: new Date(Date.now() - 25 * 86400000).toISOString(),
        current_period_end: existingPeriodEnd,
      };

      const res = await callVerify(
        { order_id: "order_live_sub_renewal", planCode: "monthly" },
        liveSubOrderRow,
        existingSub
      );

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.isPro, true);
      assert.ok(res.updatedCredits, "Must invoke update on user_addon_credits to extend expiry");
      assert.strictEqual(res.updatedCredits.expires_at, res.upsertedSub.current_period_end, "Add-on credits expires_at must match new extended subscription end date");
    });

    await check("3.9 [renewal negative control] Next verify fallback fails closed (500) if extending add-on credits fails", async () => {
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_live_fake12345678";
      const existingPeriodEnd = new Date(Date.now() + 5 * 86400000).toISOString();
      const existingSub = {
        id: "sub_active_renewal",
        user_id: mockUser.id,
        status: "active",
        plan_id: "monthly",
        current_period_start: new Date(Date.now() - 25 * 86400000).toISOString(),
        current_period_end: existingPeriodEnd,
      };

      const res = await callVerify(
        { order_id: "order_live_sub_renewal", planCode: "monthly" },
        liveSubOrderRow,
        existingSub,
        { __updateError: new Error("Failed to write updated add-on credit rows") }
      );

      assert.strictEqual(res.status, 500, "Credit extension failure must return 500, NOT 200");
      assert.strictEqual(res.body.code, "DATABASE_ERROR");
      assert.strictEqual(res.updatedOrder, null, "Payment order must NOT be marked paid when extension fails");
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
      const migPath = path.resolve("supabase/migrations/20261113a_addon_credit_expiry_subscription_sync.sql");
      const content = fs.readFileSync(migPath, "utf8");
      assert.ok(content.includes("Status: NOT APPLIED"), "Header must have NOT APPLIED status");
      assert.ok(content.includes("record-migration.cjs 20261113a_addon_credit_expiry_subscription_sync"), "Header must contain self-referencing record command");
    });

    check("4.3 Migration SQL ties add-on credit expiry to active subscription period end", () => {
      const migPath = path.resolve("supabase/migrations/20261113a_addon_credit_expiry_subscription_sync.sql");
      const content = fs.readFileSync(migPath, "utf8");
      assert.ok(content.includes("user_addon_credits"), "Migration must reference user_addon_credits");
      assert.ok(content.includes("current_period_end"), "Migration must sync with current_period_end");
      assert.ok(content.includes("SET search_path = public"), "Function definition must pin search_path inline");
      assert.ok(content.includes("PRO_REQUIRED"), "SQL RPC must require active subscription for add-on purchases");
    });

    check("4.4 Suite runner registers scripts/test-addon-verify-and-expiry.ts", () => {
      const runnerPath = path.resolve("scripts/suite-runner.ts");
      const content = fs.readFileSync(runnerPath, "utf8");
      assert.ok(content.includes("scripts/test-addon-verify-and-expiry.ts"), "suite-runner.ts must register test-addon-verify-and-expiry.ts");
    });

    console.log("\n--------------------------------------------------------------------------------");
    console.log(`TEST SUITE RESULTS: ${passed} passed, ${failed} failed`);
    console.log("--------------------------------------------------------------------------------\n");

    if (failed > 0) {
      console.error(`VERDICT: FAIL (${failed} tests failed)`);
      process.exit(1);
    } else {
      console.log("VERDICT: PASS (All add-on verify and expiry test scenarios passed)");
    }
  } finally {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = origBilling;
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = origKeyId;
    process.env.RAZORPAY_KEY_SECRET = origSecret;
  }
}

runSuite().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
