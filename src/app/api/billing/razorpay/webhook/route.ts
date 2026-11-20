import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRazorpayKeyMode } from "@/lib/billing/mode";
import { recordFailedEvent } from "@/lib/events/failedEvents";
import { createLogger } from "@/lib/observability/logger";
import { verifyWebhookSignatureBytes } from "@/lib/billing/webhookSignature";
import { verifyUserNotBanned } from "@/lib/admin/auth";
import { getRuntimeEnv } from "@/lib/ai/serviceHandler";

const baseLog = createLogger({ context: { route: "/api/billing/razorpay/webhook" } });

export const runtime = "edge";

async function getCloudflareEnv(deps?: any): Promise<Record<string, any> | undefined> {
  if (deps?.cfEnv) return deps.cfEnv;
  if (deps?.env) return deps.env;
  try {
    const mod = await import("@cloudflare/next-on-pages").catch(() => null);
    const ctx = mod?.getRequestContext?.();
    if (ctx?.env) {
      return ctx.env as Record<string, any>;
    }
  } catch {}
  try {
    const cfContext = (globalThis as any)[Symbol.for("__cloudflare-request-context__")];
    if (cfContext?.env) {
      return cfContext.env as Record<string, any>;
    }
  } catch {}
  return undefined;
}

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
  const cfEnv = await getCloudflareEnv(deps);

  // 1. Feature Flag Gating
  if (getRuntimeEnv("NEXT_PUBLIC_BILLING_ENABLED", cfEnv) !== "true") {
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
    const webhookSecret = getRuntimeEnv("RAZORPAY_WEBHOOK_SECRET", cfEnv);
    if (!webhookSecret) {
      log.error("[Razorpay Webhook] Missing RAZORPAY_WEBHOOK_SECRET");
      return NextResponse.json(
        { error: "Webhook secret is not configured" },
        { status: 500 }
      );
    }

    // Key precedence: NEXT_PUBLIC_RAZORPAY_KEY_ID || RAZORPAY_KEY_ID
    const serverKeyId =
      getRuntimeEnv("NEXT_PUBLIC_RAZORPAY_KEY_ID", cfEnv) ||
      getRuntimeEnv("RAZORPAY_KEY_ID", cfEnv) ||
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

    const isOrderFulfillmentEvent =
      eventType === "order.paid" || eventType === "payment.captured";

    let orderId = "";
    if (isOrderFulfillmentEvent) {
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

    // 8. Event ID Resolution (Validated stable ID)
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
      eventId = `${orderId}:${eventType}`;
    } else if (payload.payload?.payment?.entity?.id) {
      eventId = `${payload.payload.payment.entity.id}:${eventType}`;
    } else if (payload.payload?.subscription?.entity?.id) {
      eventId = `${payload.payload.subscription.entity.id}:${eventType}`;
    } else if (payload.payload?.order?.entity?.id) {
      eventId = `${payload.payload.order.entity.id}:${eventType}`;
    } else if (payload.subscription_id) {
      eventId = `${payload.subscription_id}:${eventType}`;
    }

    if (!eventId) {
      return NextResponse.json(
        { error: "Unable to determine stable event identifier", code: "MALFORMED_PAYLOAD" },
        { status: 400 }
      );
    }

    // (1) Dormancy Gate: subscription.* events must be gated by NEXT_PUBLIC_AUTORENEW_ENABLED
    if (eventType.startsWith("subscription.")) {
      if (getRuntimeEnv("NEXT_PUBLIC_AUTORENEW_ENABLED", cfEnv) !== "true") {
        log.info("[Razorpay Webhook] Auto-renew disabled; acknowledging and ignoring subscription event", {
          eventType,
          eventId,
        });
        return NextResponse.json(
          {
            received: true,
            ignored: true,
            reason: "AUTORENEW_DISABLED",
            event: eventType,
            eventId,
          },
          { status: 200 }
        );
      }
    }

    // 9. Supabase Admin Initialization
    try {
      if (deps.getSupabaseAdmin) {
        supabaseAdmin = deps.getSupabaseAdmin();
      } else {
        const supabaseUrl =
          getRuntimeEnv("NEXT_PUBLIC_SUPABASE_URL", cfEnv) ||
          getRuntimeEnv("SUPABASE_URL", cfEnv) ||
          "https://szakevhxhwpeskidvtfs.supabase.co";
        const serviceKey =
          getRuntimeEnv("SUPABASE_SERVICE_ROLE_KEY", cfEnv) ||
          getRuntimeEnv("SUPABASE_SERVICE_KEY", cfEnv);

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

    // -------------------------------------------------------------------------
    // (3 & 4) One atomic paid-cycle path: subscription.activated & subscription.charged
    // Handled in either order, binds subscription_id on first grant,
    // records initial_payment_id, prevents duplicate credit, supports new users.
    // -------------------------------------------------------------------------
    if (eventType === "subscription.activated" || eventType === "subscription.charged") {
      const subId =
        payload.payload?.subscription?.entity?.id ||
        payload.payload?.payment?.entity?.subscription_id ||
        payload.subscription_id ||
        payload.payload?.order?.entity?.id ||
        "";

      if (!subId || typeof subId !== "string" || !subId.trim()) {
        return NextResponse.json(
          { error: "Missing subscription id in webhook payload", code: "MISSING_SUBSCRIPTION_ID" },
          { status: 400 }
        );
      }
      const cleanSubId = subId.trim();

      // (4) Reject events with missing payment_id for any grant
      const paymentId =
        payload.payload?.payment?.entity?.id ||
        payload.payload?.subscription?.entity?.payment_id ||
        payload.payment_id ||
        "";

      if (!paymentId || typeof paymentId !== "string" || !paymentId.trim()) {
        return NextResponse.json(
          { error: "Missing payment_id for subscription grant", code: "MISSING_PAYMENT_ID" },
          { status: 400 }
        );
      }
      const cleanPaymentId = paymentId.trim();

      // Extract amount in paise if available
      const rawAmount =
        payload.payload?.payment?.entity?.amount ??
        payload.payload?.subscription?.entity?.amount ??
        payload.amount;
      const amountPaise = typeof rawAmount === "number" && rawAmount > 0 ? rawAmount : null;

      const rawCurrency =
        payload.payload?.payment?.entity?.currency ??
        payload.payload?.subscription?.entity?.currency ??
        payload.currency ??
        "INR";
      const cleanCurrency = typeof rawCurrency === "string" ? rawCurrency.trim().toUpperCase() : "INR";

      if (serverMode === "live" && cleanCurrency !== "INR") {
        log.error("[Razorpay Webhook] Currency mismatch for subscription grant", {
          currency: cleanCurrency,
          subId: cleanSubId,
        });
        return NextResponse.json(
          { error: `Currency mismatch: only INR is supported, received ${cleanCurrency}`, code: "INVALID_CURRENCY" },
          { status: 400 }
        );
      }

      // Mode isolation, provider, and ban pre-check
      let { data: dbOrder, error: orderLookupErr } = await supabaseAdmin
        .from("payment_orders")
        .select("id, provider, mode, user_id, status, plan_code, amount_paise")
        .eq("provider_order_id", cleanSubId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (orderLookupErr) {
        log.error("[Razorpay Webhook] DB error querying payment_orders", {
          error: orderLookupErr.message,
          orderId: cleanSubId,
        });
        return NextResponse.json(
          { error: "Database error querying order", code: "DATABASE_ERROR" },
          { status: 500 }
        );
      }

      if (dbOrder) {
        if (dbOrder.provider && dbOrder.provider !== "razorpay") {
          return NextResponse.json(
            { error: "Invalid payment provider", code: "INVALID_PROVIDER" },
            { status: 400 }
          );
        }
        if (dbOrder.mode && dbOrder.mode !== serverMode) {
          log.error("[Razorpay Webhook] Mode mismatch between order and server credentials", {
            orderMode: dbOrder.mode,
            serverMode,
          });
          return NextResponse.json(
            {
              error: `Webhook mode mismatch: cannot process ${dbOrder.mode} order with ${serverMode} credentials`,
              code: "MODE_MISMATCH",
            },
            { status: 400 }
          );
        }
        if (dbOrder.user_id) {
          const banChecker = deps.verifyUserNotBanned || verifyUserNotBanned;
          const banCheck = await banChecker(supabaseAdmin, dbOrder.user_id);
          if (banCheck?.isBlocked) {
            return NextResponse.json(
              { error: banCheck.error || "Account suspended. Access revoked by administrator.", code: "USER_BLOCKED" },
              { status: 403 }
            );
          }
        }
      } else {
        const { data: subRow } = await supabaseAdmin
          .from("subscriptions")
          .select("id, user_id, provider, metadata")
          .eq("subscription_id", cleanSubId)
          .maybeSingle();

        if (subRow) {
          if (subRow.provider && subRow.provider !== "razorpay") {
            return NextResponse.json(
              { error: "Invalid payment provider", code: "INVALID_PROVIDER" },
              { status: 400 }
            );
          }
          const subMode = subRow.metadata?.mode || "live";
          if (subMode !== serverMode) {
            return NextResponse.json(
              {
                error: `Webhook mode mismatch: cannot process ${subMode} subscription with ${serverMode} credentials`,
                code: "MODE_MISMATCH",
              },
              { status: 400 }
            );
          }
          if (subRow.user_id) {
            const banChecker = deps.verifyUserNotBanned || verifyUserNotBanned;
            const banCheck = await banChecker(supabaseAdmin, subRow.user_id);
            if (banCheck?.isBlocked) {
              return NextResponse.json(
                { error: banCheck.error || "Account suspended. Access revoked by administrator.", code: "USER_BLOCKED" },
                { status: 403 }
              );
            }
          }
        }
      }

      // Extract durable event timestamp (created_at on top-level payload only, NOT subscription.created_at)
      const eventTimestamp =
        typeof payload.created_at === "number" && payload.created_at > 0
          ? payload.created_at
          : null;

      // Execute atomic renewal/activation RPC
      const { data: renewalRes, error: renewalErr } = await supabaseAdmin.rpc(
        "fulfil_subscription_renewal",
        {
          p_razorpay_subscription_id: cleanSubId,
          p_payment_id: cleanPaymentId,
          p_expected_mode: serverMode,
          p_amount_paise: amountPaise,
          p_event_timestamp: eventTimestamp,
        }
      );

      if (renewalErr) {
        log.error("[Razorpay Webhook] fulfil_subscription_renewal RPC error", {
          error: renewalErr.message || String(renewalErr),
          subId: cleanSubId,
          paymentId: cleanPaymentId,
        });
        try {
          await recordFailedEvent({
            source: "razorpay_webhook",
            eventId,
            payload: {
              event: eventType,
              subscription_id: cleanSubId,
              payment_id: cleanPaymentId,
              mode: serverMode,
            },
            error: renewalErr,
            supabaseClient: supabaseAdmin,
          });
        } catch (_) {}

        return NextResponse.json(
          { error: "Subscription renewal failed", code: "RENEWAL_FAILED" },
          { status: 500 }
        );
      }

      if (renewalRes?.ignored) {
        log.info("[Razorpay Webhook] Paid event ignored by RPC", {
          subId: cleanSubId,
          reason: renewalRes.reason,
        });
        return NextResponse.json(
          {
            received: true,
            ignored: true,
            reason: renewalRes.reason || "OLD_MANDATE_IGNORED",
            event: eventType,
            eventId,
            details: renewalRes,
          },
          { status: 200 }
        );
      }

      if (!renewalRes || !renewalRes.success) {
        log.error("[Razorpay Webhook] fulfil_subscription_renewal returned failure", {
          code: renewalRes?.code,
          error: renewalRes?.error,
          subId: cleanSubId,
        });
        try {
          await recordFailedEvent({
            source: "razorpay_webhook",
            eventId,
            payload: {
              event: eventType,
              subscription_id: cleanSubId,
              payment_id: cleanPaymentId,
              mode: serverMode,
            },
            error: renewalRes?.error || "fulfil_subscription_renewal returned failure",
            supabaseClient: supabaseAdmin,
          });
        } catch (_) {}

        const statusCode =
          renewalRes?.code === "SUBSCRIPTION_NOT_FOUND"
            ? 404
            : renewalRes?.code === "USER_BANNED"
              ? 403
              : renewalRes?.code === "MODE_MISMATCH" ||
                  renewalRes?.code === "MODE_UNKNOWN" ||
                  renewalRes?.code === "INVALID_EXPECTED_MODE" ||
                  renewalRes?.code === "INVALID_PAYMENT_AMOUNT" ||
                  renewalRes?.code === "INVALID_PROVIDER" ||
                  renewalRes?.code === "MISSING_PAYMENT_ID" ||
                  renewalRes?.code === "PLAN_AMOUNT_MISMATCH" ||
                  renewalRes?.code === "INVALID_PLAN_CODE"
                ? 400
                : 500;

        return NextResponse.json(
          {
            error: renewalRes?.error || "Subscription grant failed",
            code: renewalRes?.code || "FULFILLMENT_FAILED",
          },
          { status: statusCode }
        );
      }

      // Record receipt in webhook_events
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
        log.error("[Razorpay Webhook] Failed to record dedupe on renewal", {
          error: dedupeWriteErr.message,
          eventId,
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
          renewed: true,
          eventId,
          alreadyProcessed: Boolean(renewalRes.already_processed),
          testMode: serverMode === "test" || Boolean(renewalRes.test_mode),
          isPro: serverMode === "live" && Boolean(renewalRes.is_pro),
          details: renewalRes,
        },
        { status: 200 }
      );
    }

    // -------------------------------------------------------------------------
    // (5) Subscription Lifecycle Events (halted, cancelled, completed, past_due, pending, paused, resumed)
    // Only mutates if subscription_id is the currently bound mandate.
    // Ignores out-of-order older events.
    // -------------------------------------------------------------------------
    const isLifecycleEvent =
      eventType === "subscription.pending" ||
      eventType === "subscription.halted" ||
      eventType === "subscription.cancelled" ||
      eventType === "subscription.canceled" ||
      eventType === "subscription.completed" ||
      eventType === "subscription.past_due" ||
      eventType === "subscription.paused" ||
      eventType === "subscription.resumed";

    if (isLifecycleEvent) {
      const subId =
        payload.payload?.subscription?.entity?.id ||
        payload.payload?.payment?.entity?.subscription_id ||
        payload.subscription_id ||
        "";

      if (!subId || typeof subId !== "string" || !subId.trim()) {
        return NextResponse.json(
          { error: "Missing subscription id in webhook payload", code: "MISSING_SUBSCRIPTION_ID" },
          { status: 400 }
        );
      }
      const cleanSubId = subId.trim();

      // Deduplication check on webhook_events.event_id
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
        return NextResponse.json(
          {
            received: true,
            alreadyProcessed: true,
            eventId,
            event: eventType,
          },
          { status: 200 }
        );
      }

      // Extract durable event timestamp (created_at on top-level payload only, NOT subscription.created_at)
      const eventTimestamp =
        typeof payload.created_at === "number" && payload.created_at > 0
          ? payload.created_at
          : null;

      // Atomic transition via handle_subscription_lifecycle_event RPC
      const { data: lifecycleRes, error: lifecycleErr } = await supabaseAdmin.rpc(
        "handle_subscription_lifecycle_event",
        {
          p_razorpay_subscription_id: cleanSubId,
          p_event_type: eventType,
          p_event_timestamp: eventTimestamp,
          p_expected_mode: serverMode,
        }
      );

      if (lifecycleErr) {
        log.error("[Razorpay Webhook] handle_subscription_lifecycle_event RPC error", {
          error: lifecycleErr.message || String(lifecycleErr),
          subId: cleanSubId,
          eventType,
        });
        return NextResponse.json(
          { error: "Failed to update subscription lifecycle", code: "DATABASE_ERROR" },
          { status: 500 }
        );
      }

      if (lifecycleRes?.ignored) {
        log.info("[Razorpay Webhook] Lifecycle event ignored by RPC", {
          subId: cleanSubId,
          eventType,
          reason: lifecycleRes.reason,
        });
        return NextResponse.json(
          {
            received: true,
            ignored: true,
            reason: lifecycleRes.reason || "UNBOUND_MANDATE",
            event: eventType,
            subscriptionId: cleanSubId,
            eventId,
            details: lifecycleRes,
          },
          { status: 200 }
        );
      }

      if (!lifecycleRes || !lifecycleRes.success) {
        log.error("[Razorpay Webhook] handle_subscription_lifecycle_event returned failure", {
          code: lifecycleRes?.code,
          error: lifecycleRes?.error,
          subId: cleanSubId,
        });
        const statusCode =
          lifecycleRes?.code === "USER_BANNED"
            ? 403
            : lifecycleRes?.code === "MODE_MISMATCH" ||
                lifecycleRes?.code === "MODE_UNKNOWN" ||
                lifecycleRes?.code === "INVALID_EXPECTED_MODE" ||
                lifecycleRes?.code === "INVALID_PROVIDER" ||
                lifecycleRes?.code === "INVALID_EVENT_TYPE" ||
                lifecycleRes?.code === "INVALID_SUBSCRIPTION_ID"
              ? 400
              : 500;

        return NextResponse.json(
          {
            error: lifecycleRes?.error || "Subscription lifecycle update failed",
            code: lifecycleRes?.code || "LIFECYCLE_UPDATE_FAILED",
          },
          { status: statusCode }
        );
      }

      // Record receipt in webhook_events
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
        log.error("[Razorpay Webhook] Failed to record dedupe on subscription event", {
          error: dedupeWriteErr.message,
          eventId,
        });
        return NextResponse.json(
          { error: "Failed to record webhook event receipt", code: "RECEIPT_WRITE_FAILED" },
          { status: 500 }
        );
      }

      return NextResponse.json(
        {
          received: true,
          applied: true,
          testMode: serverMode === "test" || Boolean(lifecycleRes.test_mode),
          event: eventType,
          subscriptionId: cleanSubId,
          eventId,
          status: lifecycleRes.status,
          cancel_at_period_end: lifecycleRes.cancel_at_period_end,
          grace_period_end: lifecycleRes.grace_period_end,
          details: lifecycleRes,
        },
        { status: 200 }
      );
    }

    // -------------------------------------------------------------------------
    // One-Time Order Fulfillment Events: order.paid, payment.captured
    // -------------------------------------------------------------------------
    if (isOrderFulfillmentEvent) {
      let orderId =
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

      // Query payment_orders authoritatively
      const { data: dbOrder, error: orderLookupErr } = await supabaseAdmin
        .from("payment_orders")
        .select("id, provider, mode, user_id, status, plan_code")
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

    // -------------------------------------------------------------------------
    // Handle Non-Fulfillment Events (payment.failed, refund.created, etc.)
    // -------------------------------------------------------------------------
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

    log.info(`[Razorpay Webhook] Recorded and ignored event type ${eventType}`, { eventType, eventId });
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
