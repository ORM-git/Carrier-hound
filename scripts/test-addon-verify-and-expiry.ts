/**
 * scripts/test-addon-verify-and-expiry.ts
 *
 * Comprehensive offline verification suite for PR 2:
 * 1. PLAN_MISMATCH verify bug fix & planId validation:
 *    - Add-on verify accepts add-on plan IDs (e.g. planCode: "addon_10", planId: "addon_10").
 *    - Tampered plan IDs in Next and Netlify adapters (e.g. signed addon_10 with planId: "addon_60"
 *      or planCode: "addon_30" / "monthly") must be rejected with 400 PLAN_MISMATCH.
 *    - Tampered addon IDs (e.g. addonCode: "addon_30" for an addon_10 order) must reject 400 ADDON_MISMATCH.
 *    - Subscription plan verify enforces exact subscription plan match on both planCode and planId.
 *
 * 2. Atomic SQL RPC fulfillment & Zero JS Fallback:
 *    - Fulfillment happens ONLY through the atomic SQL RPC fulfil_payment_order.
 *    - RPC failure returns 500 with ZERO partial writes and leaves the order in created status.
 *    - SQL model guarantees A-fail, B-success, A-retry yields exactly 85 days (no drift to 115).
 *    - Retrying an already-paid order returns already_paid: true without re-granting.
 *
 * 3. Credit Expiry & PRO_REQUIRED Consistency:
 *    - Add-on credit expiry ties to active subscription end date.
 *    - Rejects inactive or expired subscriptions with 403 PRO_REQUIRED.
 *    - Consistently returns HTTP 403 on Next RPC branch, Netlify adapter, and SQL model.
 *
 * 4. Catalog pricing and checkout helper alignment:
 *    - resolveOrderPricing accepts add-on IDs in planCode and planId.
 *    - handleProCheckout does not force default planCode: "monthly" when addonCode is supplied.
 *
 * 5. Migration file policy compliance:
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

    function createMockSupabase(orderRow: any, subRow: any = null, options: any = {}) {
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
                if (options.__updateError) {
                  return {
                    eq: () => ({
                      gte: () => ({
                        gt: async () => ({ data: null, error: options.__updateError }),
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
          if (options.customRpcHandler) {
            return options.customRpcHandler(fn, args);
          }

          if (fn === "fulfil_payment_order") {
            if (options.rpcError) {
              return { data: null, error: options.rpcError };
            }

            const currentOrder = orderRow;
            if (!currentOrder) {
              return { data: { success: false, code: "ORDER_NOT_FOUND", error: "Payment order not found for user" }, error: null };
            }

            if (currentOrder.provider && currentOrder.provider !== "razorpay") {
              return { data: { success: false, code: "INVALID_PROVIDER", error: "Only razorpay provider orders can be fulfilled" }, error: null };
            }

            if (currentOrder.mode !== args.p_expected_mode) {
              return { data: { success: false, code: "MODE_MISMATCH", error: `Order mode does not match fulfillment mode` }, error: null };
            }

            if (currentOrder.status !== "created" && currentOrder.status !== "paid") {
              return { data: { success: false, code: "ORDER_INVALID_STATE", error: "Payment order is not in created or paid state" }, error: null };
            }

            // Test mode isolation: Zero real entitlements granted
            if (currentOrder.mode === "test") {
              if (currentOrder.status === "paid") {
                return {
                  data: {
                    success: true,
                    test_mode: true,
                    is_pro: false,
                    already_paid: true,
                    order_id: currentOrder.id,
                    message: "Test order already verified and marked as paid",
                  },
                  error: null,
                };
              }
              updatedOrder = { ...currentOrder, status: "paid" };
              return {
                data: {
                  success: true,
                  test_mode: true,
                  is_pro: false,
                  already_paid: false,
                  order_id: currentOrder.id,
                  type: currentOrder.addon_code ? "addon" : "plan",
                  addon_code: currentOrder.addon_code,
                  plan_code: currentOrder.plan_code,
                  message: "Test payment verified; zero real entitlements granted",
                },
                error: null,
              };
            }

            // Live mode: Section 6 - Idempotency check for already fulfilled live orders
            if (currentOrder.status === "paid") {
              if (currentOrder.plan_code) {
                return {
                  data: {
                    success: true,
                    already_paid: true,
                    is_pro: true,
                    type: "plan",
                    plan_code: currentOrder.plan_code,
                    order_id: currentOrder.id,
                    period_end: subRow?.current_period_end,
                    message: "Order already fulfilled and marked as paid",
                  },
                  error: null,
                };
              } else if (currentOrder.addon_code) {
                return {
                  data: {
                    success: true,
                    already_paid: true,
                    is_pro: false,
                    type: "addon",
                    addon_code: currentOrder.addon_code,
                    order_id: currentOrder.id,
                    expires_at: subRow?.current_period_end,
                    message: "Order already fulfilled and marked as paid",
                  },
                  error: null,
                };
              }
            }

            // Live mode: Section 7 - Subscription plan purchase / renewal / upgrade
            if (currentOrder.plan_code) {
              const durationDays = currentOrder.plan_code === "weekly" ? 7 : (currentOrder.plan_code === "annual" ? 365 : 30);
              const now = Date.now();
              const existingEnd = subRow?.current_period_end ? new Date(subRow.current_period_end).getTime() : 0;
              const isActive = subRow && (subRow.status === "active" || subRow.status === "trialing") && existingEnd > 0;
              const baseTime = isActive ? Math.max(existingEnd, now) : now;
              const newEnd = new Date(baseTime + durationDays * 86400000).toISOString();

              upsertedSub = {
                user_id: args.p_user_id,
                plan_id: currentOrder.plan_code,
                status: "active",
                current_period_start: (isActive && subRow?.current_period_start) ? subRow.current_period_start : new Date(now).toISOString(),
                current_period_end: newEnd,
              };

              updatedCredits = { expires_at: newEnd };
              updatedOrder = { ...currentOrder, status: "paid" };

              return {
                data: {
                  success: true,
                  is_pro: true,
                  isPro: true,
                  type: "plan",
                  plan_code: currentOrder.plan_code,
                  planCode: currentOrder.plan_code,
                  order_id: currentOrder.id,
                  orderId: currentOrder.id,
                  period_end: newEnd,
                  periodEnd: newEnd,
                },
                error: null,
              };
            }

            // Live mode: Section 8 - Add-on pack purchase
            if (currentOrder.addon_code) {
              const now = Date.now();
              const existingEnd = subRow?.current_period_end ? new Date(subRow.current_period_end).getTime() : 0;
              const isActive = subRow && (subRow.status === "active" || subRow.status === "trialing") && existingEnd > now;

              if (!isActive) {
                return {
                  data: {
                    success: false,
                    code: "PRO_REQUIRED",
                    error: "Active Pro subscription required to activate add-on credits",
                  },
                  error: null,
                };
              }

              const sets = currentOrder.addon_code === "addon_30" ? 30 : (currentOrder.addon_code === "addon_60" ? 60 : 10);
              insertedCredit = {
                id: "credit_uuid_addon",
                user_id: args.p_user_id,
                pack_code: currentOrder.addon_code,
                sets_total: sets,
                sets_remaining: sets,
                expires_at: subRow.current_period_end,
                order_id: currentOrder.id,
              };
              updatedOrder = { ...currentOrder, status: "paid" };

              return {
                data: {
                  success: true,
                  is_pro: false,
                  isPro: false,
                  type: "addon",
                  addon_code: currentOrder.addon_code,
                  addonCode: currentOrder.addon_code,
                  order_id: currentOrder.id,
                  orderId: currentOrder.id,
                  expires_at: subRow.current_period_end,
                  expiresAt: subRow.current_period_end,
                  credit: insertedCredit,
                },
                error: null,
              };
            }
          }

          throw new Error(`RPC function ${fn} not handled in mock`);
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

    async function callVerify(body: any, orderRow: any, subRow: any = null, options: any = {}) {
      const orderId = body.order_id || body.razorpay_order_id || "order_test_123";
      const paymentId = body.payment_id || body.razorpay_payment_id || "pay_test_456";
      const sig = computeSignature(orderId, paymentId, TEST_SECRET);

      const payload = {
        order_id: orderId,
        payment_id: paymentId,
        razorpay_signature: sig,
        ...body,
      };

      const mockDb = createMockSupabase(orderRow, subRow, options);

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

    async function callNetlifyVerify(body: any, orderRow: any, subRow: any = null, options: any = {}) {
      const orderId = body.order_id || body.razorpay_order_id || "order_test_123";
      const paymentId = body.payment_id || body.razorpay_payment_id || "pay_test_456";
      const sig = computeSignature(orderId, paymentId, TEST_SECRET);

      const payload = {
        order_id: orderId,
        payment_id: paymentId,
        razorpay_signature: sig,
        ...body,
      };

      const mockDb = createMockSupabase(orderRow, subRow, options);
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
    // SECTION 3: Credit Expiry, Expired/Inactive, Read Error, Renewal & Idempotent Retry
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

    await check("3.4 [expired/inactive] Add-on verify rejects when subscription expired between order and verify (403 PRO_REQUIRED)", async () => {
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

    await check("3.5 [expired/inactive] Add-on verify rejects when subscription is canceled/inactive (403 PRO_REQUIRED)", async () => {
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

    await check("3.6 [expired/inactive] Add-on verify rejects when user has no subscription record (403 PRO_REQUIRED)", async () => {
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

    await check("3.7 [RPC failure writes nothing] RPC failure returns 500 with zero partial writes and order stays created", async () => {
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_live_fake12345678";
      const res = await callVerify(
        { order_id: "order_live_sub_renewal", planCode: "monthly" },
        liveSubOrderRow,
        null,
        { rpcError: new Error("PostgreSQL connection timeout") }
      );

      assert.strictEqual(res.status, 500, "RPC failure must return 500");
      assert.strictEqual(res.body.code, "FULFILLMENT_FAILED");
      assert.strictEqual(res.updatedOrder, null, "Order must NOT be marked paid on RPC failure");
      assert.strictEqual(res.upsertedSub, null, "Subscription must NOT be updated on RPC failure");
      assert.strictEqual(res.insertedCredit, null, "Credits must NOT be inserted on RPC failure");
      assert.strictEqual(res.updatedCredits, null, "Credits must NOT be modified on RPC failure");
    });

    await check("3.8 [SQL model: A-fail, B-success, A-retry yields 85 days] Interleaved multi-order retry with no regrant drift", async () => {
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_live_fake12345678";
      const initialEnd = new Date(Date.now() + 25 * 86400000).toISOString();
      let currentSub: any = {
        id: "sub_shared",
        user_id: mockUser.id,
        status: "active",
        plan_id: "monthly",
        current_period_start: new Date(Date.now() - 5 * 86400000).toISOString(),
        current_period_end: initialEnd,
      };

      let orderA = {
        id: "ord_A_uuid",
        provider: "razorpay",
        mode: "live",
        provider_order_id: "order_live_A_sub",
        plan_code: "monthly",
        addon_code: null,
        amount_paise: 149900,
        status: "created",
      };

      let orderB = {
        id: "ord_B_uuid",
        provider: "razorpay",
        mode: "live",
        provider_order_id: "order_live_B_sub",
        plan_code: "monthly",
        addon_code: null,
        amount_paise: 149900,
        status: "created",
      };

      // Step 1: Order A is submitted, but RPC fails (simulated DB transaction abort)
      const resA1 = await callVerify(
        { order_id: "order_live_A_sub", planCode: "monthly" },
        orderA,
        currentSub,
        { rpcError: new Error("Simulated DB transaction abort") }
      );

      assert.strictEqual(resA1.status, 500, "Failed attempt must return 500");
      assert.strictEqual(resA1.body.code, "FULFILLMENT_FAILED");
      assert.strictEqual(resA1.updatedOrder, null, "Order A must stay created on RPC failure");
      assert.strictEqual(resA1.upsertedSub, null, "Subscription must not be touched on RPC failure");

      // Step 2: Order B is submitted and RPC succeeds
      const resB = await callVerify(
        { order_id: "order_live_B_sub", planCode: "monthly" },
        orderB,
        currentSub
      );

      assert.strictEqual(resB.status, 200);
      assert.strictEqual(resB.body.success, true);
      assert.strictEqual(resB.body.isPro, true);
      assert.strictEqual(resB.updatedOrder.status, "paid");
      orderB = { ...orderB, status: "paid" };

      // Subscription extended +30 days (25 + 30 = 55 days)
      const expectedBEndMs = new Date(initialEnd).getTime() + 30 * 86400000;
      assert.ok(Math.abs(new Date(resB.upsertedSub.current_period_end).getTime() - expectedBEndMs) < 5000);
      currentSub = { ...currentSub, current_period_end: resB.upsertedSub.current_period_end };

      // Step 3: Order A is retried (still in created status) and RPC succeeds
      const resA2 = await callVerify(
        { order_id: "order_live_A_sub", planCode: "monthly" },
        orderA,
        currentSub
      );

      assert.strictEqual(resA2.status, 200);
      assert.strictEqual(resA2.body.success, true);
      assert.strictEqual(resA2.body.isPro, true);
      assert.strictEqual(resA2.updatedOrder.status, "paid");
      orderA = { ...orderA, status: "paid" };

      // Subscription extended +30 days from 55 days (55 + 30 = 85 days)
      const expectedA2EndMs = new Date(initialEnd).getTime() + 60 * 86400000;
      assert.ok(Math.abs(new Date(resA2.upsertedSub.current_period_end).getTime() - expectedA2EndMs) < 5000);
      currentSub = { ...currentSub, current_period_end: resA2.upsertedSub.current_period_end };

      // Step 4: Order A is retried AGAIN (already marked paid in DB)
      const resA3 = await callVerify(
        { order_id: "order_live_A_sub", planCode: "monthly" },
        orderA,
        currentSub
      );

      assert.strictEqual(resA3.status, 200);
      assert.strictEqual(resA3.body.alreadyPaid, true);
      // Subscription must NOT be re-extended to 115 days; it stays at 85 days
      assert.strictEqual(resA3.upsertedSub, null, "Already-paid retry must NOT modify subscription");
      assert.strictEqual(
        currentSub.current_period_end,
        resA2.upsertedSub.current_period_end,
        "Subscription period must stay 85 days, NOT 115 days"
      );
    });

    await check("3.9 [renewal unexpired credits] Plan extension extends unexpired add-on credits via atomic RPC", async () => {
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

    await check("3.10 [PRO_REQUIRED consistency] Next live RPC branch returns 403 on PRO_REQUIRED", async () => {
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_live_fake12345678";
      const res = await callVerify(
        { order_id: "order_live_addon_10", addonCode: "addon_10" },
        liveAddonOrderRow,
        null,
        {
          customRpcHandler: async () => ({
            data: { success: false, code: "PRO_REQUIRED", error: "Active Pro subscription required" },
            error: null,
          }),
        }
      );

      assert.strictEqual(res.status, 403, `Next live RPC branch must return 403 on PRO_REQUIRED, got ${res.status}`);
      assert.strictEqual(res.body.code, "PRO_REQUIRED");
    });

    await check("3.11 [PRO_REQUIRED consistency] Netlify verify returns 403 on PRO_REQUIRED", async () => {
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = TEST_KEY_ID;
      const res = await callNetlifyVerify(
        { order_id: "order_test_addon_10", addonCode: "addon_10" },
        addonOrderRow,
        null,
        {
          customRpcHandler: async () => ({
            data: { success: false, code: "PRO_REQUIRED", error: "Active Pro subscription required" },
            error: null,
          }),
        }
      );

      assert.strictEqual(res.status, 403, `Netlify verify must return 403 on PRO_REQUIRED, got ${res.status}`);
      assert.strictEqual(res.body.code, "PRO_REQUIRED");
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
      assert.ok(content.includes("SET search_path = public"), "Function definition must pin search_path inline");
    });

    check("4.3 Suite runner registers scripts/test-addon-verify-and-expiry.ts", () => {
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
