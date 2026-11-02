import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  PLAN_DEFINITIONS,
  ADDON_PACK_DEFINITIONS,
  mapPlanIdToCode,
  type PlanCode,
} from "@/lib/billing/quota";

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

    // Look up order in payment_orders table belonging to user (REQUIRED - Fail closed)
    const { data: orderRow, error: orderErr } = await supabaseAdmin
      .from("payment_orders")
      .select("*")
      .eq("provider_order_id", orderId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (orderErr || !orderRow) {
      return NextResponse.json(
        { error: "Payment order record not found or access denied", code: "ORDER_NOT_FOUND" },
        { status: 404 }
      );
    }

    // Fail closed on payload vs order row mismatch
    const payloadPlan = (body as any).planCode || (body as any).plan_code;
    const payloadAddon = (body as any).addonCode || (body as any).addon_code;
    const payloadAmount = (body as any).amount;

    if (payloadAmount && Number(payloadAmount) !== orderRow.amount_paise) {
      return NextResponse.json(
        { error: "Payment amount does not match recorded order amount", code: "AMOUNT_MISMATCH" },
        { status: 400 }
      );
    }

    if (payloadPlan && orderRow.plan_code && payloadPlan !== orderRow.plan_code) {
      return NextResponse.json(
        { error: "Plan code does not match recorded order", code: "PLAN_MISMATCH" },
        { status: 400 }
      );
    }

    if (payloadAddon && orderRow.addon_code && payloadAddon !== orderRow.addon_code) {
      return NextResponse.json(
        { error: "Addon code does not match recorded order", code: "ADDON_MISMATCH" },
        { status: 400 }
      );
    }

    if (!orderRow.plan_code && !orderRow.addon_code) {
      return NextResponse.json(
        { error: "Order record is missing valid plan or addon item", code: "INVALID_ORDER_STATE" },
        { status: 400 }
      );
    }

    // Idempotent: a second verify on an already paid order returns without granting again
    if (orderRow.status === "paid") {
      return NextResponse.json({
        success: true,
        message: "Order already verified and paid",
        alreadyPaid: true,
      });
    }

    // Test mode safety check: if key id starts with rzp_test_, NEVER grant Pro or add-on sets
    const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID || "";
    if (keyId.startsWith("rzp_test_")) {
      return NextResponse.json({
        success: true,
        testMode: true,
        isPro: false,
        message: "Test payment successful (no Pro granted)",
      });
    }

    // Attempt atomic fulfillment via Postgres RPC function
    try {
      const { data: fulfilRes, error: fulfilErr } = await supabaseAdmin.rpc("fulfil_payment_order", {
        p_provider_order_id: orderId,
        p_user_id: user.id,
      });

      if (!fulfilErr && fulfilRes) {
        if (fulfilRes.success) {
          return NextResponse.json(fulfilRes);
        }
        return NextResponse.json(
          { error: fulfilRes.error || "Payment fulfillment failed", code: fulfilRes.code || "FULFILLMENT_FAILED" },
          { status: 400 }
        );
      }
    } catch {
      // Fall through to atomic conditional update if RPC is not registered
    }

    // Atomic conditional update: only fulfill if status is currently 'created'
    const { data: updatedOrders, error: updateErr } = await supabaseAdmin
      .from("payment_orders")
      .update({
        status: "paid",
        paid_at: new Date().toISOString(),
      })
      .eq("id", orderRow.id)
      .eq("status", "created")
      .select();

    if (updateErr) {
      console.error("[Razorpay Verify] Failed to update payment order status:", updateErr);
      return NextResponse.json(
        { error: "Failed to update order status", code: "ORDER_UPDATE_FAILED" },
        { status: 500 }
      );
    }

    if (!updatedOrders || updatedOrders.length === 0) {
      return NextResponse.json({
        success: true,
        message: "Order already verified and paid",
        alreadyPaid: true,
      });
    }

    // Fulfill based strictly on orderRow (never defaulting to monthly)
    if (orderRow.addon_code) {
      const addonCode = orderRow.addon_code;
      const addonDef = ADDON_PACK_DEFINITIONS[addonCode];
      if (!addonDef) {
        return NextResponse.json({ error: "Unknown add-on pack", code: "UNKNOWN_ADDON" }, { status: 400 });
      }
      const expiresAt = new Date(Date.now() + (addonDef.validity_days || 60) * 86400000).toISOString();

      const { data: creditRow, error: creditErr } = await supabaseAdmin
        .from("user_addon_credits")
        .insert({
          user_id: user.id,
          pack_code: addonCode,
          sets_total: addonDef.sets,
          sets_remaining: addonDef.sets,
          expires_at: expiresAt,
          order_id: orderRow.id,
        })
        .select()
        .single();

      if (creditErr) {
        if (creditErr.code === "23505") {
          return NextResponse.json({ success: true, alreadyPaid: true });
        }
        console.error("[Razorpay Verify] Add-on credit persistence error:", creditErr);
        return NextResponse.json({ error: creditErr.message }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        type: "addon",
        addonCode,
        setsGranted: addonDef.sets,
        expiresAt,
        credit: creditRow,
      });
    } else if (orderRow.plan_code) {
      const planCode = orderRow.plan_code as PlanCode;
      const planDef = PLAN_DEFINITIONS[planCode];
      if (!planDef) {
        return NextResponse.json({ error: "Unknown plan code", code: "UNKNOWN_PLAN" }, { status: 400 });
      }
      const durationDays = planDef.duration_days || 30;
      const currentPeriodStart = new Date().toISOString();
      const currentPeriodEnd = new Date(Date.now() + durationDays * 86400000).toISOString();

      const { data: sub, error: subError } = await supabaseAdmin
        .from("subscriptions")
        .upsert(
          {
            user_id: user.id,
            plan_id: planCode,
            provider: "razorpay",
            currency: "INR",
            amount: planDef.price_paise,
            status: "active",
            current_period_start: currentPeriodStart,
            current_period_end: currentPeriodEnd,
            cancel_at_period_end: false,
            metadata: {
              razorpay_order_id: orderId,
              payment_order_id: orderRow.id,
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
        type: "plan",
        planCode,
        subscription: sub,
      });
    } else {
      return NextResponse.json(
        { error: "Order record missing valid item", code: "INVALID_ORDER" },
        { status: 400 }
      );
    }
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Internal server error" },
      { status: 500 }
    );
  }
}
