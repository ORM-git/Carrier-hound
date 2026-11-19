import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST as nextSubscriptionPOST, DELETE as nextSubscriptionDELETE } from "@/app/api/billing/razorpay/subscription/route";
import { createHandler as createNetlifySubscriptionHandler } from "../../../netlify/functions/billing-razorpay-subscription";
import { openRazorpaySubscription as openGatewaySubscription } from "@/lib/billing/razorpay";
import { openRazorpaySubscription as openCheckoutSubscription } from "@/lib/billing/checkout";

const mockUser = {
  id: "user_autorenew_test_123",
  email: "candidate@careermonke.com",
  user_metadata: { full_name: "Autorenew Candidate" },
};

function createMockSupabase(initialSub?: any) {
  let sub = initialSub ? { ...initialSub } : null;
  const orders: any[] = [];

  const mockClient = {
    auth: {
      getUser: async (token: string) => {
        if (token === "valid-token") {
          return { data: { user: mockUser }, error: null };
        }
        return { data: { user: null }, error: new Error("Invalid token") };
      },
      getSession: async () => {
        return { data: { session: { access_token: "valid-token", user: mockUser } }, error: null };
      },
    },
    from: (table: string) => {
      let filterUserId: string | null = null;
      let filterStatus: string | null = null;
      let filterPlanCode: string | null = null;

      const chain: any = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: (col: string, val: any) => {
          if (col === "user_id") filterUserId = val;
          if (col === "status") filterStatus = val;
          if (col === "plan_code") filterPlanCode = val;
          return chain;
        },
        maybeSingle: async () => {
          if (table === "subscriptions") {
            return { data: sub ? { ...sub } : null, error: null };
          }
          if (table === "payment_orders") {
            const match = orders.find((o) => {
              if (filterUserId && o.user_id !== filterUserId) return false;
              if (filterStatus && o.status !== filterStatus) return false;
              if (filterPlanCode && o.plan_code !== filterPlanCode) return false;
              return true;
            });
            return { data: match || null, error: null };
          }
          return { data: null, error: null };
        },
        insert: async (row: any) => {
          if (table === "payment_orders") {
            orders.push({ ...row, id: `po_${Date.now()}` });
          } else if (table === "subscriptions") {
            sub = { ...row, id: `sub_db_${Date.now()}` };
          }
          return { error: null };
        },
        update: (updates: any) => ({
          eq: async (_col: string, _val: any) => {
            if (table === "subscriptions" && sub) {
              sub = { ...sub, ...updates };
            }
            return { error: null };
          },
        }),
      };
      return chain;
    },
    _getSub: () => sub,
    _getOrders: () => orders,
  };

  return mockClient;
}

