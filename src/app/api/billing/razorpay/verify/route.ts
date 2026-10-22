import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { PLAN_DOMESTIC } from "@/lib/billing/types";

export const runtime = "edge";

interface VerifyPayload {
  order_id?: string;
  payment_id?: string;
  razorpay_signature?: string;
  // Also accept standard Razorpay handler parameter names
  razorpay_order_id?: string;
  razorpay_payment_id?: string;
}

async function verifySignature(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string
): Promise<boolean> {
  if (!orderId || !paymentId || !signature || !secret) return false;

  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(`${orderId}|${paymentId}`);
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, data);
    const hashArray = Array.from(new Uint8Array(signatureBuffer));
    const expected = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    return expected.toLowerCase() === signature.trim().toLowerCase();
  } catch (e) {
    console.error("[Razorpay Verify] Signature computation error:", e);
    return false;
  }
}

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

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return NextResponse.json(
        { error: "test keys not configured", code: "RAZORPAY_TEST_KEYS_NOT_CONFIGURED" },
        { status: 503 }
      );
    }

    const body: VerifyPayload = await req.json().catch(() => ({}));
    const orderId = body.order_id || body.razorpay_order_id;
    const paymentId = body.payment_id || body.razorpay_payment_id;
    const signature = body.razorpay_signature;

    if (!orderId || !paymentId || !signature) {
      return NextResponse.json(
        { error: "Missing required order_id, payment_id or razorpay_signature" },
        { status: 400 }
      );
    }

    // Verify HMAC-SHA256 signature
    const isValid = await verifySignature(orderId, paymentId, signature, keySecret);
    if (!isValid) {
      return NextResponse.json(
        { error: "Invalid payment signature", code: "INVALID_SIGNATURE" },
        { status: 400 }
      );
    }

    // Test mode safety check: if key id starts with rzp_test_, NEVER upsert a Pro subscription!
    const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID || "";
    if (keyId.startsWith("rzp_test_")) {
      return NextResponse.json({
        success: true,
        testMode: true,
        isPro: false,
        message: "Test payment successful (no Pro granted)",
      });
    }

    // On live mode success: persist subscription exactly like simulate-checkout
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
      console.error("[Razorpay Verify] Subscription persistence error:", subError);
      return NextResponse.json({ error: subError.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      isPro: true,
      subscription: sub,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Internal server error" },
      { status: 500 }
    );
  }
}
