import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRazorpayKeyMode } from "@/lib/billing/mode";
import { verifyUserNotBanned } from "@/lib/admin/auth";
import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";
import { createLogger } from "@/lib/observability/logger";
import { singleFlight } from "@/lib/cache/singleFlight";

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

    // 6. Map planCode to Razorpay plan ID from env
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

    // 7. Check if user already has an active plan (block duplicate / overwrite)
    // Fail-closed: if the existing-subscription/entitlement lookup errors or state cannot be established,
    // return 503 before any Razorpay call (do not rely on getServerEntitlement which returns free on read failure).
    const { data: existingSub, error: selectErr } = await supabaseAdmin
      .from("subscriptions")
      .select("id, status, plan_id, subscription_id, current_period_end, grace_period_end, metadata")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (selectErr) {
      log.error("Subscription lookup error during subscription pre-check; failing closed", { error: selectErr });
      return NextResponse.json(
        {
          error: "Unable to verify subscription state. Please try again later.",
          code: "SERVICE_UNAVAILABLE",
        },
        { status: 503 }
      );
    }

    const now = Date.now();
    const isStatusActive = existingSub && (existingSub.status === "active" || existingSub.status === "trialing");
    const periodEndMs = existingSub?.current_period_end ? new Date(existingSub.current_period_end).getTime() : 0;
    const isPeriodActive = isStatusActive && (!existingSub.current_period_end || periodEndMs > now);
    const isGraceActive = existingSub?.status === "in_grace_period" &&
      existingSub.grace_period_end &&
      new Date(existingSub.grace_period_end).getTime() > now;

    let hasActivePlan = Boolean(isPeriodActive || isGraceActive);

    // If explicit entitlement mock is provided in test deps, evaluate it fail-closed
    if (!hasActivePlan && deps.getServerEntitlement && typeof deps.getServerEntitlement === "function") {
      try {
        const ent = await deps.getServerEntitlement(user.id);
        if (ent?.isPro) {
          hasActivePlan = true;
        }
      } catch (entErr) {
        log.error("Entitlement lookup failed during pre-check; failing closed", { error: entErr });
        return NextResponse.json(
          {
            error: "Unable to verify subscription state. Please try again later.",
            code: "SERVICE_UNAVAILABLE",
          },
          { status: 503 }
        );
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

    // 8. Authoritative Pending Reuse Query (Requirement 3: no JS filtering, handles query errors)
    // Select by user + provider + mode + plan + not expired + provider status
    const EXPIRATION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
    const expirationCutoff = new Date(Date.now() - EXPIRATION_WINDOW_MS).toISOString();

    const { data: existingPendingOrder, error: pendingOrderErr } = await supabaseAdmin
      .from("payment_orders")
      .select("id, provider_order_id, plan_code, status, created_at, mode, provider")
      .eq("user_id", user.id)
      .eq("provider", "razorpay")
      .eq("mode", resolvedMode)
      .eq("plan_code", planCode)
      .eq("status", "created")
      .like("provider_order_id", "sub_%")
      .gte("created_at", expirationCutoff)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pendingOrderErr) {
      log.error("Authoritative query for pending subscription order failed; failing closed", { error: pendingOrderErr });
      return NextResponse.json(
        {
          error: "Unable to verify pending subscription state. Please try again later.",
          code: "SERVICE_UNAVAILABLE",
        },
        { status: 503 }
      );
    }

    if (
      existingPendingOrder &&
      typeof existingPendingOrder.provider_order_id === "string" &&
      existingPendingOrder.provider_order_id.startsWith("sub_") &&
      !existingPendingOrder.provider_order_id.startsWith("sub_pending_")
    ) {
      log.info("Reusing existing pending subscription order from authoritative query", {
        userId: user.id,
        planCode,
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

    // Authoritative check for a pending subscription order for a different plan
    const { data: otherPendingOrder, error: otherPendingErr } = await supabaseAdmin
      .from("payment_orders")
      .select("id, plan_code, provider_order_id")
      .eq("user_id", user.id)
      .eq("provider", "razorpay")
      .eq("mode", resolvedMode)
      .eq("status", "created")
      .neq("plan_code", planCode)
      .like("provider_order_id", "sub_%")
      .gte("created_at", expirationCutoff)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (otherPendingErr) {
      log.error("Authoritative query for other pending plans failed; failing closed", { error: otherPendingErr });
      return NextResponse.json(
        {
          error: "Unable to verify pending subscription state. Please try again later.",
          code: "SERVICE_UNAVAILABLE",
        },
        { status: 503 }
      );
    }

    if (otherPendingOrder) {
      return NextResponse.json(
        {
          error: `A checkout is already pending for another plan (${otherPendingOrder.plan_code}). Please complete or cancel that checkout first.`,
          code: "PENDING_SUBSCRIPTION_EXISTS",
        },
        { status: 409 }
      );
    }

    const metadataPendingSubId = existingSub?.metadata?.pending_subscription_id;
    const metadataPendingPlan = existingSub?.metadata?.pending_plan_code;
    const metadataPendingMode = existingSub?.metadata?.pending_mode;
    const isMetaSub =
      typeof metadataPendingSubId === "string" &&
      metadataPendingSubId.startsWith("sub_") &&
      !metadataPendingSubId.startsWith("sub_pending_");
    const isMetaMatchingMode =
      resolvedMode === "live"
        ? metadataPendingMode === "live"
        : metadataPendingMode !== "live";

    if (isMetaSub && isMetaMatchingMode) {
      if (!metadataPendingPlan || metadataPendingPlan === planCode) {
        log.info("Reusing existing pending subscription from metadata", {
          userId: user.id,
          planCode,
          subscriptionId: metadataPendingSubId,
        });
        return NextResponse.json({
          subscriptionId: metadataPendingSubId,
          keyId,
          planId: razorpayPlanId.trim(),
          planCode,
          status: "created",
          reused: true,
        });
      } else {
        return NextResponse.json(
          {
            error: `A subscription checkout is already pending for another plan (${metadataPendingPlan}). Please complete or cancel that checkout first.`,
            code: "PENDING_SUBSCRIPTION_EXISTS",
          },
          { status: 409 }
        );
      }
    }

    // 9. Atomic Double-Tab Coalescing via singleFlight:
    // Ensures concurrent clicks or simultaneous tabs from the same user for this plan share
    // ONE in-flight loader and never trigger two distinct mandate creations in Razorpay.
    const flightKey = `sub_mandate:${user.id}:${planCode}`;
    const resultResponse = await singleFlight(flightKey, async () => {
      // Re-check pending orders inside flight in case another tab or request settled just before
      const { data: racePendingOrder } = await supabaseAdmin
        .from("payment_orders")
        .select("provider_order_id, plan_code, mode, provider")
        .eq("user_id", user.id)
        .eq("provider", "razorpay")
        .eq("mode", resolvedMode)
        .eq("plan_code", planCode)
        .eq("status", "created")
        .like("provider_order_id", "sub_%")
        .gte("created_at", expirationCutoff)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const isRaceSub =
        typeof racePendingOrder?.provider_order_id === "string" &&
        racePendingOrder.provider_order_id.startsWith("sub_") &&
        !racePendingOrder.provider_order_id.startsWith("sub_pending_");

      if (isRaceSub) {
        return NextResponse.json({
          subscriptionId: racePendingOrder.provider_order_id,
          keyId,
          planId: razorpayPlanId.trim(),
          planCode,
          status: "created",
          reused: true,
        });
      }

      const credentials = btoa(`${keyId}:${keySecret}`);
      const fetchCaller = deps.fetchFn || fetch;

      // 10. Requirement 1: Provider Plan Verification
      // Before creating a Razorpay subscription, fetch the plan from Razorpay and verify amount (paise),
      // currency INR, period and interval match the selected 7/30/90-day plan; fail closed with clear error otherwise.
      let planRes: Response;
      try {
        planRes = await fetchCaller(`https://api.razorpay.com/v1/plans/${razorpayPlanId.trim()}`, {
          method: "GET",
          headers: {
            Authorization: `Basic ${credentials}`,
          },
        });
      } catch (planFetchErr: any) {
        log.error("Network error fetching Razorpay plan from provider; failing closed", { error: planFetchErr });
        return NextResponse.json(
          { error: "Failed to verify plan with payment provider", code: "PLAN_VERIFICATION_FAILED" },
          { status: 502 }
        );
      }

      if (!planRes.ok) {
        const planErr = await planRes.json().catch(() => ({}));
        log.error("Razorpay plan fetch returned non-200 from provider; failing closed", { error: planErr, status: planRes.status });
        return NextResponse.json(
          { error: "Failed to verify plan with payment provider", code: "PLAN_VERIFICATION_FAILED" },
          { status: 502 }
        );
      }

      const planData = await planRes.json();
      const planItem = planData?.item || {};
      const verifiedAmount = planItem?.amount ?? planData?.amount;
      const verifiedCurrency = (planItem?.currency ?? planData?.currency ?? "").toUpperCase();
      const verifiedPeriod = (planData?.period ?? "").toLowerCase();
      const verifiedInterval = Number(planData?.interval ?? 1);

      const PLAN_SPECS: Record<
        string,
        { amount: number; matchPeriodInterval: (period: string, interval: number) => boolean }
      > = {
        weekly: {
          amount: 69200,
          matchPeriodInterval: (p, i) => (p === "weekly" && i === 1) || (p === "daily" && i === 7),
        },
        monthly: {
          amount: 149900,
          matchPeriodInterval: (p, i) => p === "monthly" && i === 1,
        },
        quarterly: {
          amount: 399900,
          matchPeriodInterval: (p, i) => (p === "monthly" && i === 3) || (p === "quarterly" && i === 1),
        },
      };

      const expectedSpec = PLAN_SPECS[planCode];
      const isAmountValid = verifiedAmount === expectedSpec?.amount;
      const isCurrencyValid = verifiedCurrency === "INR";
      const isPeriodIntervalValid = expectedSpec
        ? expectedSpec.matchPeriodInterval(verifiedPeriod, verifiedInterval)
        : false;

      if (!expectedSpec || !isAmountValid || !isCurrencyValid || !isPeriodIntervalValid) {
        log.error("Provider plan verification failed; attributes do not match plan definition", {
          planCode,
          razorpayPlanId: razorpayPlanId.trim(),
          expectedAmount: expectedSpec?.amount,
          verifiedAmount,
          verifiedCurrency,
          verifiedPeriod,
          verifiedInterval,
        });
        return NextResponse.json(
          {
            error: `Provider plan details do not match ${planCode} plan requirements`,
            code: "PLAN_VERIFICATION_MISMATCH",
          },
          { status: 502 }
        );
      }

      // Log the verified values as required by Requirement 1
      log.info("Verified Razorpay plan with provider", {
        planCode,
        razorpayPlanId: razorpayPlanId.trim(),
        verifiedAmount,
        verifiedCurrency,
        verifiedPeriod,
        verifiedInterval,
      });

      // 11. Requirement 2: Durable Mandate Creation
      // Reserve a per-user pending subscription row in the DB (unique per user, any plan) BEFORE calling Razorpay;
      // if the provider call fails, mark the row failed/cancel any created mandate.
      // Unique-collision path must check plan equality, never reuse a different plan.
      const reservationOrderId = `sub_pending_${user.id}`;
      const { error: reserveInsertErr } = await supabaseAdmin
        .from("payment_orders")
        .insert({
          user_id: user.id,
          provider: "razorpay",
          provider_order_id: reservationOrderId,
          plan_code: planCode,
          amount_paise: verifiedAmount,
          currency: "INR",
          status: "created",
          mode: resolvedMode,
        });

      if (reserveInsertErr) {
        if (
          reserveInsertErr.code === "23505" ||
          reserveInsertErr.message?.includes("duplicate") ||
          reserveInsertErr.message?.includes("unique")
        ) {
          log.warn("Unique constraint collision on pending subscription reservation; inspecting existing pending order", {
            error: reserveInsertErr,
            userId: user.id,
          });

          const { data: existingRace, error: raceFetchErr } = await supabaseAdmin
            .from("payment_orders")
            .select("id, provider_order_id, plan_code, mode, status, created_at")
            .eq("user_id", user.id)
            .eq("provider", "razorpay")
            .eq("status", "created")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (raceFetchErr || !existingRace) {
            log.error("Failed to query conflicting order on unique collision; failing closed", { error: raceFetchErr });
            return NextResponse.json(
              { error: "A subscription checkout is already in progress. Please try again.", code: "PENDING_SUBSCRIPTION_EXISTS" },
              { status: 409 }
            );
          }

          // Unique-collision path must check plan equality, never reuse a different plan
          if (existingRace.plan_code !== planCode) {
            log.warn("Unique collision with different plan; refusing reuse", {
              requestedPlan: planCode,
              existingPlan: existingRace.plan_code,
            });
            return NextResponse.json(
              {
                error: `A subscription checkout is already pending for another plan (${existingRace.plan_code}). Please complete or cancel that checkout first.`,
                code: "PENDING_SUBSCRIPTION_EXISTS",
              },
              { status: 409 }
            );
          }

          // Same plan: check if it already has a completed mandate ID
          if (
            typeof existingRace.provider_order_id === "string" &&
            existingRace.provider_order_id.startsWith("sub_") &&
            !existingRace.provider_order_id.startsWith("sub_pending_")
          ) {
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

        log.error("Failed to insert pending subscription reservation into payment_orders", { error: reserveInsertErr });
        return NextResponse.json(
          {
            error: "Failed to initialize subscription tracking. Please try again.",
            code: "SUBSCRIPTION_RECORD_FAILED",
          },
          { status: 500 }
        );
      }

      // Total count calculation: 1 full year (52 weeks, 12 months, 4 quarters)
      const TOTAL_COUNTS: Record<string, number> = {
        weekly: 52,
        monthly: 12,
        quarterly: 4,
      };
      const totalCount = TOTAL_COUNTS[planCode] ?? 12;

      // Create subscription via Razorpay /v1/subscriptions
      let rzpRes: Response;
      try {
        rzpRes = await fetchCaller("https://api.razorpay.com/v1/subscriptions", {
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
      } catch (gatewayErr: any) {
        log.error("Network exception calling Razorpay subscriptions API", { error: gatewayErr });
        // Mark reserved row failed as required by Requirement 2
        await supabaseAdmin
          .from("payment_orders")
          .update({ status: "failed" })
          .eq("provider_order_id", reservationOrderId);

        return NextResponse.json(
          { error: "Failed to connect to payment gateway", code: "GATEWAY_CONNECTION_ERROR" },
          { status: 502 }
        );
      }

      if (!rzpRes.ok) {
        const err = await rzpRes.json().catch(() => ({}));
        log.error("Failed to create Razorpay subscription", { error: err });
        // Mark reserved row failed as required by Requirement 2
        await supabaseAdmin
          .from("payment_orders")
          .update({ status: "failed" })
          .eq("provider_order_id", reservationOrderId);

        return NextResponse.json(
          {
            error: err?.error?.description || "Failed to initialize payment gateway subscription",
            code: "RAZORPAY_SUBSCRIPTION_ERROR",
          },
          { status: rzpRes.status || 502 }
        );
      }

      const subscriptionData = await rzpRes.json();

      // Update reserved order with real Razorpay subscription ID
      const { error: updateOrderErr } = await supabaseAdmin
        .from("payment_orders")
        .update({
          provider_order_id: subscriptionData.id,
          status: "created",
        })
        .eq("provider_order_id", reservationOrderId);

      if (updateOrderErr) {
        log.error("Failed to update reserved order with provider subscription ID; cancelling mandate", {
          error: updateOrderErr,
          subscriptionId: subscriptionData.id,
        });

        // Mark reserved row failed
        await supabaseAdmin
          .from("payment_orders")
          .update({ status: "failed" })
          .eq("provider_order_id", reservationOrderId);

        // Cancel any created mandate as required by Requirement 2
        try {
          await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${subscriptionData.id}/cancel`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Basic ${credentials}`,
            },
            body: JSON.stringify({ cancel_at_cycle_end: 0 }),
          });
        } catch (cancelErr) {
          log.error("Failed to cancel orphan mandate in Razorpay", { error: cancelErr, subscriptionId: subscriptionData.id });
        }

        return NextResponse.json(
          {
            error: "Failed to persist subscription tracking. Please try again.",
            code: "SUBSCRIPTION_RECORD_FAILED",
          },
          { status: 500 }
        );
      }

      // Requirement 1: Use provider current_start/current_end when granting time. Log the verified values.
      let providerCurrentStart: string | null = null;
      let providerCurrentEnd: string | null = null;
      const rawStartSec = subscriptionData.current_start ?? subscriptionData.start_at;
      const rawEndSec = subscriptionData.current_end ?? subscriptionData.end_at;

      if (typeof rawStartSec === "number" && !isNaN(rawStartSec) && rawStartSec > 0) {
        providerCurrentStart = new Date(rawStartSec * 1000).toISOString();
      }
      if (typeof rawEndSec === "number" && !isNaN(rawEndSec) && rawEndSec > 0) {
        providerCurrentEnd = new Date(rawEndSec * 1000).toISOString();
      }

      log.info("Subscription created with provider cycle time bounds", {
        subscriptionId: subscriptionData.id,
        providerCurrentStart,
        providerCurrentEnd,
        verifiedAmount,
        verifiedCurrency,
        verifiedPeriod,
        verifiedInterval,
      });

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
              provider_current_start: providerCurrentStart,
              provider_current_end: providerCurrentEnd,
              verified_amount_paise: verifiedAmount,
              verified_currency: verifiedCurrency,
              verified_period: verifiedPeriod,
              verified_interval: verifiedInterval,
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
        currentStart: providerCurrentStart,
        currentEnd: providerCurrentEnd,
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
  const log = baseLog.child({ requestId: req?.headers.get("x-request-id") ?? "unknown", action: "cancel_subscription" });
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

    // Lookup user subscription
    const { data: sub, error: subErr } = await supabaseAdmin
      .from("subscriptions")
      .select("id, user_id, provider, subscription_id, status, current_period_end, cancel_at_period_end, metadata")
      .eq("user_id", user.id)
      .maybeSingle();

    if (subErr) {
      log.error("Failed to query subscription for cancellation; failing closed", { error: subErr });
      return NextResponse.json(
        { error: "Unable to verify subscription state. Please try again later.", code: "SERVICE_UNAVAILABLE" },
        { status: 503 }
      );
    }

    if (!sub || (sub.status !== "active" && sub.status !== "trialing" && sub.status !== "in_grace_period")) {
      return NextResponse.json(
        { error: "No active subscription found to cancel", code: "NO_ACTIVE_SUBSCRIPTION" },
        { status: 400 }
      );
    }

    if (sub.cancel_at_period_end) {
      return NextResponse.json({
        success: true,
        message: "Subscription is already scheduled to cancel at the end of the billing period",
        cancelAtPeriodEnd: true,
      });
    }

    const keyId =
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ||
      process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const credentials = keyId && keySecret ? btoa(`${keyId}:${keySecret}`) : "";
    const fetchCaller = deps.fetchFn || fetch;

    const rzpSubId =
      sub.subscription_id ||
      sub.metadata?.pending_subscription_id ||
      sub.metadata?.provider_subscription_id;

    if (sub.provider === "razorpay" && rzpSubId && rzpSubId.startsWith("sub_")) {
      if (!keyId || !keySecret) {
        log.error("Missing Razorpay credentials for subscription cancel");
        return NextResponse.json(
          { error: "Payment gateway configuration missing", code: "RAZORPAY_CONFIG_ERROR" },
          { status: 503 }
        );
      }

      try {
        const rzpCancelRes = await fetchCaller(
          `https://api.razorpay.com/v1/subscriptions/${rzpSubId}/cancel`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Basic ${credentials}`,
            },
            body: JSON.stringify({
              cancel_at_cycle_end: 1, // Cancel at cycle end via API as required by Requirement 4
            }),
          }
        );

        if (!rzpCancelRes.ok) {
          const cancelErr = await rzpCancelRes.json().catch(() => ({}));
          const desc = String(cancelErr?.error?.description || "");
          const isAlreadyDone =
            desc.toLowerCase().includes("already cancelled") ||
            desc.toLowerCase().includes("already canceled") ||
            desc.toLowerCase().includes("completed");

          if (!isAlreadyDone) {
            log.error("Razorpay subscription cancel API failed", { error: cancelErr, status: rzpCancelRes.status });
            return NextResponse.json(
              {
                error: cancelErr?.error?.description || "Failed to cancel subscription with payment provider",
                code: "RAZORPAY_CANCEL_ERROR",
              },
              { status: rzpCancelRes.status || 502 }
            );
          }
        }
      } catch (fetchErr: any) {
        log.error("Network error during Razorpay subscription cancel", { error: fetchErr });
        return NextResponse.json(
          { error: "Network error connecting to payment gateway", code: "GATEWAY_CONNECTION_ERROR" },
          { status: 502 }
        );
      }
    }

    // Update DB
    const { error: dbUpdateErr } = await supabaseAdmin
      .from("subscriptions")
      .update({
        cancel_at_period_end: true,
        updated_at: new Date().toISOString(),
        metadata: {
          ...(sub.metadata || {}),
          cancel_at_period_end: true,
          canceled_at: new Date().toISOString(),
          canceled_by: "customer",
        },
      })
      .eq("user_id", user.id);

    if (dbUpdateErr) {
      log.error("Failed to update subscription in DB after cancellation", { error: dbUpdateErr });
      return NextResponse.json(
        { error: "Failed to update subscription status in database", code: "DATABASE_ERROR" },
        { status: 500 }
      );
    }

    log.info("Customer subscription successfully scheduled for cancellation at period end", {
      userId: user.id,
      subscriptionId: rzpSubId,
    });

    return NextResponse.json({
      success: true,
      message: "Subscription auto-renew canceled. You retain Pro access until the end of your billing cycle.",
      cancelAtPeriodEnd: true,
    });
  } catch (err: any) {
    log.error("Unexpected error in subscription cancellation route", { error: err?.message || String(err) });
    reportRequestErrorToSentry(req, err);
    return NextResponse.json({ error: err?.message || "Internal server error" }, { status: 500 });
  }
}
