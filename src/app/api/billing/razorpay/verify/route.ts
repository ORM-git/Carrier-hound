import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRazorpayKeyMode } from "@/lib/billing/mode";
import { rpcWithRetry } from "@/lib/db/rpcRetry";

import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";

import { createLogger } from "@/lib/observability/logger";

const baseLog = createLogger({ context: { route: "/api/billing/razorpay/verify" } });

export const runtime = "edge";

interface VerifyPayload {
  order_id?: string;
  payment_id?: string;
  razorpay_signature?: string;
  // Also accept standard Razorpay handler parameter names
  razorpay_order_id?: string;
  razorpay_payment_id?: string;
}

/**
 * Constant-time string comparison preventing timing oracles.
 * Always compares every character without early exit.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Computes a fixed-length SHA-256 hex digest using Web Crypto.
 */
async function computeSha256Hex(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
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

    // Constant-time comparison over fixed-length SHA-256 digests (no early exit)
    const [expectedDigest, signatureDigest] = await Promise.all([
      computeSha256Hex(expected.toLowerCase()),
      computeSha256Hex(signature.trim().toLowerCase()),
    ]);
    return constantTimeEqual(expectedDigest, signatureDigest);
  } catch (e) {
    baseLog.error("Signature computation error", { error: String(e) });
    return false;
  }
}

export async function POST(req: Request) {
  const log = baseLog.child({ requestId: req?.headers.get("x-request-id") ?? "unknown" });
  const deps = (req as any).__testDeps || {};
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
    let supabaseAdmin: any;

    if (deps.getSupabaseAdmin) {
      supabaseAdmin = deps.getSupabaseAdmin();
    } else {
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
      supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false },
      });
    }

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return NextResponse.json({ error: "Invalid user session token" }, { status: 401 });
    }

    const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID || "";
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keySecret || !keyId) {
      return NextResponse.json(
        { error: "test keys not configured", code: "RAZORPAY_TEST_KEYS_NOT_CONFIGURED" },
        { status: 503 }
      );
    }

    const serverMode = getRazorpayKeyMode(keyId);
    if (serverMode === "unknown") {
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
      .select("id, provider, mode, provider_order_id, plan_code, addon_code, amount_paise, status")
      .eq("provider_order_id", orderId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (orderErr || !orderRow) {
      return NextResponse.json(
        { error: "Payment order record not found or access denied", code: "ORDER_NOT_FOUND" },
        { status: 404 }
      );
    }

    // Check provider
    if (orderRow.provider && orderRow.provider !== "razorpay") {
      return NextResponse.json(
        { error: "Invalid payment provider", code: "INVALID_PROVIDER" },
        { status: 400 }
      );
    }

    // Check order mode vs server mode
    const orderMode = orderRow.mode || (orderRow.provider_order_id?.startsWith("order_test_") ? "test" : "live");
    if (orderMode !== serverMode) {
      return NextResponse.json(
        {
          error: `Order mode mismatch: cannot verify ${orderMode} order with ${serverMode} credentials`,
          code: "MODE_MISMATCH",
        },
        { status: 400 }
      );
    }

    // Fail closed on payload vs order row mismatch (null-safe and symmetric)
    const payloadPlan = (body as any).planCode ?? (body as any).plan_code;
    const payloadPlanId = (body as any).planId ?? (body as any).plan_id;
    const payloadAddon = (body as any).addonCode ?? (body as any).addon_code;
    const payloadAmount = (body as any).amount;

    if (payloadAmount !== undefined && payloadAmount !== null) {
      const numAmount = Number(payloadAmount);
      if (isNaN(numAmount) || numAmount !== (orderRow.amount_paise ?? null)) {
        return NextResponse.json(
          { error: "Payment amount does not match recorded order amount", code: "AMOUNT_MISMATCH" },
          { status: 400 }
        );
      }
    }

    const isAddonOrder = Boolean(orderRow.addon_code);
    if (payloadAddon !== undefined && payloadAddon !== null && payloadAddon !== (orderRow.addon_code ?? null)) {
      return NextResponse.json({ error: "Addon code does not match recorded order", code: "ADDON_MISMATCH" }, { status: 400 });
    }
    const expectedItem = isAddonOrder ? orderRow.addon_code : (orderRow.plan_code ?? null);
    if (payloadPlan !== undefined && payloadPlan !== null && payloadPlan !== expectedItem) {
      return NextResponse.json(
        { error: "Plan code does not match recorded order", code: "PLAN_MISMATCH" },
        { status: 400 }
      );
    }

    if (payloadPlanId !== undefined && payloadPlanId !== null && payloadPlanId !== expectedItem) {
      return NextResponse.json(
        { error: "Plan ID does not match recorded order", code: "PLAN_MISMATCH" },
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
        testMode: serverMode === "test",
        isPro: serverMode === "live" && Boolean(orderRow.plan_code),
        orderId: orderRow.id,
      });
    }

    // Fulfillment happens only through the atomic SQL RPC fulfil_payment_order
    const { data: fulfilRes, error: fulfilErr } = await rpcWithRetry(() =>
      supabaseAdmin.rpc("fulfil_payment_order", {
        p_provider_order_id: orderId,
        p_user_id: user.id,
        p_expected_mode: serverMode,
      })
    );

    if (fulfilErr) {
      log.error("Payment fulfillment RPC error", { error: fulfilErr.message });
      return NextResponse.json(
        { error: "Payment fulfillment failed", code: "FULFILLMENT_FAILED" },
        { status: 500 }
      );
    }

    if (!fulfilRes || !fulfilRes.success) {
      return NextResponse.json(
        { error: fulfilRes?.error || "Payment fulfillment failed", code: fulfilRes?.code || "FULFILLMENT_FAILED" },
        { status: fulfilRes?.code === "PRO_REQUIRED" ? 403 : 400 }
      );
    }

    if (serverMode === "test") {
      return NextResponse.json({
        ...fulfilRes,
        success: true,
        testMode: true,
        isPro: false,
        orderId: orderRow.id,
        message: "Test payment successful (no Pro granted)",
      });
    }

    return NextResponse.json(fulfilRes);
  } catch (err: any) {
    reportRequestErrorToSentry(req, err);
    return NextResponse.json(
      { error: err?.message || "Internal server error" },
      { status: 500 }
    );
  }
}
