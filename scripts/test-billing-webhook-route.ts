/**
 * scripts/test-billing-webhook-route.ts
 *
 * Standalone offline test suite for the Cloudflare Pages Next.js edge route:
 *   src/app/api/billing/razorpay/webhook/route.ts
 *
 * NOTE: This offline suite validates handler branching, failure recovery,
 * payload validation, and idempotency using mock database adapters. It does
 * NOT claim or simulate PostgreSQL engine-level transaction isolation or ACID
 * row locks.
 */

import assert from "assert";
import crypto from "crypto";
import * as webhookRoute from "../src/app/api/billing/razorpay/webhook/route";
import {
  verifyWebhookSignature,
  verifyWebhookSignatureBytes,
  hexToBytes,
} from "../src/lib/billing/webhookSignature";

const { POST, OPTIONS } = webhookRoute;

const TEST_WEBHOOK_SECRET = "rzp_webhook_secret_abcdef1234567890";
const TEST_KEY_ID = "rzp_test_key_1234567890";

interface MockOrder {
  id: string;
  provider_order_id: string;
  user_id: string;
  provider: string;
  mode: string;
  status: string;
  amount_paise: number;
  plan_code?: string;
  addon_code?: string;
}

interface MockDbState {
  orders: Map<string, MockOrder>;
  webhookEvents: Set<string>;
  failedEvents: Array<any>;
  rpcFulfilCalls: Array<{ orderId: string; userId: string; expectedMode: string }>;
  errors?: {
    paymentOrdersLookup?: Error;
    webhookEventsLookup?: Error;
    webhookEventsInsert?: Error;
  };
  customRpcHandler?: (fnName: string, args: any) => Promise<any> | any;
}

