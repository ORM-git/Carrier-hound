import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let mockRequestContextEnv: Record<string, string> | undefined = undefined;

vi.mock("@cloudflare/next-on-pages", () => ({
  getRequestContext: vi.fn(() => {
    if (!mockRequestContextEnv) {
      throw new Error("Failed to retrieve the Cloudflare request context.");
    }
    return { env: mockRequestContextEnv };
  }),
}));

const mockCreateClient = vi.fn((_url: string, _key: string, _opts?: any) => ({
  auth: {
    getUser: vi.fn(async (token: string) => {
      if (token === "valid-session-token") {
        return { data: { user: { id: "user_cf_test_1", email: "user@careermonke.io" } }, error: null };
      }
      return { data: { user: null }, error: new Error("invalid token") };
    }),
  },
  from: vi.fn((table: string) => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({
      data: table === "payment_orders"
        ? {
            id: "order_rec_1",
            provider: "razorpay",
            mode: "test",
            user_id: "user_cf_test_1",
            provider_order_id: "order_test_123",
            plan_code: "weekly",
            amount_paise: 29900,
            currency: "INR",
            status: "created",
          }
        : null,
      error: null,
    }),
    insert: vi.fn().mockResolvedValue({ data: null, error: null }),
  })),
  rpc: vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: any[]) => (mockCreateClient as any)(...args),
}));

import { POST as handleOrder } from "@/app/api/billing/razorpay/order/route";
import { POST as handleVerify } from "@/app/api/billing/razorpay/verify/route";
import { POST as handleSubscription } from "@/app/api/billing/razorpay/subscription/route";
import { POST as handleWebhook } from "@/app/api/billing/razorpay/webhook/route";
import { getRuntimeEnv } from "@/lib/ai/serviceHandler";

