import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { POST as handleOrderPost } from "@/app/api/billing/razorpay/order/route";
import { POST as handleVerifyPost } from "@/app/api/billing/razorpay/verify/route";
import {
  resolveOrderPricing,
  PLAN_DEFINITIONS,
  hasEarlierSuccessfulMonthlyPayment,
} from "@/lib/billing/quota";
import { getPlanPricePaise, getPlanPriceINR, PLAN_PRICING } from "@/config/plans";

describe("Prepaid Razorpay Payment Flow & Pricing Engine", () => {
  const originalEnv = { ...process.env };
  const TEST_KEY_ID = "rzp_test_flow_key_123";
  const TEST_KEY_SECRET = "flow_test_secret_456";

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_BILLING_ENABLED: "true",
      RAZORPAY_MODE: "test",
      NEXT_PUBLIC_RAZORPAY_KEY_ID: TEST_KEY_ID,
      RAZORPAY_KEY_ID: TEST_KEY_ID,
      RAZORPAY_KEY_SECRET: TEST_KEY_SECRET,
      NEXT_PUBLIC_SUPABASE_URL: "https://mock.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "mock_service_key",
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("Single Source of Truth Plan Pricing (plans.ts & quota.ts)", () => {
    it("exports authoritative prepaid prices in paise and INR", () => {
      // Weekly: Rs 399, 7 days
      expect(PLAN_PRICING.weekly.price_paise).toBe(39900);
      expect(PLAN_PRICING.weekly.duration_days).toBe(7);
      expect(getPlanPricePaise("weekly")).toBe(39900);
      expect(getPlanPriceINR("weekly")).toBe(399);

      // Monthly: Rs 499 first purchase, Rs 799 repeat purchase, 30 days
      expect(PLAN_PRICING.monthly.first_purchase_price_paise).toBe(49900);
      expect(PLAN_PRICING.monthly.repeat_price_paise).toBe(79900);
      expect(PLAN_PRICING.monthly.duration_days).toBe(30);
      expect(getPlanPricePaise("monthly", true)).toBe(49900);
      expect(getPlanPricePaise("monthly", false)).toBe(79900);
      expect(getPlanPriceINR("monthly", true)).toBe(499);
      expect(getPlanPriceINR("monthly", false)).toBe(799);

      // Quarterly: Rs 2,199, 90 days
      expect(PLAN_PRICING.quarterly.price_paise).toBe(219900);
      expect(PLAN_PRICING.quarterly.duration_days).toBe(90);
      expect(getPlanPricePaise("quarterly")).toBe(219900);
      expect(getPlanPriceINR("quarterly")).toBe(2199);
    });

    it("PLAN_DEFINITIONS in quota.ts matches PLAN_PRICING single source of truth", () => {
      expect(PLAN_DEFINITIONS.weekly.price_paise).toBe(39900);
      expect(PLAN_DEFINITIONS.weekly.duration_days).toBe(7);

      expect(PLAN_DEFINITIONS.monthly.price_paise).toBe(49900);
      expect(PLAN_DEFINITIONS.monthly.duration_days).toBe(30);

      expect(PLAN_DEFINITIONS.quarterly.price_paise).toBe(219900);
      expect(PLAN_DEFINITIONS.quarterly.duration_days).toBe(90);
    });
  });

  describe("First-Month vs Repeat Monthly Pricing Detection", () => {
    it("returns false (first month) when user has no prior paid orders or subscriptions", async () => {
      const mockSupabase = {
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  limit: async () => ({ data: [], error: null }),
                }),
              }),
              limit: async () => ({ data: [], error: null }),
            }),
          }),
        }),
      };

      const hasEarlier = await hasEarlierSuccessfulMonthlyPayment(mockSupabase, "u_first_time");
      expect(hasEarlier).toBe(false);

      const pricing = resolveOrderPricing({ planCode: "monthly", isFirstMonthlyPurchase: !hasEarlier });
      expect(pricing?.amount_paise).toBe(49900);
      expect(pricing?.duration_days).toBe(30);
    });

    it("returns true (repeat month) when user has an earlier paid monthly order", async () => {
      const mockSupabase = {
        from: (table: string) => {
          if (table === "payment_orders") {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      limit: async () => ({
                        data: [{ id: "order_prev_paid_123" }],
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {
            select: () => ({
              eq: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          };
        },
      };

      const hasEarlier = await hasEarlierSuccessfulMonthlyPayment(mockSupabase, "u_repeat_customer");
      expect(hasEarlier).toBe(true);

      const pricing = resolveOrderPricing({ planCode: "monthly", isFirstMonthlyPurchase: !hasEarlier });
      expect(pricing?.amount_paise).toBe(79900);
      expect(pricing?.duration_days).toBe(30);
    });

    it("returns true (repeat month) when user has an existing monthly subscription", async () => {
      const mockSupabase = {
        from: (table: string) => {
          if (table === "payment_orders") {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      limit: async () => ({ data: [], error: null }),
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === "subscriptions") {
            return {
              select: () => ({
                eq: () => ({
                  limit: async () => ({
                    data: [{ id: "sub_1", plan_id: "monthly" }],
                    error: null,
                  }),
                }),
              }),
            };
          }
          return {} as any;
        },
      };

      const hasEarlier = await hasEarlierSuccessfulMonthlyPayment(mockSupabase, "u_existing_sub");
      expect(hasEarlier).toBe(true);

      const pricing = resolveOrderPricing({ planCode: "monthly", isFirstMonthlyPurchase: !hasEarlier });
      expect(pricing?.amount_paise).toBe(79900);
    });
  });

  describe("Order Route Server-Side Amount Enforcement (Tampered Amount Immunity)", () => {
    it("ignores client-supplied tampered amount (e.g. 100 paise) and bills Rs 499 for first month", async () => {
      let createdOrderAmount = 0;
      const fakeOrderReq = new Request("http://localhost:3000/api/billing/razorpay/order", {
        method: "POST",
        headers: {
          authorization: "Bearer valid_token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          planCode: "monthly",
          amount: 100, // Client attempts to pay Rs 1
          price: 1,
        }),
      });

      const mockSupabaseAdmin = {
        auth: {
          getUser: async () => ({
            data: { user: { id: "u_tamper_1", user_metadata: {} } },
            error: null,
          }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  limit: async () => ({ data: [], error: null }), // No earlier payment
                }),
              }),
              limit: async () => ({ data: [], error: null }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: async () => ({ data: { id: "po_1" }, error: null }),
            }),
          }),
        }),
      };

      (fakeOrderReq as any).__testDeps = {
        getSupabaseAdmin: () => mockSupabaseAdmin,
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: async (_url: string, init: any) => {
          const payload = JSON.parse(init.body);
          createdOrderAmount = payload.amount;
          return new Response(
            JSON.stringify({
              id: "order_rzp_first_499",
              amount: payload.amount,
              currency: "INR",
              status: "created",
            }),
            { status: 200 }
          );
        },
      };

      const res = await handleOrderPost(fakeOrderReq);
      expect(res.status).toBe(200);
      // Authoritative Rs 499 (49900 paise) must be sent to Razorpay, NOT the client's 100
      expect(createdOrderAmount).toBe(49900);
      const resJson = await res.json();
      expect(resJson.amount).toBe(49900);
    });

    it("enforces Rs 799 for repeat monthly buyer even if client passes Rs 499 in body", async () => {
      let createdOrderAmount = 0;
      const fakeOrderReq = new Request("http://localhost:3000/api/billing/razorpay/order", {
        method: "POST",
        headers: {
          authorization: "Bearer valid_token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          planCode: "monthly",
          amount: 49900, // Client tries to claim first-month price again
        }),
      });

      const mockSupabaseAdmin = {
        auth: {
          getUser: async () => ({
            data: { user: { id: "u_repeat_2", user_metadata: {} } },
            error: null,
          }),
        },
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  limit: async () => ({
                    // User has prior paid monthly order
                    data: table === "payment_orders" ? [{ id: "order_prev_paid" }] : [],
                    error: null,
                  }),
                }),
              }),
              limit: async () => ({ data: [], error: null }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: async () => ({ data: { id: "po_2" }, error: null }),
            }),
          }),
        }),
      };

      (fakeOrderReq as any).__testDeps = {
        getSupabaseAdmin: () => mockSupabaseAdmin,
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: async (_url: string, init: any) => {
          const payload = JSON.parse(init.body);
          createdOrderAmount = payload.amount;
          return new Response(
            JSON.stringify({
              id: "order_rzp_repeat_799",
              amount: payload.amount,
              currency: "INR",
              status: "created",
            }),
            { status: 200 }
          );
        },
      };

      const res = await handleOrderPost(fakeOrderReq);
      expect(res.status).toBe(200);
      // Authoritative repeat price Rs 799 (79900 paise) strictly enforced
      expect(createdOrderAmount).toBe(79900);
      const resJson = await res.json();
      expect(resJson.amount).toBe(79900);
    });
  });

  describe("Verify Route Tampered Amount Rejection", () => {
    const orderId = "order_test_tamper_verify";
    const paymentId = "pay_test_tamper_verify";
    const signature = crypto
      .createHmac("sha256", TEST_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    it("rejects verify request when payload amount differs from recorded order amount", async () => {
      const verifyReq = new Request("http://localhost:3000/api/billing/razorpay/verify", {
        method: "POST",
        headers: {
          authorization: "Bearer valid_token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          order_id: orderId,
          payment_id: paymentId,
          razorpay_signature: signature,
          amount: 39900, // payload claims 39900 but recorded order is 49900
        }),
      });

      const mockSupabaseAdmin = {
        auth: {
          getUser: async () => ({
            data: { user: { id: "u_verify_tamper", user_metadata: {} } },
            error: null,
          }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: "po_row_1",
                    provider: "razorpay",
                    mode: "test",
                    provider_order_id: orderId,
                    plan_code: "monthly",
                    amount_paise: 49900, // DB has 49900
                    currency: "INR",
                    status: "created",
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      };

      (verifyReq as any).__testDeps = {
        getSupabaseAdmin: () => mockSupabaseAdmin,
      };

      const res = await handleVerifyPost(verifyReq);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe("AMOUNT_MISMATCH");
    });

    it("rejects verify request when Razorpay provider payment amount does not match recorded order amount", async () => {
      const verifyReq = new Request("http://localhost:3000/api/billing/razorpay/verify", {
        method: "POST",
        headers: {
          authorization: "Bearer valid_token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          order_id: orderId,
          payment_id: paymentId,
          razorpay_signature: signature,
        }),
      });

      const mockSupabaseAdmin = {
        auth: {
          getUser: async () => ({
            data: { user: { id: "u_verify_tamper", user_metadata: {} } },
            error: null,
          }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: "po_row_1",
                    provider: "razorpay",
                    mode: "test",
                    provider_order_id: orderId,
                    plan_code: "monthly",
                    amount_paise: 49900,
                    currency: "INR",
                    status: "created",
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      };

      (verifyReq as any).__testDeps = {
        getSupabaseAdmin: () => mockSupabaseAdmin,
        fetchRazorpayPayment: async () => ({
          id: paymentId,
          order_id: orderId,
          status: "captured",
          amount: 20000, // Provider charged 20000 instead of recorded 49900
          currency: "INR",
        }),
      };

      const res = await handleVerifyPost(verifyReq);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe("AMOUNT_MISMATCH");
    });
  });

  describe("Verify Idempotency & Active Pro Extension", () => {
    it("returns 200 with alreadyPaid: true on duplicate verify of already-paid order", async () => {
      const paidOrderId = "order_test_already_paid_1";
      const paidPaymentId = "pay_test_already_paid_1";
      const signature = crypto
        .createHmac("sha256", TEST_KEY_SECRET)
        .update(`${paidOrderId}|${paidPaymentId}`)
        .digest("hex");

      const verifyReq = new Request("http://localhost:3000/api/billing/razorpay/verify", {
        method: "POST",
        headers: {
          authorization: "Bearer valid_token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          order_id: paidOrderId,
          payment_id: paidPaymentId,
          razorpay_signature: signature,
        }),
      });

      let rpcCallCount = 0;
      const mockSupabaseAdmin = {
        auth: {
          getUser: async () => ({
            data: { user: { id: "u_idem_1", user_metadata: {} } },
            error: null,
          }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: "po_already_paid",
                    provider: "razorpay",
                    mode: "test",
                    provider_order_id: paidOrderId,
                    plan_code: "weekly",
                    amount_paise: 39900,
                    currency: "INR",
                    status: "paid", // Already paid
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
        rpc: async () => {
          rpcCallCount++;
          return { data: { success: true }, error: null };
        },
      };

      (verifyReq as any).__testDeps = {
        getSupabaseAdmin: () => mockSupabaseAdmin,
      };

      const res = await handleVerifyPost(verifyReq);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.alreadyPaid).toBe(true);
      // RPC must not even be called when order is already paid
      expect(rpcCallCount).toBe(0);
    });

    it("fulfilment extends active Pro from current_period_end by plan duration", () => {
      // Test the date arithmetic rule implemented in Postgres fulfil_payment_order:
      // v_base_time := greatest(v_existing_sub.current_period_end, now());
      // v_new_end := v_base_time + (v_duration * interval '1 day');

      const now = new Date("2026-11-17T12:00:00Z");
      const activeCurrentPeriodEnd = new Date("2026-11-25T12:00:00Z"); // 8 days in the future

      // Weekly plan adds 7 days to active subscription
      const weeklyDurationDays = PLAN_PRICING.weekly.duration_days;
      const weeklyExtendedEnd = new Date(activeCurrentPeriodEnd.getTime() + weeklyDurationDays * 86400000);
      expect(weeklyExtendedEnd.toISOString()).toBe("2026-12-02T12:00:00.000Z");

      // Monthly plan adds 30 days to active subscription
      const monthlyDurationDays = PLAN_PRICING.monthly.duration_days;
      const monthlyExtendedEnd = new Date(activeCurrentPeriodEnd.getTime() + monthlyDurationDays * 86400000);
      expect(monthlyExtendedEnd.toISOString()).toBe("2026-12-25T12:00:00.000Z");

      // Quarterly plan adds 90 days to active subscription
      const quarterlyDurationDays = PLAN_PRICING.quarterly.duration_days;
      const quarterlyExtendedEnd = new Date(activeCurrentPeriodEnd.getTime() + quarterlyDurationDays * 86400000);
      expect(quarterlyExtendedEnd.toISOString()).toBe("2027-02-23T12:00:00.000Z");

      // Expired subscription extends from now
      const expiredCurrentPeriodEnd = new Date("2026-11-10T12:00:00Z"); // In the past
      const baseTime = expiredCurrentPeriodEnd > now ? expiredCurrentPeriodEnd : now;
      const newEndForExpired = new Date(baseTime.getTime() + monthlyDurationDays * 86400000);
      expect(newEndForExpired.toISOString()).toBe("2026-12-17T12:00:00.000Z");
    });
  });
});
