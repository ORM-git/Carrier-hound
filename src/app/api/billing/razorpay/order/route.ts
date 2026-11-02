import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { resolveOrderPricing } from "@/lib/billing/quota";

export const runtime = "edge";

export async function POST(req: Request) {
  try {
    if (process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") {
      return NextResponse.json(
        { error: "Billing is currently unavailable", code: "BILLING_DISABLED" },
        { status: 503 }
      );
    }

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
      return NextResponse.json({ error: "Supabase service configuration missing" }, { status: 500 });
    }

    // Verify user session token
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

    // Key validation: test mode keys only, strictly required
    const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret || !keyId.startsWith("rzp_test_")) {
      return NextResponse.json(
        {
          error: "test keys not configured",
          code: "RAZORPAY_TEST_KEYS_NOT_CONFIGURED",
        },
        { status: 503 }
      );
    }

    const body = await req.json().catch(() => ({}));
    // Resolve server-authoritative price from plans/addon_packs catalog, ignoring any client amount
    const pricing = resolveOrderPricing({
      planCode: body.planCode,
      planId: body.planId || (!body.addonCode && !body.planCode ? "monthly" : undefined),
      addonCode: body.addonCode,
    });

    if (!pricing) {
      return NextResponse.json(
        { error: "Invalid plan or addon code" },
        { status: 400 }
      );
    }

    const amountInPaise = pricing.amount_paise;
    const currency = pricing.currency;
    const receipt = `rcpt_${user.id.slice(0, 8)}_${Date.now()}`;

    // Call Razorpay REST API
    const credentials = btoa(`${keyId}:${keySecret}`);
    const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({
        amount: amountInPaise,
        currency,
        receipt,
        notes: {
          user_id: user.id,
          email: user.email || "",
          type: pricing.type,
          code: pricing.code,
        },
      }),
    });

    if (!rzpRes.ok) {
      const err = await rzpRes.json().catch(() => ({}));
      return NextResponse.json(
        { error: err.error?.description || "Failed to create Razorpay order" },
        { status: rzpRes.status || 500 }
      );
    }

    const orderData = await rzpRes.json();

    // Record order in payment_orders table with status 'created'
    try {
      await supabaseAdmin.from("payment_orders").insert({
        user_id: user.id,
        provider: "razorpay",
        provider_order_id: orderData.id,
        plan_code: pricing.type === "plan" ? pricing.code : null,
        addon_code: pricing.type === "addon" ? pricing.code : null,
        amount_paise: amountInPaise,
        currency,
        status: "created",
      });
    } catch (orderDbErr) {
      console.warn("[Razorpay Order] Failed to record payment_orders row:", orderDbErr);
    }

    return NextResponse.json({
      orderId: orderData.id,
      amount: orderData.amount,
      currency: orderData.currency,
      keyId,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Internal server error" },
      { status: 500 }
    );
  }
}
