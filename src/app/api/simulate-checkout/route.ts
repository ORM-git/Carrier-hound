import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

interface SimulationPayload {
  planId?: string;
  provider?: "razorpay" | "stripe";
}

export async function POST(req: Request) {
  // Hard guard: Payment simulation must be impossible in production, whatever the env says.
  const isProd =
    process.env.NODE_ENV === "production" ||
    process.env.CONTEXT === "production" ||
    process.env.NETLIFY_ENV === "production";

  if (isProd) {
    return NextResponse.json({ error: "Endpoint not found" }, { status: 404 });
  }

  // Outside production, simulation is strictly gated behind SIMULATE_PAYMENTS=true.
  const allowSimulation = process.env.SIMULATE_PAYMENTS === "true";
  if (!allowSimulation) {
    return NextResponse.json({ error: "Endpoint not found" }, { status: 404 });
  }

  try {
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Missing or invalid authorization header" }, { status: 401 });
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      "https://szakevhxhwpeskidvtfs.supabase.co";
    const serviceRoleKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json({ error: "Server missing Supabase configuration" }, { status: 500 });
    }

    // Verify user token with Supabase
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return NextResponse.json({ error: "Invalid user session token" }, { status: 401 });
    }

    // Parse body for plan details
    const body: SimulationPayload = await req.json().catch(() => ({}));
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
      return NextResponse.json({ error: subError.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      isPro: true,
      subscription: sub,
    });
  } catch (err: any) {
    console.error("Checkout simulation error:", err);
    return NextResponse.json({ error: err.message || "Internal server error" }, { status: 500 });
  }
}
