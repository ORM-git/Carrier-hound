import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { POST as verifyPost } from "@/app/api/billing/razorpay/verify/route";

describe("Issue 2: Mandate Ownership Verification & Cross-Linking Protection", () => {
  const KEY_ID = "rzp_test_key_issue2";
  const KEY_SECRET = "rzp_test_secret_key_issue2";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = KEY_ID;
    process.env.RAZORPAY_KEY_ID = KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  });

  function signSubscription(paymentId: string, subscriptionId: string): string {
    return crypto
      .createHmac("sha256", KEY_SECRET)
      .update(`${paymentId}|${subscriptionId}`)
      .digest("hex");
  }

  function signOrder(orderId: string, paymentId: string): string {
    return crypto
      .createHmac("sha256", KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
  }

  function makeRequest(body: any, token: string = "token_user_x"): Request {
    return new Request("https://careermonke.com/api/billing/razorpay/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  // 1. User Y calls verify with User X's subscription_id -> rejected 403 MANDATE_OWNERSHIP_MISMATCH
  it("Test 1: User Y calls verify with User X's subscription_id -> rejected 403 MANDATE_OWNERSHIP_MISMATCH", async () => {
    const paymentId = "pay_test_001";
    const subscriptionId = "sub_user_x_mandate";
    const signature = signSubscription(paymentId, subscriptionId);

    const mockFetchCaller = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: subscriptionId,
        customer_id: "cust_x",
        status: "authenticated",
        notes: {
          userId: "user_x",
          user_id: "user_x",
        },
      }),
    });

    const mockSupabaseAdmin = {
      auth: {
        getUser: vi.fn(async (tok: string) => {
          if (tok === "token_user_y") {
            return { data: { user: { id: "user_y", email: "usery@example.com" } }, error: null };
          }
          return { data: { user: { id: "user_x", email: "userx@example.com" } }, error: null };
        }),
      },
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
      rpc: vi.fn(),
    };

    const req = makeRequest(
      {
        subscription_id: subscriptionId,
        payment_id: paymentId,
        razorpay_signature: signature,
      },
      "token_user_y"
    );
    (req as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
      fetchCaller: mockFetchCaller,
    };

    const res = await verifyPost(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("MANDATE_OWNERSHIP_MISMATCH");
    expect(mockSupabaseAdmin.rpc).not.toHaveBeenCalled();
  });

  // 2. notes.userId mismatch -> rejected 403 MANDATE_OWNERSHIP_MISMATCH
  it("Test 2: notes.userId mismatch -> rejected 403 MANDATE_OWNERSHIP_MISMATCH", async () => {
    const paymentId = "pay_test_002";
    const subscriptionId = "sub_mismatch_002";
    const signature = signSubscription(paymentId, subscriptionId);

    const mockFetchCaller = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: subscriptionId,
        customer_id: "cust_attacker",
        status: "authenticated",
        notes: {
          userId: "user_victim",
        },
      }),
    });

    const mockSupabaseAdmin = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "user_attacker", email: "attacker@example.com" } },
          error: null,
        })),
      },
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
      rpc: vi.fn(),
    };

    const req = makeRequest(
      {
        subscription_id: subscriptionId,
        payment_id: paymentId,
        razorpay_signature: signature,
      },
      "token_attacker"
    );
    (req as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
      fetchCaller: mockFetchCaller,
    };

    const res = await verifyPost(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("MANDATE_OWNERSHIP_MISMATCH");
    expect(mockSupabaseAdmin.rpc).not.toHaveBeenCalled();
  });

  // 3. notes.nonce mismatch -> rejected 403 MANDATE_NONCE_MISMATCH
  it("Test 3: notes.nonce mismatch -> rejected 403 MANDATE_NONCE_MISMATCH", async () => {
    const paymentId = "pay_test_003";
    const subscriptionId = "sub_nonce_003";
    const signature = signSubscription(paymentId, subscriptionId);

    const mockFetchCaller = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: subscriptionId,
        customer_id: "cust_x",
        status: "authenticated",
        notes: {
          userId: "user_x",
          nonce: "nonce_tampered_or_stale",
        },
      }),
    });

    const mockOrderRow = {
      id: "ord_db_123",
      user_id: "user_x",
      provider_order_id: subscriptionId,
      status: "created",
      metadata: {
        nonce: "nonce_original_session",
      },
    };

    const mockSupabaseAdmin = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "user_x", email: "userx@example.com" } },
          error: null,
        })),
      },
      from: vi.fn((table: string) => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockImplementation(() => {
          if (table === "payment_orders") {
            return Promise.resolve({ data: mockOrderRow, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      })),
      rpc: vi.fn(),
    };

    const req = makeRequest(
      {
        subscription_id: subscriptionId,
        payment_id: paymentId,
        razorpay_signature: signature,
      },
      "token_user_x"
    );
    (req as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
      fetchCaller: mockFetchCaller,
    };

    const res = await verifyPost(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("MANDATE_NONCE_MISMATCH");
    expect(mockSupabaseAdmin.rpc).not.toHaveBeenCalled();
  });

  // 4. customer_id mismatch: customer belonging to user X cannot be claimed by user Y
  it("Test 4: customer_id mismatch -> customer belonging to user X cannot be claimed by user Y -> rejected 403 CUSTOMER_OWNERSHIP_MISMATCH", async () => {
    const paymentId = "pay_test_004";
    const subscriptionId = "sub_test_cust_004";
    const signature = signSubscription(paymentId, subscriptionId);

    const mockFetchCaller = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: subscriptionId,
        customer_id: "cust_shared_belonging_to_user_x",
        status: "authenticated",
        notes: {
          userId: "user_y",
        },
      }),
    });

    const mockOrderRow = {
      id: "ord_cust_4",
      user_id: "user_y",
      provider_order_id: subscriptionId,
      status: "created",
      mode: "test",
    };

    const mockSupabaseAdmin = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "user_y", email: "usery@example.com" } },
          error: null,
        })),
      },
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: mockOrderRow, error: null }),
        update: vi.fn().mockReturnThis(),
      })),
      rpc: vi.fn(async (rpcName: string) => {
        if (rpcName === "fulfil_subscription_renewal") {
          return {
            data: {
              success: false,
              code: "CUSTOMER_OWNERSHIP_MISMATCH",
              error: "Mandate customer belongs to another user account",
            },
            error: null,
          };
        }
        return { data: null, error: null };
      }),
    };

    const req = makeRequest(
      {
        subscription_id: subscriptionId,
        payment_id: paymentId,
        razorpay_signature: signature,
      },
      "token_user_y"
    );
    (req as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
      fetchCaller: mockFetchCaller,
    };

    const res = await verifyPost(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("CUSTOMER_OWNERSHIP_MISMATCH");
    expect(mockSupabaseAdmin.rpc).toHaveBeenCalled();
  });

  // 5. Mandate already attached to another user in DB -> rejected 403 MANDATE_ATTACHED_TO_ANOTHER_USER
  it("Test 5: Mandate already attached to another user in DB -> rejected 403 MANDATE_ATTACHED_TO_ANOTHER_USER", async () => {
    const paymentId = "pay_test_005";
    const subscriptionId = "sub_test_cross_005";
    const signature = signSubscription(paymentId, subscriptionId);

    const mockFetchCaller = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: subscriptionId,
        status: "authenticated",
        notes: {
          userId: "user_y",
        },
      }),
    });

    const mockOrderRow = {
      id: "ord_cross_5",
      user_id: "user_y",
      provider_order_id: subscriptionId,
      status: "created",
      mode: "test",
    };

    const mockSupabaseAdmin = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "user_y", email: "usery@example.com" } },
          error: null,
        })),
      },
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: mockOrderRow, error: null }),
        update: vi.fn().mockReturnThis(),
      })),
      rpc: vi.fn(async (rpcName: string) => {
        if (rpcName === "fulfil_subscription_renewal") {
          return {
            data: {
              success: false,
              code: "MANDATE_ATTACHED_TO_ANOTHER_USER",
              error: "Mandate is attached to another user account",
            },
            error: null,
          };
        }
        return { data: null, error: null };
      }),
    };

    const req = makeRequest(
      {
        subscription_id: subscriptionId,
        payment_id: paymentId,
        razorpay_signature: signature,
      },
      "token_user_y"
    );
    (req as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
      fetchCaller: mockFetchCaller,
    };

    const res = await verifyPost(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("MANDATE_ATTACHED_TO_ANOTHER_USER");
    expect(mockSupabaseAdmin.rpc).toHaveBeenCalled();
  });

  // 6. Invalid / tampered signature -> rejected 400 INVALID_SIGNATURE
  it("Test 6: Invalid / tampered signature -> rejected 400 INVALID_SIGNATURE", async () => {
    const paymentId = "pay_test_006";
    const subscriptionId = "sub_sig_006";
    const signature = "tampered_signature_hex_0000000000000000000000000000000000000000000000000000000000000000";

    const mockFetchCaller = vi.fn();
    const mockSupabaseAdmin = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "user_x", email: "userx@example.com" } },
          error: null,
        })),
      },
      from: vi.fn(),
      rpc: vi.fn(),
    };

    const req = makeRequest(
      {
        subscription_id: subscriptionId,
        payment_id: paymentId,
        razorpay_signature: signature,
      },
      "token_user_x"
    );
    (req as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
      fetchCaller: mockFetchCaller,
    };

    const res = await verifyPost(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_SIGNATURE");
    expect(mockFetchCaller).not.toHaveBeenCalled();
    expect(mockSupabaseAdmin.rpc).not.toHaveBeenCalled();
  });

  // 7. Happy path: correct user links own mandate with matching signature, notes, and nonce -> 200 success
  it("Test 7: Happy path: correct user links own mandate with matching signature, notes, and nonce -> 200 success", async () => {
    const paymentId = "pay_test_007";
    const subscriptionId = "sub_happy_007";
    const signature = signSubscription(paymentId, subscriptionId);
    const nonce = "nonce_verified_12345";

    const mockFetchCaller = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: subscriptionId,
        customer_id: "cust_happy_x",
        status: "authenticated",
        notes: {
          userId: "user_x",
          nonce,
        },
      }),
    });

    const mockOrderRow = {
      id: "ord_happy_1",
      user_id: "user_x",
      provider_order_id: subscriptionId,
      status: "created",
      mode: "test",
      metadata: { nonce },
    };

    const mockSubUpdate = vi.fn().mockResolvedValue({ data: null, error: null });

    const mockSupabaseAdmin = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "user_x", email: "userx@example.com" } },
          error: null,
        })),
      },
      from: vi.fn((table: string) => {
        if (table === "payment_orders") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            neq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: mockOrderRow, error: null }),
            update: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({ data: null, error: null }),
            })),
          };
        }
        if (table === "subscriptions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            neq: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            update: vi.fn(() => ({
              eq: mockSubUpdate,
            })),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
      rpc: vi.fn(async (rpcName: string, args: any) => {
        if (rpcName === "fulfil_subscription_renewal") {
          return {
            data: {
              success: true,
              subscription_id: args.p_razorpay_subscription_id,
              status: "active",
            },
            error: null,
          };
        }
        return { data: null, error: null };
      }),
    };

    const req = makeRequest(
      {
        subscription_id: subscriptionId,
        payment_id: paymentId,
        razorpay_signature: signature,
      },
      "token_user_x"
    );
    (req as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
      fetchCaller: mockFetchCaller,
    };

    const res = await verifyPost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.subscriptionId).toBe(subscriptionId);
    expect(mockSupabaseAdmin.rpc).toHaveBeenCalledWith("fulfil_subscription_renewal", {
      p_razorpay_subscription_id: subscriptionId,
      p_payment_id: paymentId,
      p_expected_mode: "test",
    });
  });

  // 8. Two concurrent link requests for the same mandate: second sees already paid
  it("Test 8: Two concurrent link requests for the same mandate: second sees already paid -> idempotent 200 without duplicate grant", async () => {
    const paymentId = "pay_test_008";
    const subscriptionId = "sub_concurrent_008";
    const signature = signSubscription(paymentId, subscriptionId);

    const mockFetchCaller = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: subscriptionId,
        status: "active",
        notes: {
          userId: "user_x",
        },
      }),
    });

    const mockPaidOrderRow = {
      id: "ord_paid_1",
      user_id: "user_x",
      provider_order_id: subscriptionId,
      status: "paid", // Already marked paid by the winning concurrent request
      mode: "test",
    };

    const mockSupabaseAdmin = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "user_x", email: "userx@example.com" } },
          error: null,
        })),
      },
      from: vi.fn((table: string) => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockImplementation(() => {
          if (table === "payment_orders") {
            return Promise.resolve({ data: mockPaidOrderRow, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      })),
      rpc: vi.fn(),
    };

    const req = makeRequest(
      {
        subscription_id: subscriptionId,
        payment_id: paymentId,
        razorpay_signature: signature,
      },
      "token_user_x"
    );
    (req as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
      fetchCaller: mockFetchCaller,
    };

    const res = await verifyPost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.alreadyPaid).toBe(true);
    expect(mockSupabaseAdmin.rpc).not.toHaveBeenCalled();
  });

  // 9. One-time order cross-user ownership check: User Y calls verify with User X's order_id -> rejected 403
  it("Test 9: User Y calls verify with User X's one-time order_id -> rejected 403 ORDER_OWNERSHIP_MISMATCH", async () => {
    const orderId = "order_user_x_999";
    const paymentId = "pay_test_009";
    const signature = signOrder(orderId, paymentId);

    const mockSupabaseAdmin = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "user_y", email: "usery@example.com" } },
          error: null,
        })),
      },
      from: vi.fn((table: string) => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockImplementation(() => {
          if (table === "payment_orders") {
            // Order belongs to user_x in DB
            return Promise.resolve({ data: { user_id: "user_x" }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      })),
      rpc: vi.fn(),
    };

    const req = makeRequest(
      {
        order_id: orderId,
        payment_id: paymentId,
        razorpay_signature: signature,
      },
      "token_user_y"
    );
    (req as any).__testDeps = {
      getSupabaseAdmin: () => mockSupabaseAdmin,
    };

    const res = await verifyPost(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("ORDER_OWNERSHIP_MISMATCH");
    expect(mockSupabaseAdmin.rpc).not.toHaveBeenCalled();
  });
});
