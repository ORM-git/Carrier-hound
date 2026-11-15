import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { POST as webhookPost } from "@/app/api/billing/razorpay/webhook/route";

describe("Issue 1: Webhook Mandate Safety & State Machine Guards", () => {
  const WEBHOOK_SECRET = "test_webhook_secret_key_issue1";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.RAZORPAY_KEY_ID = "rzp_test_key123";
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

  // 1. User A active mandate, payment.failed arrives for User B's mandate -> User A is untouched
  it("Test 1: User A active mandate is untouched when payment.failed arrives for User B's mandate", async () => {
    const userASub = {
      id: "sub_db_user_a",
      user_id: "user_a",
      subscription_id: "sub_user_a_active",
      status: "active",
      cancel_at_period_end: false,
      metadata: { plan_code: "monthly" },
    };

    const userBSub = {
      id: "sub_db_user_b",
      user_id: "user_b",
      subscription_id: "sub_user_b_mandate",
      status: "active",
      cancel_at_period_end: false,
      metadata: { plan_code: "monthly" },
    };

    const rpcCalls: any[] = [];
    const mockSupabaseAdmin = {
      from: vi.fn((table: string) => {
        if (table === "webhook_events") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        if (table === "subscriptions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn((col: string, val: string) => {
              return {
                maybeSingle: vi.fn().mockImplementation(() => {
                  if (val === "sub_user_b_mandate") return Promise.resolve({ data: userBSub, error: null });
                  if (val === "sub_user_a_active") return Promise.resolve({ data: userASub, error: null });
                  return Promise.resolve({ data: null, error: null });
                }),
              };
            }),
          };
        }
        if (table === "payment_orders") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            update: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        return {};
      }),
      rpc: vi.fn((fnName: string, args: any) => {
        rpcCalls.push({ fnName, args });
        return Promise.resolve({ data: { success: true }, error: null });
      }),
    };

    const mockFetch = vi.fn();

    // payment.failed for user B
    const payload = {
      event: "payment.failed",
      event_id: "evt_pay_failed_user_b",
      payload: {
        payment: {
          entity: {
            id: "pay_b_fail_001",
            subscription_id: "sub_user_b_mandate",
            error_code: "INSUFFICIENT_FUNDS",
            error_description: "Card declined due to insufficient funds",
            notes: { user_id: "user_b" },
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

    // Provider cancel is NEVER called
    expect(mockFetch).not.toHaveBeenCalled();

    // Only user B's metadata is touched, User A is completely untouched
    const mergeCalls = rpcCalls.filter((c) => c.fnName === "merge_subscription_metadata");
    expect(mergeCalls.length).toBe(1);
    expect(mergeCalls[0].args.p_user_id).toBe("user_b");
    expect(userASub.status).toBe("active");
    expect(userASub.cancel_at_period_end).toBe(false);
  });

  // 2. payment.failed for A's own mandate -> A's mandate is NOT cancelled, only attempt marked failed
  it("Test 2: payment.failed on User A's mandate retains active status and does NOT cancel mandate", async () => {
    const userASub = {
      id: "sub_db_user_a",
      user_id: "user_a",
      subscription_id: "sub_user_a_active",
      status: "active",
      cancel_at_period_end: false,
      metadata: { plan_code: "monthly" },
    };

    const rpcCalls: any[] = [];
    const mockSupabaseAdmin = {
      from: vi.fn((table: string) => {
        if (table === "webhook_events") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        if (table === "subscriptions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: userASub, error: null }),
          };
        }
        if (table === "payment_orders") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            update: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        return {};
      }),
      rpc: vi.fn((fnName: string, args: any) => {
        rpcCalls.push({ fnName, args });
        return Promise.resolve({ data: { success: true }, error: null });
      }),
    };

    const mockFetch = vi.fn();

    const payload = {
      event: "payment.failed",
      event_id: "evt_pay_failed_user_a",
      payload: {
        payment: {
          entity: {
            id: "pay_a_fail_001",
            subscription_id: "sub_user_a_active",
            error_code: "BAD_REQUEST_ERROR",
            error_description: "Issuer bank unavailable",
            notes: { user_id: "user_a" },
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

    // Razorpay retries charges on active subscriptions up to 3 times; mandate is retained
    expect(mockFetch).not.toHaveBeenCalled();

    // User A's mandate remains active and not cancelled
    expect(userASub.status).toBe("active");
    expect(userASub.cancel_at_period_end).toBe(false);

    // Payment failure metadata is recorded transactionally
    expect(rpcCalls.some((c) => c.fnName === "merge_subscription_metadata")).toBe(true);
    const mergeCall = rpcCalls.find((c) => c.fnName === "merge_subscription_metadata");
    expect(mergeCall.args.p_user_id).toBe("user_a");
    expect(mergeCall.args.p_metadata.last_failed_payment_id).toBe("pay_a_fail_001");
  });

  // 3. subscription.pending arrives after mandate is active -> no downgrade
  it("Test 3: subscription.pending arriving after mandate is active causes no downgrade", async () => {
    let rpcCalledWith: any = null;
    const mockSupabaseAdmin = {
      from: vi.fn((table: string) => {
        if (table === "webhook_events") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        return {};
      }),
      rpc: vi.fn((fnName: string, args: any) => {
        rpcCalledWith = { fnName, args };
        // Simulate SQL state-machine guard returning ignored: true
        return Promise.resolve({
          data: {
            success: true,
            ignored: true,
            reason: "ACTIVE_CANNOT_DOWNGRADE_TO_PENDING",
            message: "Subscription is currently active; cannot downgrade to pending",
            subscription_id: args.p_razorpay_subscription_id,
            status: "active",
          },
          error: null,
        });
      }),
    };

    const payload = {
      event: "subscription.pending",
      event_id: "evt_sub_pending_late",
      payload: {
        subscription: {
          entity: {
            id: "sub_user_a_active",
            status: "pending",
          },
        },
      },
    };

    const req = createSignedWebhookRequest(payload);
    (req as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
    };

    const res = await webhookPost(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);
    expect(json.ignored).toBe(true);
    expect(json.reason).toBe("ACTIVE_CANNOT_DOWNGRADE_TO_PENDING");

    expect(rpcCalledWith.fnName).toBe("handle_subscription_lifecycle_event");
    expect(rpcCalledWith.args.p_event_type).toBe("subscription.pending");
  });

  // 4. Event with unknown or missing subscription_id -> no change, 200 returned
  it("Test 4: event with unknown or missing subscription_id does nothing and returns 200", async () => {
    const mockSupabaseAdmin = {
      from: vi.fn((table: string) => {
        if (table === "webhook_events") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        if (table === "subscriptions" || table === "payment_orders") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        return {};
      }),
      rpc: vi.fn(),
    };

    const payload = {
      event: "payment.failed",
      event_id: "evt_pay_unknown_mandate",
      payload: {
        payment: {
          entity: {
            id: "pay_unknown_999",
            subscription_id: "sub_nonexistent_unknown_999",
          },
        },
      },
    };

    const req = createSignedWebhookRequest(payload);
    (req as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
    };

    const res = await webhookPost(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);
    expect(json.ignored).toBe(true);
    expect(json.reason).toBe("MANDATE_NOT_FOUND");

    // No RPC state transitions were executed
    expect(mockSupabaseAdmin.rpc).not.toHaveBeenCalled();
  });

  // 5. Invalid signature -> rejected (400), no DB writes
  it("Test 5: invalid signature is rejected with 400 and performs zero DB writes", async () => {
    const mockSupabaseAdmin = {
      from: vi.fn(),
      rpc: vi.fn(),
    };

    const payload = {
      event: "payment.failed",
      event_id: "evt_fake_sig",
      payload: {
        payment: {
          entity: {
            id: "pay_fake_001",
            subscription_id: "sub_fake_001",
          },
        },
      },
    };

    const req = createSignedWebhookRequest(payload, "invalid_forged_hmac_signature_hex");
    (req as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
    };

    const res = await webhookPost(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_SIGNATURE");

    // Zero DB queries or writes
    expect(mockSupabaseAdmin.from).not.toHaveBeenCalled();
    expect(mockSupabaseAdmin.rpc).not.toHaveBeenCalled();
  });

  // 6. Duplicate event delivery -> processed once (dedupe)
  it("Test 6: duplicate event delivery is acknowledged as alreadyProcessed without re-execution", async () => {
    let lookupCount = 0;
    const mockSupabaseAdmin = {
      from: vi.fn((table: string) => {
        if (table === "webhook_events") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockImplementation(() => {
              lookupCount++;
              if (lookupCount > 1) {
                // Return dedupe match
                return Promise.resolve({
                  data: { event_id: "evt_dupe_test_123" },
                  error: null,
                });
              }
              return Promise.resolve({ data: null, error: null });
            }),
            upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        if (table === "subscriptions" || table === "payment_orders") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: "sub_1", user_id: "user_1", status: "active" },
              error: null,
            }),
          };
        }
        return {};
      }),
      rpc: vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
    };

    const payload = {
      event: "payment.failed",
      event_id: "evt_dupe_test_123",
      payload: {
        payment: {
          entity: {
            id: "pay_dupe_001",
            subscription_id: "sub_1",
          },
        },
      },
    };

    // First call
    const req1 = createSignedWebhookRequest(payload);
    (req1 as any).__testDeps = { getSupabaseAdmin: () => mockSupabaseAdmin };
    const res1 = await webhookPost(req1);
    expect(res1.status).toBe(200);

    // Second duplicate call
    const req2 = createSignedWebhookRequest(payload);
    (req2 as any).__testDeps = { getSupabaseAdmin: () => mockSupabaseAdmin };
    const res2 = await webhookPost(req2);
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.alreadyProcessed).toBe(true);
  });

  // 7. Genuine subscription.cancelled for A -> only A's mandate cancelled
  it("Test 7: genuine subscription.cancelled for User A cancels only User A's mandate", async () => {
    let rpcCalledWith: any = null;
    const mockSupabaseAdmin = {
      from: vi.fn((table: string) => {
        if (table === "webhook_events") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        return {};
      }),
      rpc: vi.fn((fnName: string, args: any) => {
        rpcCalledWith = { fnName, args };
        return Promise.resolve({
          data: {
            success: true,
            applied: true,
            status: "active",
            cancel_at_period_end: true,
            subscription_id: args.p_razorpay_subscription_id,
          },
          error: null,
        });
      }),
    };

    const payload = {
      event: "subscription.cancelled",
      event_id: "evt_sub_cancelled_user_a",
      payload: {
        subscription: {
          entity: {
            id: "sub_user_a_active",
            status: "cancelled",
          },
        },
      },
    };

    const req = createSignedWebhookRequest(payload);
    (req as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
    };

    const res = await webhookPost(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);
    expect(json.applied).toBe(true);
    expect(json.cancel_at_period_end).toBe(true);

    expect(rpcCalledWith.fnName).toBe("handle_subscription_lifecycle_event");
    expect(rpcCalledWith.args.p_razorpay_subscription_id).toBe("sub_user_a_active");
    expect(rpcCalledWith.args.p_event_type).toBe("subscription.cancelled");
  });
});
