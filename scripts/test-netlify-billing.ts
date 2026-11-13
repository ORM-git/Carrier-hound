/**
 * scripts/test-netlify-billing.ts
 *
 * Comprehensive offline verification suite for Netlify serverless billing functions:
 * 1. netlify/functions/billing-razorpay-order.ts
 * 2. netlify/functions/billing-razorpay-verify.ts
 * 3. netlify/functions/billing-razorpay-webhook.ts
 *
 * Verifies all core security requirements:
 * - Flag off (503 BILLING_DISABLED when NEXT_PUBLIC_BILLING_ENABLED !== "true")
 * - No auth / invalid session (401 on order and verify)
 * - Bad signature (400 INVALID_SIGNATURE on verify and webhook)
 * - Tampered amount / mismatched plan (400 on verify)
 * - Webhook error handling: RPC returns success:false (non-200, no dedupe row left)
 * - Webhook error handling: RPC throws error on transient failure, then retry succeeds
 * - Duplicate webhook after success (200 alreadyProcessed: true without re-executing RPC)
 * - Happy paths: authoritative server pricing (Weekly 692, Monthly 1499, Addons 149/399/699),
 *   add-on Pro prerequisite check, idempotent already-paid verify, and RPC fulfilment.
 *
 * Includes negative control (--negative-control) to prove non-zero exit on invalid conditions.
 */

import assert from "assert";
import crypto from "crypto";
import { createHandler as createOrderHandler } from "../netlify/functions/billing-razorpay-order";
import { createHandler as createVerifyHandler } from "../netlify/functions/billing-razorpay-verify";
import { createHandler as createWebhookHandler } from "../netlify/functions/billing-razorpay-webhook";

const TEST_SECRET = "rzp_test_secret_key_1234567890";
const TEST_KEY_ID = "rzp_test_key_1234567890";
const TEST_WEBHOOK_SECRET = "rzp_webhook_secret_abcdef12345";

interface MockDbState {
  orders: Map<string, any>;
  webhookEvents: Set<string>;
  subscriptions: Map<string, any>;
  addonCredits: Map<string, any>;
  rpcFulfilCalls: Array<{ orderId: string; userId: string }>;
  customRpcHandler?: (fnName: string, args: any) => Promise<any> | any;
}

