/**
 * Rate limiting of NEW Razorpay order creation in the Next edge route
 * (src/app/api/billing/razorpay/order/route.ts).
 *
 * Contract under test:
 * - checkSharedRateLimitStrict with key `billing_order:user:<user.id>`,
 *   10 requests per 60 seconds, and { env: cfEnv } from the Cloudflare context.
 * - The check runs after auth and all validation, BEFORE any Razorpay order
 *   creation or payment_orders insert.
 * - Quota denied: 429, code RATE_LIMITED, retryAfter in body + Retry-After header.
 * - Strict store unavailable: 503, code RATE_LIMIT_UNAVAILABLE, Retry-After 30
 *   (fail closed, never memory fallback).
 * - Both deny paths make ZERO provider-create calls and ZERO payment_orders inserts.
 * - Allowed requests proceed unchanged (no dedupe / idempotency semantics).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  env: {} as Record<string, any>,
  rateLimit: null as any,
  admin: null as any,
  fetchFn: null as any,
  banCheck: null as any,
}));

vi.mock("@/lib/ai/serviceHandler", () => ({
  getRuntimeEnv: (name: string, env?: Record<string, any>) => (env && env[name]) ?? state.env[name],
}));
vi.mock("@cloudflare/next-on-pages", () => ({
  getRequestContext: vi.fn(() => undefined),
}));
vi.mock("@/lib/api/sharedRateLimit", () => ({
  checkSharedRateLimitStrict: (...args: unknown[]) => state.rateLimit(...args),
}));
vi.mock("@/lib/billing/quota", () => ({
  resolveOrderPricing: vi.fn(() => ({
    type: "plan",
    code: "monthly",
    amount_paise: 49900,
    currency: "INR",
  })),
  normalizePlanCode: (value: any) => value,
}));
vi.mock("@/lib/billing/mode", () => ({
  getRazorpayKeyMode: (keyId: string) => (keyId.startsWith("rzp_live_") ? "live" : "test"),
}));
vi.mock("@/lib/billing/serverEntitlement", () => ({
  getServerEntitlement: vi.fn(async () => ({ isPro: false })),
}));
vi.mock("@/lib/admin/auth", () => ({
  verifyUserNotBanned: (...args: unknown[]) => state.banCheck(...args),
}));
vi.mock("@/lib/monitoring/sentryErrorReporter", () => ({
  reportRequestErrorToSentry: vi.fn(),
}));
vi.mock("@/lib/observability/logger", () => ({
  createLogger: () => {
    const log: any = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    log.child = () => log;
    return log;
  },
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => {
    throw new Error("tests must inject deps.getSupabaseAdmin");
  }),
}));

import { POST } from "@/app/api/billing/razorpay/order/route";

const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CF_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

function makeAdmin() {
  const calls = { paymentOrdersInsert: 0 };
  const admin = {
    calls,
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: USER_ID, email: "user@example.com", user_metadata: {} } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => ({
      insert: (_row: any) => {
        if (table === "payment_orders") calls.paymentOrdersInsert += 1;
        return {
          select: () => ({ single: async () => ({ data: { id: "row-1" }, error: null }) }),
        };
      },
      select: () => ({
        eq: () => ({
          order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        }),
      }),
    })),
  };
  return admin;
}

function makeRequest(extraDeps: Record<string, any> = {}) {
  const req = new Request("https://app.test/api/billing/razorpay/order", {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ planId: "monthly" }),
  });
  (req as any).__testDeps = {
    cfEnv: CF_ENV,
    getSupabaseAdmin: () => state.admin,
    fetchFn: state.fetchFn,
    ...extraDeps,
  };
  return req;
}

beforeEach(() => {
  state.env = {
    NEXT_PUBLIC_BILLING_ENABLED: "true",
    RAZORPAY_MODE: "test",
    NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_test_123",
    RAZORPAY_KEY_SECRET: "test-secret",
  };
  state.admin = makeAdmin();
  state.rateLimit = vi.fn(async () => ({ allowed: true, retryAfter: 0, currentCount: 1, source: "shared" }));
  state.banCheck = vi.fn(async () => ({ isBlocked: false }));
  state.fetchFn = vi.fn(async () => ({
    ok: true,
    json: async () => ({ id: "order_123", amount: 49900, currency: "INR" }),
  }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/billing/razorpay/order rate limiting (new order creation only)", () => {
  it("allowed request: exact key/10/60 with edge env passed, order created as before", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orderId).toBe("order_123");

    expect(state.rateLimit).toHaveBeenCalledTimes(1);
    const [key, maxRequests, windowSeconds, options] = state.rateLimit.mock.calls[0];
    expect(key).toBe(`billing_order:user:${USER_ID}`);
    expect(maxRequests).toBe(10);
    expect(windowSeconds).toBe(60);
    expect(options).toEqual({ env: CF_ENV });

    expect(state.fetchFn).toHaveBeenCalledTimes(1);
    expect(state.admin.calls.paymentOrdersInsert).toBe(1);
  });

  it("quota denied: 429 RATE_LIMITED with retryAfter in body and Retry-After header, zero side effects", async () => {
    state.rateLimit = vi.fn(async () => ({
      allowed: false,
      retryAfter: 42,
      currentCount: 11,
      source: "shared",
    }));
    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.retryAfter).toBe(42);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(state.fetchFn).not.toHaveBeenCalled();
    expect(state.admin.calls.paymentOrdersInsert).toBe(0);
  });

  it("strict store unavailable: 503 RATE_LIMIT_UNAVAILABLE with Retry-After 30, fail closed, zero side effects", async () => {
    state.rateLimit = vi.fn(async () => ({
      allowed: false,
      retryAfter: 30,
      currentCount: 0,
      source: "unavailable",
    }));
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("RATE_LIMIT_UNAVAILABLE");
    expect(body.retryAfter).toBe(30);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(state.fetchFn).not.toHaveBeenCalled();
    expect(state.admin.calls.paymentOrdersInsert).toBe(0);
  });

  it("injected deps.checkRateLimit is used with the same key, limit, window and edge env", async () => {
    const injected = vi.fn(
      async (
        _key: string,
        _maxRequests: number,
        _windowSeconds: number,
        _options?: any
      ) => ({
        allowed: false,
        retryAfter: 7,
        currentCount: 10,
        source: "shared",
      })
    );
    const res = await POST(makeRequest({ checkRateLimit: injected }));
    expect(res.status).toBe(429);
    expect(injected).toHaveBeenCalledTimes(1);
    const [key, maxRequests, windowSeconds, options] = injected.mock.calls[0];
    expect(key).toBe(`billing_order:user:${USER_ID}`);
    expect(maxRequests).toBe(10);
    expect(windowSeconds).toBe(60);
    expect(options).toEqual({ env: CF_ENV });
    expect(state.rateLimit).not.toHaveBeenCalled();
  });
});
