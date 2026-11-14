import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "@/app/api/billing/razorpay/subscription/route";
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
        let filterUserId: string | null = null;
        const query: any = {
          select: () => query,
          order: () => query,
          limit: () => query,
          eq: (col: string, val: any) => {
            if (col === "user_id") filterUserId = val;
            return query;
          },
          maybeSingle: async () => {
            if (options?.dbError) return { data: null, error: options.dbError };
            const found = filterUserId ? mockDbSubscriptions.get(filterUserId) : null;
            return { data: found || null, error: null };
          },
          update: (updates: any) => {
            let targetUserId: string | null = null;
            const updateQuery = {
              eq: async (col: string, val: any) => {
                if (col === "user_id") targetUserId = val;
                if (options?.dbError) return { error: options.dbError };
                if (targetUserId) {
                  const existing = mockDbSubscriptions.get(targetUserId) || {};
                  mockDbSubscriptions.set(targetUserId, { ...existing, ...updates });
                }
                return { error: null };
              },
            };
            return updateQuery;
          },
          insert: async (row: any) => {
            if (options?.dbError) return { error: options.dbError };
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
    process.env.RAZORPAY_MODE = "live"; // requires rzp_live_, but key is rzp_test_
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

  it("creates weekly subscription with total_count=52 (1 year) and stores subscription_id", async () => {
    let capturedBody: any = null;
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
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
    expect(capturedBody.total_count).toBe(52); // 52 weeks = 1 calendar year
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
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
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
    expect(capturedBody.total_count).toBe(12); // 12 months = 1 calendar year
    expect(capturedBody.customer_notify).toBe(true);

    const pendingOrder = mockDbPaymentOrders.get("sub_rzp_monthly_654321");
    expect(pendingOrder).toBeDefined();
    expect(pendingOrder.provider_order_id).toBe("sub_rzp_monthly_654321");
    expect(pendingOrder.plan_code).toBe("monthly");
    expect(pendingOrder.amount_paise).toBe(149900);
  });

  it("creates quarterly subscription with total_count=4 (1 year) and stores pending order separately", async () => {
    let capturedBody: any = null;
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
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
    expect(capturedBody.total_count).toBe(4); // 4 quarters = 1 calendar year
    expect(capturedBody.customer_notify).toBe(true);

    const pendingOrder = mockDbPaymentOrders.get("sub_rzp_quarterly_987654");
    expect(pendingOrder).toBeDefined();
    expect(pendingOrder.provider_order_id).toBe("sub_rzp_quarterly_987654");
    expect(pendingOrder.plan_code).toBe("quarterly");
    expect(pendingOrder.amount_paise).toBe(399900);
  });

  it("does NOT overwrite existing active subscription_id or plan_id, storing pending subscription separately", async () => {
    mockDbSubscriptions.set(mockUser.id, {
      id: "existing_sub_row_1",
      user_id: mockUser.id,
      subscription_id: "old_sub_id",
      plan_id: "weekly",
      status: "canceled", // inactive
      metadata: { initial_plan: "free" },
    });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "sub_rzp_new_updated_123",
          plan_id: "plan_monthly_rzp_456",
          status: "created",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

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

    const sub = mockDbSubscriptions.get(mockUser.id);
    // Active columns are NOT overwritten!
    expect(sub.subscription_id).toBe("old_sub_id");
    expect(sub.plan_id).toBe("weekly");
    expect(sub.status).toBe("canceled");
    // Pending ID is stored separately in metadata
    expect(sub.metadata.pending_subscription_id).toBe("sub_rzp_new_updated_123");
    expect(sub.metadata.pending_plan_code).toBe("monthly");

    // Also recorded in payment_orders
    const pendingOrder = mockDbPaymentOrders.get("sub_rzp_new_updated_123");
    expect(pendingOrder).toBeDefined();
    expect(pendingOrder.provider_order_id).toBe("sub_rzp_new_updated_123");
    expect(pendingOrder.plan_code).toBe("monthly");
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
    // Razorpay must never be called when user already has active plan
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails closed with 500 when database update/insert fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "sub_rzp_success_before_db_fail",
          plan_id: "plan_monthly_rzp_456",
          status: "created",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const req = createMockRequest(
      { planCode: "monthly" },
      {},
      {
        getSupabaseAdmin: () =>
          createMockSupabaseAdmin({ dbError: new Error("Database disk full") }),
        verifyUserNotBanned: async () => ({ isBlocked: false }),
        fetchFn: mockFetch,
        isProductionHost: false,
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.code).toBe("SUBSCRIPTION_RECORD_FAILED");
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