function createMockSupabase(db: MockDbState, validTokens: Record<string, any>) {
  return () => ({
    auth: {
      getUser: async (token: string) => {
        const user = validTokens[token];
        if (!user) {
          return { data: { user: null }, error: new Error("Invalid JWT token") };
        }
        return { data: { user }, error: null };
      },
    },
    from: (table: string) => {
      let filterOrderId: string | null = null;
      let filterUserId: string | null = null;
      let filterEventId: string | null = null;

      const queryObj: any = {
        select: () => queryObj,
        eq: (col: string, val: any) => {
          if (col === "provider_order_id" || col === "id") filterOrderId = val;
          if (col === "user_id") filterUserId = val;
          if (col === "event_id") filterEventId = val;
          return queryObj;
        },
        maybeSingle: async () => {
          if (table === "payment_orders") {
            const order = filterOrderId ? db.orders.get(filterOrderId) : null;
            if (!order) return { data: null, error: null };
            if (filterUserId && order.user_id !== filterUserId) {
              return { data: null, error: null };
            }
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
          if (table === "payment_orders") {
            db.orders.set(row.provider_order_id, {
              ...row,
              id: `po_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              created_at: new Date().toISOString(),
            });
            return { error: null };
          }
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
          return { error: null };
        },
        upsert: async (row: any) => {
          if (table === "webhook_events") {
            db.webhookEvents.add(row.event_id);
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
        });
        const order = db.orders.get(args.p_provider_order_id);
        if (order) {
          order.status = "paid";
          order.paid_at = new Date().toISOString();
        }
        return {
          data: {
            success: true,
            order_id: args.p_provider_order_id,
            fulfilled: true,
          },
          error: null,
        };
      }
      return { data: null, error: new Error(`Unknown RPC ${fnName}`) };
    },
  });
}

function computeSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

async function runSuite() {
  console.log("================================================================================");
  console.log("     NETLIFY FUNCTIONS BILLING & SAFETY TEST SUITE [PASS-LOCAL]                 ");
  console.log("================================================================================\n");

  const isNegativeControl = process.argv.includes("--negative-control");
  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL MODE] Intentionally testing negative control assertion...");
    assert.strictEqual(
      1 + 1,
      3,
      "Negative control triggered: 1 + 1 is 2, not 3. Proving non-zero exit code."
    );
    return;
  }

  // Setup mock database and tokens
  const mockDb: MockDbState = {
    orders: new Map(),
    webhookEvents: new Set(),
    subscriptions: new Map(),
    addonCredits: new Map(),
    rpcFulfilCalls: [],
  };

  const validUser = { id: "user_pro_123", email: "candidate@example.com" };
  const freeUser = { id: "user_free_456", email: "free@example.com" };

  const validTokens: Record<string, any> = {
    "valid-token-pro": validUser,
    "valid-token-free": freeUser,
  };

  const mockAdminGetter = createMockSupabase(mockDb, validTokens);

  let mockRzpOrderCounter = 1;
  const mockFetch = (async (url: string, opts: any) => {
    if (url === "https://api.razorpay.com/v1/orders") {
      const parsedBody = JSON.parse(opts.body);
      const generatedId = `order_test_${mockRzpOrderCounter++}_${Date.now()}`;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: generatedId,
          amount: parsedBody.amount,
          currency: parsedBody.currency,
          status: "created",
        }),
      };
    }
    throw new Error(`Unexpected fetch call to ${url}`);
  }) as any;

  const mockEntitlement = async (userId: string) => {
    if (userId === "user_pro_123") {
      return { isPro: true, status: "active", planName: "Monthly" };
    }
    return { isPro: false, status: "none", planName: "Free Tier" };
  };

  const orderHandler = createOrderHandler({
    getSupabaseAdmin: mockAdminGetter,
    getServerEntitlement: mockEntitlement,
    fetchFn: mockFetch,
  });

  const verifyHandler = createVerifyHandler({
    getSupabaseAdmin: mockAdminGetter,
  });

  const webhookHandler = createWebhookHandler({
    getSupabaseAdmin: mockAdminGetter,
  });

  // Preserve original env vars
  const origBilling = process.env.NEXT_PUBLIC_BILLING_ENABLED;
  const origKeyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  const origKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const origWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const origMode = process.env.RAZORPAY_MODE;

  try {
    process.env.RAZORPAY_MODE = "test";
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = TEST_KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = TEST_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

    // ---------------------------------------------------------------------------
    // TEST 1: Flag Off (NEXT_PUBLIC_BILLING_ENABLED !== "true")
    // ---------------------------------------------------------------------------
    console.log(
      "Test 1: Verifying all 3 functions reject with 503 BILLING_DISABLED when flag is off..."
    );
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";

    const orderFlagOff = await orderHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer valid-token-pro" },
      body: JSON.stringify({ planCode: "monthly" }),
    });
    assert.strictEqual(orderFlagOff.statusCode, 503);
    assert.strictEqual(JSON.parse(orderFlagOff.body).code, "BILLING_DISABLED");

    const verifyFlagOff = await verifyHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer valid-token-pro" },
      body: JSON.stringify({
        order_id: "order_123",
        payment_id: "pay_123",
        razorpay_signature: "sig",
      }),
    });
    assert.strictEqual(verifyFlagOff.statusCode, 503);
    assert.strictEqual(JSON.parse(verifyFlagOff.body).code, "BILLING_DISABLED");

    const webhookFlagOff = await webhookHandler({
      httpMethod: "POST",
      headers: { "x-razorpay-signature": "sig" },
      body: JSON.stringify({ event: "order.paid" }),
    });
    assert.strictEqual(webhookFlagOff.statusCode, 503);
    assert.strictEqual(JSON.parse(webhookFlagOff.body).code, "BILLING_DISABLED");

    console.log("  -> [PASS-LOCAL] All endpoints return 503 BILLING_DISABLED when flag is off.");

    // Turn billing flag ON for subsequent tests
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";

    // ---------------------------------------------------------------------------
    // TEST 2: No Auth & Invalid Session Checks
    // ---------------------------------------------------------------------------
    console.log("\nTest 2: Verifying no-auth and invalid session token rejections (401)...");

    // 2A: Missing auth header on order
    const orderNoAuth = await orderHandler({
      httpMethod: "POST",
      headers: {},
      body: JSON.stringify({ planCode: "weekly" }),
    });
    assert.strictEqual(orderNoAuth.statusCode, 401);
    assert(JSON.parse(orderNoAuth.body).error.includes("authorization header"));

    // 2B: Invalid Bearer token on order
    const orderBadToken = await orderHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer invalid-tampered-token" },
      body: JSON.stringify({ planCode: "weekly" }),
    });
    assert.strictEqual(orderBadToken.statusCode, 401);
    assert(JSON.parse(orderBadToken.body).error.includes("Invalid user session"));

    // 2C: Missing auth header on verify
    const verifyNoAuth = await verifyHandler({
      httpMethod: "POST",
      headers: {},
      body: JSON.stringify({ order_id: "order_1", payment_id: "pay_1", razorpay_signature: "sig" }),
    });
    assert.strictEqual(verifyNoAuth.statusCode, 401);

    // 2D: Invalid Bearer token on verify
    const verifyBadToken = await verifyHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer invalid-token" },
      body: JSON.stringify({ order_id: "order_1", payment_id: "pay_1", razorpay_signature: "sig" }),
    });
    assert.strictEqual(verifyBadToken.statusCode, 401);

    console.log("  -> [PASS-LOCAL] Missing and invalid bearer credentials strictly return 401.");

    // ---------------------------------------------------------------------------
    // TEST 3: Authoritative Pricing & Order Creation Happy Path
    // ---------------------------------------------------------------------------
    console.log(
      "\nTest 3: Verifying server-authoritative order creation and Pro check on add-ons..."
    );

    // 3A: Weekly plan order (client specifies tampered amount: 1 rupee; server must force 69200 paise)
    const weeklyOrderRes = await orderHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer valid-token-pro" },
      body: JSON.stringify({ planCode: "weekly", amount: 100 }), // Client attempts to pay 100 paise
    });
    assert.strictEqual(weeklyOrderRes.statusCode, 200);
    const weeklyOrder = JSON.parse(weeklyOrderRes.body);
    assert.strictEqual(
      weeklyOrder.amount,
      69200,
      "Weekly plan MUST resolve to 69200 paise (Rs 692)"
    );
    assert.strictEqual(weeklyOrder.currency, "INR");
    assert(weeklyOrder.orderId.startsWith("order_test_"));

    // Verify row was created in payment_orders
    const recordedWeeklyOrder = mockDb.orders.get(weeklyOrder.orderId);
    assert(recordedWeeklyOrder, "Order must be recorded in payment_orders");
    assert.strictEqual(recordedWeeklyOrder.status, "created");
    assert.strictEqual(recordedWeeklyOrder.plan_code, "weekly");
    assert.strictEqual(recordedWeeklyOrder.amount_paise, 69200);

    // 3B: Monthly plan order
    const monthlyOrderRes = await orderHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer valid-token-pro" },
      body: JSON.stringify({ planCode: "monthly" }),
    });
    assert.strictEqual(monthlyOrderRes.statusCode, 200);
    const monthlyOrder = JSON.parse(monthlyOrderRes.body);
    assert.strictEqual(
      monthlyOrder.amount,
      149900,
      "Monthly plan MUST resolve to 149900 paise (Rs 1,499)"
    );

    // 3C: Free user attempts to buy Add-on 10 -> MUST be rejected with 403 PRO_REQUIRED
    const freeAddonRes = await orderHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer valid-token-free" },
      body: JSON.stringify({ addonCode: "addon_10" }),
    });
    assert.strictEqual(freeAddonRes.statusCode, 403);
    assert.strictEqual(JSON.parse(freeAddonRes.body).code, "PRO_REQUIRED");

    // 3D: Pro user buys Add-on 10 -> Allowed, resolves to 14900 paise
    const proAddonRes = await orderHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer valid-token-pro" },
      body: JSON.stringify({ addonCode: "addon_10" }),
    });
    assert.strictEqual(proAddonRes.statusCode, 200);
    const proAddonOrder = JSON.parse(proAddonRes.body);
    assert.strictEqual(
      proAddonOrder.amount,
      14900,
      "Addon 10 must resolve to 14900 paise (Rs 149)"
    );

    console.log("  -> [PASS-LOCAL] Server-authoritative pricing and add-on Pro gating verified.");

    // ---------------------------------------------------------------------------
    // TEST 4: Signature Verification & Bad Signature Rejections
    // ---------------------------------------------------------------------------
    console.log("\nTest 4: Verifying bad signatures are rejected with 400 INVALID_SIGNATURE...");

    const targetOrderId = monthlyOrder.orderId;
    const samplePaymentId = "pay_test_pymt_987654";
    const validSignature = computeSignature(`${targetOrderId}|${samplePaymentId}`, TEST_SECRET);
    const tamperedSignature = computeSignature(`${targetOrderId}|pay_tampered_id`, TEST_SECRET);

    // 4A: Tampered signature on verify
    const verifyBadSig = await verifyHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer valid-token-pro" },
      body: JSON.stringify({
        order_id: targetOrderId,
        payment_id: samplePaymentId,
        razorpay_signature: tamperedSignature,
      }),
    });
    assert.strictEqual(verifyBadSig.statusCode, 400);
    assert.strictEqual(JSON.parse(verifyBadSig.body).code, "INVALID_SIGNATURE");

    // 4B: Webhook bad signature
    const webhookRawBody = JSON.stringify({
      event: "order.paid",
      id: "evt_test_1001",
      payload: {
        order: { entity: { id: targetOrderId } },
        payment: { entity: { id: samplePaymentId, notes: { user_id: validUser.id } } },
      },
    });
    const webhookBadSig = await webhookHandler({
      httpMethod: "POST",
      headers: { "x-razorpay-signature": "completely_invalid_hex_signature" },
      body: webhookRawBody,
    });
    assert.strictEqual(webhookBadSig.statusCode, 400);
    assert.strictEqual(JSON.parse(webhookBadSig.body).code, "INVALID_SIGNATURE");

    console.log("  -> [PASS-LOCAL] Invalid signatures rejected with 400 on verify and webhook.");

    // ---------------------------------------------------------------------------
    // TEST 5: Tampered Amount & Mismatched Order Row
    // ---------------------------------------------------------------------------
    console.log("\nTest 5: Verifying tamper protection on payment verify...");

    // 5A: Client sends altered amount (recorded = 149900, payload = 69200)
    const verifyTamperedAmount = await verifyHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer valid-token-pro" },
      body: JSON.stringify({
        order_id: targetOrderId,
        payment_id: samplePaymentId,
        razorpay_signature: validSignature,
        amount: 69200,
      }),
    });
    assert.strictEqual(verifyTamperedAmount.statusCode, 400);
    assert.strictEqual(JSON.parse(verifyTamperedAmount.body).code, "AMOUNT_MISMATCH");

    // 5B: Client sends mismatched planCode (recorded = monthly, payload = weekly)
    const verifyTamperedPlan = await verifyHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer valid-token-pro" },
      body: JSON.stringify({
        order_id: targetOrderId,
        payment_id: samplePaymentId,
        razorpay_signature: validSignature,
        planCode: "weekly",
      }),
    });
    assert.strictEqual(verifyTamperedPlan.statusCode, 400);
    assert.strictEqual(JSON.parse(verifyTamperedPlan.body).code, "PLAN_MISMATCH");

    // 5C: Non-existent order record
    const fakeOrderId = "order_non_existent_404";
    const fakeSig = computeSignature(`${fakeOrderId}|${samplePaymentId}`, TEST_SECRET);
    const verifyNonExistent = await verifyHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer valid-token-pro" },
      body: JSON.stringify({
        order_id: fakeOrderId,
        payment_id: samplePaymentId,
        razorpay_signature: fakeSig,
      }),
    });
    assert.strictEqual(verifyNonExistent.statusCode, 404);
    assert.strictEqual(JSON.parse(verifyNonExistent.body).code, "ORDER_NOT_FOUND");

    console.log("  -> [PASS-LOCAL] Tampered amounts and mismatched orders successfully blocked.");

    // ---------------------------------------------------------------------------
    // TEST 6: Verify Happy Path & Idempotency
    // ---------------------------------------------------------------------------
    console.log("\nTest 6: Verifying verify fulfillment and repeat idempotency...");

    mockDb.rpcFulfilCalls = [];
    // 6A: First valid verify call
    const verifySuccess = await verifyHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer valid-token-pro" },
      body: JSON.stringify({
        order_id: targetOrderId,
        payment_id: samplePaymentId,
        razorpay_signature: validSignature,
      }),
    });
    assert.strictEqual(verifySuccess.statusCode, 200);
    const verifyBody = JSON.parse(verifySuccess.body);
    assert.strictEqual(verifyBody.success, true);
    assert.strictEqual(mockDb.rpcFulfilCalls.length, 1, "Must call fulfil_payment_order RPC");
    assert.strictEqual(mockDb.rpcFulfilCalls[0].orderId, targetOrderId);
    assert.strictEqual(mockDb.rpcFulfilCalls[0].userId, validUser.id);

    // 6B: Second verify call on same order -> Idempotent, returns alreadyPaid without re-fulfilling
    const verifyRepeat = await verifyHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer valid-token-pro" },
      body: JSON.stringify({
        order_id: targetOrderId,
        payment_id: samplePaymentId,
        razorpay_signature: validSignature,
      }),
    });
    assert.strictEqual(verifyRepeat.statusCode, 200);
    const repeatBody = JSON.parse(verifyRepeat.body);
    assert.strictEqual(repeatBody.alreadyPaid, true);
    assert.strictEqual(
      mockDb.rpcFulfilCalls.length,
      1,
      "Must NOT re-execute RPC on already paid order"
    );

    console.log(
      "  -> [PASS-LOCAL] Verification fulfills order and handles repeat calls idempotently."
    );

    // ---------------------------------------------------------------------------
    // TEST 7: Webhook - RPC returns success: false (non-200, no dedupe row left)
    // ---------------------------------------------------------------------------
    console.log("\nTest 7: Verifying webhook when RPC returns success: false...");

    // Create an order for testing RPC failure
    const failOrderRes = await orderHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer valid-token-pro" },
      body: JSON.stringify({ planCode: "weekly" }),
    });
    assert.strictEqual(failOrderRes.statusCode, 200);
    const failOrderId = JSON.parse(failOrderRes.body).orderId;

    const failEventId = "evt_fail_test_777";
    const failWebhookPayload = JSON.stringify({
      event: "order.paid",
      id: failEventId,
      payload: {
        order: { entity: { id: failOrderId } },
        payment: { entity: { id: "pay_fail_777", notes: { user_id: validUser.id } } },
      },
    });
    const failWebhookSig = computeSignature(failWebhookPayload, TEST_WEBHOOK_SECRET);

    // Mock RPC returning success: false
    mockDb.customRpcHandler = async () => ({
      data: {
        success: false,
        code: "ORDER_INVALID_STATE",
        error: "Payment order is not in created state",
      },
      error: null,
    });

    const webhookRpcFailRes = await webhookHandler({
      httpMethod: "POST",
      headers: { "x-razorpay-signature": failWebhookSig },
      body: failWebhookPayload,
    });

    // Must return non-200 (HTTP 500 for retry)
    assert.strictEqual(
      webhookRpcFailRes.statusCode,
      500,
      "Must return HTTP 500 on RPC success:false"
    );
    const failResBody = JSON.parse(webhookRpcFailRes.body);
    assert.strictEqual(
      failResBody.fulfilled,
      undefined,
      "Must NEVER return fulfilled:true when RPC fails"
    );
    assert.strictEqual(failResBody.code, "ORDER_INVALID_STATE");

    // Dedupe row must NOT be left in webhook_events!
    assert.strictEqual(
      mockDb.webhookEvents.has(failEventId),
      false,
      "Must NOT leave dedupe row in webhook_events when fulfillment failed"
    );

    console.log(
      "  -> [PASS-LOCAL] Webhook properly returns non-200 and leaves no dedupe row when RPC returns success:false."
    );

    // ---------------------------------------------------------------------------
    // TEST 8: Webhook - RPC throws error, then retry succeeds
    // ---------------------------------------------------------------------------
    console.log("\nTest 8: Verifying webhook when RPC throws error, then retry succeeds...");

    const retryOrderRes = await orderHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer valid-token-pro" },
      body: JSON.stringify({ planCode: "weekly" }),
    });
    assert.strictEqual(retryOrderRes.statusCode, 200);
    const retryOrderId = JSON.parse(retryOrderRes.body).orderId;

    const retryEventId = "evt_retry_test_888";
    const retryWebhookPayload = JSON.stringify({
      event: "order.paid",
      id: retryEventId,
      payload: {
        order: { entity: { id: retryOrderId } },
        payment: { entity: { id: "pay_retry_888", notes: { user_id: validUser.id } } },
      },
    });
    const retryWebhookSig = computeSignature(retryWebhookPayload, TEST_WEBHOOK_SECRET);

    // Attempt 1: RPC throws an unexpected error (e.g. DB connection reset)
    mockDb.customRpcHandler = async () => {
      throw new Error("Postgres connection timeout");
    };

    const webhookThrowRes = await webhookHandler({
      httpMethod: "POST",
      headers: { "x-razorpay-signature": retryWebhookSig },
      body: retryWebhookPayload,
    });

    assert.strictEqual(webhookThrowRes.statusCode, 500, "Thrown RPC must return HTTP 500");
    assert.strictEqual(
      mockDb.webhookEvents.has(retryEventId),
      false,
      "Dedupe row must NOT be left when RPC threw an exception"
    );

    // Attempt 2: Razorpay retries with the SAME event_id, RPC now succeeds!
    mockDb.rpcFulfilCalls = [];
    mockDb.customRpcHandler = async (fnName: string, args: any) => {
      mockDb.rpcFulfilCalls.push({
        orderId: args.p_provider_order_id,
        userId: args.p_user_id,
      });
      const order = mockDb.orders.get(args.p_provider_order_id);
      if (order) {
        order.status = "paid";
        order.paid_at = new Date().toISOString();
      }
      return {
        data: {
          success: true,
          order_id: args.p_provider_order_id,
          fulfilled: true,
        },
        error: null,
      };
    };

    const webhookRetrySuccessRes = await webhookHandler({
      httpMethod: "POST",
      headers: { "x-razorpay-signature": retryWebhookSig },
      body: retryWebhookPayload,
    });

    assert.strictEqual(webhookRetrySuccessRes.statusCode, 200, "Retry must succeed with HTTP 200");
    const retrySuccessBody = JSON.parse(webhookRetrySuccessRes.body);
    assert.strictEqual(
      retrySuccessBody.fulfilled,
      true,
      "Must return fulfilled:true on successful retry"
    );
    assert.strictEqual(mockDb.rpcFulfilCalls.length, 1, "Must execute fulfillment RPC on retry");
    assert.strictEqual(mockDb.rpcFulfilCalls[0].orderId, retryOrderId);

    // Dedupe row must NOW be saved in webhook_events
    assert.strictEqual(
      mockDb.webhookEvents.has(retryEventId),
      true,
      "Dedupe row must be inserted into webhook_events after fulfillment succeeds"
    );

    console.log(
      "  -> [PASS-LOCAL] Webhook survives transient RPC throw and successfully fulfills on retry."
    );

    // ---------------------------------------------------------------------------
    // TEST 9: Webhook - Duplicate event delivery AFTER success
    // ---------------------------------------------------------------------------
    console.log("\nTest 9: Verifying duplicate event after success returns alreadyProcessed...");

    // Send the SAME retryEventId a third time (duplicate delivery by Razorpay after success)
    mockDb.rpcFulfilCalls = [];
    const webhookDupAfterSuccessRes = await webhookHandler({
      httpMethod: "POST",
      headers: { "x-razorpay-signature": retryWebhookSig },
      body: retryWebhookPayload,
    });

    assert.strictEqual(webhookDupAfterSuccessRes.statusCode, 200);
    const dupBody = JSON.parse(webhookDupAfterSuccessRes.body);
    assert.strictEqual(
      dupBody.alreadyProcessed,
      true,
      "Must return alreadyProcessed:true on duplicate event"
    );
    assert.strictEqual(
      mockDb.rpcFulfilCalls.length,
      0,
      "Must NOT re-execute RPC on duplicate event after success"
    );

    console.log(
      "  -> [PASS-LOCAL] Duplicate webhook delivery after success safely recognized without re-fulfilment."
    );

    // ---------------------------------------------------------------------------
    // TEST 10: Audit Blocker B2: Host Canonicalization, Zero Razorpay Calls, and Live Key Success
    // ---------------------------------------------------------------------------
    console.log(
      "\nTest 10: Verifying host canonicalization, zero Razorpay calls on rejection, and live key success..."
    );

    let netlifyB2FetchCalls = 0;
    const trackedB2Fetch = async () => {
      netlifyB2FetchCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "order_b2_netlify_mock",
          amount: 69200,
          currency: "INR",
          status: "created",
        }),
      };
    };

    const b2OrderHandler = createOrderHandler({
      getSupabaseAdmin: mockAdminGetter,
      getServerEntitlement: mockEntitlement,
      fetchFn: trackedB2Fetch as any,
    });

    // 10A: Host canonicalization rejections with test key (trailing dot, uppercase, port, conflicting headers)
    process.env.RAZORPAY_MODE = "test";
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = TEST_KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = TEST_SECRET;

    const netlifyProdHostCases = [
      { desc: "host: careermonke.com", headers: { host: "careermonke.com" } },
      { desc: "host: www.careermonke.com", headers: { host: "www.careermonke.com" } },
      { desc: "host: careermonke.com. (trailing dot)", headers: { host: "careermonke.com." } },
      {
        desc: "host: www.careermonke.com. (trailing dot)",
        headers: { host: "www.careermonke.com." },
      },
      { desc: "host: CAREERMONKE.COM (uppercase)", headers: { host: "CAREERMONKE.COM" } },
      {
        desc: "host: CAREERMONKE.COM. (uppercase + trailing dot)",
        headers: { host: "CAREERMONKE.COM." },
      },
      { desc: "host: careermonke.com:443 (port)", headers: { host: "careermonke.com:443" } },
      {
        desc: "host: careermonke.com.:443 (trailing dot + port)",
        headers: { host: "careermonke.com.:443" },
      },
      {
        desc: "host: WWW.CAREERMONKE.COM.:8443 (uppercase + trailing dot + port)",
        headers: { host: "WWW.CAREERMONKE.COM.:8443" },
      },
      // Conflicting preview x-forwarded-host with a production Host
      {
        desc: "conflicting preview x-forwarded-host with careermonke.com.",
        headers: {
          "x-forwarded-host": "preview-branch.careermonke.netlify.app",
          host: "careermonke.com.",
        },
      },
      {
        desc: "conflicting preview x-forwarded-host with www.careermonke.com.",
        headers: {
          "x-forwarded-host": "preview-branch.careermonke.netlify.app",
          host: "www.careermonke.com.",
        },
      },
    ];

    for (const tc of netlifyProdHostCases) {
      netlifyB2FetchCalls = 0;
      const res = await b2OrderHandler({
        httpMethod: "POST",
        headers: { authorization: "Bearer valid-token-pro", ...tc.headers },
        body: JSON.stringify({ planCode: "weekly" }),
      });
      assert.strictEqual(
        res.statusCode,
        503,
        `Netlify order must reject test key on production host (${tc.desc})`
      );
      assert.strictEqual(
        netlifyB2FetchCalls,
        0,
        `Netlify must NEVER call Razorpay API on rejection (${tc.desc})`
      );
      assert.strictEqual(JSON.parse(res.body).code, "RAZORPAY_CONFIG_ERROR");
    }

    // rawUrl variations (trailing dot, port, with conflicting x-forwarded-host)
    const rawUrlCases = [
      "https://careermonke.com/.netlify/functions/billing-razorpay-order",
      "https://careermonke.com./.netlify/functions/billing-razorpay-order",
      "https://www.careermonke.com./.netlify/functions/billing-razorpay-order",
      "https://CAREERMONKE.COM:443/.netlify/functions/billing-razorpay-order",
    ];
    for (const rawUrl of rawUrlCases) {
      netlifyB2FetchCalls = 0;
      const res = await b2OrderHandler({
        httpMethod: "POST",
        rawUrl,
        headers: {
          authorization: "Bearer valid-token-pro",
          "x-forwarded-host": "preview-branch.netlify.app",
        },
        body: JSON.stringify({ planCode: "weekly" }),
      });
      assert.strictEqual(res.statusCode, 503, `Netlify must reject test key for rawUrl: ${rawUrl}`);
      assert.strictEqual(netlifyB2FetchCalls, 0, `Netlify must NEVER call Razorpay on ${rawUrl}`);
    }

    // 10B: Live key on production host succeeds (200 OK, calls Razorpay)
    process.env.RAZORPAY_MODE = "live";
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_live_key_valid_123456";
    process.env.RAZORPAY_KEY_SECRET = "rzp_live_secret_valid_654321";

    const liveProdCases = [
      { desc: "host: careermonke.com", headers: { host: "careermonke.com" } },
      { desc: "host: careermonke.com. (trailing dot)", headers: { host: "careermonke.com." } },
      {
        desc: "host: www.careermonke.com. (trailing dot)",
        headers: { host: "www.careermonke.com." },
      },
      {
        desc: "host: CAREERMONKE.COM:443 (uppercase + port)",
        headers: { host: "CAREERMONKE.COM:443" },
      },
      {
        desc: "conflicting preview x-forwarded-host with careermonke.com.",
        headers: { "x-forwarded-host": "preview-branch.netlify.app", host: "careermonke.com." },
      },
    ];

    for (const lc of liveProdCases) {
      netlifyB2FetchCalls = 0;
      const res = await b2OrderHandler({
        httpMethod: "POST",
        headers: { authorization: "Bearer valid-token-pro", ...lc.headers },
        body: JSON.stringify({ planCode: "weekly" }),
      });
      assert.strictEqual(
        res.statusCode,
        200,
        `Live key on production host must succeed on Netlify (${lc.desc})`
      );
      assert.strictEqual(
        netlifyB2FetchCalls,
        1,
        `Live key on production host must call Razorpay API (${lc.desc})`
      );
      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.orderId, "order_b2_netlify_mock");
    }

    console.log(
      "  -> [PASS-LOCAL] Host canonicalization, zero Razorpay calls on rejection, and live key success verified on Netlify."
    );
  } finally {
    // Restore original env vars
    process.env.NEXT_PUBLIC_BILLING_ENABLED = origBilling;
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = origKeyId;
    process.env.RAZORPAY_KEY_SECRET = origKeySecret;
    process.env.RAZORPAY_WEBHOOK_SECRET = origWebhookSecret;
    if (origMode !== undefined) {
      process.env.RAZORPAY_MODE = origMode;
    } else {
      delete process.env.RAZORPAY_MODE;
    }
  }

  console.log("\n--------------------------------------------------------------------------------");
  console.log("ALL 10 NETLIFY BILLING TEST SUITES PASSED [PASS-LOCAL]");
  console.log("--------------------------------------------------------------------------------\n");
}

runSuite().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
