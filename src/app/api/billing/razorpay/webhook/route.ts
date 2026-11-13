import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRazorpayKeyMode } from "@/lib/billing/mode";
import { recordFailedEvent } from "@/lib/events/failedEvents";
import { createLogger } from "@/lib/observability/logger";

const baseLog = createLogger({ context: { route: "/api/billing/razorpay/webhook" } });

export const runtime = "edge";

const CORS_HEADERS = {
  "Allow": "POST, OPTIONS",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Razorpay-Signature, x-razorpay-signature, x-razorpay-event-id, X-Razorpay-Event-Id",
};

/**
 * Constant-time string comparison preventing timing oracles.
 * Compares every character without early exit.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Computes a fixed-length SHA-256 hex digest using Web Crypto.
 */
export async function computeSha256Hex(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Timing-safe cryptographic signature verification for Razorpay webhooks.
 * Computes HMAC-SHA256 of the raw body using the webhook secret, then
 * performs constant-time comparison over fixed-length SHA-256 digests.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string
): Promise<boolean> {
  if (!rawBody || !signature || !secret) return false;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
    const hashArray = Array.from(new Uint8Array(signatureBuffer));
    const expectedHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

    // Constant-time comparison over fixed-length SHA-256 digests (no early exit or length leakage)
    const [expectedDigest, signatureDigest] = await Promise.all([
      computeSha256Hex(expectedHex.toLowerCase()),
      computeSha256Hex(signature.trim().toLowerCase()),
    ]);
    return constantTimeEqual(expectedDigest, signatureDigest);
  } catch {
    return false;
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: CORS_HEADERS,
  });
}

export async function GET() {
  return NextResponse.json(
    { error: "Method not allowed" },
    { status: 405, headers: CORS_HEADERS }
  );
}

