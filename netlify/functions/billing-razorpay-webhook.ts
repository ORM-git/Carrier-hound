import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { getRazorpayKeyMode } from "../../src/lib/billing/mode";
import { recordFailedEvent } from "../../src/lib/events/failedEvents";
import { verifyUserNotBanned } from "../../src/lib/admin/auth";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { safeLog } from "./_logger";

const CORS_OPTIONS = {
  allowedMethods: "POST, OPTIONS",
  allowedHeaders: "Content-Type, X-Razorpay-Signature, x-razorpay-signature, x-razorpay-event-id",
};

export interface BillingWebhookDeps {
  getSupabaseAdmin?: () => any;
  verifyUserNotBanned?: (admin: any, userId: string, meta?: any) => Promise<any>;
  fetchFn?: typeof fetch;
  credentials?: string;
}

function getDefaultSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error("Supabase service configuration missing");
  }

  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}

function constantTimeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a.toLowerCase(), "utf8");
  const bufB = Buffer.from(b.trim().toLowerCase(), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createHandler(deps: BillingWebhookDeps = {}) {
  const adminGetter = deps.getSupabaseAdmin || getDefaultSupabaseAdmin;

  return async function handler(event: any) {
    const preflight = handleCorsPreflight(event, CORS_OPTIONS);
    if (preflight) return preflight;

    const headers = {
      "Content-Type": "application/json",
      ...buildCorsHeaders(event, CORS_OPTIONS),
    };

    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    if (process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") {
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({
          error: "Billing is currently unavailable",
          code: "BILLING_DISABLED",
        }),
      };
    }

    let eventId = "";
    let payload: any = {};
    let supabaseAdmin: any = null;

    try {
      const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!webhookSecret) {
        safeLog.error("[Razorpay Webhook] Missing RAZORPAY_WEBHOOK_SECRET");
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: "Webhook secret is not configured" }),
        };
      }

      const serverKeyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID || "";
      const serverMode = getRazorpayKeyMode(serverKeyId);
      if (serverMode === "unknown") {
        safeLog.error("[Razorpay Webhook] Server Razorpay key configuration missing or invalid prefix");
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({
            error: "Server Razorpay key configuration invalid",
            code: "RAZORPAY_CONFIG_INVALID",
          }),
        };
      }

      const signature =
        event.headers?.["x-razorpay-signature"] ||
        event.headers?.["X-Razorpay-Signature"];

      if (!signature) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Missing signature header",
            code: "MISSING_SIGNATURE",
          }),
        };
      }

      const rawBody = event.body || "";

      // Cryptographic signature verification with constant-time comparison
      const expectedSignature = crypto
        .createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex");

      if (!constantTimeCompare(expectedSignature, signature)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Invalid webhook signature",
            code: "INVALID_SIGNATURE",
          }),
        };
      }

      try {
        payload = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
      } catch {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Invalid JSON request body" }),
        };
      }

      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Malformed payload shape",
            code: "MALFORMED_PAYLOAD",
          }),
        };
      }

      const eventType = payload.event;
      if (!eventType || typeof eventType !== "string" || !eventType.trim()) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Missing or invalid event field in payload",
            code: "MALFORMED_PAYLOAD",
          }),
        };
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
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: "Missing order_id in webhook payload",
              code: "MISSING_ORDER_ID",
            }),
          };
        }
        orderId = orderId.trim();
      }

      eventId =
        payload.id ||
        payload.event_id ||
        event.headers?.["x-razorpay-event-id"] ||
        event.headers?.["X-Razorpay-Event-Id"] ||
        (orderId ? `${orderId}:${eventType}` : "") ||
        (payload.payload?.payment?.entity?.id ? `${payload.payload.payment.entity.id}:${eventType}` : "") ||
        (payload.payload?.subscription?.entity?.id ? `${payload.payload.subscription.entity.id}:${eventType}` : "") ||
        (payload.subscription_id ? `${payload.subscription_id}:${eventType}` : "") ||
        `rzp_evt_${payload.event}_${Date.now()}`;

      // (1) Dormancy Gate: subscription.* events must be gated by NEXT_PUBLIC_AUTORENEW_ENABLED
      if (eventType.startsWith("subscription.")) {
        if (process.env.NEXT_PUBLIC_AUTORENEW_ENABLED !== "true") {
          safeLog.info(`[Razorpay Webhook] Auto-renew disabled; acknowledging and ignoring ${eventType}`);
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              received: true,
              ignored: true,
              reason: "AUTORENEW_DISABLED",
              event: eventType,
              eventId,
            }),
          };
        }
      }

      try {
        supabaseAdmin = adminGetter();
      } catch (err: any) {
        safeLog.error("[Razorpay Webhook] Supabase admin init error:", err);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: "Supabase service configuration missing" }),
        };
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
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: "Missing subscription id in webhook payload",
              code: "MISSING_SUBSCRIPTION_ID",
            }),
          };
        }
        const cleanSubId = String(subId).trim();

        // (4) Reject events with missing payment_id for any grant
        const paymentId =
          payload.payload?.payment?.entity?.id ||
          payload.payload?.subscription?.entity?.payment_id ||
          payload.payment_id ||
          "";

        if (!paymentId || typeof paymentId !== "string" || !String(paymentId).trim()) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: "Missing payment_id for subscription grant",
              code: "MISSING_PAYMENT_ID",
            }),
          };
        }
        const cleanPaymentId = String(paymentId).trim();

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
          safeLog.error(`[Razorpay Webhook] Currency mismatch for subscription grant: ${cleanCurrency}`);
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: `Currency mismatch: only INR is supported, received ${cleanCurrency}`,
              code: "INVALID_CURRENCY",
            }),
          };
        }

        // Mode isolation, provider, and ban pre-check
        const { data: dbOrder, error: orderLookupErr } = await supabaseAdmin
          .from("payment_orders")
          .select("id, provider, mode, user_id, status, plan_code, amount_paise")
          .eq("provider_order_id", cleanSubId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (orderLookupErr) {
          safeLog.error("[Razorpay Webhook] DB error querying payment_orders:", orderLookupErr);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "Database error querying order", code: "DATABASE_ERROR" }),
          };
        }

        if (dbOrder) {
          if (dbOrder.provider && dbOrder.provider !== "razorpay") {
            return {
              statusCode: 400,
              headers,
              body: JSON.stringify({ error: "Invalid payment provider", code: "INVALID_PROVIDER" }),
            };
          }
          if (dbOrder.mode && dbOrder.mode !== serverMode) {
            safeLog.error(`[Razorpay Webhook] Mode mismatch: ${dbOrder.mode} vs ${serverMode}`);
            return {
              statusCode: 400,
              headers,
              body: JSON.stringify({
                error: `Webhook mode mismatch: cannot process ${dbOrder.mode} order with ${serverMode} credentials`,
                code: "MODE_MISMATCH",
              }),
            };
          }
          if (dbOrder.user_id) {
            const banChecker = deps.verifyUserNotBanned || verifyUserNotBanned;
            const banCheck = await banChecker(supabaseAdmin, dbOrder.user_id);
            if (banCheck?.isBlocked) {
              return {
                statusCode: 403,
                headers,
                body: JSON.stringify({
                  error: banCheck.error || "Account suspended. Access revoked by administrator.",
                  code: "USER_BLOCKED",
                }),
              };
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
              return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Invalid payment provider", code: "INVALID_PROVIDER" }),
              };
            }
            const subMode = subRow.metadata?.mode || "live";
            if (subMode !== serverMode) {
              return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                  error: `Webhook mode mismatch: cannot process ${subMode} subscription with ${serverMode} credentials`,
                  code: "MODE_MISMATCH",
                }),
              };
            }
            if (subRow.user_id) {
              const banChecker = deps.verifyUserNotBanned || verifyUserNotBanned;
              const banCheck = await banChecker(supabaseAdmin, subRow.user_id);
              if (banCheck?.isBlocked) {
                return {
                  statusCode: 403,
                  headers,
                  body: JSON.stringify({
                    error: banCheck.error || "Account suspended. Access revoked by administrator.",
                    code: "USER_BLOCKED",
                  }),
                };
              }
            }
          }
        }

        const eventTimestamp =
          typeof payload.created_at === "number" && payload.created_at > 0
            ? payload.created_at
            : null;

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
          safeLog.error("[Razorpay Webhook] fulfil_subscription_renewal RPC error:", renewalErr);
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

          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "Subscription renewal failed", code: "RENEWAL_FAILED" }),
          };
        }

        if (renewalRes?.ignored) {
          safeLog.info(`[Razorpay Webhook] Paid event ignored by RPC for ${cleanSubId}: ${renewalRes.reason}`);
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              received: true,
              ignored: true,
              reason: renewalRes.reason || "OLD_MANDATE_IGNORED",
              event: eventType,
              eventId,
              details: renewalRes,
            }),
          };
        }

        if (!renewalRes || !renewalRes.success) {
          safeLog.error("[Razorpay Webhook] fulfil_subscription_renewal returned failure:", renewalRes);
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

          return {
            statusCode,
            headers,
            body: JSON.stringify({
              error: renewalRes?.error || "Subscription grant failed",
              code: renewalRes?.code || "FULFILLMENT_FAILED",
            }),
          };
        }

        await supabaseAdmin.from("webhook_events").upsert(
          {
            event_id: eventId,
            provider: "razorpay",
            event_type: eventType,
          },
          { onConflict: "event_id" }
        );

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            received: true,
            fulfilled: true,
            renewed: true,
            eventId,
            alreadyProcessed: Boolean(renewalRes.already_processed),
            testMode: serverMode === "test" || Boolean(renewalRes.test_mode),
            isPro: serverMode === "live" && Boolean(renewalRes.is_pro),
            details: renewalRes,
          }),
        };
      }

      // -------------------------------------------------------------------------
      // (5) Subscription Lifecycle Events (pending, halted, cancelled, past_due, completed)
      // Only mutates if subscription_id is the currently bound mandate.
      // -------------------------------------------------------------------------
      const isLifecycleEvent =
        eventType === "subscription.pending" ||
        eventType === "subscription.halted" ||
        eventType === "subscription.cancelled" ||
        eventType === "subscription.canceled" ||
        eventType === "subscription.completed" ||
        eventType === "subscription.past_due";

      if (isLifecycleEvent) {
        const subId =
          payload.payload?.subscription?.entity?.id ||
          payload.payload?.payment?.entity?.subscription_id ||
          payload.subscription_id ||
          "";

        if (!subId || typeof subId !== "string" || !subId.trim()) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: "Missing subscription id in webhook payload",
              code: "MISSING_SUBSCRIPTION_ID",
            }),
          };
        }

        const cleanSubId = String(subId).trim();

        // Deduplication check
        const { data: existingDedupe } = await supabaseAdmin
          .from("webhook_events")
          .select("event_id")
          .eq("event_id", eventId)
          .maybeSingle();

        if (existingDedupe) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              received: true,
              alreadyProcessed: true,
              eventId,
              event: eventType,
            }),
          };
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
          safeLog.error("[Razorpay Webhook] handle_subscription_lifecycle_event RPC error:", lifecycleErr);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "Failed to update subscription lifecycle", code: "DATABASE_ERROR" }),
          };
        }

        if (lifecycleRes?.ignored) {
          safeLog.info(`[Razorpay Webhook] Lifecycle event ignored by RPC for ${cleanSubId}: ${lifecycleRes.reason}`);
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              received: true,
              ignored: true,
              reason: lifecycleRes.reason || "UNBOUND_MANDATE",
              event: eventType,
              subscriptionId: cleanSubId,
              eventId,
              details: lifecycleRes,
            }),
          };
        }

        if (!lifecycleRes || !lifecycleRes.success) {
          safeLog.error("[Razorpay Webhook] handle_subscription_lifecycle_event returned failure:", lifecycleRes);
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

          return {
            statusCode,
            headers,
            body: JSON.stringify({
              error: lifecycleRes?.error || "Subscription lifecycle update failed",
              code: lifecycleRes?.code || "LIFECYCLE_UPDATE_FAILED",
            }),
          };
        }

        await supabaseAdmin.from("webhook_events").upsert(
          {
            event_id: eventId,
            provider: "razorpay",
            event_type: eventType,
          },
          { onConflict: "event_id" }
        );

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
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
          }),
        };
      }

      // -------------------------------------------------------------------------
      // One-time order fulfillment events: order.paid, payment.captured
      // -------------------------------------------------------------------------
      if (isOrderFulfillmentEvent) {
        let orderId =
          payload.payload?.order?.entity?.id ||
          payload.payload?.payment?.entity?.order_id ||
          "";

        if (!orderId) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: "Missing order_id in webhook payload",
              code: "MISSING_ORDER_ID",
            }),
          };
        }

        let userId =
          payload.payload?.payment?.entity?.notes?.user_id ||
          payload.payload?.order?.entity?.notes?.user_id;

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
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({
              error: "Order record or associated user not found",
              code: "ORDER_NOT_FOUND",
            }),
          };
        }

        if (orderRow?.provider && orderRow.provider !== "razorpay") {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: "Invalid payment provider",
              code: "INVALID_PROVIDER",
            }),
          };
        }

        const orderMode = orderRow?.mode || (orderRow?.provider_order_id?.startsWith("order_test_") ? "test" : "live");
        if (orderRow && orderMode !== serverMode) {
          safeLog.error(`[Razorpay Webhook] Mode mismatch: order mode ${orderMode} vs server mode ${serverMode}`);
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: `Webhook mode mismatch: cannot process ${orderMode} order with ${serverMode} credentials`,
              code: "MODE_MISMATCH",
            }),
          };
        }

        const { data: existingDedupe } = await supabaseAdmin
          .from("webhook_events")
          .select("event_id")
          .eq("event_id", eventId)
          .maybeSingle();

        if (existingDedupe) {
          if (orderRow && orderRow.status !== "paid") {
            safeLog.warn(
              `[Razorpay Webhook] Dedupe hit for event ${eventId} but order ${orderId} is still unpaid. Retrying fulfillment.`
            );
          } else {
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({
                received: true,
                alreadyProcessed: true,
                eventId,
                testMode: serverMode === "test",
                isPro: serverMode === "live" && Boolean(orderRow?.plan_code),
              }),
            };
          }
        }

        const { data: fulfilRes, error: fulfilErr } = await supabaseAdmin.rpc("fulfil_payment_order", {
          p_provider_order_id: orderId,
          p_user_id: userId,
          p_expected_mode: serverMode,
        });

        if (fulfilErr) {
          safeLog.error("[Razorpay Webhook] fulfil_payment_order RPC error:", fulfilErr);
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
            safeLog.warn("[Razorpay Webhook] Failed to record dead-letter event:", dlErr);
          }

          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
              error: "Payment fulfillment failed",
              code: "FULFILLMENT_FAILED",
            }),
          };
        }

        if (!fulfilRes || !fulfilRes.success) {
          const isGenuinelyPaid =
            fulfilRes?.already_paid === true ||
            (fulfilRes?.code === "ORDER_INVALID_STATE" && orderRow?.status === "paid");

          if (isGenuinelyPaid) {
            await supabaseAdmin.from("webhook_events").upsert(
              {
                event_id: eventId,
                provider: "razorpay",
                event_type: eventType,
              },
              { onConflict: "event_id" }
            );

            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({
                received: true,
                alreadyPaid: true,
                eventId,
                testMode: serverMode === "test",
                isPro: serverMode === "live" && Boolean(orderRow?.plan_code),
                details: fulfilRes,
              }),
            };
          }

          safeLog.error("[Razorpay Webhook] fulfil_payment_order returned failure:", fulfilRes);
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
            safeLog.warn("[Razorpay Webhook] Failed to record dead-letter event:", dlErr);
          }

          const statusCode = fulfilRes?.code === "ORDER_NOT_FOUND" ? 404 : 500;
          return {
            statusCode,
            headers,
            body: JSON.stringify({
              error: fulfilRes?.error || "Payment fulfillment failed",
              code: fulfilRes?.code || "FULFILLMENT_FAILED",
            }),
          };
        }

        await supabaseAdmin.from("webhook_events").upsert(
          {
            event_id: eventId,
            provider: "razorpay",
            event_type: eventType,
          },
          { onConflict: "event_id" }
        );

        if (serverMode === "test") {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              received: true,
              fulfilled: true,
              alreadyPaid: Boolean(fulfilRes.already_paid),
              testMode: true,
              isPro: false,
              eventId,
              details: fulfilRes,
            }),
          };
        }

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            received: true,
            fulfilled: true,
            alreadyPaid: Boolean(fulfilRes.already_paid),
            testMode: false,
            isPro: Boolean(fulfilRes?.is_pro ?? orderRow?.plan_code),
            eventId,
            details: fulfilRes,
          }),
        };
      }

      // -------------------------------------------------------------------------
      // Non-fulfillment events (payment.failed, refund.created, etc.)
      // -------------------------------------------------------------------------
      // Deduplication check
      const { data: existingNonFulfilDedupe } = await supabaseAdmin
        .from("webhook_events")
        .select("event_id")
        .eq("event_id", eventId)
        .maybeSingle();

      if (existingNonFulfilDedupe) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            received: true,
            alreadyProcessed: true,
            eventId,
            event: eventType,
          }),
        };
      }

      // Separate payment attempt failure from mandate termination for payment.failed
      // Razorpay retries charges on active subscriptions up to 3 times; a single failed charge attempt
      // must NOT cancel the mandate.
      if (eventType === "payment.failed") {
        const paymentEntity =
          payload.payload?.payment?.entity ||
          payload.payment?.entity ||
          payload.payment ||
          {};
        const subId =
          typeof paymentEntity.subscription_id === "string" && paymentEntity.subscription_id.trim()
            ? paymentEntity.subscription_id.trim()
            : typeof payload.payload?.subscription?.entity?.id === "string" && payload.payload.subscription.entity.id.trim()
              ? payload.payload.subscription.entity.id.trim()
              : "";
        const orderId =
          typeof paymentEntity.order_id === "string" && paymentEntity.order_id.trim()
            ? paymentEntity.order_id.trim()
            : typeof payload.payload?.order?.entity?.id === "string" && payload.payload.order.entity.id.trim()
              ? payload.payload.order.entity.id.trim()
              : "";

        if (subId) {
          // Strict lookup: resolve mandate only by exact provider identifier from stored records
          const { data: subRow } = await supabaseAdmin
            .from("subscriptions")
            .select("id, user_id, status, metadata, cancel_at_period_end")
            .eq("subscription_id", subId)
            .maybeSingle();

          const { data: orderRow } = await supabaseAdmin
            .from("payment_orders")
            .select("id, user_id, status, metadata")
            .eq("provider_order_id", subId)
            .maybeSingle();

          if (!subRow && !orderRow) {
            safeLog.info("[Razorpay Webhook] payment.failed received for unmapped subscription; ignoring without state change", JSON.stringify({
              subId,
              eventId,
            }));
            await supabaseAdmin
              .from("webhook_events")
              .upsert({ event_id: eventId, provider: "razorpay", event_type: eventType }, { onConflict: "event_id" });
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({ received: true, ignored: true, reason: "MANDATE_NOT_FOUND", eventId, subId }),
            };
          }

          const targetUserId = subRow?.user_id || orderRow?.user_id;

          // Verify notes ownership if present: if notes.userId exists and mismatches DB owner, do nothing destructive
          const notesUserId =
            paymentEntity.notes?.user_id ||
            paymentEntity.notes?.userId ||
            payload.payload?.subscription?.entity?.notes?.user_id ||
            payload.payload?.subscription?.entity?.notes?.userId;

          if (notesUserId && targetUserId && String(notesUserId).trim() !== String(targetUserId).trim()) {
            safeLog.warn("[Razorpay Webhook] payment.failed notes.userId mismatch with DB record; failing closed", JSON.stringify({
              notesUserId,
              targetUserId,
              subId,
              eventId,
            }));
            await supabaseAdmin
              .from("webhook_events")
              .upsert({ event_id: eventId, provider: "razorpay", event_type: eventType }, { onConflict: "event_id" });
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({ received: true, ignored: true, reason: "MANDATE_OWNERSHIP_MISMATCH", eventId }),
            };
          }

          // Separate "payment failed" from "mandate dead":
          // A single failed charge attempt on an active subscription must NOT cancel or terminate the mandate!
          // Razorpay automatically retries up to 3 times. We retain mandate status as active.
          if (subRow && subRow.status === "active") {
            safeLog.info("[Razorpay Webhook] payment.failed on active subscription; retaining active mandate and recording attempt", JSON.stringify({
              subId,
              userId: targetUserId,
              eventId,
            }));

            await supabaseAdmin.rpc("merge_subscription_metadata", {
              p_user_id: targetUserId,
              p_metadata: {
                last_failed_payment_id: paymentEntity.id || null,
                last_payment_failure_at: new Date().toISOString(),
                last_payment_failure_code: paymentEntity.error_code || null,
                last_payment_failure_description: paymentEntity.error_description || null,
              },
            }).catch(() => null);
          }

          if (orderId) {
            await supabaseAdmin
              .from("payment_orders")
              .update({ status: "failed", updated_at: new Date().toISOString() })
              .eq("provider_order_id", orderId)
              .in("status", ["created", "reserved"]);
          }
        } else if (orderId) {
          // One-time order payment failure
          const { data: oneTimeOrder } = await supabaseAdmin
            .from("payment_orders")
            .select("id, user_id, status")
            .eq("provider_order_id", orderId)
            .maybeSingle();

          if (!oneTimeOrder) {
            safeLog.info("[Razorpay Webhook] payment.failed for unmapped one-time order; ignoring", JSON.stringify({ orderId, eventId }));
            await supabaseAdmin
              .from("webhook_events")
              .upsert({ event_id: eventId, provider: "razorpay", event_type: eventType }, { onConflict: "event_id" });
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({ received: true, ignored: true, reason: "ORDER_NOT_FOUND", eventId, orderId }),
            };
          }

          await supabaseAdmin
            .from("payment_orders")
            .update({ status: "failed", updated_at: new Date().toISOString() })
            .eq("provider_order_id", orderId)
            .in("status", ["created", "reserved"]);
        }
      }

      await supabaseAdmin.from("webhook_events").insert({
        event_id: eventId,
        provider: "razorpay",
        event_type: eventType || "unknown",
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          received: true,
          event: eventType,
          eventId,
          recovered: eventType === "payment.failed",
        }),
      };
    } catch (err: any) {
      safeLog.error("[Razorpay Webhook]", err);
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
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err?.message || "Internal server error" }),
      };
    }
  };
}

export const handler = createHandler();
