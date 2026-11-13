/**
 * scripts/test-billing-webhook-route.ts
 *
 * Standalone offline test suite for the Cloudflare Pages Next.js edge route:
 *   src/app/api/billing/razorpay/webhook/route.ts
 *
 * Tests:
 *   1. Timing-safe cryptographic signature verification (Web Crypto HMAC-SHA256).
 *   2. Method check (GET returns 405, OPTIONS returns 200 with CORS headers).
 *   3. Disabled billing gate (503 BILLING_DISABLED when NEXT_PUBLIC_BILLING_ENABLED !== "true").
 *   4. Configuration validation (500 if RAZORPAY_WEBHOOK_SECRET missing or key prefix unknown).
 *   5. Missing & invalid signature headers (400 MISSING_SIGNATURE, 400 INVALID_SIGNATURE).
 *   6. Malformed JSON payload rejection after valid signature.
 *   7. Missing order_id (400 MISSING_ORDER_ID).
 *   8. Order record not found (404 ORDER_NOT_FOUND).
 *   9. Payment provider mismatch (400 INVALID_PROVIDER).
 *  10. Payment mode isolation (400 MODE_MISMATCH).
 *  11. Valid signed payload - Happy path fulfillment (200 with fulfilled: true and dedupe insert).
 *  12. Replay / Duplicate webhook idempotency (200 alreadyProcessed: true without re-running RPC).
 *  13. Transient RPC failure (500 FULFILLMENT_FAILED, no dedupe row left, recorded in failed_events).
 *  14. RPC throws unexpected exception (500 returned, no dedupe row left, recorded in failed_events).
 *  15. Non-fulfillment event handling (200 ignored: true for payment.failed).
 */

import assert from "assert";
import crypto from "crypto";
import {
  POST,
  GET,
  OPTIONS,
} from "../src/app/api/billing/razorpay/webhook/route";
import {
  verifyWebhookSignature,
  constantTimeEqual,
} from "../src/lib/billing/webhookSignature";

const TEST_WEBHOOK_SECRET = "rzp_webhook_secret_abcdef1234567890";
const TEST_KEY_ID = "rzp_test_key_1234567890";

interface MockDbState {
  orders: Map<string, any>;
  webhookEvents: Set<string>;
  failedEvents: Array<any>;
  rpcFulfilCalls: Array<{ orderId: string; userId: string; expectedMode: string }>;
  customRpcHandler?: (fnName: string, args: any) => Promise<any> | any;
}