describe("Cloudflare Pages Runtime Secret Reading for Billing Routes", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockRequestContextEnv = undefined;
    vi.clearAllMocks();

    // Ensure all target secrets/flags are wiped from process.env
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_MODE;
    delete process.env.NEXT_PUBLIC_BILLING_ENABLED;
    delete process.env.NEXT_PUBLIC_AUTORENEW_ENABLED;
    delete process.env.RAZORPAY_AUTORENEW_PLAN_WEEKLY;
    delete process.env.RAZORPAY_AUTORENEW_PLAN_MONTHLY;
    delete process.env.RAZORPAY_AUTORENEW_PLAN_QUARTERLY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    mockRequestContextEnv = undefined;
    vi.restoreAllMocks();
  });

  it("getRuntimeEnv picks up a value present only in request-context env", () => {
    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();

    const cfEnv = {
      SUPABASE_SERVICE_ROLE_KEY: "cf-context-only-service-key",
      RAZORPAY_KEY_SECRET: "cf-context-only-razorpay-secret",
    };

    const resolvedRoleKey = getRuntimeEnv("SUPABASE_SERVICE_ROLE_KEY", cfEnv);
    const resolvedSecret = getRuntimeEnv("RAZORPAY_KEY_SECRET", cfEnv);

    expect(resolvedRoleKey).toBe("cf-context-only-service-key");
    expect(resolvedSecret).toBe("cf-context-only-razorpay-secret");
  });

  it("order route picks up secrets present ONLY in Cloudflare request context without throwing 'Supabase service configuration missing'", async () => {
    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(process.env.RAZORPAY_KEY_SECRET).toBeUndefined();

    // Populate ONLY Cloudflare getRequestContext().env
    mockRequestContextEnv = {
      NEXT_PUBLIC_BILLING_ENABLED: "true",
      NEXT_PUBLIC_SUPABASE_URL: "https://cf-test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "cf-test-service-role-key",
      RAZORPAY_MODE: "test",
      NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_test_cfContextKey",
      RAZORPAY_KEY_SECRET: "cf-test-razorpay-secret",
    };

    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "order_cf_test_999",
        amount: 29900,
        currency: "INR",
      }),
    }));

    const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ planCode: "weekly" }),
    });
    (req as any).__testDeps = { fetchFn: mockFetch };

    const res = await handleOrder(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.orderId).toBe("order_cf_test_999");
    expect(body.keyId).toBe("rzp_test_cfContextKey");

    // Verify createClient was called with the context-only service role key
    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://cf-test.supabase.co",
      "cf-test-service-role-key",
      expect.any(Object)
    );
  });

  it("order route fails with 500 'Supabase service configuration missing' when secret is absent from BOTH process.env and Cloudflare context", async () => {
    // Missing SUPABASE_SERVICE_ROLE_KEY everywhere
    mockRequestContextEnv = {
      NEXT_PUBLIC_BILLING_ENABLED: "true",
      NEXT_PUBLIC_SUPABASE_URL: "https://cf-test.supabase.co",
      RAZORPAY_MODE: "test",
      NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_test_cfContextKey",
      RAZORPAY_KEY_SECRET: "cf-test-razorpay-secret",
    };

    const req = new Request("http://localhost:3000/api/billing/razorpay/order", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ planCode: "weekly" }),
    });

    const res = await handleOrder(req);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Supabase service configuration missing");
  });

  it("verify route picks up secrets present ONLY in Cloudflare request context", async () => {
    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(process.env.RAZORPAY_KEY_SECRET).toBeUndefined();

    const mockSecret = "cf-test-razorpay-secret";
    mockRequestContextEnv = {
      NEXT_PUBLIC_BILLING_ENABLED: "true",
      NEXT_PUBLIC_SUPABASE_URL: "https://cf-test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "cf-test-service-role-key",
      NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_test_cfContextKey",
      RAZORPAY_KEY_SECRET: mockSecret,
    };

    // Compute valid HMAC signature for mockSecret
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(mockSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode("order_test_123|pay_test_456"));
    const validSignature = Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const req = new Request("http://localhost:3000/api/billing/razorpay/verify", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        order_id: "order_test_123",
        payment_id: "pay_test_456",
        razorpay_signature: validSignature,
      }),
    });
    (req as any).__testDeps = {
      fetchRazorpayPayment: vi.fn(async () => ({
        id: "pay_test_456",
        status: "captured",
        amount: 29900,
        currency: "INR",
        order_id: "order_test_123",
      })),
    };

    const res = await handleVerify(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    // Confirms createClient received the context-only service role key
    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://cf-test.supabase.co",
      "cf-test-service-role-key",
      expect.any(Object)
    );
  });

  it("subscription route reads AUTORENEW and the weekly plan id from Cloudflare context", async () => {
    mockRequestContextEnv = {
      NEXT_PUBLIC_BILLING_ENABLED: "true",
      NEXT_PUBLIC_AUTORENEW_ENABLED: "true",
      NEXT_PUBLIC_SUPABASE_URL: "https://cf-test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "cf-test-service-role-key",
      RAZORPAY_MODE: "test",
      NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_test_cfContextKey",
      RAZORPAY_KEY_SECRET: "cf-test-razorpay-secret",
      RAZORPAY_AUTORENEW_PLAN_WEEKLY: "plan_test_weekly_cf_123",
    };

    const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        planCode: "weekly",
        consent: { agreed: true, version: "2026-11-autorenew-v1", timestamp: new Date().toISOString() },
      }),
    });
    const planFetch = vi.fn(async () => new Response(JSON.stringify({ error: { description: "stop here" } }), { status: 404 }));
    (req as any).__testDeps = { fetchFn: planFetch };

    const res = await handleSubscription(req);
    const body = await res.json();

    // Gets past the flag, auth, plan and consent checks, then looks up the context-only weekly plan id
    expect(res.status).toBe(502);
    expect(body.code).toBe("PLAN_FETCH_FAILED");
    expect(String((planFetch.mock.calls[0] as unknown[])[0])).toContain("/plans/plan_test_weekly_cf_123");
  });

  it("webhook route picks up RAZORPAY_WEBHOOK_SECRET and SUPABASE_SERVICE_ROLE_KEY present ONLY in Cloudflare request context", async () => {
    expect(process.env.RAZORPAY_WEBHOOK_SECRET).toBeUndefined();
    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();

    const webhookSecret = "cf-test-webhook-secret";
    mockRequestContextEnv = {
      NEXT_PUBLIC_BILLING_ENABLED: "true",
      NEXT_PUBLIC_SUPABASE_URL: "https://cf-test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "cf-test-service-role-key",
      NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_test_cfContextKey",
      RAZORPAY_WEBHOOK_SECRET: webhookSecret,
    };

    const rawPayload = JSON.stringify({
      entity: "event",
      account_id: "acc_test_1",
      event: "payment.captured",
      contains: ["payment"],
      payload: {
        payment: {
          entity: {
            id: "pay_test_captured",
            order_id: "order_test_123",
            amount: 29900,
            currency: "INR",
            status: "captured",
            notes: {
              user_id: "user_cf_test_1",
            },
          },
        },
      },
    });

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(rawPayload));
    const validSignature = Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const req = new Request("http://localhost:3000/api/billing/razorpay/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": validSignature,
        "x-razorpay-event-id": "evt_test_cf_123",
      },
      body: rawPayload,
    });

    const res = await handleWebhook(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.received).toBe(true);
    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://cf-test.supabase.co",
      "cf-test-service-role-key",
      expect.any(Object)
    );
  });
});
