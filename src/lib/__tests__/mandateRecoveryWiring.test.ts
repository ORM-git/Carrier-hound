import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { POST as webhookPost } from "@/app/api/billing/razorpay/webhook/route";
import { runMandateReconciliationJob } from "../billing/mandateReconciliationJob";

describe("Issue 2: Failed-Mandate Recovery Wiring", () => {
  const WEBHOOK_SECRET = "test_webhook_secret_key_123456";
  const CRON_SECRET = "test_cron_secret_high_entropy_123";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.RAZORPAY_KEY_ID = "rzp_test_key123";
    process.env.CRON_SECRET = CRON_SECRET;
  });

  function createSignedWebhookRequest(bodyObj: any, signatureOverride?: string): Request {
    const rawBody = JSON.stringify(bodyObj);
    const validSignature = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    const signature = signatureOverride !== undefined ? signatureOverride : validSignature;

    return new Request("https://careermonke.com/api/billing/razorpay/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Razorpay-Signature": signature,
      },
      body: rawBody,
    });
  }

  it("triggers recovery when a payment.failed webhook event arrives", async () => {
    const insertedReconciliations: any[] = [];
    const insertedDedupe: any[] = [];
    const updatedReconciliations: any[] = [];
    const updatedOrders: any[] = [];

    const mockSupabaseAdmin = {
      from: vi.fn((table: string) => {
        if (table === "webhook_events") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            upsert: vi.fn((row: any) => {
              insertedDedupe.push(row);
              return Promise.resolve({ data: row, error: null });
            }),
          };
        }
        if (table === "payment_orders") {
          return {
            select: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "order_mock_1",
                user_id: "user_fail_1",
                provider_order_id: "sub_failed_123",
                mode: "recurring",
              },
              error: null,
            }),
            update: vi.fn((patch: any) => {
              updatedOrders.push(patch);
              return {
                eq: vi.fn().mockReturnThis(),
                in: vi.fn().mockResolvedValue({ data: null, error: null }),
              };
            }),
          };
        }
        if (table === "subscription_reconciliations") {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockImplementation(() => {
              // Return pending records
              return Promise.resolve({
                data: insertedReconciliations.map((r, i) => ({
                  id: `rec_${i + 1}`,
                  ...r,
                  created_at: new Date().toISOString(),
                })),
                error: null,
              });
            }),
            insert: vi.fn((rows: any) => {
              const rowArr = Array.isArray(rows) ? rows : [rows];
              insertedReconciliations.push(...rowArr);
              return Promise.resolve({ data: rowArr, error: null });
            }),
            update: vi.fn((patch: any) => {
              updatedReconciliations.push(patch);
              return { eq: vi.fn().mockResolvedValue({ data: null, error: null }) };
            }),
          };
        }
        return {};
      }),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          id: "sub_failed_123",
          status: "cancelled",
          notes: { user_id: "user_fail_1" },
        }),
    });

    const payload = {
      event: "payment.failed",
      event_id: "evt_payment_failed_101",
      payload: {
        payment: {
          entity: {
            id: "pay_failed_101",
            subscription_id: "sub_failed_123",
            error_code: "BAD_REQUEST_ERROR",
            error_description: "Payment failed due to invalid card or mandate",
            notes: { user_id: "user_fail_1" },
          },
        },
      },
    };

    const req = createSignedWebhookRequest(payload);
    (req as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
      fetchFn: mockFetch,
    };

    const res = await webhookPost(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);
    expect(json.recovered).toBe(true);

    // Verify reconciliation record was created
    expect(insertedReconciliations.length).toBeGreaterThan(0);
    expect(insertedReconciliations[0].provider_subscription_id).toBe("sub_failed_123");
    expect(insertedReconciliations[0].reconciliation_state).toBe("pending");
    expect(insertedReconciliations[0].failure_reason).toContain("Payment failed");

    // Verify recovery code was invoked
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.razorpay.com/v1/subscriptions/sub_failed_123",
      expect.anything()
    );

    // Verify reconciliation record was updated to resolved
    expect(updatedReconciliations.length).toBeGreaterThan(0);
    expect(updatedReconciliations[0].reconciliation_state).toBe("resolved");

    // Verify order was marked cancelled
    expect(updatedOrders.length).toBeGreaterThan(0);
    expect(updatedOrders[0].status).toBe("cancelled");
  });

  it("is idempotent: second call with the same event is a no-op", async () => {
    let callCount = 0;
    const mockSupabaseAdmin = {
      from: vi.fn((table: string) => {
        if (table === "webhook_events") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockImplementation(() => {
              callCount++;
              if (callCount > 1) {
                // Second call returns existing dedupe record
                return Promise.resolve({
                  data: { event_id: "evt_payment_failed_dupe" },
                  error: null,
                });
              }
              return Promise.resolve({ data: null, error: null });
            }),
            upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        if (table === "payment_orders") {
          return {
            select: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        if (table === "subscription_reconciliations") {
          return {
            insert: vi.fn().mockResolvedValue({ data: null, error: null }),
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        return {};
      }),
    };

    const mockFetch = vi.fn();
    const payload = {
      event: "payment.failed",
      event_id: "evt_payment_failed_dupe",
      payload: {
        payment: {
          entity: {
            id: "pay_failed_dupe",
            subscription_id: "sub_dupe_123",
            error_code: "BAD_REQUEST_ERROR",
          },
        },
      },
    };

    // First call: succeeds and processes
    const req1 = createSignedWebhookRequest(payload);
    (req1 as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
      fetchFn: mockFetch,
    };
    const res1 = await webhookPost(req1);
    expect(res1.status).toBe(200);

    // Second call: duplicate event_id is recognized
    const req2 = createSignedWebhookRequest(payload);
    (req2 as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
      fetchFn: mockFetch,
    };
    const res2 = await webhookPost(req2);
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.alreadyProcessed).toBe(true);

    // mockFetch should not be called on the second request
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  it("refuses unauthenticated webhook requests with invalid signature without triggering recovery", async () => {
    const mockSupabaseAdmin = {
      from: vi.fn(),
    };
    const mockFetch = vi.fn();

    const payload = {
      event: "payment.failed",
      event_id: "evt_invalid_sig",
      payload: {
        payment: {
          entity: {
            id: "pay_invalid_sig",
            subscription_id: "sub_invalid_sig",
          },
        },
      },
    };

    const req = createSignedWebhookRequest(
      payload,
      "0000000000000000000000000000000000000000000000000000000000000000" // Invalid signature
    );
    (req as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
      fetchFn: mockFetch,
    };

    const res = await webhookPost(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_SIGNATURE");

    // Supabase DB and provider fetch must NEVER be invoked
    expect(mockSupabaseAdmin.from).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("scheduled job finds stuck mandates and recovers them", async () => {
    const insertedReconciliations: any[] = [];
    const updatedReconciliations: any[] = [];
    const updatedOrders: any[] = [];

    const mockStuckOrders = [
      {
        id: "order_stuck_1",
        user_id: "user_stuck_1",
        provider_order_id: "sub_stuck_real_999",
        status: "reserved",
        created_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(), // 3 hours old
      },
      {
        id: "order_stuck_2",
        user_id: "user_stuck_2",
        provider_order_id: "sub_pending_place_888",
        status: "created",
        created_at: new Date(Date.now() - 26 * 3600 * 1000).toISOString(), // 26 hours old (> 24h)
      },
    ];

    const mockSupabaseAdmin = {
      from: vi.fn((table: string) => {
        if (table === "payment_orders") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            lte: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: mockStuckOrders,
              error: null,
            }),
            update: vi.fn((patch: any) => {
              updatedOrders.push(patch);
              return {
                eq: vi.fn().mockReturnThis(),
                in: vi.fn().mockResolvedValue({ data: null, error: null }),
              };
            }),
          };
        }
        if (table === "subscription_reconciliations") {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockImplementation(() => {
              return Promise.resolve({
                data: insertedReconciliations.map((r, i) => ({
                  id: `rec_job_${i + 1}`,
                  ...r,
                  created_at: r.created_at || new Date(Date.now() - 26 * 3600 * 1000).toISOString(),
                })),
                error: null,
              });
            }),
            insert: vi.fn((rows: any) => {
              const rowArr = Array.isArray(rows) ? rows : [rows];
              insertedReconciliations.push(...rowArr);
              return Promise.resolve({ data: rowArr, error: null });
            }),
            update: vi.fn((patch: any) => {
              updatedReconciliations.push(patch);
              return { eq: vi.fn().mockResolvedValue({ data: null, error: null }) };
            }),
          };
        }
        return {};
      }),
    };

    // Provider returns 404 for sub_stuck_real_999 (mandate nonexistent -> release)
    const mockFetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
    });

    const result = await runMandateReconciliationJob({
      supabaseAdmin: mockSupabaseAdmin,
      jobAuthSecret: CRON_SECRET,
      expectedSecret: CRON_SECRET,
      fetchFn: mockFetch as any,
      staleHours: 1,
    });

    expect(result.success).toBe(true);
    expect(result.stuckOrdersFound).toBe(2);
    expect(result.enqueuedCount).toBe(2);
    expect(result.recoveryResult?.processed).toBe(2);
    expect(result.recoveryResult?.resolved).toBe(2);

    // Both orders were recovered: real sub marked failed (404), stale placeholder marked expired (>24h)
    expect(updatedOrders.some((o) => o.status === "failed")).toBe(true);
    expect(updatedOrders.some((o) => o.status === "expired")).toBe(true);
  });

  it("scheduled job rejects unauthenticated execution when cron secret is invalid", async () => {
    const mockSupabaseAdmin = {
      from: vi.fn(),
    };

    await expect(
      runMandateReconciliationJob({
        supabaseAdmin: mockSupabaseAdmin,
        jobAuthSecret: "wrong_secret_key",
        expectedSecret: CRON_SECRET,
      })
    ).rejects.toThrow("UNAUTHORIZED_JOB_INVOCATION");

    expect(mockSupabaseAdmin.from).not.toHaveBeenCalled();
  });
});
