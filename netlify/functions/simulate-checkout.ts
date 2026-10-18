import { createClient } from "@supabase/supabase-js";

interface SimulationPayload {
  planId?: string;
  provider?: "razorpay" | "stripe";
}

import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { safeLog } from "./_logger";

const CORS_OPTIONS = {
  allowedMethods: "POST, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

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

  // Hard guard: Payment simulation must be impossible in production, whatever the env says.
  const isProd =
    process.env.NODE_ENV === "production" ||
    process.env.CONTEXT === "production" ||
    process.env.NETLIFY_ENV === "production";

  if (isProd) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: "Payments not enabled", code: "PAYMENTS_DISABLED" }),
    };
  }

  // Outside production, simulation is strictly gated behind SIMULATE_PAYMENTS=true.
  const allowSimulation = process.env.SIMULATE_PAYMENTS === "true";
  if (!allowSimulation) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: "Payments not enabled", code: "PAYMENTS_DISABLED" }),
    };
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Missing or invalid authorization header" }),
      };
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://szakevhxhwpeskidvtfs.supabase.co";
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl) {
      safeLog.error("[Netlify /simulate-checkout] Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL");
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: "Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL",
          missingVariable: "NEXT_PUBLIC_SUPABASE_URL",
        }),
      };
    }

    if (!serviceRoleKey) {
      safeLog.error("[Netlify /simulate-checkout] Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY");
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: "Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY",
          missingVariable: "SUPABASE_SERVICE_ROLE_KEY",
        }),
      };
    }

    // Verify user token with Supabase
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Invalid user session token" }),
      };
    }

    // Parse body for plan details
    let body: SimulationPayload = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch (e) {
        safeLog.warn("[Netlify /simulate-checkout] JSON parse error", e);
      }
    }

    const planId = body.planId === "intl_monthly_9" ? "intl_monthly_9" : "domestic_monthly_199";
    const isIntl = planId === "intl_monthly_9";
    const provider = body.provider || (isIntl ? "stripe" : "razorpay");
    const currency = isIntl ? "USD" : "INR";
    const amount = isIntl ? 900 : 19900;

    const currentPeriodStart = new Date().toISOString();
    const currentPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Persist entitlement to subscriptions table
    const { data: sub, error: subError } = await supabaseAdmin
      .from("subscriptions")
      .upsert(
        {
          user_id: user.id,
          plan_id: planId,
          provider: provider,
          currency: currency,
          amount: amount,
          status: "active",
          current_period_start: currentPeriodStart,
          current_period_end: currentPeriodEnd,
          cancel_at_period_end: false,
          metadata: {
            simulated: true,
            simulated_at: new Date().toISOString(),
            source: "payment_button_simulation",
          },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      )
      .select()
      .single();

    if (subError) {
      console.error("Subscription persistence error:", subError);
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
    safeLog.error("[Netlify /simulate-checkout]", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || "Internal server error" }),
    };
  }
}
