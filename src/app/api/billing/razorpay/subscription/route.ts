import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRazorpayKeyMode } from "@/lib/billing/mode";
import { verifyUserNotBanned } from "@/lib/admin/auth";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";
import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";
import { createLogger } from "@/lib/observability/logger";

const baseLog = createLogger({ context: { route: "/api/billing/razorpay/subscription" } });

export const runtime = "edge";

function isProductionHost(req: Request, deps?: any): boolean {
  if (deps?.isProductionHost !== undefined) {
    return Boolean(deps.isProductionHost);
  }
  const PROD_HOSTS = new Set(["careermonke.com", "www.careermonke.com"]);

  const canonicalizeHost = (raw: string | null | undefined): string => {
    if (!raw || typeof raw !== "string") return "";
    let h = raw.trim().toLowerCase();
    if (h.startsWith("[")) {
      const endBracket = h.indexOf("]");
      if (endBracket !== -1) {
        h = h.slice(1, endBracket);
      }
    } else {
      h = h.split(":")[0];
    }
    while (h.endsWith(".")) {
      h = h.slice(0, -1);
    }
    return h.trim();
  };

  const matchesProd = (candidate: string | null | undefined): boolean => {
    return PROD_HOSTS.has(canonicalizeHost(candidate));
  };

  const getHeader = (name: string): string | null => {
    if (!req?.headers) return null;
    if (typeof req.headers.get === "function") {
      return req.headers.get(name);
    }
    const h = req.headers as any;
    return h[name] || h[name.toLowerCase()] || null;
  };

  // 1. Canonical Host header (must not be overridden by caller-supplied forwarding headers)
  const hostHeader = getHeader("host");
  if (hostHeader) {
    const parts = hostHeader.split(",");
    for (const part of parts) {
      if (matchesProd(part)) return true;
    }
  }

  // 2. Canonical request URL
  if (req?.url) {
    try {
      const url = new URL(req.url);
      if (matchesProd(url.hostname) || matchesProd(url.host)) return true;
    } catch {
      // ignore
    }
  }

  // 3. Forwarded host headers (caller-supplied header must never override a production Host or URL)
  const xForwardedHost = getHeader("x-forwarded-host");
  if (xForwardedHost) {
    const parts = xForwardedHost.split(",");
    for (const part of parts) {
      if (matchesProd(part)) return true;
    }
  }

  // 4. Deployment environment hints
  const envUrls = [process.env.NEXT_PUBLIC_SITE_URL, process.env.URL, process.env.SITE_URL];
  for (const envUrl of envUrls) {
    if (envUrl) {
      try {
        const parsed = new URL(envUrl.startsWith("http") ? envUrl : `https://${envUrl}`);
        if (matchesProd(parsed.hostname) || matchesProd(parsed.host)) return true;
      } catch {
        if (matchesProd(envUrl)) return true;
      }
    }
  }

  return false;
}

