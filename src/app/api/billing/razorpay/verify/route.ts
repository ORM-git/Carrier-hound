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
  subscription_id?: string;
  razorpay_subscription_id?: string;
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

async function verifySignatureString(
  payloadString: string,
  signature: string,
  secret: string
): Promise<boolean> {
  if (!payloadString || !signature || !secret) return false;

  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(payloadString);
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

async function verifySignature(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string
): Promise<boolean> {
  if (!orderId || !paymentId || !signature || !secret) return false;
  return verifySignatureString(`${orderId}|${paymentId}`, signature, secret);
}

async function verifySubscriptionSignature(
  paymentId: string,
  subscriptionId: string,
  signature: string,
  secret: string
): Promise<boolean> {
  if (!paymentId || !subscriptionId || !signature || !secret) return false;
  const match1 = await verifySignatureString(`${paymentId}|${subscriptionId}`, signature, secret);
  if (match1) return true;
  return await verifySignatureString(`${subscriptionId}|${paymentId}`, signature, secret);
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

    const rawSubId = (body as any).subscription_id || (body as any).razorpay_subscription_id;
    const isSubscription = Boolean(rawSubId || (orderId && orderId.startsWith("sub_")));
    const subscriptionId = rawSubId || (orderId && orderId.startsWith("sub_") ? orderId : undefined);

    if ((!orderId && !subscriptionId) || !paymentId || !signature) {
      return NextResponse.json(
        { error: "Missing required order_id, payment_id or razorpay_signature" },
        { status: 400 }
      );
    }

    if (isSubscription && subscriptionId) {
      // 1. Verify subscription HMAC-SHA256 signature
      const isValid = await verifySubscriptionSignature(paymentId, subscriptionId, signature, keySecret);
      if (!isValid) {
        return NextResponse.json(
          { error: "Invalid payment signature", code: "INVALID_SIGNATURE" },
          { status: 400 }
        );
      }

      // 2. Fetch subscription entity directly from provider by ID (never trust client claims)
      const fetchCaller = deps.fetchCaller || fetch;
      const credentials = typeof btoa === "function"
        ? btoa(`${keyId}:${keySecret}`)
        : Buffer.from(`${keyId}:${keySecret}`).toString("base64");

      let rzpRes: Response;
      try {
        rzpRes = await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${subscriptionId}`, {
          method: "GET",
          headers: {
            Authorization: `Basic ${credentials}`,
          },
        });
      } catch (gatewayErr: any) {
        log.error("Network error fetching subscription from provider", { error: String(gatewayErr), subscriptionId });
        return NextResponse.json(
          { error: "Failed to verify mandate with provider", code: "GATEWAY_CONNECTION_ERROR" },
          { status: 502 }
        );
      }

      if (!rzpRes.ok) {
        log.error("Provider returned non-200 for subscription fetch", { status: rzpRes.status, subscriptionId });
        return NextResponse.json(
          { error: "Failed to verify mandate with provider", code: "GATEWAY_CONNECTION_ERROR" },
          { status: 502 }
        );
      }

      let subData: any;
      try {
        subData = await rzpRes.json();
      } catch (parseErr: any) {
        log.error("Failed to parse provider subscription response", { error: String(parseErr), subscriptionId });
        return NextResponse.json(
          { error: "Invalid payment gateway response", code: "GATEWAY_RESPONSE_INVALID" },
          { status: 502 }
        );
      }

      // 3. Ownership Check: provider notes.userId == authenticated user
      const providerUserId = subData?.notes?.userId || subData?.notes?.user_id;
      if (!providerUserId || providerUserId !== user.id) {
        log.warn("Mandate ownership mismatch: notes.userId does not match session user", {
          subscriptionId,
          sessionUserId: user.id,
        });
        return NextResponse.json(
          { error: "Mandate does not belong to authenticated user", code: "MANDATE_OWNERSHIP_MISMATCH" },
          { status: 403 }
        );
      }

      // 4. DB Order and Nonce Check
      const { data: orderRow } = await supabaseAdmin
        .from("payment_orders")
        .select("id, user_id, provider, mode, provider_order_id, plan_code, amount_paise, status, metadata")
        .eq("provider_order_id", subscriptionId)
        .maybeSingle();

      if (orderRow && orderRow.user_id !== user.id) {
        log.warn("Mandate order ownership mismatch", { subscriptionId, sessionUserId: user.id });
        return NextResponse.json(
          { error: "Mandate does not belong to authenticated user", code: "MANDATE_OWNERSHIP_MISMATCH" },
          { status: 403 }
        );
      }

      if (orderRow?.metadata?.nonce && subData?.notes?.nonce) {
        if (orderRow.metadata.nonce !== subData.notes.nonce) {
          log.warn("Mandate nonce mismatch", { subscriptionId, sessionUserId: user.id });
          return NextResponse.json(
            { error: "Mandate verification failed: nonce mismatch", code: "MANDATE_NONCE_MISMATCH" },
            { status: 403 }
          );
        }
      }

      // 5. Cross-link check on payment_orders table
      const { data: crossOrder } = await supabaseAdmin
        .from("payment_orders")
        .select("user_id")
        .eq("provider_order_id", subscriptionId)
        .neq("user_id", user.id)
        .maybeSingle();

      if (crossOrder && crossOrder.user_id !== user.id) {
        log.warn("Mandate cross-linked: order attached to another user", { subscriptionId, sessionUserId: user.id });
        return NextResponse.json(
          { error: "Mandate already attached to another user", code: "MANDATE_ATTACHED_TO_ANOTHER_USER" },
          { status: 403 }
        );
      }

      // If provider returned customer_id, store on order metadata so RPC can bind it
      if (subData?.customer_id && orderRow && !orderRow.metadata?.provider_customer_id) {
        await supabaseAdmin
          .from("payment_orders")
          .update({
            metadata: {
              ...(orderRow.metadata || {}),
              provider_customer_id: subData.customer_id,
            },
            updated_at: new Date().toISOString(),
          })
          .eq("provider_order_id", subscriptionId);
      }

      // 6. Check mode
      const subMode = orderRow?.mode || (subscriptionId.startsWith("sub_test_") ? "test" : "live");
      if (subMode !== serverMode) {
        return NextResponse.json(
          { error: `Order mode mismatch: cannot verify ${subMode} order with ${serverMode} credentials`, code: "MODE_MISMATCH" },
          { status: 400 }
        );
      }

      // 7. Idempotency: already paid returns cleanly
      if (orderRow?.status === "paid") {
        return NextResponse.json({
          success: true,
          message: "Subscription already verified and active",
          alreadyPaid: true,
          testMode: serverMode === "test",
          isPro: serverMode === "live",
          subscriptionId,
        });
      }

      // 8. Atomic fulfillment via fulfil_subscription_renewal RPC (enforces subscriptions table ownership and customer binding)
      const { data: fulfilRes, error: fulfilErr } = await rpcWithRetry(() =>
        supabaseAdmin.rpc("fulfil_subscription_renewal", {
          p_razorpay_subscription_id: subscriptionId,
          p_payment_id: paymentId,
          p_expected_mode: serverMode,
        })
      );

      if (fulfilErr) {
        log.error("Subscription renewal fulfillment RPC error", { error: fulfilErr.message, subscriptionId });
        return NextResponse.json(
          { error: "Subscription fulfillment failed", code: "FULFILLMENT_FAILED" },
          { status: 500 }
        );
      }

      if (!fulfilRes || !fulfilRes.success) {
        if (
          fulfilRes?.code === "MANDATE_ATTACHED_TO_ANOTHER_USER" ||
          fulfilRes?.code === "CUSTOMER_OWNERSHIP_MISMATCH" ||
          fulfilRes?.code === "MANDATE_OWNERSHIP_MISMATCH"
        ) {
          return NextResponse.json(
            { error: fulfilRes.error || "Mandate ownership validation failed", code: fulfilRes.code },
            { status: 403 }
          );
        }
        return NextResponse.json(
          { error: fulfilRes?.error || "Subscription fulfillment failed", code: fulfilRes?.code || "FULFILLMENT_FAILED" },
          { status: 400 }
        );
      }

      return NextResponse.json({
        ...fulfilRes,
        success: true,
        isPro: serverMode === "live",
        testMode: serverMode === "test",
        subscriptionId,
        paymentId,
      });
    }

    // Verify HMAC-SHA256 signature for one-time order
    const isValid = await verifySignature(orderId!, paymentId, signature, keySecret);
    if (!isValid) {
      return NextResponse.json(
        { error: "Invalid payment signature", code: "INVALID_SIGNATURE" },
        { status: 400 }
      );
    }

    // Check if order exists for ANY user in payment_orders
    const { data: anyOrder } = await supabaseAdmin
      .from("payment_orders")
      .select("user_id")
      .eq("provider_order_id", orderId!)
      .maybeSingle();

    if (anyOrder && anyOrder.user_id !== user.id) {
      log.warn("Order ownership mismatch: order belongs to another user", {
        orderId,
        sessionUserId: user.id,
      });
      return NextResponse.json(
        { error: "Payment order belongs to another user", code: "ORDER_OWNERSHIP_MISMATCH" },
        { status: 403 }
      );
    }

    // Look up order in payment_orders table belonging to user (REQUIRED - Fail closed)
    const { data: orderRow, error: orderErr } = await supabaseAdmin
      .from("payment_orders")
      .select("id, provider, mode, provider_order_id, plan_code, addon_code, amount_paise, status")
      .eq("provider_order_id", orderId!)
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
