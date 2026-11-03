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

      // Deduplicate event in webhook_events table
      const { error: dedupeErr } = await supabaseAdmin.from("webhook_events").insert({
        event_id: eventId,
        provider: "razorpay",
        event_type: payload.event || "unknown",
      });

      if (dedupeErr) {
        // Unique constraint violation (Postgres error code 23505) -> Already processed
        if (
          dedupeErr.code === "23505" ||
          dedupeErr.message?.includes("duplicate") ||
          dedupeErr.message?.includes("unique")
        ) {
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
        safeLog.warn("[Razorpay Webhook] Deduplication insert warning:", dedupeErr);
      }

      // Process fulfillment on payment success events
      const eventType = payload.event;
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

        // If user_id is not in notes, look up payment_orders row by provider_order_id
        if (!userId) {
          const { data: orderRow } = await supabaseAdmin
            .from("payment_orders")
            .select("user_id")
            .eq("provider_order_id", orderId)
            .maybeSingle();

          userId = orderRow?.user_id;
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

        // Call database fulfillment function atomically
        const { data: fulfilRes, error: fulfilErr } = await supabaseAdmin.rpc("fulfil_payment_order", {
          p_provider_order_id: orderId,
          p_user_id: userId,
        });

        if (fulfilErr) {
          safeLog.error("[Razorpay Webhook] fulfil_payment_order RPC error:", fulfilErr);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
              error: "Payment fulfillment failed",
              code: "FULFILLMENT_FAILED",
            }),
          };
        }

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

      // Other unhandled events (e.g. payment.failed, refund.created)
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