export async function POST(req: Request) {
  const log = baseLog.child({ requestId: req?.headers.get("x-request-id") ?? "unknown" });
  const deps = (req as any).__testDeps || {};

  // 1. Gating: Payments must be enabled
  if (process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") {
    return NextResponse.json(
      {
        error: "Billing is currently unavailable",
        code: "BILLING_DISABLED",
      },
      { status: 503, headers: CORS_HEADERS }
    );
  }

  let eventId = "";
  let payload: any = {};
  let supabaseAdmin: any = null;

  try {
    // 2. Secret configuration validation
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      log.error("[Razorpay Webhook] Missing RAZORPAY_WEBHOOK_SECRET");
      return NextResponse.json(
        { error: "Webhook secret is not configured" },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const serverKeyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID || "";
    const serverMode = getRazorpayKeyMode(serverKeyId);
    if (serverMode === "unknown") {
      log.error("[Razorpay Webhook] Server Razorpay key configuration missing or invalid prefix");
      return NextResponse.json(
        {
          error: "Server Razorpay key configuration invalid",
          code: "RAZORPAY_CONFIG_INVALID",
        },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    // 3. Signature verification BEFORE any payload processing
    const signature =
      req.headers.get("x-razorpay-signature") ||
      req.headers.get("X-Razorpay-Signature");

    if (!signature) {
      return NextResponse.json(
        {
          error: "Missing signature header",
          code: "MISSING_SIGNATURE",
        },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const rawBody = await req.text();

    const isValidSignature = await verifyWebhookSignature(rawBody, signature, webhookSecret);
    if (!isValidSignature) {
      return NextResponse.json(
        {
          error: "Invalid webhook signature",
          code: "INVALID_SIGNATURE",
        },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // 4. JSON body parsing after signature is cryptographically verified
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON request body" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    eventId =
      payload.id ||
      payload.event_id ||
      req.headers.get("x-razorpay-event-id") ||
      req.headers.get("X-Razorpay-Event-Id") ||
      `rzp_evt_${payload.event}_${payload.payload?.payment?.entity?.id || payload.payload?.order?.entity?.id}_${payload.created_at || Date.now()}`;

    // 5. Database client initialization
    if (deps.getSupabaseAdmin) {
      supabaseAdmin = deps.getSupabaseAdmin();
    } else {
      const supabaseUrl =
        process.env.NEXT_PUBLIC_SUPABASE_URL ||
        process.env.SUPABASE_URL ||
        "https://szakevhxhwpeskidvtfs.supabase.co";
      const serviceKey =
        process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

      if (!supabaseUrl || !serviceKey) {
        log.error("[Razorpay Webhook] Supabase service configuration missing");
        return NextResponse.json(
          { error: "Supabase service configuration missing" },
          { status: 500, headers: CORS_HEADERS }
        );
      }

      supabaseAdmin = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false },
      });
    }

    const eventType = payload.event;

    // 6. Handle payment fulfillment events: order.paid and payment.captured
    if (eventType === "order.paid" || eventType === "payment.captured") {
      const orderId =
        payload.payload?.order?.entity?.id ||
        payload.payload?.payment?.entity?.order_id;

      if (!orderId) {
        return NextResponse.json(
          {
            error: "Missing order_id in webhook payload",
            code: "MISSING_ORDER_ID",
          },
          { status: 400, headers: CORS_HEADERS }
        );
      }

      let userId =
        payload.payload?.payment?.entity?.notes?.user_id ||
        payload.payload?.order?.entity?.notes?.user_id;

      // Fetch order row from payment_orders to check current status and user_id
      let orderRow: any = null;
      const { data: dbOrder } = await supabaseAdmin
        .from("payment_orders")
        .select("*")
        .eq("provider_order_id", orderId)
        .maybeSingle();

      orderRow = dbOrder;
      if (!userId && orderRow?.user_id) {
        userId = orderRow.user_id;
      }

      if (!userId) {
        return NextResponse.json(
          {
            error: "Order record or associated user not found",
            code: "ORDER_NOT_FOUND",
          },
          { status: 404, headers: CORS_HEADERS }
        );
      }

      // Validate provider
      if (orderRow?.provider && orderRow.provider !== "razorpay") {
        return NextResponse.json(
          {
            error: "Invalid payment provider",
            code: "INVALID_PROVIDER",
          },
          { status: 400, headers: CORS_HEADERS }
        );
      }

      // Mode Isolation: Server environment mode must match order mode
      const orderMode =
        orderRow?.mode ||
        (orderRow?.provider_order_id?.startsWith("order_test_") ? "test" : "live");
      if (orderRow && orderMode !== serverMode) {
        log.error("[Razorpay Webhook] Mode mismatch between order and server credentials", {
          orderMode,
          serverMode,
        });
        return NextResponse.json(
          {
            error: `Webhook mode mismatch: cannot process ${orderMode} order with ${serverMode} credentials`,
            code: "MODE_MISMATCH",
          },
          { status: 400, headers: CORS_HEADERS }
        );
      }

      // 7. Deduplication: Check if event was previously processed
      const { data: existingDedupe } = await supabaseAdmin
        .from("webhook_events")
        .select("event_id")
        .eq("event_id", eventId)
        .maybeSingle();

      if (existingDedupe) {
        // On a dedupe hit, re-attempt fulfillment if the order is still unpaid
        if (orderRow && orderRow.status !== "paid") {
          log.warn("[Razorpay Webhook] Dedupe hit but order is still unpaid; retrying fulfillment", {
            eventId,
            orderId,
          });
        } else {
          // Order is genuinely already paid / fulfilled
          return NextResponse.json(
            {
              received: true,
              alreadyProcessed: true,
              eventId,
              testMode: serverMode === "test",
              isPro: serverMode === "live" && Boolean(orderRow?.plan_code),
            },
            { status: 200, headers: CORS_HEADERS }
          );
        }
      }

      // 8. Fulfil atomically via database function
      const { data: fulfilRes, error: fulfilErr } = await supabaseAdmin.rpc("fulfil_payment_order", {
        p_provider_order_id: orderId,
        p_user_id: userId,
        p_expected_mode: serverMode,
      });

      if (fulfilErr) {
        log.error("[Razorpay Webhook] fulfil_payment_order RPC error", {
          eventId,
          orderId,
          error: String(fulfilErr),
        });
        try {
          await recordFailedEvent({
            source: "razorpay_webhook",
            eventId,
            payload: {
              event: eventType,
              order_id: orderId,
              user_id: userId,
              mode: serverMode,
              payload,
            },
            error: fulfilErr,
            supabaseClient: supabaseAdmin,
          });
        } catch (dlErr) {
          log.warn("[Razorpay Webhook] Failed to record dead-letter event", { error: String(dlErr) });
        }

        // Do not record dedupe row on RPC failure: return 500 so Razorpay retries
        return NextResponse.json(
          {
            error: "Payment fulfillment failed",
            code: "FULFILLMENT_FAILED",
          },
          { status: 500, headers: CORS_HEADERS }
        );
      }

      // 9. Strictly check fulfilRes.success
      if (!fulfilRes || !fulfilRes.success) {
        // Check if order was already paid (e.g. via verify endpoint race or ORDER_INVALID_STATE when genuinely paid)
        const isGenuinelyPaid =
          fulfilRes?.already_paid === true ||
          (fulfilRes?.code === "ORDER_INVALID_STATE" && orderRow?.status === "paid");

        if (isGenuinelyPaid) {
          // Genuinely already paid: record dedupe row and return 200
          await supabaseAdmin.from("webhook_events").upsert(
            {
              event_id: eventId,
              provider: "razorpay",
              event_type: eventType,
            },
            { onConflict: "event_id" }
          );

          return NextResponse.json(
            {
              received: true,
              alreadyPaid: true,
              eventId,
              testMode: serverMode === "test",
              isPro: serverMode === "live" && Boolean(orderRow?.plan_code),
              details: fulfilRes,
            },
            { status: 200, headers: CORS_HEADERS }
          );
        }

        // Unsuccessful: DO NOT record dedupe row!
        log.error("[Razorpay Webhook] fulfil_payment_order returned failure", {
          eventId,
          orderId,
          code: fulfilRes?.code,
        });
        try {
          await recordFailedEvent({
            source: "razorpay_webhook",
            eventId,
            payload: {
              event: eventType,
              order_id: orderId,
              user_id: userId,
              mode: serverMode,
              payload,
            },
            error: fulfilRes?.error || "fulfil_payment_order returned failure",
            supabaseClient: supabaseAdmin,
          });
        } catch (dlErr) {
          log.warn("[Razorpay Webhook] Failed to record dead-letter event", { error: String(dlErr) });
        }

        const statusCode = fulfilRes?.code === "ORDER_NOT_FOUND" ? 404 : 500;
        return NextResponse.json(
          {
            error: fulfilRes?.error || "Payment fulfillment failed",
            code: fulfilRes?.code || "FULFILLMENT_FAILED",
          },
          { status: statusCode, headers: CORS_HEADERS }
        );
      }

      // 10. Fulfillment succeeded (fulfilRes.success is true): Record dedupe row
      await supabaseAdmin.from("webhook_events").upsert(
        {
          event_id: eventId,
          provider: "razorpay",
          event_type: eventType,
        },
        { onConflict: "event_id" }
      );

      return NextResponse.json(
        {
          received: true,
          fulfilled: true,
          alreadyPaid: Boolean(fulfilRes.already_paid),
          testMode: serverMode === "test",
          isPro: serverMode === "live" && Boolean(fulfilRes?.is_pro ?? orderRow?.plan_code),
          eventId,
          details: fulfilRes,
        },
        { status: 200, headers: CORS_HEADERS }
      );
    }

    // 11. For non-fulfillment events (e.g. payment.failed, refund.created)
    await supabaseAdmin.from("webhook_events").insert({
      event_id: eventId,
      provider: "razorpay",
      event_type: eventType || "unknown",
    });

    return NextResponse.json(
      {
        received: true,
        ignored: true,
        event: eventType,
      },
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (err: any) {
    log.error("[Razorpay Webhook] Unexpected webhook handler error", { error: err?.message || String(err) });
    if (eventId && supabaseAdmin) {
      try {
        await recordFailedEvent({
          source: "razorpay_webhook",
          eventId,
          payload: payload || {},
          error: err,
          supabaseClient: supabaseAdmin,
        });
      } catch (_) {}
    }
    return NextResponse.json(
      { error: err?.message || "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