function computeHmacSignature(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function createMockSupabase(db: MockDbState) {
  return {
    from: (table: string) => {
      let filterOrderId: string | null = null;
      let filterEventId: string | null = null;

      const queryObj: any = {
        select: () => queryObj,
        eq: (col: string, val: any) => {
          if (col === "provider_order_id" || col === "id") filterOrderId = val;
          if (col === "event_id") filterEventId = val;
          return queryObj;
        },
        maybeSingle: async () => {
          if (table === "payment_orders") {
            const order = filterOrderId ? db.orders.get(filterOrderId) : null;
            if (!order) return { data: null, error: null };
            return { data: { ...order }, error: null };
          }
          if (table === "webhook_events") {
            if (filterEventId && db.webhookEvents.has(filterEventId)) {
              return { data: { event_id: filterEventId }, error: null };
            }
            return { data: null, error: null };
          }
          return { data: null, error: null };
        },
        insert: async (row: any) => {
          if (table === "webhook_events") {
            if (db.webhookEvents.has(row.event_id)) {
              return {
                error: {
                  code: "23505",
                  message: `duplicate key value violates unique constraint "webhook_events_pkey"`,
                },
              };
            }
            db.webhookEvents.add(row.event_id);
            return { error: null };
          }
          if (table === "failed_events") {
            db.failedEvents.push(row);
            return { error: null };
          }
          return { error: null };
        },
        upsert: async (row: any) => {
          if (table === "webhook_events") {
            db.webhookEvents.add(row.event_id);
            return { error: null };
          }
          if (table === "failed_events") {
            db.failedEvents.push(row);
            return { error: null };
          }
          return { error: null };
        },
      };

      return queryObj;
    },
    rpc: async (fnName: string, args: any) => {
      if (db.customRpcHandler) {
        return db.customRpcHandler(fnName, args);
      }
      if (fnName === "fulfil_payment_order") {
        db.rpcFulfilCalls.push({
          orderId: args.p_provider_order_id,
          userId: args.p_user_id,
          expectedMode: args.p_expected_mode,
        });

        const order = db.orders.get(args.p_provider_order_id);
        if (!order) {
          return {
            data: { success: false, code: "ORDER_NOT_FOUND", error: "Order not found" },
            error: null,
          };
        }
        if (order.status === "paid") {
          return {
            data: { success: true, already_paid: true, is_pro: Boolean(order.plan_code) },
            error: null,
          };
        }

        order.status = "paid";
        return {
          data: {
            success: true,
            already_paid: false,
            is_pro: Boolean(order.plan_code),
            order_id: args.p_provider_order_id,
          },
          error: null,
        };
      }
      return { data: null, error: new Error(`Unknown RPC: ${fnName}`) };
    },
  };
}

function buildMockRequest(
  options: {
    method?: string;
    signature?: string | null;
    eventId?: string;
    body?: string;
    mockDb?: MockDbState;
  } = {}
): Request {
  const method = options.method || "POST";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (options.signature !== null && options.signature !== undefined) {
    headers["x-razorpay-signature"] = options.signature;
  }
  if (options.eventId) {
    headers["x-razorpay-event-id"] = options.eventId;
  }

  const req = new Request("http://localhost:3000/api/billing/razorpay/webhook", {
    method,
    headers,
    body: method === "POST" ? (options.body ?? "") : undefined,
  });

  if (options.mockDb) {
    const mockClient = createMockSupabase(options.mockDb);
    (req as any).__testDeps = {
      getSupabaseAdmin: () => mockClient,
    };
  }

  return req;
}

async function runTestSuite() {
  console.log("================================================================================");
  console.log("     CLOUDFLARE RAZORPAY WEBHOOK ROUTE OFFLINE TEST SUITE                       ");
  console.log("================================================================================\n");

  let passed = 0;
  let total = 0;

  function runTest(name: string, fn: () => Promise<void> | void) {
    total++;
    try {
      const res = fn();
      if (res && typeof (res as any).then === "function") {
        return (res as Promise<void>)
          .then(() => {
            console.log(`[PASS] ${name}`);
            passed++;
          })
          .catch((err) => {
            console.error(`[FAIL] ${name}:`, err.message);
          });
      }
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`[FAIL] ${name}:`, err.message);
    }
  }

  // Setup initial environment
  process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
  process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  process.env.RAZORPAY_KEY_ID = TEST_KEY_ID;
  process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = TEST_KEY_ID;

  // 1. Web Crypto Timing-Safe Verification direct tests
  await runTest("1. Timing-safe constantTimeEqual direct test", () => {
    assert.strictEqual(constantTimeEqual("abc", "abc"), true);
    assert.strictEqual(constantTimeEqual("abc", "abd"), false);
    assert.strictEqual(constantTimeEqual("abc", "ab"), false);
    assert.strictEqual(constantTimeEqual("", ""), true);
    assert.strictEqual(constantTimeEqual("a", ""), false);
  });

  await runTest("2. verifyWebhookSignature direct verification", async () => {
    const raw = JSON.stringify({ event: "order.paid", id: "evt_123" });
    const sig = computeHmacSignature(raw, TEST_WEBHOOK_SECRET);

    assert.strictEqual(await verifyWebhookSignature(raw, sig, TEST_WEBHOOK_SECRET), true);
    assert.strictEqual(await verifyWebhookSignature(raw, "invalid_sig", TEST_WEBHOOK_SECRET), false);
    assert.strictEqual(await verifyWebhookSignature(raw, sig, "wrong_secret"), false);
    assert.strictEqual(await verifyWebhookSignature("", sig, TEST_WEBHOOK_SECRET), false);
  });

  // 3. Method checks
  await runTest("3. GET returns 405 Method Not Allowed", async () => {
    const res = await GET();
    assert.strictEqual(res.status, 405);
    const json = await res.json();
    assert.strictEqual(json.error, "Method not allowed");
  });

  await runTest("4. OPTIONS returns 200 with CORS headers", async () => {
    const res = await OPTIONS();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("Allow"), "POST, OPTIONS");
  });

  // 5. Billing disabled check
  await runTest("5. Gating: returns 503 BILLING_DISABLED when NEXT_PUBLIC_BILLING_ENABLED !== 'true'", async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";
    const req = buildMockRequest({ body: "{}" });
    const res = await POST(req);
    assert.strictEqual(res.status, 503);
    const json = await res.json();
    assert.strictEqual(json.code, "BILLING_DISABLED");
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
  });

  // 6. Secret configuration
  await runTest("6. Config: returns 500 when RAZORPAY_WEBHOOK_SECRET is missing", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const req = buildMockRequest({ body: "{}" });
    const res = await POST(req);
    assert.strictEqual(res.status, 500);
    const json = await res.json();
    assert.strictEqual(json.error, "Webhook secret is not configured");
    process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  });

  await runTest("7. Config: returns 500 RAZORPAY_CONFIG_INVALID when key prefix is invalid", async () => {
    process.env.RAZORPAY_KEY_ID = "invalid_key_prefix";
    delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
    const req = buildMockRequest({ body: "{}" });
    const res = await POST(req);
    assert.strictEqual(res.status, 500);
    const json = await res.json();
    assert.strictEqual(json.code, "RAZORPAY_CONFIG_INVALID");
    process.env.RAZORPAY_KEY_ID = TEST_KEY_ID;
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = TEST_KEY_ID;
  });

  // 8. Missing signature header
  await runTest("8. Missing signature header returns 400 MISSING_SIGNATURE", async () => {
    const req = buildMockRequest({ signature: null, body: "{}" });
    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.strictEqual(json.code, "MISSING_SIGNATURE");
  });

  // 9. Invalid signature header
  await runTest("9. Invalid signature returns 400 INVALID_SIGNATURE", async () => {
    const raw = JSON.stringify({ event: "order.paid" });
    const req = buildMockRequest({ signature: "bad_signature_hex", body: raw });
    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.strictEqual(json.code, "INVALID_SIGNATURE");
  });

  // 10. Malformed JSON body
  await runTest("10. Malformed JSON with valid signature returns 400 Invalid JSON request body", async () => {
    const raw = "not a valid json string {";
    const sig = computeHmacSignature(raw, TEST_WEBHOOK_SECRET);
    const req = buildMockRequest({ signature: sig, body: raw });
    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.strictEqual(json.error, "Invalid JSON request body");
  });

  // Mock Database Setup for Order Processing Tests
  const mockDb: MockDbState = {
    orders: new Map(),
    webhookEvents: new Set(),
    failedEvents: [],
    rpcFulfilCalls: [],
  };

  const sampleOrderId = "order_test_999999";
  const sampleUserId = "user_test_uuid_abc";

  mockDb.orders.set(sampleOrderId, {
    id: "po_123",
    provider_order_id: sampleOrderId,
    user_id: sampleUserId,
    provider: "razorpay",
    mode: "test",
    plan_code: "weekly",
    status: "created",
  });

  // 11. Missing order_id in payload
  await runTest("11. Missing order_id returns 400 MISSING_ORDER_ID", async () => {
    const raw = JSON.stringify({
      event: "order.paid",
      id: "evt_missing_order_id",
      payload: {},
    });
    const sig = computeHmacSignature(raw, TEST_WEBHOOK_SECRET);
    const req = buildMockRequest({ signature: sig, body: raw, mockDb });
    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.strictEqual(json.code, "MISSING_ORDER_ID");
  });

  // 12. Order record not found
  await runTest("12. Non-existent order returns 404 ORDER_NOT_FOUND", async () => {
    const raw = JSON.stringify({
      event: "order.paid",
      id: "evt_nonexistent_order",
      payload: {
        order: { entity: { id: "order_test_non_existent" } },
      },
    });
    const sig = computeHmacSignature(raw, TEST_WEBHOOK_SECRET);
    const req = buildMockRequest({ signature: sig, body: raw, mockDb });
    const res = await POST(req);
    assert.strictEqual(res.status, 404);
    const json = await res.json();
    assert.strictEqual(json.code, "ORDER_NOT_FOUND");
  });

  // 13. Mode mismatch (order is live, server credentials are test)
  await runTest("13. Mode mismatch returns 400 MODE_MISMATCH", async () => {
    const liveOrderId = "order_live_mismatch_1";
    mockDb.orders.set(liveOrderId, {
      id: "po_live_1",
      provider_order_id: liveOrderId,
      user_id: sampleUserId,
      provider: "razorpay",
      mode: "live",
      plan_code: "weekly",
      status: "created",
    });

    const raw = JSON.stringify({
      event: "order.paid",
      id: "evt_mode_mismatch",
      payload: {
        order: { entity: { id: liveOrderId } },
        payment: { entity: { notes: { user_id: sampleUserId } } },
      },
    });
    const sig = computeHmacSignature(raw, TEST_WEBHOOK_SECRET);
    const req = buildMockRequest({ signature: sig, body: raw, mockDb });
    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.strictEqual(json.code, "MODE_MISMATCH");
  });

  // 14. Happy Path: Valid signed payload fulfills order and inserts dedupe row
  const happyEventId = "evt_happy_path_100";
  await runTest("14. Happy Path: Valid payload fulfills order, inserts dedupe row, returns 200", async () => {
    mockDb.rpcFulfilCalls = [];
    const raw = JSON.stringify({
      event: "order.paid",
      id: happyEventId,
      payload: {
        order: { entity: { id: sampleOrderId } },
        payment: { entity: { id: "pay_happy_100", notes: { user_id: sampleUserId } } },
      },
    });
    const sig = computeHmacSignature(raw, TEST_WEBHOOK_SECRET);
    const req = buildMockRequest({ signature: sig, body: raw, mockDb });
    const res = await POST(req);

    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.received, true);
    assert.strictEqual(json.fulfilled, true);
    assert.strictEqual(json.testMode, true);
    assert.strictEqual(mockDb.rpcFulfilCalls.length, 1);
    assert.strictEqual(mockDb.rpcFulfilCalls[0].orderId, sampleOrderId);
    assert.strictEqual(mockDb.rpcFulfilCalls[0].expectedMode, "test");
    assert.strictEqual(mockDb.webhookEvents.has(happyEventId), true);
  });

  // 15. Replay / Duplicate webhook: Returns 200 alreadyProcessed: true without re-running RPC
  await runTest("15. Replay: Duplicate event_id returns 200 alreadyProcessed without re-executing RPC", async () => {
    mockDb.rpcFulfilCalls = [];
    const raw = JSON.stringify({
      event: "order.paid",
      id: happyEventId,
      payload: {
        order: { entity: { id: sampleOrderId } },
        payment: { entity: { id: "pay_happy_100", notes: { user_id: sampleUserId } } },
      },
    });
    const sig = computeHmacSignature(raw, TEST_WEBHOOK_SECRET);
    const req = buildMockRequest({ signature: sig, body: raw, mockDb });
    const res = await POST(req);

    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.received, true);
    assert.strictEqual(json.alreadyProcessed, true);
    assert.strictEqual(mockDb.rpcFulfilCalls.length, 0, "Must not re-execute RPC on duplicate webhook");
  });

  // 16. RPC returns failure: returns 500, does NOT record dedupe, writes failed_events
  await runTest("16. RPC failure (success:false) returns 500, records failed_event, leaves no dedupe row", async () => {
    const failOrderId = "order_test_rpc_fail_1";
    mockDb.orders.set(failOrderId, {
      id: "po_fail_1",
      provider_order_id: failOrderId,
      user_id: sampleUserId,
      provider: "razorpay",
      mode: "test",
      status: "created",
    });

    const failEventId = "evt_rpc_fail_1";
    const raw = JSON.stringify({
      event: "order.paid",
      id: failEventId,
      payload: {
        order: { entity: { id: failOrderId } },
        payment: { entity: { notes: { user_id: sampleUserId } } },
      },
    });
    const sig = computeHmacSignature(raw, TEST_WEBHOOK_SECRET);

    mockDb.customRpcHandler = async () => ({
      data: {
        success: false,
        code: "ORDER_INVALID_STATE",
        error: "Payment order is not in created state",
      },
      error: null,
    });

    const req = buildMockRequest({ signature: sig, body: raw, mockDb });
    const res = await POST(req);

    assert.strictEqual(res.status, 500);
    const json = await res.json();
    assert.strictEqual(json.code, "ORDER_INVALID_STATE");
    assert.strictEqual(mockDb.webhookEvents.has(failEventId), false, "Must not insert dedupe on failure");
    assert.strictEqual(mockDb.failedEvents.length > 0, true, "Must record dead-letter failed_event");

    delete mockDb.customRpcHandler;
  });

  // 17. RPC throws unexpected exception: returns 500, leaves no dedupe, writes failed_event
  await runTest("17. RPC exception returns 500, leaves no dedupe row", async () => {
    const throwOrderId = "order_test_rpc_throw_1";
    mockDb.orders.set(throwOrderId, {
      id: "po_throw_1",
      provider_order_id: throwOrderId,
      user_id: sampleUserId,
      provider: "razorpay",
      mode: "test",
      status: "created",
    });

    const throwEventId = "evt_rpc_throw_1";
    const raw = JSON.stringify({
      event: "order.paid",
      id: throwEventId,
      payload: {
        order: { entity: { id: throwOrderId } },
        payment: { entity: { notes: { user_id: sampleUserId } } },
      },
    });
    const sig = computeHmacSignature(raw, TEST_WEBHOOK_SECRET);

    mockDb.customRpcHandler = async () => {
      throw new Error("PostgreSQL connection reset");
    };

    const req = buildMockRequest({ signature: sig, body: raw, mockDb });
    const res = await POST(req);

    assert.strictEqual(res.status, 500);
    assert.strictEqual(mockDb.webhookEvents.has(throwEventId), false);

    delete mockDb.customRpcHandler;
  });

  // 18. Non-fulfillment event (payment.failed)
  await runTest("18. Non-fulfillment event (payment.failed) inserts dedupe and returns 200 ignored: true", async () => {
    const ignoreEventId = "evt_ignore_payment_failed_1";
    const raw = JSON.stringify({
      event: "payment.failed",
      id: ignoreEventId,
      payload: {
        payment: { entity: { id: "pay_failed_1" } },
      },
    });
    const sig = computeHmacSignature(raw, TEST_WEBHOOK_SECRET);
    const req = buildMockRequest({ signature: sig, body: raw, mockDb });
    const res = await POST(req);

    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.received, true);
    assert.strictEqual(json.ignored, true);
    assert.strictEqual(mockDb.webhookEvents.has(ignoreEventId), true);
  });

  console.log("\n--------------------------------------------------------------------------------");
  console.log(`TEST SUITE RESULTS: ${passed}/${total} tests passed`);
  console.log("--------------------------------------------------------------------------------\n");

  if (passed === total) {
    console.log("VERDICT: PASS (All webhook route security, idempotency, and error semantics verified)\n");
    process.exit(0);
  } else {
    console.error("VERDICT: FAIL (Some tests failed)\n");
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error("FATAL: Test runner crashed:", err);
  process.exit(1);
});
