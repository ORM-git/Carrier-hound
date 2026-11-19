import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRazorpayKeyMode } from "@/lib/billing/mode";
import { normalizePlanCode } from "@/lib/billing/quota";
import { PLAN_PRICING } from "@/config/plans";
import { verifyUserNotBanned } from "@/lib/admin/auth";
import { getRuntimeEnv } from "@/lib/ai/serviceHandler";
import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";
import { createLogger } from "@/lib/observability/logger";
import { singleFlight } from "@/lib/cache/singleFlight";
import { handleSubscriptionCancellation } from "@/lib/billing/subscriptionCancellation";
import { validateRazorpayPlan } from "@/lib/billing/validatePlan";

const baseLog = createLogger({ context: { route: "/api/billing/razorpay/subscription" } });

export const runtime = "edge";

async function getCloudflareEnv(deps?: any): Promise<Record<string, any> | undefined> {
  if (deps?.cfEnv) return deps.cfEnv;
  if (deps?.env) return deps.env;
  try {
    const mod = await import("@cloudflare/next-on-pages").catch(() => null);
    const ctx = mod?.getRequestContext?.();
    if (ctx?.env) {
      return ctx.env as Record<string, any>;
    }
  } catch {}
  try {
    const cfContext = (globalThis as any)[Symbol.for("__cloudflare-request-context__")];
    if (cfContext?.env) {
      return cfContext.env as Record<string, any>;
    }
  } catch {}
  return undefined;
}

