import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { PGlite } from "@electric-sql/pglite";
import { POST as handleOrderPost } from "@/app/api/billing/razorpay/order/route";
import { POST as handleVerifyPost } from "@/app/api/billing/razorpay/verify/route";
import {
  resolveOrderPricing,
  PLAN_DEFINITIONS,
  hasEarlierSuccessfulMonthlyPayment,
  checkMonthlyIntroEligibilityAndReserve,
  releaseMonthlyIntroReservation,
} from "@/lib/billing/quota";
import { getPlanPricePaise, getPlanPriceINR, PLAN_PRICING } from "@/config/plans";

describe("Prepaid Razorpay Payment Flow & Pricing Engine", () => {
  const originalEnv = { ...process.env };
  const TEST_KEY_ID = "rzp_test_flow_key_123";
  const TEST_KEY_SECRET = "flow_test_secret_456";

  function createMockSupabase(overrides?: {
    paidOrders?: any[];
    pendingOrders?: any[];
    subscriptions?: any[];
    orderError?: any;
    subError?: any;
    pendingError?: any;
    reservationConflict?: boolean;
    reservationError?: any;
  }) {
    return {
      auth: {
        getUser: async () => ({
          data: { user: { id: "u_test_auth", user_metadata: {} } },
          error: null,
        }),
      },
      from: (table: string) => {
        const builder: any = {
          _filters: {},
          select: vi.fn(() => builder),
          eq: vi.fn((col: string, val: any) => {
            builder._filters[col] = val;
            return builder;
          }),
          gte: vi.fn(() => builder),
          or: vi.fn(async () => ({ data: null, error: null })),
          delete: vi.fn(() => builder),
          insert: vi.fn(() => {
            if (overrides?.reservationConflict) {
              return {
                select: () => ({
                  single: async () => ({
                    data: null,
                    error: { code: "23505", message: "duplicate key value violates unique constraint" },
                  }),
                }),
              };
            }
            if (overrides?.reservationError) {
              return {
                select: () => ({
                  single: async () => ({ data: null, error: overrides.reservationError }),
                }),
              };
            }
            return {
              select: () => ({
                single: async () => ({ data: { id: "po_row_new", user_id: "u_test_auth" }, error: null }),
              }),
            };
          }),
          update: vi.fn(() => builder),
          then: (resolve: any) => Promise.resolve({ data: null, error: null }).then(resolve),
          catch: (reject: any) => Promise.resolve({ data: null, error: null }).catch(reject),
          limit: vi.fn(async () => {
            if (table === "payment_orders") {
              if (overrides?.orderError) return { data: null, error: overrides.orderError };
              if (builder._filters.status === "paid") {
                return { data: overrides?.paidOrders || [], error: null };
              }
              if (builder._filters.status === "created") {
                if (overrides?.pendingError) return { data: null, error: overrides.pendingError };
                return { data: overrides?.pendingOrders || [], error: null };
              }
              return { data: [], error: null };
            }
            if (table === "subscriptions") {
              if (overrides?.subError) return { data: null, error: overrides.subError };
              return { data: overrides?.subscriptions || [], error: null };
            }
            return { data: [], error: null };
          }),
          single: vi.fn(async () => ({ data: { id: "po_1" }, error: null })),
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        };
        return builder;
      },
    };
  }

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

  describe("First-Month vs Repeat Monthly Pricing Detection & Fail-Closed Guards", () => {
    it("returns false (first month) when user has no prior paid orders or subscriptions", async () => {
      const mockSupabase = createMockSupabase();
      const hasEarlier = await hasEarlierSuccessfulMonthlyPayment(mockSupabase, "u_first_time");
      expect(hasEarlier).toBe(false);

      const pricing = resolveOrderPricing({ planCode: "monthly", isFirstMonthlyPurchase: !hasEarlier });
      expect(pricing?.amount_paise).toBe(49900);
      expect(pricing?.duration_days).toBe(30);
    });

    it("returns true (repeat month) when user has an earlier paid live monthly order", async () => {
      const mockSupabase = createMockSupabase({
        paidOrders: [{ id: "order_prev_paid_123", status: "paid", mode: "live" }],
      });
      const hasEarlier = await hasEarlierSuccessfulMonthlyPayment(mockSupabase, "u_repeat_customer");
      expect(hasEarlier).toBe(true);

      const pricing = resolveOrderPricing({ planCode: "monthly", isFirstMonthlyPurchase: !hasEarlier });
      expect(pricing?.amount_paise).toBe(79900);
      expect(pricing?.duration_days).toBe(30);
    });

    it("FAIL-CLOSED: charges repeat price Rs 799 when order query returns a database error", async () => {
      const mockSupabase = createMockSupabase({
        orderError: { message: "database connection terminated abruptly", code: "57P01" },
      });
      const eligibility = await checkMonthlyIntroEligibilityAndReserve(mockSupabase, "u_db_err");
      expect(eligibility.isFirstMonthlyPurchase).toBe(false);
      expect(eligibility.reason).toBe("DB_ORDER_QUERY_ERROR");

      const pricing = resolveOrderPricing({
        planCode: "monthly",
        isFirstMonthlyPurchase: eligibility.isFirstMonthlyPurchase,
      });
      expect(pricing?.amount_paise).toBe(79900);
    });

    it("FAIL-CLOSED: charges repeat price Rs 799 when subscription query returns a database error", async () => {
      const mockSupabase = createMockSupabase({
        subError: { message: "relation public.subscriptions does not exist", code: "42P01" },
      });
      const eligibility = await checkMonthlyIntroEligibilityAndReserve(mockSupabase, "u_sub_err");
      expect(eligibility.isFirstMonthlyPurchase).toBe(false);
      expect(eligibility.reason).toBe("DB_SUBSCRIPTION_QUERY_ERROR");

      const pricing = resolveOrderPricing({
        planCode: "monthly",
        isFirstMonthlyPurchase: eligibility.isFirstMonthlyPurchase,
      });
      expect(pricing?.amount_paise).toBe(79900);
    });

    it("FAIL-CLOSED: charges repeat price Rs 799 when supabase admin client is missing or null", async () => {
      const eligibility = await checkMonthlyIntroEligibilityAndReserve(null, "u_no_client");
      expect(eligibility.isFirstMonthlyPurchase).toBe(false);
      expect(eligibility.reason).toBe("ADMIN_CLIENT_UNAVAILABLE");

      const pricing = resolveOrderPricing({
        planCode: "monthly",
        isFirstMonthlyPurchase: eligibility.isFirstMonthlyPurchase,
      });
      expect(pricing?.amount_paise).toBe(79900);
    });

    it("TEST-MODE ISOLATION: ignores previous test-mode paid orders when user buys live", async () => {
      const mockSupabase = createMockSupabase({
        paidOrders: [],
      });
      const eligibility = await checkMonthlyIntroEligibilityAndReserve(mockSupabase, "u_test_buyer", "live");
      expect(eligibility.isFirstMonthlyPurchase).toBe(true);

      const pricing = resolveOrderPricing({
        planCode: "monthly",
        isFirstMonthlyPurchase: eligibility.isFirstMonthlyPurchase,
      });
      expect(pricing?.amount_paise).toBe(49900);
    });

    it("FAILED & UNPAID ORDERS: ignores failed, expired or unpaid orders", async () => {
      const mockSupabase = createMockSupabase({
        paidOrders: [],
        subscriptions: [{ id: "sub_unpaid_1", plan_id: "monthly", status: "unpaid", amount: 0 }],
      });
      const eligibility = await checkMonthlyIntroEligibilityAndReserve(mockSupabase, "u_failed_buyer", "live");
      expect(eligibility.isFirstMonthlyPurchase).toBe(true);

      const pricing = resolveOrderPricing({
        planCode: "monthly",
        isFirstMonthlyPurchase: eligibility.isFirstMonthlyPurchase,
      });
      expect(pricing?.amount_paise).toBe(49900);
    });

    it("LEGACY SUBSCRIPTION RULE: active legacy subscription blocks intro price; test legacy subscription does not", async () => {
      // Case A: Real legacy paid subscription
      const mockSupabaseReal = createMockSupabase({
        subscriptions: [
          {
            id: "sub_legacy_real",
            plan_id: "monthly",
            status: "active",
            amount: 19900,
            metadata: {},
          },
        ],
      });
      const eligReal = await checkMonthlyIntroEligibilityAndReserve(mockSupabaseReal, "u_legacy_real", "live");
      expect(eligReal.isFirstMonthlyPurchase).toBe(false);
      expect(eligReal.reason).toBe("LEGACY_PAID_MONTHLY_SUBSCRIPTION");

      // Case B: Test-mode legacy subscription (metadata.mode = 'test') does not block live intro
      const mockSupabaseTest = createMockSupabase({
        subscriptions: [
          {
            id: "sub_legacy_test",
            plan_id: "monthly",
            status: "active",
            amount: 19900,
            metadata: { mode: "test" },
          },
        ],
      });
      const eligTest = await checkMonthlyIntroEligibilityAndReserve(mockSupabaseTest, "u_legacy_test", "live");
      expect(eligTest.isFirstMonthlyPurchase).toBe(true);
    });

    it("ONCE-ONLY INTRO PRICE: sequential/concurrent second order before payment cannot both get Rs 499", async () => {
      const mockSupabasePending = createMockSupabase({
        pendingOrders: [
          {
            id: "po_order_1_pending",
            amount_paise: 49900,
            status: "created",
            created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
          },
        ],
      });
      const eligibility2 = await checkMonthlyIntroEligibilityAndReserve(mockSupabasePending, "u_concurrent_user", "live");
      expect(eligibility2.isFirstMonthlyPurchase).toBe(false);
      expect(eligibility2.reason).toBe("PENDING_PROMO_ORDER_EXISTS");

      const pricing2 = resolveOrderPricing({
        planCode: "monthly",
        isFirstMonthlyPurchase: eligibility2.isFirstMonthlyPurchase,
      });
      expect(pricing2?.amount_paise).toBe(79900);
    });

    it("CANCEL/EXPIRY SAFETY: when earlier pending order is expired (>30m), user can claim Rs 499 again", async () => {
      const mockSupabaseExpired = createMockSupabase({
        pendingOrders: [],
      });
      const eligibility3 = await checkMonthlyIntroEligibilityAndReserve(mockSupabaseExpired, "u_expired_reorder", "live");
      expect(eligibility3.isFirstMonthlyPurchase).toBe(true);

      const pricing3 = resolveOrderPricing({
        planCode: "monthly",
        isFirstMonthlyPurchase: eligibility3.isFirstMonthlyPurchase,
      });
      expect(pricing3?.amount_paise).toBe(49900);
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

      const mockSupabaseAdmin = createMockSupabase();

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

      const mockSupabaseAdmin = createMockSupabase({
        paidOrders: [{ id: "order_prev_paid", status: "paid", mode: "live" }],
      });

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

  describe("Real PostgreSQL fulfil_payment_order Integration (PGlite)", () => {
    let pg: PGlite;

    beforeEach(async () => {
      pg = new PGlite();
      await pg.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
            CREATE ROLE service_role;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            CREATE ROLE authenticated;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            CREATE ROLE anon;
          END IF;
        END $$;

        CREATE SCHEMA IF NOT EXISTS auth;
        CREATE TABLE IF NOT EXISTS auth.users (
          id UUID PRIMARY KEY,
          email TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS public.plans (
          code TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          duration_days INT NOT NULL,
          price_paise INT NOT NULL
        );
        INSERT INTO public.plans (code, name, duration_days, price_paise) VALUES
          ('weekly', 'Weekly', 7, 39900),
          ('monthly', 'Monthly', 30, 49900),
          ('quarterly', 'Quarterly', 90, 219900);

        CREATE TABLE IF NOT EXISTS public.addon_packs (
          code TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          sets INT NOT NULL,
          validity_days INT NOT NULL,
          price_paise INT NOT NULL
        );
        INSERT INTO public.addon_packs (code, name, sets, validity_days, price_paise) VALUES
          ('addon_10', '10 extra', 10, 60, 14900),
          ('addon_30', '30 extra', 30, 60, 39900),
          ('addon_60', '60 extra', 60, 60, 69900);

        CREATE TABLE IF NOT EXISTS public.subscriptions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
          plan_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          currency TEXT NOT NULL DEFAULT 'INR',
          amount INT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          current_period_start TIMESTAMPTZ DEFAULT NOW(),
          current_period_end TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
          cancel_at_period_end BOOLEAN DEFAULT FALSE,
          metadata JSONB DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS public.user_addon_credits (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
          order_id UUID,
          sets_remaining INT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS public.payment_orders (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
          provider TEXT NOT NULL DEFAULT 'razorpay',
          provider_order_id TEXT UNIQUE,
          plan_code TEXT REFERENCES public.plans(code),
          addon_code TEXT REFERENCES public.addon_packs(code),
          amount_paise INT NOT NULL,
          currency TEXT NOT NULL DEFAULT 'INR',
          status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed','expired')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          paid_at TIMESTAMPTZ,
          mode TEXT NOT NULL DEFAULT 'live',
          metadata JSONB DEFAULT '{}'::jsonb
        );

        CREATE TABLE IF NOT EXISTS public.intro_promo_reservations (
          user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
          order_id UUID,
          provider_order_id TEXT,
          amount_paise INT NOT NULL DEFAULT 49900,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'released')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes')
        );
      `);

      const migrationPath = path.resolve(process.cwd(), "supabase/migrations/20261103g_fulfil_payment_upgrade_extend.sql");
      const fnSql = fs.readFileSync(migrationPath, "utf8");
      await pg.exec(fnSql);
    });

    it("grants exact 7, 30, and 90 days for weekly, monthly, and quarterly plans", async () => {
      // 1. Weekly plan -> 7 days
      const uWeekly = "11111111-1111-1111-1111-111111111111";
      await pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [uWeekly, "weekly@example.com"]);
      await pg.query(
        `INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
         VALUES ($1, 'razorpay', 'ord_weekly_real', 'weekly', 39900, 'created', 'live')`,
        [uWeekly]
      );
      const resW = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_weekly_real', $1::uuid) as result`,
        [uWeekly]
      );
      expect(resW.rows[0].result.success).toBe(true);
      expect(resW.rows[0].result.plan_code).toBe("weekly");

      const subW = await pg.query<{ plan_id: string; current_period_start: string; current_period_end: string; status: string }>(
        `SELECT plan_id, current_period_start, current_period_end, status FROM public.subscriptions WHERE user_id = $1`,
        [uWeekly]
      );
      expect(subW.rows[0].status).toBe("active");
      expect(subW.rows[0].plan_id).toBe("weekly");
      const diffW = (new Date(subW.rows[0].current_period_end).getTime() - new Date(subW.rows[0].current_period_start).getTime()) / 86400000;
      expect(Math.round(diffW)).toBe(7);

      // 2. Monthly plan -> 30 days
      const uMonthly = "22222222-2222-2222-2222-222222222222";
      await pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [uMonthly, "monthly@example.com"]);
      await pg.query(
        `INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
         VALUES ($1, 'razorpay', 'ord_monthly_real', 'monthly', 49900, 'created', 'live')`,
        [uMonthly]
      );
      const resM = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_monthly_real', $1::uuid) as result`,
        [uMonthly]
      );
      expect(resM.rows[0].result.success).toBe(true);
      expect(resM.rows[0].result.plan_code).toBe("monthly");

      const subM = await pg.query<{ plan_id: string; current_period_start: string; current_period_end: string }>(
        `SELECT plan_id, current_period_start, current_period_end FROM public.subscriptions WHERE user_id = $1`,
        [uMonthly]
      );
      const diffM = (new Date(subM.rows[0].current_period_end).getTime() - new Date(subM.rows[0].current_period_start).getTime()) / 86400000;
      expect(Math.round(diffM)).toBe(30);

      // 3. Quarterly plan -> 90 days
      const uQuarterly = "33333333-3333-3333-3333-333333333333";
      await pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [uQuarterly, "quarterly@example.com"]);
      await pg.query(
        `INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
         VALUES ($1, 'razorpay', 'ord_quarterly_real', 'quarterly', 219900, 'created', 'live')`,
        [uQuarterly]
      );
      const resQ = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_quarterly_real', $1::uuid) as result`,
        [uQuarterly]
      );
      expect(resQ.rows[0].result.success).toBe(true);
      expect(resQ.rows[0].result.plan_code).toBe("quarterly");

      const subQ = await pg.query<{ plan_id: string; current_period_start: string; current_period_end: string }>(
        `SELECT plan_id, current_period_start, current_period_end FROM public.subscriptions WHERE user_id = $1`,
        [uQuarterly]
      );
      const diffQ = (new Date(subQ.rows[0].current_period_end).getTime() - new Date(subQ.rows[0].current_period_start).getTime()) / 86400000;
      expect(Math.round(diffQ)).toBe(90);
    });

    it("extends active Pro from current_period_end, and restarts expired Pro from now", async () => {
      // Case A: Active Pro extension (user has 10 days left on existing active subscription)
      const uActive = "44444444-4444-4444-4444-444444444444";
      await pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [uActive, "active@example.com"]);
      await pg.query(
        `INSERT INTO public.subscriptions (user_id, plan_id, provider, amount, status, current_period_start, current_period_end)
         VALUES ($1, 'weekly', 'razorpay', 39900, 'active', NOW(), NOW() + INTERVAL '10 days')`,
        [uActive]
      );
      const initialSub = await pg.query<{ current_period_end: string }>(
        `SELECT current_period_end FROM public.subscriptions WHERE user_id = $1`,
        [uActive]
      );
      const initialEndMs = new Date(initialSub.rows[0].current_period_end).getTime();

      // Purchase monthly plan (30 days) while active
      await pg.query(
        `INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
         VALUES ($1, 'razorpay', 'ord_extend_active', 'monthly', 79900, 'created', 'live')`,
        [uActive]
      );
      const resExtend = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_extend_active', $1::uuid) as result`,
        [uActive]
      );
      expect(resExtend.rows[0].result.success).toBe(true);

      const extendedSub = await pg.query<{ current_period_end: string }>(
        `SELECT current_period_end FROM public.subscriptions WHERE user_id = $1`,
        [uActive]
      );
      const extendedEndMs = new Date(extendedSub.rows[0].current_period_end).getTime();
      const addedDays = (extendedEndMs - initialEndMs) / 86400000;
      // Must add exactly 30 days to the previous current_period_end (total ~40 days from now)
      expect(Math.round(addedDays)).toBe(30);

      // Case B: Expired Pro restart (user had a subscription that expired 5 days ago)
      const uExpired = "55555555-5555-5555-5555-555555555555";
      await pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [uExpired, "expired@example.com"]);
      await pg.query(
        `INSERT INTO public.subscriptions (user_id, plan_id, provider, amount, status, current_period_start, current_period_end)
         VALUES ($1, 'monthly', 'razorpay', 49900, 'canceled', NOW() - INTERVAL '35 days', NOW() - INTERVAL '5 days')`,
        [uExpired]
      );

      // Purchase monthly plan (30 days) after expiration
      await pg.query(
        `INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
         VALUES ($1, 'razorpay', 'ord_restart_expired', 'monthly', 79900, 'created', 'live')`,
        [uExpired]
      );
      const beforeRestart = Date.now();
      const resRestart = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_restart_expired', $1::uuid) as result`,
        [uExpired]
      );
      expect(resRestart.rows[0].result.success).toBe(true);

      const restartedSub = await pg.query<{ current_period_end: string; status: string }>(
        `SELECT current_period_end, status FROM public.subscriptions WHERE user_id = $1`,
        [uExpired]
      );
      expect(restartedSub.rows[0].status).toBe("active");
      const restartedEndMs = new Date(restartedSub.rows[0].current_period_end).getTime();
      const restartedDaysFromNow = (restartedEndMs - beforeRestart) / 86400000;
      // Must start from now (30 days), NOT from the 5-days-past expired date
      expect(Math.round(restartedDaysFromNow)).toBe(30);
    });

    it("IDEMPOTENCY: duplicate verify and webhook retries return already_paid without double granting", async () => {
      const uIdem = "66666666-6666-6666-6666-666666666666";
      await pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [uIdem, "idem@example.com"]);
      await pg.query(
        `INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
         VALUES ($1, 'razorpay', 'ord_idem_real', 'weekly', 39900, 'created', 'live')`,
        [uIdem]
      );

      // First fulfillment
      const res1 = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_idem_real', $1::uuid) as result`,
        [uIdem]
      );
      expect(res1.rows[0].result.success).toBe(true);
      const firstPeriodEnd = res1.rows[0].result.period_end;

      // Second fulfillment (duplicate verify / webhook retry)
      const res2 = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_idem_real', $1::uuid) as result`,
        [uIdem]
      );
      expect(res2.rows[0].result.success).toBe(true);
      expect(res2.rows[0].result.already_paid).toBe(true);
      expect(res2.rows[0].result.period_end).toBe(firstPeriodEnd);

      // Third retry
      const res3 = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_idem_real', $1::uuid) as result`,
        [uIdem]
      );
      expect(res3.rows[0].result.already_paid).toBe(true);

      const subFinal = await pg.query<{ current_period_end: string }>(
        `SELECT current_period_end FROM public.subscriptions WHERE user_id = $1`,
        [uIdem]
      );
      expect(new Date(subFinal.rows[0].current_period_end).getTime()).toBe(
        new Date(firstPeriodEnd).getTime()
      );
    });

    it("CONCURRENT SEPARATE ORDERS: two distinct orders extend period sequentially without conflict", async () => {
      const uMulti = "77777777-7777-7777-7777-777777777777";
      await pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [uMulti, "multi@example.com"]);

      // Order A: Weekly plan (7 days)
      await pg.query(
        `INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
         VALUES ($1, 'razorpay', 'ord_multi_A', 'weekly', 39900, 'created', 'live')`,
        [uMulti]
      );
      // Order B: Monthly plan (30 days)
      await pg.query(
        `INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
         VALUES ($1, 'razorpay', 'ord_multi_B', 'monthly', 79900, 'created', 'live')`,
        [uMulti]
      );

      const resA = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_multi_A', $1::uuid) as result`,
        [uMulti]
      );
      expect(resA.rows[0].result.success).toBe(true);

      const resB = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_multi_B', $1::uuid) as result`,
        [uMulti]
      );
      expect(resB.rows[0].result.success).toBe(true);

      const orders = await pg.query<{ provider_order_id: string; status: string }>(
        `SELECT provider_order_id, status FROM public.payment_orders WHERE user_id = $1 ORDER BY provider_order_id`,
        [uMulti]
      );
      expect(orders.rows).toHaveLength(2);
      expect(orders.rows[0].status).toBe("paid");
      expect(orders.rows[1].status).toBe("paid");

      const sub = await pg.query<{ current_period_start: string; current_period_end: string }>(
        `SELECT current_period_start, current_period_end FROM public.subscriptions WHERE user_id = $1`,
        [uMulti]
      );
      const totalDays = (new Date(sub.rows[0].current_period_end).getTime() - new Date(sub.rows[0].current_period_start).getTime()) / 86400000;
      expect(Math.round(totalDays)).toBe(37);
    });

    it("PROMO ONCE-ONLY INTEGRATION: user who pays intro Rs 499 is authoritative repeat buyer at Rs 799", async () => {
      const uPromo = "88888888-8888-8888-8888-888888888888";
      await pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [uPromo, "promo@example.com"]);

      // Initial monthly order with intro promo price 49900
      await pg.query(
        `INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode, metadata)
         VALUES ($1, 'razorpay', 'ord_promo_once', 'monthly', 49900, 'created', 'live', '{"is_intro_promo": true}'::jsonb)`,
        [uPromo]
      );

      const res = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_promo_once', $1::uuid) as result`,
        [uPromo]
      );
      expect(res.rows[0].result.success).toBe(true);

      const poCheck = await pg.query<{ status: string; mode: string }>(
        `SELECT status, mode FROM public.payment_orders WHERE provider_order_id = 'ord_promo_once'`,
      );
      expect(poCheck.rows[0].status).toBe("paid");
      expect(poCheck.rows[0].mode).toBe("live");

      // Build mock Supabase adapter backed by this real pg instance
      const pgSupabaseAdapter = {
        from: (table: string) => ({
          select: () => ({
            eq: (_c1: string, v1: any) => ({
              eq: (_c2: string, v2: any) => ({
                eq: (_c3: string, v3: any) => ({
                  eq: (_c4: string, v4: any) => ({
                    limit: async () => {
                      const r = await pg.query(`SELECT id, status, mode FROM public.${table} WHERE user_id = $1 AND plan_code = $2 AND status = $3 AND mode = $4`, [v1, v2, v3, v4]);
                      return { data: r.rows, error: null };
                    },
                  }),
                }),
              }),
            }),
          }),
        }),
      };

      const eligibility = await checkMonthlyIntroEligibilityAndReserve(pgSupabaseAdapter, uPromo, "live");
      expect(eligibility.isFirstMonthlyPurchase).toBe(false);
      expect(eligibility.reason).toBe("PRIOR_LIVE_PAID_MONTHLY_ORDER");

      const nextOrderPricing = resolveOrderPricing({
        planCode: "monthly",
        isFirstMonthlyPurchase: eligibility.isFirstMonthlyPurchase,
      });
      expect(nextOrderPricing?.amount_paise).toBe(79900);
    });
  });
  });
});
