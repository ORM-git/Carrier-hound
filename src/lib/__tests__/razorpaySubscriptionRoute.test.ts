import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST, DELETE } from "@/app/api/billing/razorpay/subscription/route";
import { openRazorpaySubscription as openGatewaySubscription } from "@/lib/billing/razorpay";
import { openRazorpaySubscription as openCheckoutSubscription } from "@/lib/billing/checkout";

describe("Razorpay Subscription Route (/api/billing/razorpay/subscription)", () => {
  const originalEnv = { ...process.env };

  const mockUser = {
    id: "user_test_uuid_123",
    email: "test@careermonke.com",
    user_metadata: { full_name: "Test User" },
  };

  let mockDbSubscriptions: Map<string, any>;
  let mockDbPaymentOrders: Map<string, any>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";
    process.env.RAZORPAY_MODE = "test";
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_fixture_key_123456";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_fixture_secret_abcdef";
    process.env.RAZORPAY_AUTORENEW_PLAN_WEEKLY = "plan_weekly_rzp_123";
    process.env.RAZORPAY_AUTORENEW_PLAN_MONTHLY = "plan_monthly_rzp_456";
    process.env.RAZORPAY_AUTORENEW_PLAN_QUARTERLY = "plan_quarterly_rzp_789";

    mockDbSubscriptions = new Map();
    mockDbPaymentOrders = new Map();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  function createMockSupabaseAdmin(options?: {
    getUserError?: any;
    dbError?: any;
    insertError?: any;
    updateError?: any;
  }) {
    return {
      auth: {
        getUser: async (token: string) => {
          if (options?.getUserError) {
            return { data: { user: null }, error: options.getUserError };
          }
          if (token === "valid_token") {
            return { data: { user: mockUser }, error: null };
          }
          return { data: { user: null }, error: new Error("Invalid token") };
        },
      },
      from: (table: string) => {
        let filters: Record<string, any> = {};
        let neqFilters: Record<string, any> = {};
        let likeFilters: Record<string, string> = {};
        let gteFilters: Record<string, any> = {};

        const query: any = {
          select: () => query,
          order: () => query,
          limit: () => query,
          eq: (col: string, val: any) => {
            filters[col] = val;
            return query;
          },
          neq: (col: string, val: any) => {
            neqFilters[col] = val;
            return query;
          },
          like: (col: string, pattern: string) => {
            likeFilters[col] = pattern;
            return query;
          },
          gte: (col: string, val: any) => {
            gteFilters[col] = val;
            return query;
          },
          maybeSingle: async () => {
            if (options?.dbError) return { data: null, error: options.dbError };
            if (table === "payment_orders") {
              const orders = Array.from(mockDbPaymentOrders.values());
              const match = orders.find((o) => {
                for (const [k, v] of Object.entries(filters)) {
                  if (o[k] !== v) return false;
                }
                for (const [k, v] of Object.entries(neqFilters)) {
                  if (o[k] === v) return false;
                }
                for (const [k, pat] of Object.entries(likeFilters)) {
                  const val = String(o[k] || "");
                  const prefix = pat.replace("%", "");
                  if (!val.startsWith(prefix)) return false;
                }
                for (const [k, v] of Object.entries(gteFilters)) {
                  if (o[k] < v) return false;
                }
                return true;
              });
              return { data: match || null, error: null };
            }
            if (table === "subscriptions") {
              const filterUserId = filters.user_id;
              const found = filterUserId ? mockDbSubscriptions.get(filterUserId) : null;
              return { data: found || null, error: null };
            }
            return { data: null, error: null };
          },
          update: (updates: any) => {
            const updateQuery = {
              eq: async (col: string, val: any) => {
                if (options?.updateError || options?.dbError) {
                  return { error: options.updateError || options.dbError };
                }
                if (table === "payment_orders") {
                  const existing = mockDbPaymentOrders.get(val);
                  if (existing) {
                    const updated = { ...existing, ...updates };
                    mockDbPaymentOrders.delete(val);
                    mockDbPaymentOrders.set(updates.provider_order_id || val, updated);
                  }
                } else if (table === "subscriptions") {
                  if (col === "user_id") {
                    const existing = mockDbSubscriptions.get(val) || {};
                    mockDbSubscriptions.set(val, { ...existing, ...updates });
                  }
                }
                return { error: null };
              },
            };
            return updateQuery;
          },
          insert: async (row: any) => {
            if (options?.insertError || options?.dbError) return { error: options.insertError || options.dbError };
            if (table === "payment_orders") {
              mockDbPaymentOrders.set(row.provider_order_id, { ...row });
            } else {
              mockDbSubscriptions.set(row.user_id, { ...row });
            }
            return { error: null };
          },
        };
        return query;
      },
    };
  }

  function createMockRazorpayFetch(overrides?: {
    planData?: any;
    planStatus?: number;
    subData?: any;
    subStatus?: number;
    cancelStatus?: number;
  }) {
    return vi.fn().mockImplementation(async (url: string, init: any) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/plans/")) {
        if (overrides?.planStatus && overrides.planStatus !== 200) {
          return new Response(JSON.stringify({ error: "Plan not found" }), {
            status: overrides.planStatus,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (overrides?.planData) {
          return new Response(JSON.stringify(overrides.planData), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        let amount = 149900;
        let period = "monthly";
        let interval = 1;
        if (urlStr.includes("weekly")) {
          amount = 69200;
          period = "weekly";
          interval = 1;
        } else if (urlStr.includes("quarterly")) {
          amount = 399900;
          period = "monthly";
          interval = 3;
        }
        return new Response(
          JSON.stringify({
            id: urlStr.split("/").pop(),
            item: { amount, currency: "INR" },
            period,
            interval,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (urlStr.includes("/v1/subscriptions") && urlStr.includes("/cancel")) {
        return new Response(
          JSON.stringify({
            id: urlStr.split("/").slice(-2)[0],
            status: "cancelled",
          }),
          { status: overrides?.cancelStatus || 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (urlStr.includes("/v1/subscriptions")) {
        if (overrides?.subStatus && overrides.subStatus !== 200) {
          return new Response(
            JSON.stringify({ error: { description: "Subscription creation failed" } }),
            { status: overrides.subStatus, headers: { "Content-Type": "application/json" } }
          );
        }
        const body = init?.body ? JSON.parse(init.body) : {};
        const planId = body.plan_id || "plan_123";
        let subId = "sub_rzp_monthly_654321";
        if (planId.includes("weekly")) subId = "sub_rzp_weekly_123456";
        else if (planId.includes("quarterly")) subId = "sub_rzp_quarterly_987654";

        const subResponse = overrides?.subData || {
          id: subId,
          plan_id: planId,
          status: "created",
          current_start: Math.floor(Date.now() / 1000),
          current_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        };
        return new Response(JSON.stringify(subResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    });
  }

  function createMockRequest(body: any, headers?: Record<string, string>, deps?: any) {
    const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_token",
        ...(headers || {}),
      },
      body: JSON.stringify(body),
    });
    (req as any).__testDeps = deps || {
      getSupabaseAdmin: () => createMockSupabaseAdmin(),
      verifyUserNotBanned: async () => ({ isBlocked: false }),
      fetchFn: createMockRazorpayFetch(),
    };
    return req;
  }

  it("refuses with 503 when NEXT_PUBLIC_AUTORENEW_ENABLED is off or unset", async () => {
    delete process.env.NEXT_PUBLIC_AUTORENEW_ENABLED;
    const req = createMockRequest({ planCode: "monthly" });
    const res = await POST(req);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.code).toBe("AUTORENEW_DISABLED");
  });

  it("refuses with 503 when NEXT_PUBLIC_BILLING_ENABLED is off", async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";
    const req = createMockRequest({ planCode: "monthly" });
    const res = await POST(req);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.code).toBe("BILLING_DISABLED");
  });

  it("refuses with 401 when Authorization header is missing", async () => {
    const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planCode: "monthly" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("refuses with 401 when session token is invalid", async () => {
    const req = createMockRequest(
      { planCode: "monthly" },
      { Authorization: "Bearer invalid_token" },
      {
        getSupabaseAdmin: () =>
          createMockSupabaseAdmin({ getUserError: new Error("Invalid session") }),
      }
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("refuses with 503 when RAZORPAY_MODE is invalid", async () => {
    process.env.RAZORPAY_MODE = "invalid_mode";
    const req = createMockRequest({ planCode: "monthly" });
    const res = await POST(req);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.code).toBe("RAZORPAY_CONFIG_ERROR");
  });

  it("refuses with 503 when key prefix does not match configured mode", async () => {
    process.env.RAZORPAY_MODE = "live";
    const req = createMockRequest({ planCode: "monthly" });
    const res = await POST(req);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.code).toBe("RAZORPAY_CONFIG_ERROR");
  });

  it("refuses test keys on production host with 503", async () => {
    const req = createMockRequest(
      { planCode: "monthly" },
      { Host: "careermonke.com" },
      {
        getSupabaseAdmin: () => createMockSupabaseAdmin(),
        isProductionHost: true,
      }
    );
    const res = await POST(req);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.code).toBe("RAZORPAY_CONFIG_ERROR");
  });

  it("refuses invalid planCode with 400", async () => {
    const req = createMockRequest({ planCode: "yearly" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects blocked user with 403 USER_BLOCKED", async () => {
    const req = createMockRequest(
      { planCode: "monthly" },
      {},
      {
        getSupabaseAdmin: () => createMockSupabaseAdmin(),
        verifyUserNotBanned: async () => ({ isBlocked: true, error: "Account suspended." }),
      }
    );
    const res = await POST(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe("USER_BLOCKED");
  });

  it("fails closed with 503 when ban check service is unavailable", async () => {
    const req = createMockRequest(
      { planCode: "monthly" },
      {},
      {
        getSupabaseAdmin: () => createMockSupabaseAdmin(),
        verifyUserNotBanned: async () => ({ isBlocked: true, isServiceUnavailable: true, error: "Unavailable" }),
      }
    );
    const res = await POST(req);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.code).toBe("USER_BLOCKED");
  });

  // =========================================================================
  // ITEM 1: PROVIDER PLAN VERIFICATION
  // =========================================================================
  describe("Provider Plan Verification (Item 1)", () => {
    it("fails closed with 502 PLAN_VERIFICATION_MISMATCH when plan amount does not match catalog", async () => {
      const mockFetch = createMockRazorpayFetch({
        planData: {
          id: "plan_monthly_rzp_456",
          item: { amount: 99900, currency: "INR" }, // Mismatched amount
          period: "monthly",
          interval: 1,
        },
      });

      const req = createMockRequest(
        { planCode: "monthly" },
        {},
        {
          getSupabaseAdmin: () => createMockSupabaseAdmin(),
          verifyUserNotBanned: async () => ({ isBlocked: false }),
          fetchFn: mockFetch,
          isProductionHost: false,
        }
      );

      const res = await POST(req);
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.code).toBe("PLAN_VERIFICATION_MISMATCH");
    });

    it("fails closed with 502 PLAN_VERIFICATION_MISMATCH when currency is not INR", async () => {
      const mockFetch = createMockRazorpayFetch({
        planData: {
          id: "plan_monthly_rzp_456",
          item: { amount: 149900, currency: "USD" }, // Mismatched currency
          period: "monthly",
          interval: 1,
        },
      });

      const req = createMockRequest(
        { planCode: "monthly" },
        {},
        {
          getSupabaseAdmin: () => createMockSupabaseAdmin(),
          verifyUserNotBanned: async () => ({ isBlocked: false }),
          fetchFn: mockFetch,
          isProductionHost: false,
        }
      );

      const res = await POST(req);
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.code).toBe("PLAN_VERIFICATION_MISMATCH");
    });

    it("fails closed with 502 PLAN_VERIFICATION_MISMATCH when period/interval mismatch", async () => {
      const mockFetch = createMockRazorpayFetch({
        planData: {
          id: "plan_weekly_rzp_123",
          item: { amount: 69200, currency: "INR" },
          period: "yearly", // Mismatched period
          interval: 1,
        },
      });

      const req = createMockRequest(
        { planCode: "weekly" },
        {},
        {
          getSupabaseAdmin: () => createMockSupabaseAdmin(),
          verifyUserNotBanned: async () => ({ isBlocked: false }),
          fetchFn: mockFetch,
          isProductionHost: false,
        }
      );

      const res = await POST(req);
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.code).toBe("PLAN_VERIFICATION_MISMATCH");
    });

    it("fails closed with 502 PLAN_VERIFICATION_FAILED when plan endpoint returns non-200", async () => {
      const mockFetch = createMockRazorpayFetch({ planStatus: 404 });

      const req = createMockRequest(
        { planCode: "monthly" },
        {},
        {
          getSupabaseAdmin: () => createMockSupabaseAdmin(),
          verifyUserNotBanned: async () => ({ isBlocked: false }),
          fetchFn: mockFetch,
          isProductionHost: false,
        }
      );

      const res = await POST(req);
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.code).toBe("PLAN_VERIFICATION_FAILED");
    });
  });

  // =========================================================================
  // ITEM 2: DURABLE MANDATE CREATION & RESERVATION
  // =========================================================================
  describe("Durable Mandate Creation (Item 2)", () => {
    it("reserves pending row in DB before calling Razorpay and updates with real ID", async () => {
      const mockFetch = createMockRazorpayFetch();
      const req = createMockRequest(
        { planCode: "monthly" },
        {},
        {
          getSupabaseAdmin: () => createMockSupabaseAdmin(),
          verifyUserNotBanned: async () => ({ isBlocked: false }),
          fetchFn: mockFetch,
          isProductionHost: false,
        }
      );

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.subscriptionId).toBe("sub_rzp_monthly_654321");

      const order = mockDbPaymentOrders.get("sub_rzp_monthly_654321");
      expect(order).toBeDefined();
      expect(order.status).toBe("created");
      expect(order.plan_code).toBe("monthly");
      expect(order.amount_paise).toBe(149900);
    });

    it("marks reserved row as failed when Razorpay subscription call fails", async () => {
      const mockFetch = createMockRazorpayFetch({ subStatus: 500 });
      const req = createMockRequest(
        { planCode: "monthly" },
        {},
        {
          getSupabaseAdmin: () => createMockSupabaseAdmin(),
          verifyUserNotBanned: async () => ({ isBlocked: false }),
          fetchFn: mockFetch,
          isProductionHost: false,
        }
      );

      const res = await POST(req);
      expect(res.status).toBe(500);

      const reservationOrder = mockDbPaymentOrders.get(`sub_pending_${mockUser.id}`);
      expect(reservationOrder).toBeDefined();
      expect(reservationOrder.status).toBe("failed");
    });

    it("handles unique collision by inspecting existing plan and rejects differing plan", async () => {
      // Simulate existing collision for weekly plan
      mockDbPaymentOrders.set(`sub_pending_${mockUser.id}`, {
        id: "order_existing_res",
        user_id: mockUser.id,
        provider: "razorpay",
        provider_order_id: `sub_pending_${mockUser.id}`,
        plan_code: "weekly",
        status: "created",
      });

      const mockFetch = createMockRazorpayFetch();
      const req = createMockRequest(
        { planCode: "monthly" }, // Requesting monthly while weekly is pending
        {},
        {
          getSupabaseAdmin: () =>
            createMockSupabaseAdmin({
              insertError: { code: "23505", message: "duplicate key value violates unique constraint" },
            }),
          verifyUserNotBanned: async () => ({ isBlocked: false }),
          fetchFn: mockFetch,
          isProductionHost: false,
        }
      );

      const res = await POST(req);
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe("PENDING_SUBSCRIPTION_EXISTS");
      expect(json.error).toContain("weekly");
    });
  });

  // =========================================================================
  // ITEM 3: AUTHORITATIVE PENDING REUSE
  // =========================================================================
  describe("Authoritative Pending Reuse (Item 3)", () => {
    it("reuses existing pending payment_orders row for the same user and plan without calling Razorpay", async () => {
      mockDbPaymentOrders.set("sub_rzp_existing_pending_1", {
        id: "order_123",
        user_id: mockUser.id,
        provider: "razorpay",
        provider_order_id: "sub_rzp_existing_pending_1",
        plan_code: "monthly",
        amount_paise: 149900,
        status: "created",
        mode: "test",
        created_at: new Date().toISOString(),
      });

      const mockFetch = vi.fn();
      const req = createMockRequest(
        { planCode: "monthly" },
        {},
        {
          getSupabaseAdmin: () => createMockSupabaseAdmin(),
          verifyUserNotBanned: async () => ({ isBlocked: false }),
          fetchFn: mockFetch,
          isProductionHost: false,
        }
      );

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.subscriptionId).toBe("sub_rzp_existing_pending_1");
      expect(json.reused).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("blocks with 409 PENDING_SUBSCRIPTION_EXISTS when user has pending order for a different plan", async () => {
      mockDbPaymentOrders.set("sub_rzp_pending_weekly", {
        id: "order_weekly_1",
        user_id: mockUser.id,
        provider: "razorpay",
        provider_order_id: "sub_rzp_pending_weekly",
        plan_code: "weekly",
        amount_paise: 69200,
        status: "created",
        mode: "test",
        created_at: new Date().toISOString(),
      });

      const mockFetch = vi.fn();
      const req = createMockRequest(
        { planCode: "monthly" },
        {},
        {
          getSupabaseAdmin: () => createMockSupabaseAdmin(),
          verifyUserNotBanned: async () => ({ isBlocked: false }),
          fetchFn: mockFetch,
          isProductionHost: false,
        }
      );

      const res = await POST(req);
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe("PENDING_SUBSCRIPTION_EXISTS");
      expect(json.error).toContain("weekly");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("fails closed with 503 before Razorpay call when pending query errors", async () => {
      const mockFetch = vi.fn();
      const req = createMockRequest(
        { planCode: "monthly" },
        {},
        {
          getSupabaseAdmin: () =>
            createMockSupabaseAdmin({ dbError: new Error("Database network failure") }),
          verifyUserNotBanned: async () => ({ isBlocked: false }),
          fetchFn: mockFetch,
          isProductionHost: false,
        }
      );

      const res = await POST(req);
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.code).toBe("SERVICE_UNAVAILABLE");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // ITEM 4: CUSTOMER CANCELLATION
  // =========================================================================
  describe("Customer Cancellation (Item 4)", () => {
    it("refuses cancellation with 401 when Authorization header is missing", async () => {
      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      const res = await DELETE(req);
      expect(res.status).toBe(401);
    });

    it("refuses cancellation with 400 when user has no active subscription", async () => {
      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid_token",
        },
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => createMockSupabaseAdmin(),
      };

      const res = await DELETE(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.code).toBe("NO_ACTIVE_SUBSCRIPTION");
    });

    it("successfully cancels auto-renewal at period end via Razorpay API and updates DB", async () => {
      mockDbSubscriptions.set(mockUser.id, {
        id: "active_sub_to_cancel",
        user_id: mockUser.id,
        provider: "razorpay",
        subscription_id: "sub_rzp_cancel_test_123",
        status: "active",
        current_period_end: new Date(Date.now() + 15 * 86400000).toISOString(),
        cancel_at_period_end: false,
      });

      let rzpCancelCalled = false;
      let rzpCancelBody: any = null;
      const mockFetch = vi.fn().mockImplementation(async (url: string, init: any) => {
        if (url.includes("/cancel")) {
          rzpCancelCalled = true;
          rzpCancelBody = JSON.parse(init.body);
          return new Response(
            JSON.stringify({ id: "sub_rzp_cancel_test_123", status: "active" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid_token",
        },
      });
      (req as any).__testDeps = {
        getSupabaseAdmin: () => createMockSupabaseAdmin(),
        fetchFn: mockFetch,
      };

      const res = await DELETE(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.cancelAtPeriodEnd).toBe(true);

      // Verify Razorpay cancel endpoint called with cancel_at_cycle_end: 1
      expect(rzpCancelCalled).toBe(true);
      expect(rzpCancelBody.cancel_at_cycle_end).toBe(1);

      // Verify DB updated with cancel_at_period_end: true
      const sub = mockDbSubscriptions.get(mockUser.id);
      expect(sub.cancel_at_period_end).toBe(true);
      expect(sub.metadata.canceled_by).toBe("customer");
    });
  });

  // =========================================================================
  // EXISTING LIFECYCLE TESTS
  // =========================================================================
  it("creates weekly subscription with total_count=52 (1 year) and stores subscription_id", async () => {
    let capturedBody: any = null;
    const mockFetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/plans/")) {
        return new Response(
          JSON.stringify({
            id: "plan_weekly_rzp_123",
            item: { amount: 69200, currency: "INR" },
            period: "weekly",
            interval: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          id: "sub_rzp_weekly_123456",
          plan_id: capturedBody.plan_id,
          status: "created",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const req = createMockRequest(
      { planCode: "weekly" },
      {},
      {
        getSupabaseAdmin: () => createMockSupabaseAdmin(),
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: mockFetch,
        isProductionHost: false,
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.subscriptionId).toBe("sub_rzp_weekly_123456");
    expect(json.planId).toBe("plan_weekly_rzp_123");
    expect(json.planCode).toBe("weekly");
    expect(capturedBody.total_count).toBe(52);
    expect(capturedBody.customer_notify).toBe(true);

    const pendingOrder = mockDbPaymentOrders.get("sub_rzp_weekly_123456");
    expect(pendingOrder).toBeDefined();
    expect(pendingOrder.provider_order_id).toBe("sub_rzp_weekly_123456");
    expect(pendingOrder.plan_code).toBe("weekly");
    expect(pendingOrder.amount_paise).toBe(69200);
    expect(pendingOrder.status).toBe("created");
  });

  it("creates monthly subscription with total_count=12 (1 year) and stores pending order separately", async () => {
    let capturedBody: any = null;
    const mockFetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/plans/")) {
        return new Response(
          JSON.stringify({
            id: "plan_monthly_rzp_456",
            item: { amount: 149900, currency: "INR" },
            period: "monthly",
            interval: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          id: "sub_rzp_monthly_654321",
          plan_id: capturedBody.plan_id,
          status: "created",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const req = createMockRequest(
      { planCode: "monthly" },
      {},
      {
        getSupabaseAdmin: () => createMockSupabaseAdmin(),
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: mockFetch,
        isProductionHost: false,
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.subscriptionId).toBe("sub_rzp_monthly_654321");
    expect(json.planId).toBe("plan_monthly_rzp_456");
    expect(capturedBody.total_count).toBe(12);
    expect(capturedBody.customer_notify).toBe(true);

    const pendingOrder = mockDbPaymentOrders.get("sub_rzp_monthly_654321");
    expect(pendingOrder).toBeDefined();
    expect(pendingOrder.provider_order_id).toBe("sub_rzp_monthly_654321");
    expect(pendingOrder.plan_code).toBe("monthly");
    expect(pendingOrder.amount_paise).toBe(149900);
  });

  it("creates quarterly subscription with total_count=4 (1 year) and stores pending order separately", async () => {
    let capturedBody: any = null;
    const mockFetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/plans/")) {
        return new Response(
          JSON.stringify({
            id: "plan_quarterly_rzp_789",
            item: { amount: 399900, currency: "INR" },
            period: "monthly",
            interval: 3,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          id: "sub_rzp_quarterly_987654",
          plan_id: capturedBody.plan_id,
          status: "created",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const req = createMockRequest(
      { planCode: "quarterly" },
      {},
      {
        getSupabaseAdmin: () => createMockSupabaseAdmin(),
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: mockFetch,
        isProductionHost: false,
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.subscriptionId).toBe("sub_rzp_quarterly_987654");
    expect(json.planId).toBe("plan_quarterly_rzp_789");
    expect(capturedBody.total_count).toBe(4);
    expect(capturedBody.customer_notify).toBe(true);

    const pendingOrder = mockDbPaymentOrders.get("sub_rzp_quarterly_987654");
    expect(pendingOrder).toBeDefined();
    expect(pendingOrder.provider_order_id).toBe("sub_rzp_quarterly_987654");
    expect(pendingOrder.plan_code).toBe("quarterly");
    expect(pendingOrder.amount_paise).toBe(399900);
  });

  it("blocks subscription creation with 409 when user already has an active plan", async () => {
    const futureDate = new Date(Date.now() + 15 * 86400000).toISOString();
    mockDbSubscriptions.set(mockUser.id, {
      id: "active_sub_row",
      user_id: mockUser.id,
      subscription_id: "active_sub_123",
      plan_id: "monthly",
      status: "active",
      current_period_end: futureDate,
    });

    const mockFetch = vi.fn();
    const req = createMockRequest(
      { planCode: "monthly" },
      {},
      {
        getSupabaseAdmin: () => createMockSupabaseAdmin(),
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: mockFetch,
        isProductionHost: false,
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("ACTIVE_PLAN_EXISTS");
    expect(json.error).toBe(
      "You already have an active subscription plan. Please manage your existing subscription in account settings."
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails closed with 503 before Razorpay call when entitlement check throws", async () => {
    const mockFetch = vi.fn();
    const req = createMockRequest(
      { planCode: "monthly" },
      {},
      {
        getSupabaseAdmin: () => createMockSupabaseAdmin(),
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        getServerEntitlement: async () => {
          throw new Error("Entitlement service down");
        },
        fetchFn: mockFetch,
        isProductionHost: false,
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.code).toBe("SERVICE_UNAVAILABLE");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("never reuses a prepaid order_* row when creating a subscription", async () => {
    mockDbPaymentOrders.set("order_prepaid_123", {
      id: "order_prepaid_id",
      user_id: mockUser.id,
      provider: "razorpay",
      provider_order_id: "order_prepaid_123",
      plan_code: "monthly",
      amount_paise: 149900,
      status: "created",
      mode: "test",
      created_at: new Date().toISOString(),
    });

    const mockFetch = createMockRazorpayFetch({
      subData: {
        id: "sub_new_mandate_from_gateway",
        plan_id: "plan_monthly_rzp_456",
        status: "created",
      },
    });

    const req = createMockRequest(
      { planCode: "monthly" },
      {},
      {
        getSupabaseAdmin: () => createMockSupabaseAdmin(),
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: mockFetch,
        isProductionHost: false,
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscriptionId).toBe("sub_new_mandate_from_gateway");
    expect(json.reused).toBeUndefined();
  });

  it("openGatewaySubscription fails closed when NEXT_PUBLIC_AUTORENEW_ENABLED is off", async () => {
    delete process.env.NEXT_PUBLIC_AUTORENEW_ENABLED;
    const onError = vi.fn();
    await openGatewaySubscription({
      planCode: "monthly",
      onError,
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Auto-renew subscriptions are currently disabled"),
      })
    );
  });

  it("openCheckoutSubscription fails closed when NEXT_PUBLIC_AUTORENEW_ENABLED is off", async () => {
    delete process.env.NEXT_PUBLIC_AUTORENEW_ENABLED;
    const onError = vi.fn();
    await openCheckoutSubscription({
      planCode: "monthly",
      onError,
    });
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("Auto-renew subscriptions are currently disabled")
    );
  });
});
