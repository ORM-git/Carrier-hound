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
          insert: vi.fn(() => ({
            select: () => ({
              single: async () => ({ data: { id: "po_row_new", user_id: "u_test_auth" }, error: null }),
            }),
          })),
          update: vi.fn(() => builder),
          then: (resolve: any) => Promise.resolve({ data: null, error: null }).then(resolve),
          catch: (reject: any) => Promise.resolve({ data: null, error: null }).catch(reject),
          limit: vi.fn(async () => {
            if (table === "payment_orders") {
              if (overrides?.orderError) return { data: null, error: overrides.orderError };
              return { data: overrides?.paidOrders || [], error: null };
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

      // Monthly: Rs 499 for everyone, 30 days
      expect(PLAN_PRICING.monthly.price_paise).toBe(49900);
      expect(PLAN_PRICING.monthly.duration_days).toBe(30);
      expect(getPlanPricePaise("monthly")).toBe(49900);
      expect(getPlanPriceINR("monthly")).toBe(499);

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

    it("resolveOrderPricing resolves exact prepaid pricing for all plans", () => {
      const weekly = resolveOrderPricing({ planCode: "weekly" });
      expect(weekly?.amount_paise).toBe(39900);
      expect(weekly?.duration_days).toBe(7);

      const monthly = resolveOrderPricing({ planCode: "monthly" });
      expect(monthly?.amount_paise).toBe(49900);
      expect(monthly?.duration_days).toBe(30);

      const quarterly = resolveOrderPricing({ planCode: "quarterly" });
      expect(quarterly?.amount_paise).toBe(219900);
      expect(quarterly?.duration_days).toBe(90);
    });
  });

  describe("Order Route Server-Side Amount Enforcement (Tampered Amount Immunity)", () => {
    it("ignores client-supplied tampered amount (e.g. 100 paise) and bills Rs 499 for monthly", async () => {
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
            data: { user: { id: "u_verify_tamper_rzp", user_metadata: {} } },
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
  });

  describe("Real PostgreSQL fulfil_payment_order Integration (PGlite - Full Migration Chain)", () => {
    let pg: PGlite;

    beforeEach(async () => {
      pg = new PGlite();

      // Bootstrap base roles and tables before migrations
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
          price_paise INT NOT NULL,
          is_active BOOLEAN DEFAULT TRUE
        );
        INSERT INTO public.plans (code, name, duration_days, price_paise, is_active) VALUES
          ('weekly', 'Weekly', 7, 69200, true),
          ('monthly', 'Monthly', 30, 149900, true),
          ('quarterly', 'Quarterly', 90, 399900, true);

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
          subscription_id TEXT,
          plan_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          currency TEXT NOT NULL DEFAULT 'INR',
          amount INT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          current_period_start TIMESTAMPTZ DEFAULT NOW(),
          current_period_end TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
          cancel_at_period_end BOOLEAN DEFAULT FALSE,
          grace_period_end TIMESTAMPTZ,
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
          metadata JSONB DEFAULT '{}'::jsonb
        );

        CREATE TABLE IF NOT EXISTS public.blocked_users (
          user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
          email TEXT NOT NULL,
          reason TEXT,
          blocked_by TEXT,
          blocked_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS public.webhook_events (
          event_id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          event_type TEXT,
          processed_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // Load FULL current migration chain:
      // 1. 20261104b_payment_order_mode_isolation.sql (payment-mode)
      // 2. 20261114a_payment_plan_stack_guard.sql
      // 3. 20261115a_autorenew.sql
      // 4. 20261117a_update_plan_prices_399_499_2199.sql
      const migrations = [
        "20261104b_payment_order_mode_isolation.sql",
        "20261114a_payment_plan_stack_guard.sql",
        "20261115a_autorenew.sql",
        "20261117a_update_plan_prices_399_499_2199.sql",
      ];

      for (const m of migrations) {
        const sqlPath = path.resolve(process.cwd(), "supabase/migrations", m);
        const sql = fs.readFileSync(sqlPath, "utf8");
        await pg.exec(sql);
      }
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
        `SELECT public.fulfil_payment_order('ord_weekly_real', $1::uuid, 'live') as result`,
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
        `SELECT public.fulfil_payment_order('ord_monthly_real', $1::uuid, 'live') as result`,
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
        `SELECT public.fulfil_payment_order('ord_quarterly_real', $1::uuid, 'live') as result`,
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
      const uExtend = "44444444-4444-4444-4444-444444444444";
      await pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [uExtend, "extend@example.com"]);

      // Case A: User has active Pro ending 10 days in future
      const existingFutureEnd = new Date(Date.now() + 10 * 86400000);
      await pg.query(
        `INSERT INTO public.subscriptions (user_id, plan_id, provider, currency, amount, status, current_period_start, current_period_end)
         VALUES ($1, 'monthly', 'razorpay', 'INR', 49900, 'active', NOW(), $2)`,
        [uExtend, existingFutureEnd.toISOString()]
      );

      // User buys 30-day monthly plan -> period end should be existingFutureEnd + 30 days
      await pg.query(
        `INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
         VALUES ($1, 'razorpay', 'ord_extend_active', 'monthly', 49900, 'created', 'live')`,
        [uExtend]
      );

      const resExtend = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_extend_active', $1::uuid, 'live') as result`,
        [uExtend]
      );
      expect(resExtend.rows[0].result.success).toBe(true);

      const subActive = await pg.query<{ current_period_end: string }>(
        `SELECT current_period_end FROM public.subscriptions WHERE user_id = $1`,
        [uExtend]
      );
      const actualEndMs = new Date(subActive.rows[0].current_period_end).getTime();
      const expectedEndMs = existingFutureEnd.getTime() + 30 * 86400000;
      // Allow +/- 5 seconds tolerance for execution
      expect(Math.abs(actualEndMs - expectedEndMs)).toBeLessThan(5000);

      // Case B: User has expired Pro ending 10 days in the PAST
      const uExpired = "55555555-5555-5555-5555-555555555555";
      await pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [uExpired, "expired@example.com"]);
      const pastEnd = new Date(Date.now() - 10 * 86400000);
      await pg.query(
        `INSERT INTO public.subscriptions (user_id, plan_id, provider, currency, amount, status, current_period_start, current_period_end)
         VALUES ($1, 'monthly', 'razorpay', 'INR', 49900, 'canceled', $2, $2)`,
        [uExpired, pastEnd.toISOString()]
      );

      // User buys 30-day monthly plan -> period end should be NOW + 30 days, NOT pastEnd + 30 days
      await pg.query(
        `INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
         VALUES ($1, 'razorpay', 'ord_restart_expired', 'monthly', 49900, 'created', 'live')`,
        [uExpired]
      );

      const resRestart = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_restart_expired', $1::uuid, 'live') as result`,
        [uExpired]
      );
      expect(resRestart.rows[0].result.success).toBe(true);

      const subRestarted = await pg.query<{ current_period_end: string }>(
        `SELECT current_period_end FROM public.subscriptions WHERE user_id = $1`,
        [uExpired]
      );
      const expectedRestartEndMs = Date.now() + 30 * 86400000;
      expect(Math.abs(new Date(subRestarted.rows[0].current_period_end).getTime() - expectedRestartEndMs)).toBeLessThan(5000);
    });

    it("IDEMPOTENCY: duplicate verify and webhook retries return already_paid without double granting", async () => {
      const uIdem = "66666666-6666-6666-6666-666666666666";
      await pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [uIdem, "idem@example.com"]);
      await pg.query(
        `INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
         VALUES ($1, 'razorpay', 'ord_idem_real', 'monthly', 49900, 'created', 'live')`,
        [uIdem]
      );

      // First call: succeeds and grants 30 days
      const res1 = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_idem_real', $1::uuid, 'live') as result`,
        [uIdem]
      );
      expect(res1.rows[0].result.success).toBe(true);
      const firstPeriodEnd = res1.rows[0].result.period_end;

      // Second call (e.g. webhook delivery after client verify): returns already_paid: true
      const res2 = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_idem_real', $1::uuid, 'live') as result`,
        [uIdem]
      );
      expect(res2.rows[0].result.success).toBe(true);
      expect(res2.rows[0].result.already_paid).toBe(true);

      // Third call (retry): also returns already_paid: true
      const res3 = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_idem_real', $1::uuid, 'live') as result`,
        [uIdem]
      );
      expect(res3.rows[0].result.success).toBe(true);
      expect(res3.rows[0].result.already_paid).toBe(true);

      // Verify that subscription period_end did NOT increment further
      const subFinal = await pg.query<{ current_period_end: string }>(
        `SELECT current_period_end FROM public.subscriptions WHERE user_id = $1`,
        [uIdem]
      );
      expect(new Date(subFinal.rows[0].current_period_end).getTime()).toBe(new Date(firstPeriodEnd).getTime());
    });

    it("CONCURRENT SEPARATE ORDERS: two distinct orders extend period sequentially without conflict", async () => {
      const uStack = "77777777-7777-7777-7777-777777777777";
      await pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [uStack, "stack@example.com"]);

      // Order 1: Weekly (7 days)
      await pg.query(
        `INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
         VALUES ($1, 'razorpay', 'ord_stack_1', 'weekly', 39900, 'created', 'live')`,
        [uStack]
      );
      // Order 2: Monthly (30 days)
      await pg.query(
        `INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
         VALUES ($1, 'razorpay', 'ord_stack_2', 'monthly', 49900, 'created', 'live')`,
        [uStack]
      );

      // Fulfill Order 1
      const res1 = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_stack_1', $1::uuid, 'live') as result`,
        [uStack]
      );
      expect(res1.rows[0].result.success).toBe(true);

      // Fulfill Order 2
      const res2 = await pg.query<{ result: any }>(
        `SELECT public.fulfil_payment_order('ord_stack_2', $1::uuid, 'live') as result`,
        [uStack]
      );
      expect(res2.rows[0].result.success).toBe(true);

      // Final period end must be approx NOW + 37 days (7 + 30)
      const subStacked = await pg.query<{ current_period_end: string }>(
        `SELECT current_period_end FROM public.subscriptions WHERE user_id = $1`,
        [uStack]
      );
      const expectedStackedEndMs = Date.now() + 37 * 86400000;
      expect(Math.abs(new Date(subStacked.rows[0].current_period_end).getTime() - expectedStackedEndMs)).toBeLessThan(5000);
    });
  });
});
