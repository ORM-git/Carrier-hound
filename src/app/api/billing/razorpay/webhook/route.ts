import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRazorpayKeyMode } from "@/lib/billing/mode";
import { recordFailedEvent } from "@/lib/events/failedEvents";
import { createLogger } from "@/lib/observability/logger";
import { verifyWebhookSignatureBytes } from "@/lib/billing/webhookSignature";

const baseLog = createLogger({ context: { route: "/api/billing/razorpay/webhook" } });

export const runtime = "edge";

const MAX_BODY_BYTES = 256 * 1024; // 256 KB max payload to protect Edge memory

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, X-Razorpay-Signature, x-razorpay-signature, x-razorpay-event-id, X-Razorpay-Event-Id",
    },
  });
}

/**
 * Reads the request body stream up to maxBytes.
 * Works uniformly for chunked, streamed, or missing Content-Length requests.
 */
async function readBoundedRawBody(
  req: Request,
  maxBytes: number
): Promise<{ rawBytes: Uint8Array; oversize: boolean }> {
  if (!req.body) {
    return { rawBytes: new Uint8Array(0), oversize: false };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel();
          } catch (_) {}
          return { rawBytes: new Uint8Array(0), oversize: true };
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { rawBytes: result, oversize: false };
}

export async function POST(req: Request) {
  const log = baseLog.child({ requestId: req?.headers.get("x-request-id") ?? "unknown" });
  const deps = (req as any).__testDeps || {};

  // 1. Feature Flag Gating
  if (process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") {
    return NextResponse.json(
      {
        error: "Billing is currently unavailable",
        code: "BILLING_DISABLED",
      },
      { status: 503 }
    );
  }

  let eventId = "";
  let payload: any = {};
  let supabaseAdmin: any = null;

  try {
    // 2. Gateway and Secret Configuration
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      log.error("[Razorpay Webhook] Missing RAZORPAY_WEBHOOK_SECRET");
      return NextResponse.json(
        { error: "Webhook secret is not configured" },
        { status: 500 }
      );
    }

    // Key precedence: NEXT_PUBLIC_RAZORPAY_KEY_ID || RAZORPAY_KEY_ID
    const serverKeyId =
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ||
      process.env.RAZORPAY_KEY_ID ||
      "";
    const serverMode = getRazorpayKeyMode(serverKeyId);
    if (serverMode === "unknown") {
      log.error("[Razorpay Webhook] Server Razorpay key configuration missing or invalid prefix");
      return NextResponse.json(
        {
          error: "Server Razorpay key configuration invalid",
          code: "RAZORPAY_CONFIG_INVALID",
        },
        { status: 500 }
      );
    }

    // 3. Signature Header Extraction
    const signature =
      req.headers.get("x-razorpay-signature") ||
      req.headers.get("X-Razorpay-Signature");

    if (!signature) {
      return NextResponse.json(
        { error: "Missing signature header", code: "MISSING_SIGNATURE" },
        { status: 400 }
      );
    }

    // 4. Bounded Byte Ingestion (413 on oversize)
    const { rawBytes, oversize } = await readBoundedRawBody(req, MAX_BODY_BYTES);
    if (oversize) {
      log.warn("[Razorpay Webhook] Payload exceeded size limit", { maxBytes: MAX_BODY_BYTES });
      return NextResponse.json(
        { error: "Payload too large", code: "PAYLOAD_TOO_LARGE" },
        { status: 413 }
      );
    }

    // 5. Signature Verification via WebCrypto verify primitive
    const isValidSignature = await verifyWebhookSignatureBytes(
      rawBytes,
      signature,
      webhookSecret
    );

    if (!isValidSignature) {
      return NextResponse.json(
        { error: "Invalid webhook signature", code: "INVALID_SIGNATURE" },
        { status: 400 }
      );
    }

    // 6. JSON Parse
    try {
      const text = new TextDecoder().decode(rawBytes);
      payload = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON request body" },
        { status: 400 }
      );
    }

    // 7. Validate Payload Shape
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return NextResponse.json(
        { error: "Malformed payload shape", code: "MALFORMED_PAYLOAD" },
        { status: 400 }
      );
    }

    const eventType = payload.event;
    if (!eventType || typeof eventType !== "string" || !eventType.trim()) {
      return NextResponse.json(
        { error: "Missing or invalid event field in payload", code: "MALFORMED_PAYLOAD" },
        { status: 400 }
      );
    }

    const isFulfillmentEvent =
      eventType === "order.paid" || eventType === "payment.captured";

    let orderId = "";
    if (isFulfillmentEvent) {
      orderId =
        payload.payload?.order?.entity?.id ||
        payload.payload?.payment?.entity?.order_id ||
        "";

      if (!orderId || typeof orderId !== "string" || !orderId.trim()) {
        return NextResponse.json(
          { error: "Missing order_id in webhook payload", code: "MISSING_ORDER_ID" },
          { status: 400 }
        );
      }
      orderId = orderId.trim();
    }

    // 8. Event ID Resolution (Validated stable ID, no Date.now fallback)
    const headerEventId =
      req.headers.get("x-razorpay-event-id") ||
      req.headers.get("X-Razorpay-Event-Id");

    const payloadEventId =
      typeof payload.event_id === "string" && payload.event_id.trim()
        ? payload.event_id.trim()
        : typeof payload.id === "string" && payload.id.trim()
          ? payload.id.trim()
          : "";

    if (headerEventId && headerEventId.trim()) {
      eventId = headerEventId.trim();
    } else if (payloadEventId) {
      eventId = payloadEventId;
    } else if (orderId) {
      // Stable composite order:event
      eventId = `${orderId}:${eventType}`;
    } else if (payload.payload?.payment?.entity?.id) {
      eventId = `${payload.payload.payment.entity.id}:${eventType}`;
    }

    if (!eventId) {
      return NextResponse.json(
        { error: "Unable to determine stable event identifier", code: "MALFORMED_PAYLOAD" },
        { status: 400 }
      );
    }

    // 9. Supabase Admin Initialization
    try {
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
          throw new Error("Supabase service configuration missing");
        }

        supabaseAdmin = createClient(supabaseUrl, serviceKey, {
          auth: { persistSession: false },
        });
      }
    } catch (err: any) {
      log.error("[Razorpay Webhook] Supabase admin init error", { error: err?.message || String(err) });
      return NextResponse.json(
        { error: "Supabase service configuration missing" },
        { status: 500 }
      );
    }

    // 10. Process Fulfillment Events
    if (isFulfillmentEvent) {
      // Query payment_orders authoritatively
      const { data: dbOrder, error: orderLookupErr } = await supabaseAdmin
        .from("payment_orders")
        .select("*")
        .eq("provider_order_id", orderId)
        .maybeSingle();

      if (orderLookupErr) {
        log.error("[Razorpay Webhook] DB error querying payment_orders", {
          error: orderLookupErr.message,
          orderId,
        });
        try {
          await recordFailedEvent({
            source: "razorpay_webhook",
            eventId,
            payload: { order_id: orderId, event: eventType, error: orderLookupErr.message },
            error: orderLookupErr,
            supabaseClient: supabaseAdmin,
          });
        } catch (_) {}
        return NextResponse.json(
          { error: "Database error querying order", code: "DATABASE_ERROR" },
          { status: 500 }
        );
      }

      if (!dbOrder) {
        return NextResponse.json(
          { error: "Order record not found", code: "ORDER_NOT_FOUND" },
          { status: 404 }
        );
      }

      // Require authoritative provider
      if (!dbOrder.provider || dbOrder.provider !== "razorpay") {
        return NextResponse.json(
          { error: "Invalid payment provider", code: "INVALID_PROVIDER" },
          { status: 400 }
        );
      }

      // Require authoritative mode matching server mode
      const orderMode = dbOrder.mode;
      if (!orderMode || orderMode !== serverMode) {
        log.error("[Razorpay Webhook] Mode mismatch between order and server credentials", {
          orderMode,
          serverMode,
        });
        return NextResponse.json(
          {
            error: `Webhook mode mismatch: cannot process ${orderMode || "unknown"} order with ${serverMode} credentials`,
            code: "MODE_MISMATCH",
          },
          { status: 400 }
        );
      }

      // Derive authoritative user from row
      const userId = dbOrder.user_id;
      if (!userId) {
        return NextResponse.json(
          { error: "Order record has no associated user", code: "ORDER_NOT_FOUND" },
          { status: 404 }
        );
      }

      // Reject mismatch between authoritative user and payload notes
      const payloadNotesUserId =
        payload.payload?.payment?.entity?.notes?.user_id ||
        payload.payload?.order?.entity?.notes?.user_id ||
        payload.notes?.user_id ||
        payload.notes?.userId;

      if (payloadNotesUserId && String(payloadNotesUserId).trim() !== String(userId).trim()) {
        log.error("[Razorpay Webhook] User mismatch between payload notes and order row", {
          payloadUserId: payloadNotesUserId,
          orderUserId: userId,
        });
        return NextResponse.json(
          { error: "Payload user does not match order record", code: "USER_MISMATCH" },
          { status: 400 }
        );
      }

      // Check deduplication in webhook_events
      const { data: existingDedupe, error: dedupeLookupErr } = await supabaseAdmin
        .from("webhook_events")
        .select("event_id")
        .eq("event_id", eventId)
        .maybeSingle();

      if (dedupeLookupErr) {
        log.error("[Razorpay Webhook] DB error querying webhook_events dedupe", {
          error: dedupeLookupErr.message,
          eventId,
        });
        return NextResponse.json(
          { error: "Database error checking webhook idempotency", code: "DATABASE_ERROR" },
          { status: 500 }
        );
      }

      if (existingDedupe) {
        if (dbOrder.status !== "paid") {
          log.warn("[Razorpay Webhook] Dedupe hit but order is still unpaid. Retrying fulfillment.", {
            eventId,
            orderId,
          });
        } else {
          return NextResponse.json(
            {
              received: true,
              alreadyProcessed: true,
              eventId,
              testMode: serverMode === "test",
              isPro: serverMode === "live" && Boolean(dbOrder.plan_code),
            },
            { status: 200 }
          );
        }
      }

      // Call database atomic procedure
      const { data: fulfilRes, error: fulfilErr } = await supabaseAdmin.rpc("fulfil_payment_order", {
        p_provider_order_id: orderId,
        p_user_id: userId,
        p_expected_mode: serverMode,
      });

      if (fulfilErr) {
        log.error("[Razorpay Webhook] fulfil_payment_order RPC error", {
          error: fulfilErr.message || String(fulfilErr),
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
            },
            error: fulfilErr,
            supabaseClient: supabaseAdmin,
          });
        } catch (_) {}

        return NextResponse.json(
          { error: "Payment fulfillment failed", code: "FULFILLMENT_FAILED" },
          { status: 500 }
        );
      }

      if (!fulfilRes || !fulfilRes.success) {
        const isGenuinelyPaid =
          fulfilRes?.already_paid === true ||
          (fulfilRes?.code === "ORDER_INVALID_STATE" && dbOrder.status === "paid");

        if (isGenuinelyPaid) {
          const { error: dedupeWriteErr } = await supabaseAdmin
            .from("webhook_events")
            .upsert(
              {
                event_id: eventId,
                provider: "razorpay",
                event_type: eventType,
              },
              { onConflict: "event_id" }
            );

          if (dedupeWriteErr) {
            log.error("[Razorpay Webhook] Failed to record dedupe for already-paid order", {
              error: dedupeWriteErr.message,
            });
            return NextResponse.json(
              { error: "Failed to record webhook event receipt", code: "RECEIPT_WRITE_FAILED" },
              { status: 500 }
            );
          }

          return NextResponse.json(
            {
              received: true,
              alreadyPaid: true,
              eventId,
              testMode: serverMode === "test",
              isPro: serverMode === "live" && Boolean(dbOrder.plan_code),
              details: fulfilRes,
            },
            { status: 200 }
          );
        }

        log.error("[Razorpay Webhook] fulfil_payment_order returned failure", {
          code: fulfilRes?.code,
          error: fulfilRes?.error,
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
            },
            error: fulfilRes?.error || "fulfil_payment_order returned failure",
            supabaseClient: supabaseAdmin,
          });
        } catch (_) {}

        const statusCode = fulfilRes?.code === "ORDER_NOT_FOUND" ? 404 : 500;
        return NextResponse.json(
          {
            error: fulfilRes?.error || "Payment fulfillment failed",
            code: fulfilRes?.code || "FULFILLMENT_FAILED",
          },
          { status: statusCode }
        );
      }

      // Fulfillment succeeded -> Record receipt in webhook_events
      const { error: dedupeWriteErr } = await supabaseAdmin
        .from("webhook_events")
        .upsert(
          {
            event_id: eventId,
            provider: "razorpay",
            event_type: eventType,
          },
          { onConflict: "event_id" }
        );

      if (dedupeWriteErr) {
        log.error("[Razorpay Webhook] Failed to record dedupe on successful fulfillment", {
          error: dedupeWriteErr.message,
        });
        return NextResponse.json(
          { error: "Failed to record webhook event receipt", code: "RECEIPT_WRITE_FAILED" },
          { status: 500 }
        );
      }

      return NextResponse.json(
        {
          received: true,
          fulfilled: true,
          eventId,
          testMode: serverMode === "test",
          isPro: serverMode === "live" && Boolean(dbOrder.plan_code),
        },
        { status: 200 }
      );
    }

    // 11. Handle Non-Fulfillment Events (payment.failed, refund.created, etc.)
    const { error: nonFulfilDedupeErr } = await supabaseAdmin
      .from("webhook_events")
      .upsert(
        {
          event_id: eventId,
          provider: "razorpay",
          event_type: eventType,
        },
        { onConflict: "event_id" }
      );

    if (nonFulfilDedupeErr) {
      log.error("[Razorpay Webhook] Failed to record dedupe for non-fulfillment event", {
        error: nonFulfilDedupeErr.message,
      });
      return NextResponse.json(
        { error: "Failed to record webhook event receipt", code: "RECEIPT_WRITE_FAILED" },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        received: true,
        ignored: true,
        event: eventType,
        eventId,
      },
      { status: 200 }
    );
  } catch (err: any) {
    log.error("[Razorpay Webhook] Unexpected webhook handler error", {
      error: err?.message || String(err),
    });
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
      { status: 500 }
    );
  }
}