describe("Auto-Renew Subscription Route & Handlers (Flat Rs 499)", () => {
  const originalEnv = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.RAZORPAY_MODE = "test";
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_fixture_key_123456";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_fixture_secret_abcdef";
    process.env.RAZORPAY_AUTORENEW_PLAN_MONTHLY = "plan_monthly_rzp_499";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("Feature flag gating", () => {
    it("returns 503 AUTORENEW_DISABLED when NEXT_PUBLIC_AUTORENEW_ENABLED !== 'true'", async () => {
      process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "false";
      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
        body: JSON.stringify({ planCode: "monthly" }),
      });
      const res = await nextSubscriptionPOST(req);
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.code).toBe("AUTORENEW_DISABLED");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns 503 BILLING_DISABLED when NEXT_PUBLIC_BILLING_ENABLED !== 'true'", async () => {
      process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";
      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
        body: JSON.stringify({ planCode: "monthly" }),
      });
      const res = await nextSubscriptionPOST(req);
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.code).toBe("BILLING_DISABLED");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("client gateway and checkout orchestrator fail closed without network when flag is off", async () => {
      process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "false";
      const gatewayError = vi.fn();
      await openGatewaySubscription({ planCode: "monthly", authToken: "tok", onError: gatewayError });
      expect(gatewayError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("Auto-renew subscriptions are currently disabled") })
      );

      const checkoutError = vi.fn();
      const onStart = vi.fn();
      await openCheckoutSubscription({ planCode: "monthly", onError: checkoutError, onStart });
      expect(checkoutError).toHaveBeenCalledWith(expect.stringContaining("Auto-renew subscriptions are currently disabled"));
      expect(onStart).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("Authentication and Ban checking", () => {
    it("returns 401 when Authorization header is missing", async () => {
      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planCode: "monthly" }),
      });
      const res = await nextSubscriptionPOST(req);
      expect(res.status).toBe(401);
    });

    it("returns 401 when token is invalid", async () => {
      const mockDb = createMockSupabase();
      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer invalid-token" },
        body: JSON.stringify({ planCode: "monthly" }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb,
      };
      const res = await nextSubscriptionPOST(req);
      expect(res.status).toBe(401);
    });

    it("returns 403 USER_BLOCKED when user is suspended", async () => {
      const mockDb = createMockSupabase();
      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
        body: JSON.stringify({ planCode: "monthly" }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb,
        verifyUserNotBanned: async () => ({ isBlocked: true }),
      };
      const res = await nextSubscriptionPOST(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe("USER_BLOCKED");
    });
  });

  describe("Plan validation & Server configuration", () => {
    it("rejects non-monthly plans (weekly, quarterly) with 400 UNSUPPORTED_PLAN", async () => {
      const mockDb = createMockSupabase();
      for (const invalidPlan of ["weekly", "quarterly", "annual"]) {
        const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
          body: JSON.stringify({ planCode: invalidPlan }),
        });
        (req as any).__testDeps = {
          getSupabaseAdmin: () => mockDb,
          verifyUserNotBanned: async () => ({ isBlocked: false }),
        };
        const res = await nextSubscriptionPOST(req);
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.code).toBe("UNSUPPORTED_PLAN");
      }
    });

    it("returns 503 PLAN_NOT_CONFIGURED when RAZORPAY_AUTORENEW_PLAN_MONTHLY is missing", async () => {
      delete process.env.RAZORPAY_AUTORENEW_PLAN_MONTHLY;
      const mockDb = createMockSupabase();
      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
        body: JSON.stringify({ planCode: "monthly" }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb,
        verifyUserNotBanned: async () => ({ isBlocked: false }),
      };
      const res = await nextSubscriptionPOST(req);
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.code).toBe("PLAN_NOT_CONFIGURED");
    });
  });

  describe("Subscription creation (Next.js & Netlify)", () => {
    it("successfully creates flat Rs 499 Razorpay subscription via Next.js route", async () => {
      let rzpPayload: any = null;
      fetchSpy.mockImplementation(async (url: any, init: any) => {
        rzpPayload = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            id: "sub_rzp_monthly_499",
            entity: "subscription",
            plan_id: rzpPayload.plan_id,
            status: "created",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });

      const mockDb = createMockSupabase();
      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
        body: JSON.stringify({ planCode: "monthly" }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb,
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: fetchSpy,
      };

      const res = await nextSubscriptionPOST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.subscriptionId).toBe("sub_rzp_monthly_499");
      expect(json.planCode).toBe("monthly");
      expect(rzpPayload.plan_id).toBe("plan_monthly_rzp_499");
      expect(rzpPayload.total_count).toBe(12);

      const orders = mockDb._getOrders();
      expect(orders.length).toBe(1);
      expect(orders[0].provider_order_id).toBe("sub_rzp_monthly_499");
      expect(orders[0].amount_paise).toBe(49900);
      expect(orders[0].plan_code).toBe("monthly");
    });

    it("creates flat Rs 499 subscription identically on Netlify function handler", async () => {
      fetchSpy.mockImplementation(async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            id: "sub_netlify_monthly_499",
            entity: "subscription",
            plan_id: body.plan_id,
            status: "created",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });

      const mockDb = createMockSupabase();
      const handler = createNetlifySubscriptionHandler({
        getSupabaseAdmin: () => mockDb,
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: fetchSpy,
      });

      const res = await handler({
        httpMethod: "POST",
        headers: { authorization: "Bearer valid-token" },
        body: JSON.stringify({ planCode: "monthly" }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.subscriptionId).toBe("sub_netlify_monthly_499");
      expect(body.planCode).toBe("monthly");
    });
  });

  describe("Subscription cancellation at cycle end", () => {
    it("cancels active subscription at cycle end via Next.js POST action:'cancel'", async () => {
      let rzpCancelBody: any = null;
      fetchSpy.mockImplementation(async (url: any, init: any) => {
        rzpCancelBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ id: "sub_rzp_active_123", status: "cancelled" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });

      const mockDb = createMockSupabase({
        user_id: mockUser.id,
        subscription_id: "sub_rzp_active_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: new Date(Date.now() + 15 * 86400 * 1000).toISOString(),
      });

      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
        body: JSON.stringify({ action: "cancel" }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb,
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: fetchSpy,
      };

      const res = await nextSubscriptionPOST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.cancelAtPeriodEnd).toBe(true);
      expect(rzpCancelBody.cancel_at_cycle_end).toBe(1);
      expect(mockDb._getSub().cancel_at_period_end).toBe(true);
    });

    it("cancels active subscription via Next.js DELETE method", async () => {
      fetchSpy.mockImplementation(async () => {
        return new Response(
          JSON.stringify({ id: "sub_rzp_active_123", status: "cancelled" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });

      const mockDb = createMockSupabase({
        user_id: mockUser.id,
        subscription_id: "sub_rzp_active_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: new Date(Date.now() + 15 * 86400 * 1000).toISOString(),
      });

      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb,
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: fetchSpy,
      };

      const res = await nextSubscriptionDELETE(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.cancelAtPeriodEnd).toBe(true);
      expect(mockDb._getSub().cancel_at_period_end).toBe(true);
    });

    it("cancels subscription identically via Netlify function", async () => {
      fetchSpy.mockImplementation(async () => {
        return new Response(
          JSON.stringify({ id: "sub_rzp_active_123", status: "cancelled" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });

      const mockDb = createMockSupabase({
        user_id: mockUser.id,
        subscription_id: "sub_rzp_active_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: new Date(Date.now() + 15 * 86400 * 1000).toISOString(),
      });

      const handler = createNetlifySubscriptionHandler({
        getSupabaseAdmin: () => mockDb,
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: fetchSpy,
      });

      const res = await handler({
        httpMethod: "DELETE",
        headers: { authorization: "Bearer valid-token" },
        body: JSON.stringify({}),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.cancelAtPeriodEnd).toBe(true);
    });

    it("Netlify function rejects unsupported HTTP methods with 405", async () => {
      const handler = createNetlifySubscriptionHandler();
      const res = await handler({ httpMethod: "GET", headers: {} });
      expect(res.statusCode).toBe(405);
    });
  });
});
