import { createClient } from "@supabase/supabase-js";
import { verifyStripeWebhookSignature } from "../../src/lib/billing/stripe";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { safeLog } from "./_logger";

const CORS_OPTIONS = {
  allowedMethods: "POST, OPTIONS",
  allowedHeaders: "Content-Type, Stripe-Signature",
};

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing server Supabase configuration");
  }

  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}

export async function handler(event: any) {
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

  const signatureHeader =
    event.headers?.["stripe-signature"] ||
    event.headers?.["Stripe-Signature"] ||
    "";
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    safeLog.error("[Stripe Webhook]", "Missing STRIPE_WEBHOOK_SECRET environment variable");
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Webhook secret is not configured" }),
    };
  }

  const rawBody = event.body || "";

  // 1. Signature Verification with Timestamp Tolerance (prevents replay and tampering)
  const isValid = await verifyStripeWebhookSignature(rawBody, signatureHeader, webhookSecret);
  if (!isValid) {
    safeLog.warn("[Stripe Webhook]", "Invalid or expired signature rejected");
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid webhook signature or expired timestamp" }),
    };
  }

  // 2. Parse Event JSON
  let stripeEvent: any;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch (err) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  const eventId = stripeEvent?.id;
  const eventType = stripeEvent?.type;
  const eventObj = stripeEvent?.data?.object;

  if (!eventId || !eventType || !eventObj) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Missing required event fields" }),
    };
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();
    const userId = eventObj.client_reference_id || eventObj.metadata?.userId || eventObj.metadata?.user_id;

    if (!userId) {
      // Event without candidate user reference (e.g. general Stripe account event)
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ received: true, ignored: true, reason: "No userId attached" }),
      };
    }

    // 3a. Atomic idempotency guard via webhook_events table (owner-applied migration).
    // INSERT with PRIMARY KEY on event_id: a duplicate insert means this exact event
    // was already processed, even under concurrent deliveries. If the table is not
    // applied yet (or any other error), fall back to the metadata check below.
    try {
      const { error: idemErr } = await supabaseAdmin
        .from("webhook_events")
        .insert({ event_id: eventId, provider: "stripe", event_type: eventType });
      if (!idemErr) {
        safeLog.info("[Stripe Webhook]", `Event ${eventId} recorded in webhook_events.`);
      } else if (idemErr.code === "23505") {
        safeLog.info("[Stripe Webhook]", `Duplicate event ${eventId} rejected atomically.`);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ received: true, alreadyProcessed: true, eventId }),
        };
      }
      // Other errors (table missing, etc.): metadata fallback below still applies.
    } catch {
      // fall back to metadata-based idempotency below
    }

    // 3b. Idempotency Check (Row 54 requirement e)
    const { data: existingSub, error: subError } = await supabaseAdmin
      .from("subscriptions")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (subError) {
      safeLog.error("[Stripe Webhook] Error querying existing subscription", subError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Database error during idempotency check" }),
      };
    }

    const processedEvents: string[] = existingSub?.metadata?.processed_event_ids || [];
    if (processedEvents.includes(eventId)) {
      safeLog.info("[Stripe Webhook]", `Duplicate event ${eventId} detected. Idempotently ignoring.`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ received: true, alreadyProcessed: true, eventId }),
      };
    }

    // 4. State Transitions based on Event Type
    const updatedEvents = [...processedEvents, eventId];
    const newMetadata = {
      ...(existingSub?.metadata || {}),
      processed_event_ids: updatedEvents,
      last_event_id: eventId,
      last_event_type: eventType,
    };

    if (
      eventType === "checkout.session.completed" ||
      eventType === "customer.subscription.created" ||
      eventType === "customer.subscription.updated"
    ) {
      const periodEnd = eventObj.current_period_end
        ? new Date(eventObj.current_period_end * 1000).toISOString()
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      const { error: upsertErr } = await supabaseAdmin.from("subscriptions").upsert(
        {
          user_id: userId,
          provider: "stripe",
          customer_id: eventObj.customer || existingSub?.customer_id,
          subscription_id:
            eventObj.subscription ||
            (eventType.startsWith("customer.subscription.") ? eventObj.id : null) ||
            existingSub?.subscription_id ||
            null,
          plan_id: "intl_monthly_9",
          currency: (eventObj.currency || "USD").toUpperCase(),
          amount: eventObj.amount_total || eventObj.plan?.amount || 900,
          status: "active",
          current_period_start: new Date().toISOString(),
          current_period_end: periodEnd,
          cancel_at_period_end: Boolean(eventObj.cancel_at_period_end),
          metadata: newMetadata,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

      if (upsertErr) {
        throw new Error(`Failed to upsert subscription: ${upsertErr.message}`);
      }
    } else if (eventType === "customer.subscription.deleted") {
      const { error: cancelErr } = await supabaseAdmin
        .from("subscriptions")
        .update({
          status: "canceled",
          cancel_at_period_end: true,
          metadata: newMetadata,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);

      if (cancelErr) {
        throw new Error(`Failed to update canceled subscription: ${cancelErr.message}`);
      }
    } else {
      // Unhandled event type, record as processed to prevent repeats
      if (existingSub) {
        await supabaseAdmin
          .from("subscriptions")
          .update({ metadata: newMetadata })
          .eq("user_id", userId);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ received: true, processed: true, eventId }),
    };
  } catch (err: any) {
    safeLog.error("[Stripe Webhook] Processing failure, allowing provider retry", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err?.message || "Internal server error" }),
    };
  }
}
