import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { PLAN_DOMESTIC } from "../../src/lib/billing/types";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { safeLog } from "./_logger";

const CORS_OPTIONS = {
  allowedMethods: "POST, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

interface VerifyPayload {
  order_id?: string;
  payment_id?: string;
  razorpay_signature?: string;
  razorpay_order_id?: string;
  razorpay_payment_id?: string;
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

  try {
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

    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Missing or invalid authorization header" }),
      };
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      "https://szakevhxhwpeskidvtfs.supabase.co";
    const serviceRoleKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Supabase service configuration missing" }),
      };
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Invalid user session token" }),
      };
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({
          error: "test keys not configured",
          code: "RAZORPAY_TEST_KEYS_NOT_CONFIGURED",
        }),
      };
    }

    let body: VerifyPayload = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch (e) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Invalid JSON request body" }),
        };
      }
    }

    const orderId = body.order_id || body.razorpay_order_id;
    const paymentId = body.payment_id || body.razorpay_payment_id;
    const signature = body.razorpay_signature;

    if (!orderId || !paymentId || !signature) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing required order_id, payment_id or razorpay_signature",
        }),
      };
    }

    // Verify HMAC-SHA256 signature
    const expectedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    if (expectedSignature.toLowerCase() !== signature.trim().toLowerCase()) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Invalid payment signature",
          code: "INVALID_SIGNATURE",
        }),
      };
    }

    // Test mode safety check: if key id starts with rzp_test_, NEVER upsert a Pro subscription!
    const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID || "";
    if (keyId.startsWith("rzp_test_")) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          testMode: true,
          isPro: false,
          message: "Test payment successful (no Pro granted)",
        }),
      };
    }

    // Persist entitlement to subscriptions table
    const currentPeriodStart = new Date().toISOString();
    const currentPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: sub, error: subError } = await supabaseAdmin
      .from("subscriptions")
      .upsert(
        {
          user_id: user.id,
          plan_id: PLAN_DOMESTIC.id,
          provider: "razorpay",
          currency: PLAN_DOMESTIC.currency,
          amount: PLAN_DOMESTIC.price * 100,
          status: "active",
          current_period_start: currentPeriodStart,
          current_period_end: currentPeriodEnd,
          cancel_at_period_end: false,
          metadata: {
            razorpay_order_id: orderId,
            razorpay_payment_id: paymentId,
            verified_at: new Date().toISOString(),
            mode: "live",
            source: "razorpay_standard_checkout",
          },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      )
      .select()
      .single();

    if (subError) {
      safeLog.error("[Netlify /billing-razorpay-verify] Subscription persistence error:", subError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: subError.message }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        isPro: true,
        subscription: sub,
      }),
    };
  } catch (err: any) {
    safeLog.error("[Netlify /billing-razorpay-verify]", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err?.message || "Internal server error" }),
    };
  }
}