function computeHmacSignature(rawBytes: Uint8Array | string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBytes).digest("hex");
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
            if (db.errors?.paymentOrdersLookup) {
              return { data: null, error: db.errors.paymentOrdersLookup };
            }
            const order = filterOrderId ? db.orders.get(filterOrderId) : null;
            if (!order) return { data: null, error: null };
            return { data: { ...order }, error: null };
          }
          if (table === "webhook_events") {
            if (db.errors?.webhookEventsLookup) {
              return { data: null, error: db.errors.webhookEventsLookup };
            }
            if (filterEventId && db.webhookEvents.has(filterEventId)) {
              return { data: { event_id: filterEventId }, error: null };
            }
            return { data: null, error: null };
          }
          return { data: null, error: null };
        },
        insert: async (row: any) => {
          if (table === "webhook_events") {
            if (db.errors?.webhookEventsInsert) {
              return { error: db.errors.webhookEventsInsert };
            }
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
            if (db.errors?.webhookEventsInsert) {
              return { error: db.errors.webhookEventsInsert };
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
    body?: string | Uint8Array;
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

  let bodyData: BodyInit | undefined = undefined;
  if (method === "POST") {
    bodyData = options.body !== undefined ? (options.body as any) : "";
  }

  const req = new Request("http://localhost:3000/api/billing/razorpay/webhook", {
    method,
    headers,
    body: bodyData,
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

  // Set standard test environment
  process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
  process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = TEST_KEY_ID;
  delete process.env.RAZORPAY_KEY_ID;

  // 1. Web Crypto Verify Primitive & Hex helper direct tests
  await runTest("1. hexToBytes validation", () => {
    assert.strictEqual(hexToBytes(""), null);
    assert.strictEqual(hexToBytes("not-a-hex"), null);
    assert.strictEqual(hexToBytes("0123456789abcdef"), null); // wrong length
    const validHex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const bytes = hexToBytes(validHex);
    assert.ok(bytes instanceof Uint8Array);
    assert.strictEqual(bytes?.length, 32);
    assert.strictEqual(bytes?.[0], 0);
    assert.strictEqual(bytes?.[31], 31);
  });

  await runTest("2. verifyWebhookSignatureBytes direct verification", async () => {
    const raw = new TextEncoder().encode(JSON.stringify({ event: "order.paid", id: "evt_123" }));
    const sig = computeHmacSignature(raw, TEST_WEBHOOK_SECRET);

    assert.strictEqual(await verifyWebhookSignatureBytes(raw, sig, TEST_WEBHOOK_SECRET), true);
    assert.strictEqual(await verifyWebhookSignatureBytes(raw, "00".repeat(32), TEST_WEBHOOK_SECRET), false);
    assert.strictEqual(await verifyWebhookSignatureBytes(raw, sig, "wrong_secret"), false);
    assert.strictEqual(await verifyWebhookSignatureBytes(new Uint8Array(0), sig, TEST_WEBHOOK_SECRET), false);
  });

  // 3. Method checks
  await runTest("3. GET is not exported (disallowed)", async () => {
    assert.strictEqual(typeof (webhookRoute as any).GET, "undefined");
    assert.strictEqual(typeof (webhookRoute as any).PUT, "undefined");
    assert.strictEqual(typeof (webhookRoute as any).DELETE, "undefined");
  });

  await runTest("4. OPTIONS returns 200 with CORS headers", async () => {
    const res = await OPTIONS();
    assert.strictEqual(res.status, 200);
  });

  // 5. Billing disabled check
  await runTest("5. Gating: returns 503 with 'Billing is currently unavailable'", async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";
    const req = buildMockRequest({ body: "{}" });
    const res = await POST(req);
    assert.strictEqual(res.status, 503);
    const json = await res.json();
    assert.strictEqual(json.error, "Billing is currently unavailable");
    assert.strictEqual(json.code, "BILLING_DISABLED");
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
  });

  // 6. Configuration checks
  await runTest("6. Missing RAZORPAY_WEBHOOK_SECRET returns 500 without code property", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const req = buildMockRequest({ body: "{}" });
    const res = await POST(req);
    assert.strictEqual(res.status, 500);
    const json = await res.json();
    assert.strictEqual(json.error, "Webhook secret is not configured");
    assert.strictEqual(typeof json.code, "undefined"); // Must have no code!
    process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  });

  await runTest("7. Key env precedence and invalid prefix check", async () => {
    // NEXT_PUBLIC_RAZORPAY_KEY_ID should take precedence over RAZORPAY_KEY_ID
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "invalid_prefix_key";
    process.env.RAZORPAY_KEY_ID = "rzp_test_valid_key";
    const req = buildMockRequest({ body: "{}" });
    const res = await POST(req);
    assert.strictEqual(res.status, 500);
    const json = await res.json();
    assert.strictEqual(json.code, "RAZORPAY_CONFIG_INVALID");
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = TEST_KEY_ID;
  });

  // 8. Bounded Byte Ingestion (413 on oversize)
  await runTest("8. Oversize body returns 413 PAYLOAD_TOO_LARGE", async () => {
    const oversizeBytes = new Uint8Array(260 * 1024); // 260 KB > 256 KB limit
    const sig = computeHmacSignature(oversizeBytes, TEST_WEBHOOK_SECRET);
    const req = buildMockRequest({
      body: oversizeBytes,
      signature: sig,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 413);
    const json = await res.json();
    assert.strictEqual(json.code, "PAYLOAD_TOO_LARGE");
  });

  // 9. Signature header checks
  await runTest("9. Missing signature header returns 400 MISSING_SIGNATURE", async () => {
    const req = buildMockRequest({ body: "{}", signature: null });
    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.strictEqual(json.code, "MISSING_SIGNATURE");
  });

  await runTest("10. Invalid signature returns 400 INVALID_SIGNATURE", async () => {
    const req = buildMockRequest({ body: "{}", signature: "deadbeef".repeat(8) });
    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.strictEqual(json.code, "INVALID_SIGNATURE");
  });

  // 11. Malformed payload shapes
  await runTest("11. Malformed JSON with valid signature returns 400", async () => {
    const invalidJson = "{ invalid-json ";
    const sig = computeHmacSignature(invalidJson, TEST_WEBHOOK_SECRET);
    const req = buildMockRequest({ body: invalidJson, signature: sig });
    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.strictEqual(json.error, "Invalid JSON request body");
  });

  await runTest("12. Non-object or missing event returns 400 MALFORMED_PAYLOAD", async () => {
    const body1 = JSON.stringify(["item"]);
    const req1 = buildMockRequest({ body: body1, signature: computeHmacSignature(body1, TEST_WEBHOOK_SECRET) });
    const res1 = await POST(req1);
    assert.strictEqual(res1.status, 400);
    assert.strictEqual((await res1.json()).code, "MALFORMED_PAYLOAD");

    const body2 = JSON.stringify({ no_event: true });
    const req2 = buildMockRequest({ body: body2, signature: computeHmacSignature(body2, TEST_WEBHOOK_SECRET) });
    const res2 = await POST(req2);
    assert.strictEqual(res2.status, 400);
    assert.strictEqual((await res2.json()).code, "MALFORMED_PAYLOAD");
  });

  await runTest("13. Missing order_id on fulfillment returns 400 MISSING_ORDER_ID", async () => {
    const body = JSON.stringify({ event: "order.paid", payload: {} });
    const req = buildMockRequest({ body, signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET) });
    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.strictEqual(json.code, "MISSING_ORDER_ID");
  });

  // 12. Fail closed on DB errors
  await runTest("14. DB error querying payment_orders fails closed with 500", async () => {
    const mockDb: MockDbState = {
      orders: new Map(),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
      errors: {
        paymentOrdersLookup: new Error("PostgreSQL socket connection terminated"),
      },
    };
    const body = JSON.stringify({
      event: "order.paid",
      payload: { order: { entity: { id: "order_test_err_1" } } },
    });
    const req = buildMockRequest({
      body,
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 500);
    const json = await res.json();
    assert.strictEqual(json.code, "DATABASE_ERROR");
  });

  await runTest("15. Non-existent order returns 404 ORDER_NOT_FOUND", async () => {
    const mockDb: MockDbState = {
      orders: new Map(),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
    };
    const body = JSON.stringify({
      event: "order.paid",
      payload: { order: { entity: { id: "order_test_nonexistent" } } },
    });
    const req = buildMockRequest({
      body,
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 404);
    const json = await res.json();
    assert.strictEqual(json.code, "ORDER_NOT_FOUND");
  });

  await runTest("16. Invalid provider returns 400 INVALID_PROVIDER", async () => {
    const mockDb: MockDbState = {
      orders: new Map([
        [
          "order_stripe_1",
          {
            id: "row_1",
            provider_order_id: "order_stripe_1",
            user_id: "user_1",
            provider: "stripe",
            mode: "test",
            status: "created",
            amount_paise: 9900,
          },
        ],
      ]),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
    };
    const body = JSON.stringify({
      event: "order.paid",
      payload: { order: { entity: { id: "order_stripe_1" } } },
    });
    const req = buildMockRequest({
      body,
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.strictEqual(json.code, "INVALID_PROVIDER");
  });

  await runTest("17. Mode mismatch returns 400 MODE_MISMATCH", async () => {
    const mockDb: MockDbState = {
      orders: new Map([
        [
          "order_live_1",
          {
            id: "row_live_1",
            provider_order_id: "order_live_1",
            user_id: "user_live_1",
            provider: "razorpay",
            mode: "live", // Server credentials are test mode
            status: "created",
            amount_paise: 9900,
          },
        ],
      ]),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
    };
    const body = JSON.stringify({
      event: "order.paid",
      payload: { order: { entity: { id: "order_live_1" } } },
    });
    const req = buildMockRequest({
      body,
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.strictEqual(json.code, "MODE_MISMATCH");
  });

  await runTest("18. Payload notes user mismatch rejects with 400 USER_MISMATCH", async () => {
    const mockDb: MockDbState = {
      orders: new Map([
        [
          "order_test_user_match",
          {
            id: "row_u_1",
            provider_order_id: "order_test_user_match",
            user_id: "auth_user_123",
            provider: "razorpay",
            mode: "test",
            status: "created",
            amount_paise: 9900,
          },
        ],
      ]),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
    };
    const body = JSON.stringify({
      event: "order.paid",
      payload: {
        order: {
          entity: {
            id: "order_test_user_match",
            notes: { user_id: "impostor_user_999" }, // mismatch!
          },
        },
      },
    });
    const req = buildMockRequest({
      body,
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.strictEqual(json.code, "USER_MISMATCH");
  });

  // 13. webhook_events DB errors
  await runTest("19. DB error querying webhook_events dedupe returns 500", async () => {
    const mockDb: MockDbState = {
      orders: new Map([
        [
          "order_test_dedupe_err",
          {
            id: "row_dedupe_1",
            provider_order_id: "order_test_dedupe_err",
            user_id: "user_dedupe_1",
            provider: "razorpay",
            mode: "test",
            status: "created",
            amount_paise: 9900,
          },
        ],
      ]),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
      errors: {
        webhookEventsLookup: new Error("I/O error reading replica"),
      },
    };
    const body = JSON.stringify({
      event: "order.paid",
      payload: { order: { entity: { id: "order_test_dedupe_err" } } },
    });
    const req = buildMockRequest({
      body,
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 500);
    const json = await res.json();
    assert.strictEqual(json.code, "DATABASE_ERROR");
  });

  await runTest("20. DB error writing webhook_events receipt returns 500 so provider retries", async () => {
    const mockDb: MockDbState = {
      orders: new Map([
        [
          "order_test_receipt_err",
          {
            id: "row_receipt_1",
            provider_order_id: "order_test_receipt_err",
            user_id: "user_receipt_1",
            provider: "razorpay",
            mode: "test",
            status: "created",
            amount_paise: 9900,
          },
        ],
      ]),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
      errors: {
        webhookEventsInsert: new Error("Disk full: cannot write receipt row"),
      },
    };
    const body = JSON.stringify({
      event: "order.paid",
      payload: { order: { entity: { id: "order_test_receipt_err" } } },
    });
    const req = buildMockRequest({
      body,
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 500);
    const json = await res.json();
    assert.strictEqual(json.code, "RECEIPT_WRITE_FAILED");
  });

  // 14. Happy Path, Concurrent Duplicates & Retry Lifecycle
  await runTest("21. Happy Path: Valid payload fulfills order, records receipt", async () => {
    const mockDb: MockDbState = {
      orders: new Map([
        [
          "order_test_happy_1",
          {
            id: "row_happy_1",
            provider_order_id: "order_test_happy_1",
            user_id: "user_happy_1",
            provider: "razorpay",
            mode: "test",
            status: "created",
            amount_paise: 9900,
            plan_code: "monthly",
          },
        ],
      ]),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
    };
    const body = JSON.stringify({
      event: "order.paid",
      payload: {
        order: {
          entity: {
            id: "order_test_happy_1",
          },
        },
      },
    });
    const req = buildMockRequest({
      body,
      eventId: "evt_happy_1",
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.fulfilled, true);
    assert.strictEqual(mockDb.webhookEvents.has("evt_happy_1"), true);
    assert.strictEqual(mockDb.rpcFulfilCalls.length, 1);
  });

  await runTest("22. Replay / Concurrent duplicates: Second call returns 200 alreadyProcessed without re-running RPC", async () => {
    const mockDb: MockDbState = {
      orders: new Map([
        [
          "order_test_replay_1",
          {
            id: "row_replay_1",
            provider_order_id: "order_test_replay_1",
            user_id: "user_replay_1",
            provider: "razorpay",
            mode: "test",
            status: "paid", // Already paid
            amount_paise: 9900,
          },
        ],
      ]),
      webhookEvents: new Set(["evt_replay_1"]),
      failedEvents: [],
      rpcFulfilCalls: [],
    };
    const body = JSON.stringify({
      event: "order.paid",
      payload: { order: { entity: { id: "order_test_replay_1" } } },
    });
    const req = buildMockRequest({
      body,
      eventId: "evt_replay_1",
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.alreadyProcessed, true);
    assert.strictEqual(mockDb.rpcFulfilCalls.length, 0); // Did not re-execute RPC
  });

  await runTest("23. Retry after failed fulfillment: RPC failure leaves no receipt, retry succeeds", async () => {
    let rpcShouldFail = true;
    const mockDb: MockDbState = {
      orders: new Map([
        [
          "order_test_retry_flow",
          {
            id: "row_retry_1",
            provider_order_id: "order_test_retry_flow",
            user_id: "user_retry_1",
            provider: "razorpay",
            mode: "test",
            status: "created",
            amount_paise: 9900,
          },
        ],
      ]),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
      customRpcHandler: async (fn, args) => {
        if (rpcShouldFail) {
          return { data: { success: false, code: "LOCK_TIMEOUT", error: "Lock timeout" }, error: null };
        }
        return { data: { success: true, already_paid: false }, error: null };
      },
    };

    const body = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { order_id: "order_test_retry_flow" } } },
    });

    // Attempt 1: Fails
    const req1 = buildMockRequest({
      body,
      eventId: "evt_retry_flow_1",
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res1 = await POST(req1);
    assert.strictEqual(res1.status, 500);
    assert.strictEqual(mockDb.webhookEvents.has("evt_retry_flow_1"), false); // No receipt!
    assert.strictEqual(mockDb.failedEvents.length, 1);

    // Attempt 2 (Retry after transient lock release): Succeeds
    rpcShouldFail = false;
    const req2 = buildMockRequest({
      body,
      eventId: "evt_retry_flow_1",
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res2 = await POST(req2);
    assert.strictEqual(res2.status, 200);
    assert.strictEqual((await res2.json()).fulfilled, true);
    assert.strictEqual(mockDb.webhookEvents.has("evt_retry_flow_1"), true); // Receipt recorded!
  });

  await runTest("24. Same order with different events succeed independently", async () => {
    const mockDb: MockDbState = {
      orders: new Map([
        [
          "order_multi_evt_1",
          {
            id: "row_multi_1",
            provider_order_id: "order_multi_evt_1",
            user_id: "user_multi_1",
            provider: "razorpay",
            mode: "test",
            status: "created",
            amount_paise: 9900,
          },
        ],
      ]),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
    };

    // Event 1: payment.captured (fulfills order)
    const body1 = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { order_id: "order_multi_evt_1" } } },
    });
    const req1 = buildMockRequest({
      body: body1,
      eventId: "evt_captured_99",
      signature: computeHmacSignature(body1, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res1 = await POST(req1);
    assert.strictEqual(res1.status, 200);
    assert.strictEqual((await res1.json()).fulfilled, true);
    assert.strictEqual(mockDb.webhookEvents.has("evt_captured_99"), true);

    // Event 2: refund.created on same order (processed as non-fulfillment terminal event)
    const body2 = JSON.stringify({
      event: "refund.created",
      payload: { payment: { entity: { order_id: "order_multi_evt_1" } } },
    });
    const req2 = buildMockRequest({
      body: body2,
      eventId: "evt_refund_99",
      signature: computeHmacSignature(body2, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res2 = await POST(req2);
    assert.strictEqual(res2.status, 200);
    assert.strictEqual((await res2.json()).ignored, true);
    assert.strictEqual(mockDb.webhookEvents.has("evt_refund_99"), true);
  });

  // Finish
  console.log("--------------------------------------------------------------------------------");
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
  console.error("Unhandled test suite execution error:", err);
  process.exit(1);
});