export async function POST(req: Request) {
  const log = baseLog.child({ requestId: req?.headers.get("x-request-id") ?? "unknown" });
  const deps = (req as any).__testDeps || {};

  try {
    // 1. Feature Flag Check: NEXT_PUBLIC_AUTORENEW_ENABLED must be strictly "true"
    if (process.env.NEXT_PUBLIC_AUTORENEW_ENABLED !== "true") {
      return NextResponse.json(
        { error: "Auto-renew subscriptions are currently unavailable", code: "AUTORENEW_DISABLED" },
        { status: 503 }
      );
    }

    // Also verify base billing enabled flag
    if (process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") {
      return NextResponse.json(
        { error: "Billing is currently unavailable", code: "BILLING_DISABLED" },
        { status: 503 }
      );
    }

    // 2. Authentication: requires valid Bearer token
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Missing or invalid authorization header" },
        { status: 401 }
      );
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
        return NextResponse.json(
          { error: "Supabase service configuration missing" },
          { status: 500 }
        );
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

    // 3. Server-authoritative mode & key validation (Audit Blocker B2 & F01)
    const configuredMode = process.env.RAZORPAY_MODE;
    if (configuredMode !== "test" && configuredMode !== "live") {
      log.error("Payment configuration error: invalid or missing mode");
      return NextResponse.json(
        {
          error: "Payment configuration error",
          code: "RAZORPAY_CONFIG_ERROR",
        },
        { status: 503 }
      );
    }

    const keyId =
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ||
      process.env.RAZORPAY_KEY_ID;
    const keySecret =
      process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      log.error("Payment configuration error: missing Razorpay credentials");
      return NextResponse.json(
        {
          error: "Payment configuration error",
          code: "RAZORPAY_CONFIG_ERROR",
        },
        { status: 503 }
      );
    }

    const keyPrefixMode = getRazorpayKeyMode(keyId);
    if (!keyPrefixMode) {
      log.error("Payment configuration error: unrecognized key prefix");
      return NextResponse.json(
        {
          error: "Payment configuration error",
          code: "RAZORPAY_CONFIG_ERROR",
        },
        { status: 503 }
      );
    }

    if (keyPrefixMode !== configuredMode) {
      log.error("Payment configuration error: key prefix does not match configured mode");
      return NextResponse.json(
        {
          error: "Payment configuration error",
          code: "RAZORPAY_CONFIG_ERROR",
        },
        { status: 503 }
      );
    }

    const resolvedMode = keyPrefixMode;

    if (keyPrefixMode === "test" && isProductionHost(req, deps)) {
      log.error("FATAL CONFIGURATION ERROR: Razorpay test keys refused on production host");
      return NextResponse.json(
        {
          error: "Payment configuration error",
          code: "RAZORPAY_CONFIG_ERROR",
        },
        { status: 503 }
      );
    }

    // 4. Validate planCode in {weekly, monthly, quarterly}
    const body = await req.json().catch(() => ({}));
    const planCode = body.planCode;
    if (planCode !== "weekly" && planCode !== "monthly" && planCode !== "quarterly") {
      return NextResponse.json(
        { error: "Invalid plan code: must be one of weekly, monthly, quarterly" },
        { status: 400 }
      );
    }

    // 5. Fail-closed server ban check (verifyUserNotBanned / blocked_users)
    const banChecker = deps.verifyUserNotBanned || verifyUserNotBanned;
    const banCheck = await banChecker(supabaseAdmin, user.id, user.user_metadata);
    if (banCheck?.isBlocked) {
      return NextResponse.json(
        {
          error: banCheck.error || "Account suspended. Access revoked by administrator.",
          code: "USER_BLOCKED",
        },
        { status: banCheck.isServiceUnavailable ? 503 : 403 }
      );
    }

    // 6. Check if user already has an active plan (block duplicate / overwrite)
    const { data: existingSub, error: selectErr } = await supabaseAdmin
      .from("subscriptions")
      .select("id, status, plan_id, subscription_id, current_period_end, grace_period_end, metadata")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (selectErr) {
      log.warn("Subscription lookup error during subscription pre-check", { error: selectErr });
    }

    const now = Date.now();
    const isStatusActive = existingSub && (existingSub.status === "active" || existingSub.status === "trialing");
    const periodEndMs = existingSub?.current_period_end ? new Date(existingSub.current_period_end).getTime() : 0;
    const isPeriodActive = isStatusActive && (!existingSub.current_period_end || periodEndMs > now);
    const isGraceActive = existingSub?.status === "in_grace_period" &&
      existingSub.grace_period_end &&
      new Date(existingSub.grace_period_end).getTime() > now;

    let hasActivePlan = Boolean(isPeriodActive || isGraceActive);

    const entitlementChecker = deps.getServerEntitlement || getServerEntitlement;
    if (!hasActivePlan && typeof entitlementChecker === "function") {
      try {
        const ent = await entitlementChecker(user.id);
        if (ent?.isPro) {
          hasActivePlan = true;
        }
      } catch {
        // ignore fallback errors
      }
    }

    if (hasActivePlan) {
      return NextResponse.json(
        {
          error: "You already have an active subscription plan. Please manage your existing subscription in account settings.",
          code: "ACTIVE_PLAN_EXISTS",
        },
        { status: 409 }
      );
    }

    // 7. Map planCode to Razorpay plan ID from env
    let razorpayPlanId: string | undefined;
    if (planCode === "weekly") {
      razorpayPlanId = process.env.RAZORPAY_AUTORENEW_PLAN_WEEKLY;
    } else if (planCode === "monthly") {
      razorpayPlanId = process.env.RAZORPAY_AUTORENEW_PLAN_MONTHLY;
    } else if (planCode === "quarterly") {
      razorpayPlanId = process.env.RAZORPAY_AUTORENEW_PLAN_QUARTERLY;
    }

    if (!razorpayPlanId || typeof razorpayPlanId !== "string" || !razorpayPlanId.trim()) {
      log.error("Payment configuration error: missing Razorpay plan ID for planCode", { planCode });
      return NextResponse.json(
        {
          error: "Payment configuration error",
          code: "RAZORPAY_CONFIG_ERROR",
        },
        { status: 503 }
      );
    }

    // 8. Total count calculation:
    // Razorpay /v1/subscriptions requires total_count (mandatory).
    // We set total_count based on planCode to represent exactly one calendar year (12 months) of recurring billing:
    // - weekly: 52 cycles (52 weeks = 1 full year)
    // - monthly: 12 cycles (12 months = 1 full year)
    // - quarterly: 4 cycles (4 quarters = 1 full year)
    // Why: One calendar year is the standard consumer SaaS recurring term before requiring payment method
    // re-authorization, preventing unbounded runaway charges while ensuring uninterrupted subscriber access.
    const TOTAL_COUNTS: Record<string, number> = {
      weekly: 52,
      monthly: 12,
      quarterly: 4,
    };
    const totalCount = TOTAL_COUNTS[planCode] ?? 12;

    // 9. Create subscription via Razorpay /v1/subscriptions
    // Server-authoritative: client amounts or prices are completely ignored.
    const credentials = btoa(`${keyId}:${keySecret}`);
    const fetchCaller = deps.fetchFn || fetch;
    const rzpRes = await fetchCaller("https://api.razorpay.com/v1/subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({
        plan_id: razorpayPlanId.trim(),
        total_count: totalCount,
        customer_notify: true,
        notes: {
          user_id: user.id,
          email: user.email || "",
          plan_code: planCode,
        },
      }),
    });

    if (!rzpRes.ok) {
      const err = await rzpRes.json().catch(() => ({}));
      log.error("Failed to create Razorpay subscription", { error: err });
      return NextResponse.json(
        {
          error: err?.error?.description || "Failed to initialize payment gateway subscription",
          code: "RAZORPAY_SUBSCRIPTION_ERROR",
        },
        { status: rzpRes.status || 502 }
      );
    }

    const subscriptionData = await rzpRes.json();

    // 10. Store pending subscription separately without overwriting existing subscription_id/plan_id
    const PLAN_PAISE: Record<string, number> = {
      weekly: 69200,
      monthly: 149900,
      quarterly: 399900,
    };
    const amountInPaise = PLAN_PAISE[planCode] ?? 149900;

    // Record pending subscription order in payment_orders
    const { error: orderInsertErr } = await supabaseAdmin
      .from("payment_orders")
      .insert({
        user_id: user.id,
        provider: "razorpay",
        provider_order_id: subscriptionData.id,
        plan_code: planCode,
        amount_paise: amountInPaise,
        currency: "INR",
        status: "created",
        mode: resolvedMode,
      });

    if (orderInsertErr) {
      log.error("Failed to insert pending subscription into payment_orders", { error: orderInsertErr });
      return NextResponse.json(
        {
          error: "Failed to initialize subscription tracking. Please try again.",
          code: "SUBSCRIPTION_RECORD_FAILED",
        },
        { status: 500 }
      );
    }

    // If an existing subscription row exists (e.g. previously canceled/expired), store pending subscription ID
    // in metadata without overwriting subscription_id, plan_id, or active status before payment is confirmed.
    if (existingSub) {
      const { error: updateErr } = await supabaseAdmin
        .from("subscriptions")
        .update({
          updated_at: new Date().toISOString(),
          metadata: {
            ...(existingSub.metadata || {}),
            pending_subscription_id: subscriptionData.id,
            pending_plan_code: planCode,
            pending_created_at: new Date().toISOString(),
          },
        })
        .eq("user_id", user.id);

      if (updateErr) {
        log.warn("Failed to update pending subscription metadata on existing subscription row", { error: updateErr });
      }
    }

    return NextResponse.json({
      subscriptionId: subscriptionData.id,
      keyId,
      planId: razorpayPlanId.trim(),
      planCode,
      status: subscriptionData.status,
    });
  } catch (err: any) {
    log.error("Unexpected error in subscription route", { error: err?.message || String(err), stack: err?.stack });
    reportRequestErrorToSentry(req, err);
    return NextResponse.json({ error: err?.message || "Internal server error" }, { status: 500 });
  }
}
