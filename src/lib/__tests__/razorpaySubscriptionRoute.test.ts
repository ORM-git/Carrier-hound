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

const validConsent = {
  agreed: true,
  version: "2026-11-autorenew-v1",
  timestamp: new Date().toISOString(),
};

const validPlanResponse = {
  id: "plan_monthly_rzp_499",
  entity: "plan",
  interval: 1,
  period: "monthly",
  item: {
    id: "item_monthly_499",
    amount: 49900,
    currency: "INR",
  },
};

function createMockSupabase(
  initialSub?: any,
  // raceOrder: the row another server instance inserted first; it appears when this insert gets 23505
  opts: { orders?: any[]; insertConflict?: boolean; failOrderUpdate?: boolean; raceOrder?: any } = {}
) {
  let sub = initialSub ? { ...initialSub } : null;
  const orders: any[] = (opts.orders || []).map((o) => ({ ...o }));

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
          if (table === "payment_orders" && opts.insertConflict) {
            if (opts.raceOrder) orders.push({ ...opts.raceOrder });
            return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
          if (table === "payment_orders") {
            orders.push({ ...row, id: `po_${Date.now()}` });
          } else if (table === "subscriptions") {
            sub = { ...row, id: `sub_db_${Date.now()}` };
          }
          return { error: null };
        },
        update: (updates: any) => {
          const filters: Record<string, any> = {};
          const q: any = {
            eq: (col: string, val: any) => {
              filters[col] = val;
              return q;
            },
            then: (resolve: any, reject: any) => {
              if (table === "payment_orders" && opts.failOrderUpdate) {
                return Promise.resolve({ error: { message: "write failed" } }).then(resolve, reject);
              }
              if (table === "subscriptions" && sub) {
                sub = { ...sub, ...updates };
              }
              if (table === "payment_orders") {
                orders.forEach((o, i) => {
                  if (Object.entries(filters).every(([k, v]) => o[k] === v)) orders[i] = { ...o, ...updates };
                });
              }
              return Promise.resolve({ error: null }).then(resolve, reject);
            },
          };
          return q;
        },
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
        body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
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
        body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
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
      await openGatewaySubscription({ planCode: "monthly", consent: validConsent, authToken: "tok", onError: gatewayError });
      expect(gatewayError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("Auto-renew subscriptions are currently disabled") })
      );

      const checkoutError = vi.fn();
      const onStart = vi.fn();
      await openCheckoutSubscription({ planCode: "monthly", consent: validConsent, onError: checkoutError, onStart });
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
        body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
      });
      const res = await nextSubscriptionPOST(req);
      expect(res.status).toBe(401);
    });

    it("returns 401 when token is invalid", async () => {
      const mockDb = createMockSupabase();
      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer invalid-token" },
        body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
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
        body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
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

  describe("Consent validation (Blocker 2)", () => {
    it("rejects request without consent with 400 CONSENT_REQUIRED", async () => {
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
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe("CONSENT_REQUIRED");
    });

    it("rejects request with consent.agreed = false with 400 CONSENT_REQUIRED", async () => {
      const mockDb = createMockSupabase();
      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
        body: JSON.stringify({
          planCode: "monthly",
          consent: { agreed: false, version: "2026-11-autorenew-v1", timestamp: new Date().toISOString() },
        }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb,
        verifyUserNotBanned: async () => ({ isBlocked: false }),
      };
      const res = await nextSubscriptionPOST(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe("CONSENT_REQUIRED");
    });

    it("rejects request with invalid consent timestamp with 400 INVALID_CONSENT_TIMESTAMP", async () => {
      const mockDb = createMockSupabase();
      const futureTimestamp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
        body: JSON.stringify({
          planCode: "monthly",
          consent: { agreed: true, version: "2026-11-autorenew-v1", timestamp: futureTimestamp },
        }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb,
        verifyUserNotBanned: async () => ({ isBlocked: false }),
      };
      const res = await nextSubscriptionPOST(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe("INVALID_CONSENT_TIMESTAMP");
    });
  });

  describe("Plan validation & Server configuration (Blocker 4)", () => {
    it("rejects plans outside weekly/monthly/quarterly with 400 UNSUPPORTED_PLAN", async () => {
      const mockDb = createMockSupabase();
      for (const invalidPlan of ["annual", "lifetime", "addon_30"]) {
        const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
          body: JSON.stringify({ planCode: invalidPlan, consent: validConsent }),
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
        body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
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

    it("returns 502 PLAN_FETCH_FAILED when Razorpay plan API returns non-2xx", async () => {
      fetchSpy.mockImplementation(async (url: any) => {
        if (String(url).includes("/plans/")) {
          return new Response(JSON.stringify({ error: { description: "Plan not found" } }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 500 });
      });

      const mockDb = createMockSupabase();
      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
        body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb,
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: fetchSpy,
      };
      const res = await nextSubscriptionPOST(req);
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.code).toBe("PLAN_FETCH_FAILED");
    });

    it("returns 502 INVALID_PLAN_AMOUNT when plan amount is not 49900", async () => {
      fetchSpy.mockImplementation(async (url: any) => {
        if (String(url).includes("/plans/")) {
          return new Response(
            JSON.stringify({
              id: "plan_monthly_rzp_499",
              entity: "plan",
              interval: 1,
              period: "monthly",
              item: { amount: 39900, currency: "INR" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("{}", { status: 500 });
      });

      const mockDb = createMockSupabase();
      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
        body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb,
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: fetchSpy,
      };
      const res = await nextSubscriptionPOST(req);
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.code).toBe("INVALID_PLAN_AMOUNT");
    });
  });

  describe("Subscription creation with durable consent (Next.js & Netlify)", () => {
    it("successfully creates flat Rs 499 Razorpay subscription and stores consent durably", async () => {
      let rzpPayload: any = null;
      fetchSpy.mockImplementation(async (url: any, init: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/plans/")) {
          return new Response(JSON.stringify(validPlanResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
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
        body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
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
      expect(orders[0].metadata?.consent?.agreed).toBe(true);
      expect(orders[0].metadata?.consent?.version).toBe("2026-11-autorenew-v1");
    });

    it("creates flat Rs 499 subscription identically on Netlify function handler", async () => {
      fetchSpy.mockImplementation(async (url: any, init: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/plans/")) {
          return new Response(JSON.stringify(validPlanResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
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
        body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.subscriptionId).toBe("sub_netlify_monthly_499");
      expect(body.planCode).toBe("monthly");
    });

    describe.each([
      { planCode: "weekly", envVar: "RAZORPAY_AUTORENEW_PLAN_WEEKLY", planId: "plan_weekly_rzp_399", period: "weekly", interval: 1, amount: 39900, totalCount: 52 },
      { planCode: "quarterly", envVar: "RAZORPAY_AUTORENEW_PLAN_QUARTERLY", planId: "plan_quarterly_rzp_2199", period: "monthly", interval: 3, amount: 219900, totalCount: 4 },
    ])("$planCode auto-renew", ({ planCode, envVar, planId, period, interval, amount, totalCount }) => {
      const planResponse = { id: planId, entity: "plan", period, interval, item: { amount, currency: "INR" } };

      const mockGateway = () => {
        const calls: { url: string; body: any }[] = [];
        fetchSpy.mockImplementation(async (url: any, init: any) => {
          const urlStr = String(url);
          calls.push({ url: urlStr, body: init?.body ? JSON.parse(init.body) : null });
          if (urlStr.includes("/plans/")) {
            return new Response(JSON.stringify(planResponse), { status: 200 });
          }
          return new Response(JSON.stringify({ id: `sub_rzp_${planCode}`, status: "created" }), { status: 200 });
        });
        return calls;
      };

      beforeEach(() => {
        process.env[envVar] = planId;
      });

      it("Next.js route creates the subscription with its own plan id, amount and ~1 year cap", async () => {
        const calls = mockGateway();
        const mockDb = createMockSupabase();
        const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
          body: JSON.stringify({ planCode, consent: validConsent }),
        });
        (req as any).__testDeps = {
          getSupabaseAdmin: () => mockDb,
          verifyUserNotBanned: async () => ({ isBlocked: false }),
          fetchFn: fetchSpy,
        };

        const res = await nextSubscriptionPOST(req);
        expect(res.status).toBe(200);
        expect((await res.json()).planCode).toBe(planCode);
        expect(calls[0].url).toContain(`/plans/${planId}`);
        const createCall = calls.find((c) => c.url.endsWith("/v1/subscriptions"));
        expect(createCall?.body.plan_id).toBe(planId);
        expect(createCall?.body.total_count).toBe(totalCount);
        expect(createCall?.body.notes.plan_code).toBe(planCode);
        const [order] = mockDb._getOrders();
        expect(order.plan_code).toBe(planCode);
        expect(order.amount_paise).toBe(amount);
      });

      it("Netlify handler creates the same subscription", async () => {
        const calls = mockGateway();
        const handler = createNetlifySubscriptionHandler({
          getSupabaseAdmin: () => createMockSupabase(),
          verifyUserNotBanned: async () => ({ isBlocked: false }),
          fetchFn: fetchSpy,
        });
        const res = await handler({
          httpMethod: "POST",
          headers: { authorization: "Bearer valid-token" },
          body: JSON.stringify({ planCode, consent: validConsent }),
        });
        expect(res.statusCode).toBe(200);
        const createCall = calls.find((c) => c.url.endsWith("/v1/subscriptions"));
        expect(createCall?.body.plan_id).toBe(planId);
        expect(createCall?.body.total_count).toBe(totalCount);
      });

      it(`returns 503 PLAN_NOT_CONFIGURED when ${envVar} is missing`, async () => {
        delete process.env[envVar];
        const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
          body: JSON.stringify({ planCode, consent: validConsent }),
        });
        (req as any).__testDeps = {
          getSupabaseAdmin: () => createMockSupabase(),
          verifyUserNotBanned: async () => ({ isBlocked: false }),
          fetchFn: fetchSpy,
        };
        const res = await nextSubscriptionPOST(req);
        expect(res.status).toBe(503);
        expect((await res.json()).code).toBe("PLAN_NOT_CONFIGURED");
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it("refuses a Razorpay plan whose amount does not match this plan's price", async () => {
        fetchSpy.mockImplementation(async () =>
          new Response(JSON.stringify({ ...planResponse, item: { amount: 49900, currency: "INR" } }), { status: 200 })
        );
        const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
          body: JSON.stringify({ planCode, consent: validConsent }),
        });
        (req as any).__testDeps = {
          getSupabaseAdmin: () => createMockSupabase(),
          verifyUserNotBanned: async () => ({ isBlocked: false }),
          fetchFn: fetchSpy,
        };
        const res = await nextSubscriptionPOST(req);
        expect(res.status).toBe(502);
        expect((await res.json()).code).toBe("INVALID_PLAN_AMOUNT");
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });
    });

    it("Netlify handler rejects request without consent before calling Razorpay", async () => {
      const handler = createNetlifySubscriptionHandler({
        getSupabaseAdmin: () => createMockSupabase(),
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: fetchSpy,
      });
      const res = await handler({
        httpMethod: "POST",
        headers: { authorization: "Bearer valid-token" },
        body: JSON.stringify({ planCode: "monthly" }),
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("CONSENT_REQUIRED");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("One pending mandate per user across plans (Next.js & Netlify)", () => {
    const plans: Record<string, any> = {
      plan_w: { period: "weekly", interval: 1, item: { amount: 39900, currency: "INR" } },
      plan_m: { period: "monthly", interval: 1, item: { amount: 49900, currency: "INR" } },
      plan_q: { period: "monthly", interval: 3, item: { amount: 219900, currency: "INR" } },
    };
    let created: any[] = [];
    let cancelled: string[] = [];

    beforeEach(() => {
      process.env.RAZORPAY_AUTORENEW_PLAN_WEEKLY = "plan_w";
      process.env.RAZORPAY_AUTORENEW_PLAN_MONTHLY = "plan_m";
      process.env.RAZORPAY_AUTORENEW_PLAN_QUARTERLY = "plan_q";
      created = [];
      cancelled = [];
      fetchSpy.mockImplementation(async (url: any, init: any) => {
        const u = String(url);
        const plan = u.match(/\/plans\/(\w+)$/)?.[1];
        if (plan) return new Response(JSON.stringify(plans[plan]), { status: 200 });
        const cancel = u.match(/\/subscriptions\/(\w+)\/cancel$/)?.[1];
        if (cancel) {
          cancelled.push(cancel);
          return new Response(JSON.stringify({ id: cancel, status: "cancelled" }), { status: 200 });
        }
        const body = JSON.parse(init.body);
        created.push(body);
        return new Response(JSON.stringify({ id: `sub_new_${created.length}`, status: "created" }), { status: 200 });
      });
    });

    const pending = (planCode: string, extra: any = {}) => ({
      id: `po_${planCode}`,
      user_id: mockUser.id,
      provider: "razorpay",
      provider_order_id: `sub_pending_${planCode}`,
      plan_code: planCode,
      status: "created",
      mode: "test",
      created_at: new Date().toISOString(),
      metadata: { expire_by: Math.floor(Date.now() / 1000) + 20 * 60 },
      ...extra,
    });

    const routes = {
      "Next.js": async (mockDb: any, planCode: string) => {
        const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
          body: JSON.stringify({ planCode, consent: validConsent }),
        });
        (req as any).__testDeps = { getSupabaseAdmin: () => mockDb, verifyUserNotBanned: async () => ({ isBlocked: false }), fetchFn: fetchSpy };
        const res = await nextSubscriptionPOST(req);
        return { status: res.status, body: await res.json() };
      },
      Netlify: async (mockDb: any, planCode: string) => {
        const handler = createNetlifySubscriptionHandler({
          getSupabaseAdmin: () => mockDb,
          verifyUserNotBanned: async () => ({ isBlocked: false }),
          fetchFn: fetchSpy,
        });
        const res = await handler({
          httpMethod: "POST",
          headers: { authorization: "Bearer valid-token" },
          body: JSON.stringify({ planCode, consent: validConsent }),
        });
        return { status: res.statusCode, body: JSON.parse(res.body) };
      },
    };

    for (const [platform, call] of Object.entries(routes)) {
      for (const [first, second] of [["weekly", "quarterly"], ["quarterly", "weekly"]]) {
        it(`${platform}: ${first} then ${second} refuses the second with 409 and creates one mandate`, async () => {
          const mockDb = createMockSupabase();
          const a = await call(mockDb, first);
          const b = await call(mockDb, second);
          expect(a.status).toBe(200);
          expect(b.status).toBe(409);
          expect(b.body.code).toBe("PENDING_SUBSCRIPTION_OTHER_PLAN");
          expect(b.body.subscriptionId).toBeUndefined();
          expect(created).toHaveLength(1);
          expect(mockDb._getOrders().map((o: any) => o.plan_code)).toEqual([first]);
        });
      }

      it(`${platform}: same-plan retry reuses the pending mandate`, async () => {
        const mockDb = createMockSupabase();
        const a = await call(mockDb, "quarterly");
        const b = await call(mockDb, "quarterly");
        expect(b.status).toBe(200);
        expect(b.body).toMatchObject({ reused: true, subscriptionId: a.body.subscriptionId, planCode: "quarterly" });
        expect(created).toHaveLength(1);
      });

      it(`${platform}: new mandates carry expire_by; a pending one past it is expired so another plan can start`, async () => {
        const stale = pending("weekly", { metadata: { expire_by: Math.floor(Date.now() / 1000) - 5 * 60 } });
        const mockDb = createMockSupabase(null, { orders: [stale] });
        const res = await call(mockDb, "quarterly");
        expect(res.status).toBe(200);
        expect(mockDb._getOrders()[0].status).toBe("expired");
        const expireBy = created[0].expire_by;
        expect(expireBy).toBeGreaterThan(Date.now() / 1000 + 25 * 60);
        expect(expireBy).toBeLessThanOrEqual(Date.now() / 1000 + 30 * 60);
        expect(mockDb._getOrders()[1].metadata.expire_by).toBe(expireBy);
      });

      it(`${platform}: a stale #670 mandate without expire_by is cancelled at Razorpay before it is expired`, async () => {
        const legacy = pending("monthly", { metadata: {}, created_at: new Date(Date.now() - 40 * 60 * 1000).toISOString() });
        const mockDb = createMockSupabase(null, { orders: [legacy] });
        const res = await call(mockDb, "weekly");
        expect(res.status).toBe(200);
        expect(cancelled).toEqual(["sub_pending_monthly"]);
        expect(mockDb._getOrders()[0].status).toBe("expired");
      });

      it(`${platform}: 23505 race with another plan's mandate returns 409, never that mandate, and cancels the orphan`, async () => {
        const mockDb = createMockSupabase(null, { insertConflict: true, raceOrder: pending("weekly") });
        const res = await call(mockDb, "quarterly");
        expect(res.status).toBe(409);
        expect(res.body.code).toBe("PENDING_SUBSCRIPTION_EXISTS");
        expect(res.body.subscriptionId).toBeUndefined();
        expect(cancelled).toEqual(["sub_new_1"]);
      });

      it(`${platform}: 23505 race with a same-plan mandate in the other key mode is not reused`, async () => {
        const mockDb = createMockSupabase(null, { insertConflict: true, raceOrder: pending("quarterly", { mode: "live" }) });
        const res = await call(mockDb, "quarterly");
        expect(res.status).toBe(409);
        expect(res.body.subscriptionId).toBeUndefined();
      });

      it(`${platform}: a bound mandate in grace (still retrying charges) blocks a new plan`, async () => {
        const mockDb = createMockSupabase({
          user_id: mockUser.id,
          subscription_id: "sub_bound_grace",
          status: "in_grace_period",
          current_period_end: new Date(Date.now() - 86400 * 1000).toISOString(),
        });
        const res = await call(mockDb, "weekly");
        expect(res.status).toBe(409);
        expect(res.body.code).toBe("ACTIVE_SUBSCRIPTION_EXISTS");
        expect(created).toHaveLength(0);
      });
    }
  });

  describe("Consent persisted on reused pending orders", () => {
    const legacyOrder = (minutesAgo: number, metadata: any = { source: "legacy" }) => ({
      user_id: mockUser.id,
      provider: "razorpay",
      provider_order_id: "sub_legacy_pending_1",
      plan_code: "monthly",
      status: "created",
      mode: "test",
      created_at: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
      metadata,
    });

    const mockGateway = () =>
      fetchSpy.mockImplementation(async (url: any) =>
        String(url).includes("/plans/")
          ? new Response(JSON.stringify(validPlanResponse), { status: 200 })
          : new Response(JSON.stringify({ id: "sub_fresh_new", status: "created" }), { status: 200 })
      );

    const callNext = async (mockDb: any) => {
      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
        body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => mockDb,
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: fetchSpy,
      };
      const res = await nextSubscriptionPOST(req);
      return { status: res.status, body: await res.json() };
    };

    const callNetlify = async (mockDb: any) => {
      const handler = createNetlifySubscriptionHandler({
        getSupabaseAdmin: () => mockDb,
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: fetchSpy,
      });
      const res = await handler({
        httpMethod: "POST",
        headers: { authorization: "Bearer valid-token" },
        body: JSON.stringify({ planCode: "monthly", consent: validConsent }),
      });
      return { status: res.statusCode, body: JSON.parse(res.body) };
    };

    for (const [platform, call] of [["Next.js", callNext], ["Netlify", callNetlify]] as const) {
      it(`${platform}: recent legacy pending order without consent gets this request's consent merged before reuse`, async () => {
        mockGateway();
        const mockDb = createMockSupabase(null, { orders: [legacyOrder(2)] });
        const { status, body } = await call(mockDb);
        expect(status).toBe(200);
        expect(body.reused).toBe(true);
        expect(body.subscriptionId).toBe("sub_legacy_pending_1");
        const saved = mockDb._getOrders()[0].metadata;
        expect(saved.source).toBe("legacy");
        expect(saved.consent).toMatchObject({ agreed: true, version: validConsent.version });
      });

      it(`${platform}: uniqueness-race reuse writes consent onto the existing pending order`, async () => {
        mockGateway();
        // Invisible to the pre-check; another instance inserts it first, so only the race path can return it
        const mockDb = createMockSupabase(null, { insertConflict: true, raceOrder: legacyOrder(0) });
        const { status, body } = await call(mockDb);
        expect(status).toBe(200);
        expect(body.reused).toBe(true);
        expect(body.subscriptionId).toBe("sub_legacy_pending_1");
        const saved = mockDb._getOrders()[0].metadata;
        expect(saved.source).toBe("legacy");
        expect(saved.consent).toMatchObject({ agreed: true, version: validConsent.version });
      });

      it(`${platform}: fails closed when consent cannot be written on reuse (recent and race paths)`, async () => {
        mockGateway();
        const recent = await call(createMockSupabase(null, { orders: [legacyOrder(2)], failOrderUpdate: true }));
        expect(recent.status).toBe(500);
        expect(recent.body.code).toBe("CONSENT_RECORD_FAILED");
        const race = await call(
          createMockSupabase(null, { insertConflict: true, raceOrder: legacyOrder(0), failOrderUpdate: true })
        );
        expect(race.status).toBe(500);
        expect(race.body.code).toBe("CONSENT_RECORD_FAILED");
      });

      it(`${platform}: existing consent on a reused order is kept, not overwritten`, async () => {
        mockGateway();
        const original = { agreed: true, version: "2026-10-original", timestamp: "2026-11-19T00:00:00.000Z" };
        const mockDb = createMockSupabase(null, { orders: [legacyOrder(2, { consent: original })] });
        const { status } = await call(mockDb);
        expect(status).toBe(200);
        expect(mockDb._getOrders()[0].metadata.consent).toEqual(original);
      });
    }
  });

  describe("Fail-closed subscription cancellation (Blocker 1)", () => {
    it("fails closed with 502 on non-2xx from Razorpay cancel API without updating DB (Next.js)", async () => {
      fetchSpy.mockImplementation(async () => {
        return new Response(
          JSON.stringify({ error: { description: "Subscription is in invalid state" } }),
          { status: 400, headers: { "Content-Type": "application/json" } }
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
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.code).toBe("RAZORPAY_CANCEL_FAILED");
      expect(mockDb._getSub().cancel_at_period_end).toBe(false); // Retriable
    });

    it("fails closed with 504 on gateway timeout without updating DB (Next.js)", async () => {
      fetchSpy.mockImplementation(async () => {
        const err = new Error("AbortError");
        err.name = "AbortError";
        throw err;
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
      expect(res.status).toBe(504);
      const json = await res.json();
      expect(json.code).toBe("GATEWAY_TIMEOUT");
      expect(mockDb._getSub().cancel_at_period_end).toBe(false); // Retriable
    });

    it("fails closed with 503 on missing credentials without updating DB (Next.js)", async () => {
      delete process.env.RAZORPAY_KEY_SECRET;

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
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.code).toBe("RAZORPAY_CONFIG_ERROR");
      expect(mockDb._getSub().cancel_at_period_end).toBe(false); // Retriable
    });

    it("fails closed on non-2xx on Netlify function handler (Netlify)", async () => {
      fetchSpy.mockImplementation(async () => {
        return new Response(
          JSON.stringify({ error: { description: "Subscription is cancelled" } }),
          { status: 400, headers: { "Content-Type": "application/json" } }
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

      expect(res.statusCode).toBe(502);
      expect(mockDb._getSub().cancel_at_period_end).toBe(false);
    });

    it("fails closed on timeout on Netlify function handler (Netlify)", async () => {
      fetchSpy.mockImplementation(async () => {
        const err = new Error("AbortError");
        err.name = "AbortError";
        throw err;
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

      expect(res.statusCode).toBe(504);
      expect(mockDb._getSub().cancel_at_period_end).toBe(false);
    });

    it("fails closed on missing credentials on Netlify function handler (Netlify)", async () => {
      delete process.env.RAZORPAY_KEY_SECRET;

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

      expect(res.statusCode).toBe(503);
      expect(mockDb._getSub().cancel_at_period_end).toBe(false);
    });

    it("cancels active subscription at cycle end only after Razorpay 200 confirmation (Next.js & Netlify)", async () => {
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
  });
});
