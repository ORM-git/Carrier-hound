/**
 * Rate limiting of NEW Razorpay order creation in the Netlify mirror
 * (netlify/functions/billing-razorpay-order.ts) - parity with the Next edge route.
 *
 * Contract under test:
 * - checkSharedRateLimitStrict with key `billing_order:user:<user.id>`,
 *   10 requests per 60 seconds, and { client: supabaseAdmin } (the helper's
 *   process-env default remains available when no client is passed).
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
  rateLimit: null as any,
  admin: null as any,
  fetchFn: null as any,
  banCheck: null as any,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => {
    throw new Error("tests must inject deps.getSupabaseAdmin");
  }),
}));
vi.mock("../billing/quota", () => ({
  resolveOrderPricing: vi.fn(() => ({
    type: "plan",
    code: "monthly",
    amount_paise: 49900,
    currency: "INR",
  })),
  normalizePlanCode: (value: any) => value,
}));
vi.mock("../billing/mode", () => ({
  getRazorpayKeyMode: (keyId: string) => (keyId.startsWith("rzp_live_") ? "live" : "test"),
}));
vi.mock("../billing/serverEntitlement", () => ({
  getServerEntitlement: vi.fn(async () => ({ isPro: false })),
}));
vi.mock("../admin/auth", () => ({
  verifyUserNotBanned: (...args: unknown[]) => state.banCheck(...args),
}));
vi.mock("../../../netlify/functions/_cors", () => ({
  buildCorsHeaders: vi.fn(() => ({})),
  handleCorsPreflight: vi.fn(() => null),
}));
vi.mock("../../../netlify/functions/_logger", () => ({
  safeLog: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../../../netlify/functions/_sharedRateLimit", () => ({
  checkSharedRateLimitStrict: (...args: unknown[]) => state.rateLimit(...args),
}));

import { createHandler } from "../../../netlify/functions/billing-razorpay-order";

const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ENV_KEYS = [
  "NEXT_PUBLIC_BILLING_ENABLED",
  "RAZORPAY_MODE",
  "NEXT_PUBLIC_RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
];

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

function makeEvent() {
  return {
    httpMethod: "POST",
    headers: { authorization: "Bearer good", host: "app.test" },
    rawUrl: "https://app.test/.netlify/functions/billing-razorpay-order",
    body: JSON.stringify({ planId: "monthly" }),
  };
}

function makeDeps(extra: Record<string, any> = {}) {
  return {
    getSupabaseAdmin: () => state.admin,
    fetchFn: state.fetchFn,
    verifyUserNotBanned: state.banCheck,
    isProductionHost: false,
    ...extra,
  };
}

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
  process.env.RAZORPAY_MODE = "test";
  process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_123";
  process.env.RAZORPAY_KEY_SECRET = "test-secret";
  state.admin = makeAdmin();
  state.rateLimit = vi.fn(async () => ({ allowed: true, retryAfter: 0, currentCount: 1, source: "shared" }));
  state.banCheck = vi.fn(async () => ({ isBlocked: false }));
  state.fetchFn = vi.fn(async () => ({
    ok: true,
    json: async () => ({ id: "order_123", amount: 49900, currency: "INR" }),
  }));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.clearAllMocks();
});

describe("Netlify billing-razorpay-order rate limiting (parity with Next route)", () => {
  it("allowed request: default helper called with exact key/10/60 and { client: supabaseAdmin }, order created as before", async () => {
    const handler = createHandler(makeDeps());
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.orderId).toBe("order_123");

    expect(state.rateLimit).toHaveBeenCalledTimes(1);
    const [key, maxRequests, windowSeconds, options] = state.rateLimit.mock.calls[0];
    expect(key).toBe(`billing_order:user:${USER_ID}`);
    expect(maxRequests).toBe(10);
    expect(windowSeconds).toBe(60);
    expect(options).toEqual({ client: state.admin });

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
    const handler = createHandler(makeDeps());
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.retryAfter).toBe(42);
    expect((res.headers as Record<string, string>)["Retry-After"]).toBe("42");
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
    const handler = createHandler(makeDeps());
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("RATE_LIMIT_UNAVAILABLE");
    expect(body.retryAfter).toBe(30);
    expect((res.headers as Record<string, string>)["Retry-After"]).toBe("30");
    expect(state.fetchFn).not.toHaveBeenCalled();
    expect(state.admin.calls.paymentOrdersInsert).toBe(0);
  });

  it("injected deps.checkRateLimit is used with the same key, limit, window and client option", async () => {
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
    const handler = createHandler(makeDeps({ checkRateLimit: injected }));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(429);
    expect(injected).toHaveBeenCalledTimes(1);
    const [key, maxRequests, windowSeconds, options] = injected.mock.calls[0];
    expect(key).toBe(`billing_order:user:${USER_ID}`);
    expect(maxRequests).toBe(10);
    expect(windowSeconds).toBe(60);
    expect(options).toEqual({ client: state.admin });
    expect(state.rateLimit).not.toHaveBeenCalled();
  });
});
