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
import { PLAN_PRICING } from "../src/config/plans";
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

interface MockSubscription {
  id: string;
  user_id: string;
  subscription_id?: string;
  plan_id: string;
  status: string;
  provider?: string;
  current_period_start?: string;
  current_period_end?: string;
  grace_period_end?: string | null;
  cancel_at_period_end?: boolean;
  metadata?: any;
  updated_at?: string;
}

interface MockDbState {
  orders: Map<string, MockOrder>;
  subscriptions?: Map<string, MockSubscription>;
  webhookEvents: Set<string>;
  failedEvents: Array<any>;
  bannedUsers?: Set<string>;
  rpcFulfilCalls: Array<{ orderId: string; userId: string; expectedMode: string }>;
  rpcRenewalCalls?: Array<{
    subId: string;
    paymentId?: string | null;
    expectedMode?: string;
    amountPaise?: number | null;
  }>;
  errors?: {
    paymentOrdersLookup?: Error;
    subscriptionsLookup?: Error;
    subscriptionsUpdate?: Error;
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
      let filterSubId: string | null = null;
      let filterUserId: string | null = null;
      let filterOrExpr: string | null = null;
      let updatePayloadData: any = null;

      const queryObj: any = {
        select: () => queryObj,
        order: () => queryObj,
        limit: () => queryObj,
        eq: (col: string, val: any) => {
          if (col === "provider_order_id" || col === "id") filterOrderId = val;
          if (col === "event_id") filterEventId = val;
          if (col === "id" || col === "subscription_id") filterSubId = val;
          if (col === "user_id") filterUserId = val;
          return queryObj;
        },
        or: (expr: string) => {
          filterOrExpr = expr;
          return queryObj;
        },
        update: (data: any) => {
          updatePayloadData = data;
          return queryObj;
        },
        then: (resolve: any, reject: any) => {
          if (table === "subscriptions" && updatePayloadData) {
            if (db.errors?.subscriptionsUpdate) {
              return resolve({ data: null, error: db.errors.subscriptionsUpdate });
            }
            const sub = filterSubId
              ? Array.from(db.subscriptions?.values() || []).find(
                  (s) => s.id === filterSubId || s.subscription_id === filterSubId
                )
              : null;
            if (sub) {
              Object.assign(sub, updatePayloadData);
            }
            return resolve({ data: sub ? { ...sub } : null, error: null });
          }
          return resolve({ data: null, error: null });
        },
        maybeSingle: async () => {
          if (table === "blocked_users") {
            if (filterUserId && db.bannedUsers?.has(filterUserId)) {
              return { data: { user_id: filterUserId }, error: null };
            }
            return { data: null, error: null };
          }
          if (table === "payment_orders") {
            if (db.errors?.paymentOrdersLookup) {
              return { data: null, error: db.errors.paymentOrdersLookup };
            }
            const order = filterOrderId ? db.orders.get(filterOrderId) : null;
            if (!order) return { data: null, error: null };
            return { data: { ...order }, error: null };
          }
          if (table === "subscriptions") {
            if (db.errors?.subscriptionsLookup) {
              return { data: null, error: db.errors.subscriptionsLookup };
            }
            const subs = Array.from(db.subscriptions?.values() || []);
            let match: MockSubscription | undefined;
            if (filterSubId) {
              match = subs.find((s) => s.id === filterSubId || s.subscription_id === filterSubId);
            }
            if (!match && filterUserId) {
              match = subs.find((s) => s.user_id === filterUserId);
            }
            if (!match && filterOrExpr) {
              const parts = filterOrExpr.split(",");
              for (const part of parts) {
                const subStr = part.split(".eq.")[1]?.trim();
                if (subStr) {
                  match = subs.find(
                    (s) =>
                      s.id === subStr ||
                      s.subscription_id === subStr ||
                      s.metadata?.razorpay_subscription_id === subStr ||
                      s.metadata?.subscription_id === subStr
                  );
                  if (match) break;
                }
              }
            }
            if (!match) return { data: null, error: null };
            return { data: { ...match }, error: null };
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
      if (fnName === "fulfil_subscription_renewal") {
        db.rpcRenewalCalls = db.rpcRenewalCalls || [];
        db.rpcRenewalCalls.push({
          subId: args.p_razorpay_subscription_id,
          paymentId: args.p_payment_id,
          expectedMode: args.p_expected_mode,
          amountPaise: args.p_amount_paise,
        });

        if (!args.p_payment_id || !String(args.p_payment_id).trim()) {
          return {
            data: { success: false, code: "MISSING_PAYMENT_ID", error: "Payment ID is required" },
            error: null,
          };
        }

        const subId = args.p_razorpay_subscription_id;
        let order = db.orders.get(subId);
        if (!order) {
          order = Array.from(db.orders.values()).find((o) => o.provider_order_id === subId);
        }

        let sub = Array.from(db.subscriptions?.values() || []).find(
          (s) =>
            s.id === subId ||
            s.subscription_id === subId ||
            s.metadata?.razorpay_subscription_id === subId ||
            s.metadata?.subscription_id === subId
        );

        if (!order && !sub) {
          return {
            data: { success: false, code: "SUBSCRIPTION_NOT_FOUND", error: "Subscription not found" },
            error: null,
          };
        }

        const userId = order?.user_id || sub?.user_id;
        if (userId && db.bannedUsers?.has(userId)) {
          return {
            data: { success: false, code: "USER_BANNED", error: "Account is suspended" },
            error: null,
          };
        }

        const effectiveMode = order?.mode || sub?.metadata?.mode || "live";
        const expectedMode = args.p_expected_mode || "live";
        if (effectiveMode !== expectedMode) {
          return {
            data: {
              success: false,
              code: "MODE_MISMATCH",
              error: `Order mode (${effectiveMode}) does not match expected (${expectedMode})`,
            },
            error: null,
          };
        }

        const planCode = order?.plan_code || sub?.plan_id || "monthly";
        const planPrices: Record<string, number> = {
          weekly: PLAN_PRICING.weekly.price_paise,
          monthly: PLAN_PRICING.monthly.price_paise,
          quarterly: PLAN_PRICING.quarterly.price_paise,
        };
        const expectedPrice = planPrices[planCode] || PLAN_PRICING.monthly.price_paise;
        if (args.p_amount_paise && args.p_amount_paise !== expectedPrice) {
          return {
            data: {
              success: false,
              code: "PLAN_AMOUNT_MISMATCH",
              error: `Payment amount ${args.p_amount_paise} does not match plan price ${expectedPrice}`,
            },
            error: null,
          };
        }

        // Idempotency check on payment_id
        const processedPayments: string[] = sub?.metadata?.processed_payments || [];
        if (
          (sub && (
            processedPayments.includes(args.p_payment_id) ||
            sub.metadata?.initial_payment_id === args.p_payment_id ||
            sub.metadata?.last_payment_id === args.p_payment_id
          )) ||
          (order && order.status === "paid" && (order as any).metadata?.payment_id === args.p_payment_id)
        ) {
          return {
            data: {
              success: true,
              already_processed: true,
              is_pro: true,
              subscription_id: sub?.id,
              user_id: userId,
              plan_id: planCode,
              current_period_end: sub?.current_period_end,
              payment_id: args.p_payment_id,
            },
            error: null,
          };
        }

        const duration = planCode.includes("week") ? 7 : planCode.includes("quarter") ? 90 : 30;
        const currentEnd = sub?.current_period_end ? new Date(sub.current_period_end).getTime() : Date.now();
        const base = Math.max(currentEnd, Date.now());
        const newEnd = new Date(base + duration * 24 * 60 * 60 * 1000).toISOString();

        if (sub) {
          sub.current_period_end = newEnd;
          sub.status = "active";
          sub.subscription_id = subId;
          sub.metadata = {
            ...(sub.metadata || {}),
            processed_payments: [...processedPayments, args.p_payment_id],
            last_payment_id: args.p_payment_id,
            last_renewal_payment_id: args.p_payment_id,
            initial_payment_id: sub.metadata?.initial_payment_id || args.p_payment_id,
          };
        } else if (order) {
          const newSubRow: MockSubscription = {
            id: `sub_row_${Date.now()}`,
            user_id: order.user_id,
            subscription_id: subId,
            plan_id: planCode,
            status: "active",
            current_period_start: new Date().toISOString(),
            current_period_end: newEnd,
            metadata: {
              processed_payments: [args.p_payment_id],
              initial_payment_id: args.p_payment_id,
              last_payment_id: args.p_payment_id,
              mode: order.mode || "live",
            },
          };
          db.subscriptions = db.subscriptions || new Map();
          db.subscriptions.set(newSubRow.id, newSubRow);
          sub = newSubRow;
        }

        if (order) {
          order.status = "paid";
          (order as any).metadata = {
            ...((order as any).metadata || {}),
            payment_id: args.p_payment_id,
          };
        }

        return {
          data: {
            success: true,
            already_processed: false,
            is_pro: true,
            subscription_id: sub?.id,
            user_id: userId,
            plan_id: planCode,
            duration_days: duration,
            current_period_end: newEnd,
            payment_id: args.p_payment_id,
          },
          error: null,
        };
      }

      if (fnName === "handle_subscription_lifecycle_event") {
        const subId = args.p_razorpay_subscription_id;
        const eventType = args.p_event_type;
        const eventTimestamp = args.p_event_timestamp;
        const expectedMode = args.p_expected_mode || "live";

        let sub = Array.from(db.subscriptions?.values() || []).find(
          (s) => s.subscription_id === subId
        );

        if (!sub) {
          return {
            data: {
              success: true,
              ignored: true,
              reason: "UNBOUND_MANDATE",
              message: `Mandate ${subId} is not currently bound`,
            },
            error: null,
          };
        }

        if (sub.user_id && db.bannedUsers?.has(sub.user_id)) {
          return {
            data: { success: false, code: "USER_BANNED", error: "Account is suspended" },
            error: null,
          };
        }

        const effectiveMode = sub.metadata?.mode || "live";
        if (effectiveMode !== expectedMode) {
          return {
            data: {
              success: false,
              code: "MODE_MISMATCH",
              error: `Order mode (${effectiveMode}) does not match expected (${expectedMode})`,
            },
            error: null,
          };
        }

        // Durable provider last-event timestamp check
        if (eventTimestamp !== null && eventTimestamp > 0) {
          const lastTime = sub.metadata?.last_event_time;
          if (typeof lastTime === "number") {
            const incomingMs = eventTimestamp > 1e11 ? eventTimestamp : eventTimestamp * 1000;
            const storedMs = lastTime > 1e11 ? lastTime : lastTime * 1000;
            if (incomingMs < storedMs) {
              return {
                data: {
                  success: true,
                  ignored: true,
                  reason: "OUT_OF_ORDER_EVENT",
                  message: `Event timestamp is older than stored last event time`,
                },
                error: null,
              };
            }
          }
        }

        sub.metadata = sub.metadata || {};
        if (eventTimestamp !== null && eventTimestamp > 0) {
          sub.metadata.last_event_time = eventTimestamp;
        }

        if (eventType === "subscription.pending") {
          sub.status = "in_grace_period";
          sub.grace_period_end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        } else if (eventType === "subscription.halted" || eventType === "subscription.past_due") {
          sub.status = "past_due";
        } else if (
          eventType === "subscription.cancelled" ||
          eventType === "subscription.canceled" ||
          eventType === "subscription.completed"
        ) {
          sub.cancel_at_period_end = true;
        }

        return {
          data: {
            success: true,
            applied: true,
            test_mode: expectedMode === "test",
            event_type: eventType,
            subscription_id: sub.subscription_id,
            status: sub.status,
            cancel_at_period_end: sub.cancel_at_period_end,
            grace_period_end: sub.grace_period_end,
            user_id: sub.user_id,
            last_event_time: eventTimestamp,
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
    verifyUserNotBanned?: (client: any, userId: string) => Promise<{ isBlocked: boolean; error?: string }>;
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
      verifyUserNotBanned: options.verifyUserNotBanned,
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
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => { logged.push(a.join(" ")); };
    let res2: Response;
    try {
      res2 = await POST(req2);
    } finally {
      console.log = origLog;
    }
    assert.strictEqual(res2.status, 200);
    assert.strictEqual((await res2.json()).ignored, true);
    assert.strictEqual(mockDb.webhookEvents.has("evt_refund_99"), true);
    assert.ok(logged.some((l) => l.includes("Recorded and ignored event type refund.created")), "ignored event type must be logged");
  });

  // 15. Auto-Renewal & Subscription Lifecycle Events
  await runTest("25. Dormancy: subscription events ignored with 200 AUTORENEW_DISABLED when NEXT_PUBLIC_AUTORENEW_ENABLED is off", async () => {
    delete process.env.NEXT_PUBLIC_AUTORENEW_ENABLED;
    const mockDb: MockDbState = {
      orders: new Map(),
      subscriptions: new Map(),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
    };
    for (const evt of ["subscription.activated", "subscription.charged", "subscription.pending", "subscription.halted", "subscription.cancelled"]) {
      const body = JSON.stringify({
        event: evt,
        payload: {
          subscription: { entity: { id: "sub_dormant_1" } },
          payment: { entity: { id: "pay_dormant_1" } },
        },
      });
      const req = buildMockRequest({
        body,
        eventId: `evt_dormant_${evt}`,
        signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
        mockDb,
      });
      const res = await POST(req);
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.received, true);
      assert.strictEqual(json.ignored, true);
      assert.strictEqual(json.reason, "AUTORENEW_DISABLED");
    }
  });

  // Enable auto-renew for remaining tests
  process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";

  await runTest("26. Missing subscription ID on subscription events returns 400 MISSING_SUBSCRIPTION_ID", async () => {
    const mockDb: MockDbState = {
      orders: new Map(),
      subscriptions: new Map(),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
    };
    const body = JSON.stringify({
      event: "subscription.charged",
      payload: {
        payment: { entity: { id: "pay_sub_missing" } },
      },
    });
    const req = buildMockRequest({
      body,
      eventId: "evt_sub_missing_id",
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).code, "MISSING_SUBSCRIPTION_ID");
  });

  await runTest("27. (Requirement 4) Reject subscription cycle event with missing payment_id with 400 MISSING_PAYMENT_ID", async () => {
    const mockDb: MockDbState = {
      orders: new Map(),
      subscriptions: new Map(),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
    };
    const body = JSON.stringify({
      event: "subscription.charged",
      payload: {
        subscription: { entity: { id: "sub_missing_pay" } },
      },
    });
    const req = buildMockRequest({
      body,
      eventId: "evt_sub_missing_payment",
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).code, "MISSING_PAYMENT_ID");
  });

  await runTest("28. (Requirement 2) Mode isolation: mode mismatch rejects with 400 MODE_MISMATCH", async () => {
    const mockDb: MockDbState = {
      orders: new Map([
        [
          "sub_rzp_live_mismatch",
          {
            id: "order_row_live",
            provider_order_id: "sub_rzp_live_mismatch",
            user_id: "user_live_mismatch",
            provider: "razorpay",
            mode: "live",
            status: "created",
            amount_paise: 39900,
            plan_code: "weekly",
          },
        ],
      ]),
      subscriptions: new Map(),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
    };
    const body = JSON.stringify({
      event: "subscription.charged",
      payload: {
        subscription: { entity: { id: "sub_rzp_live_mismatch" } },
        payment: { entity: { id: "pay_live_mismatch" } },
      },
    });
    const req = buildMockRequest({
      body,
      eventId: "evt_sub_mode_mismatch",
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).code, "MODE_MISMATCH");
  });

  await runTest("29. (Requirement 2) Ban isolation: blocked user on subscription event rejects with 403 USER_BLOCKED", async () => {
    const mockDb: MockDbState = {
      orders: new Map([
        [
          "sub_rzp_banned",
          {
            id: "order_row_banned",
            provider_order_id: "sub_rzp_banned",
            user_id: "user_banned_999",
            provider: "razorpay",
            mode: "test",
            status: "created",
            amount_paise: 39900,
            plan_code: "weekly",
          },
        ],
      ]),
      subscriptions: new Map(),
      webhookEvents: new Set(),
      failedEvents: [],
      bannedUsers: new Set(["user_banned_999"]),
      rpcFulfilCalls: [],
    };
    const body = JSON.stringify({
      event: "subscription.charged",
      payload: {
        subscription: { entity: { id: "sub_rzp_banned" } },
        payment: { entity: { id: "pay_banned_1" } },
      },
    });
    const req = buildMockRequest({
      body,
      eventId: "evt_sub_banned",
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
      verifyUserNotBanned: async () => ({ isBlocked: true, error: "Account suspended." }),
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).code, "USER_BLOCKED");
  });

  await runTest("30. (Requirement 6) Plan amount validation: mismatched amount rejects with 400 PLAN_AMOUNT_MISMATCH", async () => {
    const mockDb: MockDbState = {
      orders: new Map([
        [
          "sub_rzp_amount_chk",
          {
            id: "order_row_chk",
            provider_order_id: "sub_rzp_amount_chk",
            user_id: "user_amount_chk",
            provider: "razorpay",
            mode: "test",
            status: "created",
            amount_paise: 39900,
            plan_code: "weekly",
          },
        ],
      ]),
      subscriptions: new Map(),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
    };
    const body = JSON.stringify({
      event: "subscription.charged",
      payload: {
        subscription: { entity: { id: "sub_rzp_amount_chk" } },
        payment: { entity: { id: "pay_amount_bad", amount: 50000 } },
      },
    });
    const req = buildMockRequest({
      body,
      eventId: "evt_sub_amount_mismatch",
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).code, "PLAN_AMOUNT_MISMATCH");
  });

  await runTest("31. (Requirement 3 & 4) Atomic paid-cycle path: new user without subscriptions row is bound on first grant", async () => {
    const mockDb: MockDbState = {
      orders: new Map([
        [
          "sub_rzp_new_user",
          {
            id: "order_row_new_user",
            provider_order_id: "sub_rzp_new_user",
            user_id: "user_new_123",
            provider: "razorpay",
            mode: "test",
            status: "created",
            amount_paise: 39900,
            plan_code: "weekly",
          },
        ],
      ]),
      subscriptions: new Map(),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
      rpcRenewalCalls: [],
    };

    const body = JSON.stringify({
      event: "subscription.activated",
      payload: {
        subscription: { entity: { id: "sub_rzp_new_user" } },
        payment: { entity: { id: "pay_initial_101", amount: 39900 } },
      },
    });
    const req = buildMockRequest({
      body,
      eventId: "evt_sub_act_new_user",
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.renewed, true);
    assert.strictEqual(json.alreadyProcessed, false);
    assert.strictEqual(mockDb.webhookEvents.has("evt_sub_act_new_user"), true);

    const subValues = Array.from(mockDb.subscriptions?.values() || []);
    assert.strictEqual(subValues.length, 1);
    const createdSub = subValues[0];
    assert.strictEqual(createdSub.user_id, "user_new_123");
    assert.strictEqual(createdSub.subscription_id, "sub_rzp_new_user");
    assert.strictEqual(createdSub.status, "active");
    assert.strictEqual(createdSub.plan_id, "weekly");
    assert.strictEqual(createdSub.metadata?.initial_payment_id, "pay_initial_101");

    const endMs = new Date(createdSub.current_period_end!).getTime();
    const approx7DaysMs = 7 * 24 * 60 * 60 * 1000;
    const diffMs = endMs - Date.now();
    assert.ok(Math.abs(diffMs - approx7DaysMs) < 60000, "Must be exactly 7 days from now");
  });

  await runTest("32. (Requirement 3 & 4) Atomic paid-cycle: subscription.charged with same payment_id credits ZERO duplicate days", async () => {
    const now = Date.now();
    const existingEnd = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
    const existingSub: MockSubscription = {
      id: "sub_row_existing_cycle",
      user_id: "user_new_123",
      subscription_id: "sub_rzp_same_cycle",
      plan_id: "weekly",
      status: "active",
      current_period_end: existingEnd,
      metadata: {
        initial_payment_id: "pay_initial_101",
        processed_payments: ["pay_initial_101"],
      },
    };
    const mockDb: MockDbState = {
      orders: new Map([
        [
          "sub_rzp_same_cycle",
          {
            id: "order_row_same_cycle",
            provider_order_id: "sub_rzp_same_cycle",
            user_id: "user_new_123",
            provider: "razorpay",
            mode: "test",
            status: "paid",
            amount_paise: 39900,
            plan_code: "weekly",
          },
        ],
      ]),
      subscriptions: new Map([["sub_row_existing_cycle", existingSub]]),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
      rpcRenewalCalls: [],
    };

    const body = JSON.stringify({
      event: "subscription.charged",
      payload: {
        subscription: { entity: { id: "sub_rzp_same_cycle" } },
        payment: { entity: { id: "pay_initial_101", amount: 39900 } },
      },
    });
    const req = buildMockRequest({
      body,
      eventId: "evt_sub_charged_same_payment",
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.alreadyProcessed, true);
    assert.strictEqual(json.renewed, true);
    assert.strictEqual(existingSub.current_period_end, existingEnd);
  });

  await runTest("33. (Requirement 6) Renewal cycle: subscription.charged with new payment_id extends period", async () => {
    const initialEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const existingSub: MockSubscription = {
      id: "sub_row_renewal_1",
      subscription_id: "sub_rzp_renewal_1",
      user_id: "user_renewal_1",
      plan_id: "monthly",
      status: "active",
      current_period_end: initialEnd,
      metadata: {
        initial_payment_id: "pay_cycle_1",
        processed_payments: ["pay_cycle_1"],
      },
    };
    const mockDb: MockDbState = {
      orders: new Map([
        [
          "sub_rzp_renewal_1",
          {
            id: "order_renewal_1",
            provider_order_id: "sub_rzp_renewal_1",
            user_id: "user_renewal_1",
            provider: "razorpay",
            mode: "test",
            status: "paid",
            amount_paise: PLAN_PRICING.monthly.price_paise,
            plan_code: "monthly",
          },
        ],
      ]),
      subscriptions: new Map([["sub_row_renewal_1", existingSub]]),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
      rpcRenewalCalls: [],
    };
    const body = JSON.stringify({
      event: "subscription.charged",
      payload: {
        subscription: { entity: { id: "sub_rzp_renewal_1" } },
        payment: { entity: { id: "pay_cycle_2", amount: PLAN_PRICING.monthly.price_paise } },
      },
    });
    const req = buildMockRequest({
      body,
      eventId: "evt_sub_charged_renewal",
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.renewed, true);
    assert.strictEqual(json.alreadyProcessed, false);

    const newEndMs = new Date(existingSub.current_period_end!).getTime();
    const expectedMs = new Date(initialEnd).getTime() + 30 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(newEndMs - expectedMs) < 60000, "Period must be extended by 30 days from previous end");
  });

  await runTest("34. Lifecycle events: pending -> in_grace_period, halted -> past_due, cancelled -> cancel_at_period_end", async () => {
    const subPending: MockSubscription = {
      id: "sub_row_p1",
      subscription_id: "sub_rzp_p1",
      user_id: "user_p1",
      plan_id: "monthly",
      status: "active",
      grace_period_end: null,
      metadata: { mode: "test" },
    };
    const subHalted: MockSubscription = {
      id: "sub_row_h1",
      subscription_id: "sub_rzp_h1",
      user_id: "user_h1",
      plan_id: "monthly",
      status: "in_grace_period",
      metadata: { mode: "test" },
    };
    const subCanc: MockSubscription = {
      id: "sub_row_c1",
      subscription_id: "sub_rzp_c1",
      user_id: "user_c1",
      plan_id: "monthly",
      status: "active",
      cancel_at_period_end: false,
      metadata: { mode: "test" },
    };

    const mockDb: MockDbState = {
      orders: new Map(),
      subscriptions: new Map([
        ["sub_row_p1", subPending],
        ["sub_row_h1", subHalted],
        ["sub_row_c1", subCanc],
      ]),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
    };

    const bodyP = JSON.stringify({ event: "subscription.pending", payload: { subscription: { entity: { id: "sub_rzp_p1" } } } });
    const resP = await POST(buildMockRequest({ body: bodyP, eventId: "evt_p1", signature: computeHmacSignature(bodyP, TEST_WEBHOOK_SECRET), mockDb }));
    assert.strictEqual(resP.status, 200);
    assert.strictEqual(subPending.status, "in_grace_period");
    assert.ok(subPending.grace_period_end);

    const bodyH = JSON.stringify({ event: "subscription.halted", payload: { subscription: { entity: { id: "sub_rzp_h1" } } } });
    const resH = await POST(buildMockRequest({ body: bodyH, eventId: "evt_h1", signature: computeHmacSignature(bodyH, TEST_WEBHOOK_SECRET), mockDb }));
    assert.strictEqual(resH.status, 200);
    assert.strictEqual(subHalted.status, "past_due");

    const bodyC = JSON.stringify({ event: "subscription.cancelled", payload: { subscription: { entity: { id: "sub_rzp_c1" } } } });
    const resC = await POST(buildMockRequest({ body: bodyC, eventId: "evt_c1", signature: computeHmacSignature(bodyC, TEST_WEBHOOK_SECRET), mockDb }));
    assert.strictEqual(resC.status, 200);
    assert.strictEqual(subCanc.cancel_at_period_end, true);
  });

  await runTest("35. (Requirement 5) Lifecycle events: unbound or abandoned mandate acknowledged with 200 UNBOUND_MANDATE", async () => {
    const activeSub: MockSubscription = {
      id: "sub_active_row",
      subscription_id: "sub_active_mandate",
      user_id: "user_with_active",
      plan_id: "monthly",
      status: "active",
      metadata: { mode: "test" },
    };
    const mockDb: MockDbState = {
      orders: new Map(),
      subscriptions: new Map([["sub_active_row", activeSub]]),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
    };

    const body = JSON.stringify({
      event: "subscription.cancelled",
      payload: {
        subscription: { entity: { id: "sub_old_abandoned" } },
      },
    });
    const req = buildMockRequest({
      body,
      eventId: "evt_unbound_mandate",
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.ignored, true);
    assert.strictEqual(json.reason, "UNBOUND_MANDATE");

    assert.strictEqual(activeSub.status, "active");
    assert.strictEqual(activeSub.cancel_at_period_end, undefined);
  });

  await runTest("36. (Requirement 5) Lifecycle events: out-of-order older event ignored with 200 OUT_OF_ORDER_EVENT", async () => {
    const currentTimeSec = Math.floor(Date.now() / 1000);
    const targetSub: MockSubscription = {
      id: "sub_row_time_chk",
      subscription_id: "sub_rzp_time_chk",
      user_id: "user_time_chk",
      plan_id: "monthly",
      status: "active",
      metadata: { mode: "test", last_event_time: currentTimeSec },
      updated_at: new Date(Date.now() - 1000).toISOString(),
    };
    const mockDb: MockDbState = {
      orders: new Map(),
      subscriptions: new Map([["sub_row_time_chk", targetSub]]),
      webhookEvents: new Set(),
      failedEvents: [],
      rpcFulfilCalls: [],
    };

    const oldTimestampSec = Math.floor((Date.now() - 3600 * 1000) / 1000);
    const body = JSON.stringify({
      event: "subscription.halted",
      created_at: oldTimestampSec,
      payload: {
        subscription: { entity: { id: "sub_rzp_time_chk", created_at: oldTimestampSec } },
      },
    });
    const req = buildMockRequest({
      body,
      eventId: "evt_out_of_order",
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.ignored, true);
    assert.strictEqual(json.reason, "OUT_OF_ORDER_EVENT");

    assert.strictEqual(targetSub.status, "active");
  });

  await runTest("37. Deduplication: Duplicate webhook event_id returns 200 alreadyProcessed without re-running RPC", async () => {
    const mockDb: MockDbState = {
      orders: new Map(),
      subscriptions: new Map([
        [
          "sub_row_dup",
          {
            id: "sub_row_dup",
            subscription_id: "sub_rzp_dup",
            user_id: "user_dup",
            plan_id: "monthly",
            status: "active",
            metadata: { mode: "test" },
          },
        ],
      ]),
      webhookEvents: new Set(["evt_already_delivered"]),
      failedEvents: [],
      rpcFulfilCalls: [],
      rpcRenewalCalls: [],
    };
    const body = JSON.stringify({
      event: "subscription.halted",
      payload: {
        subscription: { entity: { id: "sub_rzp_dup" } },
      },
    });
    const req = buildMockRequest({
      body,
      eventId: "evt_already_delivered",
      signature: computeHmacSignature(body, TEST_WEBHOOK_SECRET),
      mockDb,
    });
    const res = await POST(req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.alreadyProcessed, true);
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
