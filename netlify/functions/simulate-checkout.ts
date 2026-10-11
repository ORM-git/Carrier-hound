import { createClient } from "@supabase/supabase-js";

interface SimulationPayload {
  planId?: string;
  provider?: "razorpay" | "stripe";
}

export async function handler(event: any) {
  // CORS headers
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  // Simulation code is strictly gated behind SIMULATE_PAYMENTS=true.
  // In production builds, this endpoint returns 404.
  const isProd = process.env.NODE_ENV === "production" || process.env.CONTEXT === "production";
  const allowSimulation = process.env.SIMULATE_PAYMENTS === "true";
  if (isProd && !allowSimulation) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: "Endpoint not found" }),
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

    if (!supabaseUrl || !serviceRoleKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Server missing Supabase configuration" }),
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
      } catch {}
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
    console.error("Checkout simulation error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || "Internal server error" }),
    };
  }
}