function isProductionHost(req: Request, deps?: any, cfEnv?: Record<string, any>): boolean {
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

  const hostHeader = getHeader("host");
  if (hostHeader) {
    const parts = hostHeader.split(",");
    for (const part of parts) {
      if (matchesProd(part)) return true;
    }
  }

  if (req?.url) {
    try {
      const url = new URL(req.url);
      if (matchesProd(url.hostname) || matchesProd(url.host)) return true;
    } catch {
      // ignore
    }
  }

  const xForwardedHost = getHeader("x-forwarded-host");
  if (xForwardedHost) {
    const parts = xForwardedHost.split(",");
    for (const part of parts) {
      if (matchesProd(part)) return true;
    }
  }

  const envUrls = [
    getRuntimeEnv("NEXT_PUBLIC_SITE_URL", cfEnv),
    getRuntimeEnv("URL", cfEnv),
    getRuntimeEnv("SITE_URL", cfEnv),
  ];
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
  const cfEnv = await getCloudflareEnv(deps);

  try {
    // Check if this is an explicit cancellation request
    let bodyText = "";
    try {
      bodyText = await req.clone().text();
    } catch {}

    let bodyJson: any = {};
    if (bodyText) {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {}
    }

    if (bodyJson?.action === "cancel") {
      return await handleSubscriptionCancellation(req, deps, cfEnv, log);
    }

    // 1. Feature Flag Checks: NEXT_PUBLIC_AUTORENEW_ENABLED and NEXT_PUBLIC_BILLING_ENABLED
    if (getRuntimeEnv("NEXT_PUBLIC_AUTORENEW_ENABLED", cfEnv) !== "true") {
      return NextResponse.json(
        { error: "Auto-renew subscriptions are currently unavailable", code: "AUTORENEW_DISABLED" },
        { status: 503 }
      );
    }

    if (getRuntimeEnv("NEXT_PUBLIC_BILLING_ENABLED", cfEnv) !== "true") {
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
        getRuntimeEnv("NEXT_PUBLIC_SUPABASE_URL", cfEnv) ||
        getRuntimeEnv("SUPABASE_URL", cfEnv) ||
        "https://szakevhxhwpeskidvtfs.supabase.co";
      const serviceRoleKey =
        getRuntimeEnv("SUPABASE_SERVICE_ROLE_KEY", cfEnv) ||
        getRuntimeEnv("SUPABASE_SERVICE_KEY", cfEnv);

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

    // 3. User Ban Check
    const banChecker = deps.verifyUserNotBanned || verifyUserNotBanned;
    const banResult = await banChecker(supabaseAdmin, user.id, user.user_metadata);
    if (banResult.isBlocked) {
      return NextResponse.json({ error: "Account suspended", code: "USER_BLOCKED" }, { status: 403 });
    }

    // 4. Server-authoritative mode & key validation
    const configuredMode = getRuntimeEnv("RAZORPAY_MODE", cfEnv) || (deps.configuredMode ?? "test");
    if (configuredMode !== "test" && configuredMode !== "live") {
      log.error("Payment configuration error: invalid or missing mode");
      return NextResponse.json(
        { error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" },
        { status: 503 }
      );
    }

    const keyId =
      getRuntimeEnv("NEXT_PUBLIC_RAZORPAY_KEY_ID", cfEnv) ||
      getRuntimeEnv("RAZORPAY_KEY_ID", cfEnv);
    const keySecret = getRuntimeEnv("RAZORPAY_KEY_SECRET", cfEnv);

    if (!keyId || !keySecret) {
      log.error("Payment configuration error: missing credentials");
      return NextResponse.json(
        { error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" },
        { status: 503 }
      );
    }

    const resolvedMode = getRazorpayKeyMode(keyId);
    const expectedPrefix = configuredMode === "test" ? "rzp_test_" : "rzp_live_";
    if (!keyId.startsWith(expectedPrefix) || resolvedMode !== configuredMode) {
      log.error("Payment configuration error: key prefix does not match configured mode");
      return NextResponse.json(
        { error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" },
        { status: 503 }
      );
    }

    if (
      isProductionHost(req, deps, cfEnv) &&
      (keyId.startsWith("rzp_test_") || configuredMode === "test")
    ) {
      log.error("FATAL CONFIGURATION ERROR: Razorpay test keys refused on production host");
      return NextResponse.json(
        { error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" },
        { status: 503 }
      );
    }

    // 5. Parse and validate plan code: Flat Rs 499 monthly plan ONLY
    const rawPlan = bodyJson?.planCode || bodyJson?.planId || "monthly";
    const planCode = normalizePlanCode(rawPlan);

    if (planCode !== "monthly") {
      return NextResponse.json(
        {
          error: "Only the flat Rs 499 monthly auto-renew subscription is supported",
          code: "UNSUPPORTED_PLAN",
        },
        { status: 400 }
      );
    }

    // 6. Explicit auto-renew consent validation (Blocker 2)
    const consent = bodyJson?.consent;
    if (
      !consent ||
      typeof consent !== "object" ||
      consent.agreed !== true ||
      typeof consent.version !== "string" ||
      !consent.version.trim() ||
      typeof consent.timestamp !== "string" ||
      Number.isNaN(Date.parse(consent.timestamp))
    ) {
      return NextResponse.json(
        {
          error: "Explicit auto-renew consent is required to create a subscription",
          code: "CONSENT_REQUIRED",
        },
        { status: 400 }
      );
    }

    const consentTimestampMs = Date.parse(consent.timestamp);
    if (
      consentTimestampMs > Date.now() + 5 * 60 * 1000 ||
      consentTimestampMs < Date.now() - 24 * 60 * 60 * 1000
    ) {
      return NextResponse.json(
        {
          error: "Invalid consent timestamp",
          code: "INVALID_CONSENT_TIMESTAMP",
        },
        { status: 400 }
      );
    }

    const consentRecord = {
      agreed: true,
      version: consent.version.trim(),
      timestamp: new Date(consentTimestampMs).toISOString(),
      recorded_at: new Date().toISOString(),
    };

    // 7. Plan ID from environment variables only — NEVER hardcoded
    const razorpayPlanId =
      getRuntimeEnv("RAZORPAY_AUTORENEW_PLAN_MONTHLY", cfEnv) ||
      process.env.RAZORPAY_AUTORENEW_PLAN_MONTHLY;

    if (!razorpayPlanId || !razorpayPlanId.trim()) {
      log.error("Payment configuration error: RAZORPAY_AUTORENEW_PLAN_MONTHLY env var missing");
      return NextResponse.json(
        {
          error: "Subscription plan is not configured on server",
          code: "PLAN_NOT_CONFIGURED",
        },
        { status: 503 }
      );
    }

    // 8. Validate plan attributes from Razorpay API before use (Blocker 4)
    const planValidation = await validateRazorpayPlan(
      razorpayPlanId,
      keyId,
      keySecret,
      { fetchFn: deps.fetchFn, timeoutMs: deps.planValidationTimeoutMs }
    );

    if (!planValidation.valid) {
      log.error("Razorpay plan validation failed", {
        code: planValidation.code,
        error: planValidation.error,
      });
      return NextResponse.json(
        {
          error: planValidation.error || "Subscription plan validation failed",
          code: planValidation.code || "PLAN_INVALID",
        },
        { status: planValidation.code === "PLAN_NOT_CONFIGURED" ? 503 : 502 }
      );
    }

    const amountInPaise = PLAN_PRICING.monthly.price_paise; // 49900 paise = Rs 499
    const totalCount = 12;

    // 9. Atomic single-flight per user & plan
    const flightKey = `sub_create:${user.id}:${planCode}`;
    const resultResponse = await singleFlight(flightKey, async () => {
      // Check for an active non-expired subscription
      const { data: existingSub } = await supabaseAdmin
        .from("subscriptions")
        .select("id, status, current_period_end, subscription_id, metadata")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const periodEnd = existingSub?.current_period_end
        ? new Date(existingSub.current_period_end)
        : null;
      const isActiveAndValid =
        existingSub?.status === "active" &&
        periodEnd &&
        periodEnd.getTime() > Date.now();

      const hasActiveRecurringMandate =
        isActiveAndValid &&
        typeof existingSub?.subscription_id === "string" &&
        existingSub.subscription_id.startsWith("sub_");

      if (hasActiveRecurringMandate) {
        return NextResponse.json(
          {
            error: "You already have an active subscription.",
            code: "ACTIVE_SUBSCRIPTION_EXISTS",
          },
          { status: 409 }
        );
      }

      // Check for a recent pending order in payment_orders
      const { data: existingPendingOrder } = await supabaseAdmin
        .from("payment_orders")
        .select("provider_order_id, plan_code, mode, created_at")
        .eq("user_id", user.id)
        .eq("plan_code", planCode)
        .eq("status", "created")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const isRecent =
        existingPendingOrder?.created_at &&
        Date.now() - new Date(existingPendingOrder.created_at).getTime() < 15 * 60 * 1000;
      const isSubOrder =
        typeof existingPendingOrder?.provider_order_id === "string" &&
        existingPendingOrder.provider_order_id.startsWith("sub_");
      const isMatchingMode =
        resolvedMode === "live"
          ? existingPendingOrder?.mode === "live"
          : existingPendingOrder?.mode !== "live";

      if (existingPendingOrder && isRecent && isSubOrder && isMatchingMode) {
        log.info("Reusing existing pending subscription mandate", {
          subscriptionId: existingPendingOrder.provider_order_id,
        });
        return NextResponse.json({
          subscriptionId: existingPendingOrder.provider_order_id,
          keyId,
          planId: razorpayPlanId.trim(),
          planCode,
          status: "created",
          reused: true,
        });
      }

      // Create Razorpay Subscription via REST API
      const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
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
          customer_notify: 1,
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

      // Record pending subscription order in payment_orders with durable consent record
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
          metadata: {
            consent: consentRecord,
          },
        });

      if (orderInsertErr) {
        if (
          orderInsertErr.code === "23505" ||
          orderInsertErr.message?.includes("duplicate") ||
          orderInsertErr.message?.includes("unique")
        ) {
          log.warn("Unique constraint collision on payment_orders; fetching and reusing existing pending order", {
            error: orderInsertErr,
          });
          const { data: existingRace } = await supabaseAdmin
            .from("payment_orders")
            .select("provider_order_id, plan_code, mode")
            .eq("user_id", user.id)
            .eq("status", "created")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          const isRaceSub =
            typeof existingRace?.provider_order_id === "string" &&
            existingRace.provider_order_id.startsWith("sub_");
          const isRaceMatchingMode =
            resolvedMode === "live"
              ? existingRace?.mode === "live"
              : existingRace?.mode !== "live";

          if (isRaceSub && isRaceMatchingMode) {
            return NextResponse.json({
              subscriptionId: existingRace.provider_order_id,
              keyId,
              planId: razorpayPlanId.trim(),
              planCode,
              status: "created",
              reused: true,
            });
          }
          return NextResponse.json(
            {
              error: "A subscription checkout is already in progress. Please complete the pending payment.",
              code: "PENDING_SUBSCRIPTION_EXISTS",
            },
            { status: 409 }
          );
        }

        log.error("Failed to insert pending subscription into payment_orders", { error: orderInsertErr });
        return NextResponse.json(
          {
            error: "Failed to initialize subscription tracking. Please try again.",
            code: "SUBSCRIPTION_RECORD_FAILED",
          },
          { status: 500 }
        );
      }

      if (existingSub) {
        const { error: updateErr } = await supabaseAdmin
          .from("subscriptions")
          .update({
            updated_at: new Date().toISOString(),
            metadata: {
              ...(existingSub.metadata || {}),
              pending_subscription_id: subscriptionData.id,
              pending_plan_code: planCode,
              pending_mode: resolvedMode,
              pending_created_at: new Date().toISOString(),
              pending_consent: consentRecord,
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
    });

    return resultResponse.clone();
  } catch (err: any) {
    log.error("Unexpected error in subscription route", { error: err?.message || String(err), stack: err?.stack });
    reportRequestErrorToSentry(req, err);
    return NextResponse.json({ error: err?.message || "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const log = baseLog.child({ requestId: req?.headers.get("x-request-id") ?? "unknown" });
  const deps = (req as any).__testDeps || {};
  const cfEnv = await getCloudflareEnv(deps);
  return await handleSubscriptionCancellation(req, deps, cfEnv, log);
}
