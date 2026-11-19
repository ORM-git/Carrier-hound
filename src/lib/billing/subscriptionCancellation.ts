import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyUserNotBanned } from "@/lib/admin/auth";
import { getRuntimeEnv } from "@/lib/ai/serviceHandler";

/**
 * Shared cancellation logic that cancels Razorpay recurring subscription at cycle end
 * and marks cancel_at_period_end = true in Supabase ONLY after Razorpay confirms.
 *
 * FAILS CLOSED:
 * On non-2xx status from Razorpay, gateway timeout, network exception, or missing credentials:
 * returns an error and keeps the database state intact (cancel_at_period_end remains false),
 * allowing the user to safely retry cancellation.
 */
export async function handleSubscriptionCancellation(
  req: Request,
  deps: any,
  cfEnv: Record<string, any> | undefined,
  log: any
) {
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
      getRuntimeEnv("NEXT_PUBLIC_SUPABASE_URL", cfEnv) ||
      getRuntimeEnv("SUPABASE_URL", cfEnv) ||
      "https://szakevhxhwpeskidvtfs.supabase.co";
    const serviceRoleKey =
      getRuntimeEnv("SUPABASE_SERVICE_ROLE_KEY", cfEnv) ||
      getRuntimeEnv("SUPABASE_SERVICE_KEY", cfEnv);

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json({ error: "Supabase service configuration missing" }, { status: 500 });
    }

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

  const banChecker = deps.verifyUserNotBanned || verifyUserNotBanned;
  const banResult = await banChecker(supabaseAdmin, user.id, user.user_metadata);
  if (banResult.isBlocked) {
    return NextResponse.json({ error: "Account suspended", code: "USER_BLOCKED" }, { status: 403 });
  }

  // Find active subscription for user
  const { data: sub, error: subError } = await supabaseAdmin
    .from("subscriptions")
    .select("id, user_id, subscription_id, status, cancel_at_period_end, current_period_end, metadata")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (subError) {
    log.error("Failed to query subscriptions for cancellation", { error: subError });
    return NextResponse.json({ error: "Failed to query subscription", code: "DATABASE_ERROR" }, { status: 500 });
  }

  if (!sub || (sub.status !== "active" && sub.status !== "trialing" && sub.status !== "in_grace_period")) {
    return NextResponse.json(
      { error: "No active subscription found to cancel", code: "NO_ACTIVE_SUBSCRIPTION" },
      { status: 404 }
    );
  }

  if (sub.cancel_at_period_end) {
    return NextResponse.json({
      success: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: sub.current_period_end,
      message: "Subscription is already set to cancel at the end of the billing period",
    });
  }

  const rzpSubId = sub.subscription_id || sub.metadata?.razorpay_subscription_id;

  // Fail-closed requirement: must be a recurring Razorpay subscription
  if (!rzpSubId || typeof rzpSubId !== "string" || !rzpSubId.startsWith("sub_")) {
    return NextResponse.json(
      { error: "No active recurring subscription mandate found to cancel", code: "NOT_A_RECURRING_SUBSCRIPTION" },
      { status: 400 }
    );
  }

  const keyId =
    getRuntimeEnv("NEXT_PUBLIC_RAZORPAY_KEY_ID", cfEnv) ||
    getRuntimeEnv("RAZORPAY_KEY_ID", cfEnv);
  const keySecret = getRuntimeEnv("RAZORPAY_KEY_SECRET", cfEnv);

  // Fail closed if payment credentials are not configured: keep DB unchanged
  if (!keyId || !keySecret) {
    log.error("Missing Razorpay credentials for subscription cancellation");
    return NextResponse.json(
      { error: "Payment gateway credentials are not configured", code: "RAZORPAY_CONFIG_ERROR" },
      { status: 503 }
    );
  }

  const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const fetchCaller = deps.fetchFn || fetch;
  const timeoutMs = deps.timeoutMs ?? 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let rzpCancelRes: Response;
  try {
    rzpCancelRes = await fetchCaller(
      `https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(rzpSubId)}/cancel`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({ cancel_at_cycle_end: 1 }),
        signal: controller.signal,
      }
    );
  } catch (err: any) {
    clearTimeout(timer);
    const isTimeout =
      err?.name === "AbortError" ||
      err?.message?.toLowerCase().includes("timeout") ||
      err?.message?.toLowerCase().includes("abort");

    log.error("Razorpay subscription cancellation network exception or timeout (DB state kept intact)", {
      isTimeout,
      error: err?.message || err,
    });

    return NextResponse.json(
      {
        error: isTimeout
          ? "Payment gateway cancellation request timed out. Please try again."
          : "Failed to communicate with payment gateway. Please try again.",
        code: isTimeout ? "GATEWAY_TIMEOUT" : "GATEWAY_ERROR",
      },
      { status: isTimeout ? 504 : 502 }
    );
  } finally {
    clearTimeout(timer);
  }

  // Fail closed on non-2xx response: do NOT mark in DB
  if (!rzpCancelRes.ok) {
    const rzpErr = await rzpCancelRes.json().catch(() => ({}));
    log.error("Razorpay API subscription cancel returned non-2xx (DB state kept intact)", {
      status: rzpCancelRes.status,
      error: rzpErr,
    });

    return NextResponse.json(
      {
        error:
          rzpErr?.error?.description ||
          "Payment gateway rejected subscription cancellation. Please try again.",
        code: "RAZORPAY_CANCEL_FAILED",
        gatewayStatus: rzpCancelRes.status,
      },
      { status: 502 }
    );
  }

  // ONLY after Razorpay confirms cancellation: update DB
  const nowIso = new Date().toISOString();
  const updatedMetadata = {
    ...(sub.metadata || {}),
    cancel_at_cycle_end: true,
    cancelled_at: nowIso,
  };

  const { error: updateErr } = await supabaseAdmin
    .from("subscriptions")
    .update({
      cancel_at_period_end: true,
      updated_at: nowIso,
      metadata: updatedMetadata,
    })
    .eq("id", sub.id);

  if (updateErr) {
    log.error("Failed to update cancel_at_period_end in subscriptions table after Razorpay confirmed cancel", { error: updateErr });
    return NextResponse.json(
      { error: "Failed to update subscription cancellation in database", code: "DATABASE_ERROR" },
      { status: 500 }
    );
  }

  log.info("Subscription cancelled at cycle end confirmed by Razorpay and updated in DB", {
    userId: user.id,
    subscriptionId: rzpSubId,
  });

  return NextResponse.json({
    success: true,
    cancelAtPeriodEnd: true,
    currentPeriodEnd: sub.current_period_end,
    message: "Subscription will cancel at the end of the current billing period",
  });
}
