import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { safeLog } from "./_logger";

const CORS_OPTIONS = {
  allowedMethods: "POST, OPTIONS",
  allowedHeaders: "Content-Type, X-Razorpay-Signature, x-razorpay-signature, x-razorpay-event-id",
};

export interface BillingWebhookDeps {
  getSupabaseAdmin?: () => any;
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

      let payload: any = {};
      try {
        payload = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
      } catch {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Invalid JSON request body" }),
        };
      }

      const eventId =
        payload.id ||
        payload.event_id ||
        event.headers?.["x-razorpay-event-id"] ||
        event.headers?.["X-Razorpay-Event-Id"] ||
        `rzp_evt_${payload.event}_${payload.payload?.payment?.entity?.id || payload.payload?.order?.entity?.id}_${payload.created_at || Date.now()}`;

      let supabaseAdmin: any;
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

      const eventType = payload.event;

      // Handle payment fulfillment events: order.paid and payment.captured
      if (eventType === "order.paid" || eventType === "payment.captured") {
        const orderId =
          payload.payload?.order?.entity?.id ||
          payload.payload?.payment?.entity?.order_id;

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
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({
              error: "Order record or associated user not found",
              code: "ORDER_NOT_FOUND",
            }),
          };
        }

        // Check if event was previously deduplicated
        const { data: existingDedupe } = await supabaseAdmin
          .from("webhook_events")
          .select("event_id")
          .eq("event_id", eventId)
          .maybeSingle();

        if (existingDedupe) {
          // On a dedupe hit, re-attempt fulfillment if the order is still unpaid
          if (orderRow && orderRow.status !== "paid") {
            safeLog.warn(
              `[Razorpay Webhook] Dedupe hit for event ${eventId} but order ${orderId} is still unpaid. Retrying fulfillment.`
            );
          } else {
            // Order is genuinely already paid / fulfilled
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({
                received: true,
                alreadyProcessed: true,
                eventId,
              }),
            };
          }
        }

        // Fulfil first: Call database fulfillment function atomically
        const { data: fulfilRes, error: fulfilErr } = await supabaseAdmin.rpc("fulfil_payment_order", {
          p_provider_order_id: orderId,
          p_user_id: userId,
        });

        if (fulfilErr) {
          safeLog.error("[Razorpay Webhook] fulfil_payment_order RPC error:", fulfilErr);
          // Do not record dedupe row on RPC failure: return 500 so Razorpay retries
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
              error: "Payment fulfillment failed",
              code: "FULFILLMENT_FAILED",
            }),
          };
        }

        // Strictly check fulfilRes.success
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

            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({
                received: true,
                alreadyPaid: true,
                eventId,
                details: fulfilRes,
              }),
            };
          }

          // Unsuccessful: DO NOT record dedupe row!
          safeLog.error("[Razorpay Webhook] fulfil_payment_order returned failure:", fulfilRes);
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

        // Fulfillment succeeded (fulfilRes.success is true): Insert dedupe row now
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
            eventId,
            details: fulfilRes,
          }),
        };
      }

      // For non-fulfillment events (e.g. payment.failed, refund.created)
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
          ignored: true,
          event: eventType,
        }),
      };
    } catch (err: any) {
      safeLog.error("[Razorpay Webhook]", err);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err?.message || "Internal server error" }),
      };
    }
  };
}

export const handler = createHandler();
