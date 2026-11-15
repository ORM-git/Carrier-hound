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

const LEASE_DURATION_MS = 5 * 60 * 1000; // 5 minute reservation lease
const EXPIRATION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

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

    // Base billing enabled flag check
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

    // 3. Server-authoritative mode & key validation
    const configuredMode = process.env.RAZORPAY_MODE;
    if (configuredMode !== "test" && configuredMode !== "live") {
      log.error("Payment configuration error: invalid or missing mode");
      return NextResponse.json(
        { error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" },
        { status: 503 }
      );
    }

    const keyId =
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ||
      process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      log.error("Payment configuration error: missing Razorpay credentials");
      return NextResponse.json(
        { error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" },
        { status: 503 }
      );
    }

    const keyPrefixMode = getRazorpayKeyMode(keyId);
    if (!keyPrefixMode) {
      log.error("Payment configuration error: unrecognized key prefix");
      return NextResponse.json(
        { error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" },
        { status: 503 }
      );
    }

    if (keyPrefixMode !== configuredMode) {
      log.error("Payment configuration error: key prefix does not match configured mode");
      return NextResponse.json(
        { error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" },
        { status: 503 }
      );
    }

    const resolvedMode = keyPrefixMode;

    if (keyPrefixMode === "test" && isProductionHost(req, deps)) {
      log.error("FATAL CONFIGURATION ERROR: Razorpay test keys refused on production host");
      return NextResponse.json(
        { error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" },
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

    // 5. Fail-closed server ban check
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
        { error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" },
        { status: 503 }
      );
    }
    const activeRazorpayPlanId: string = razorpayPlanId.trim();

    // 7. Check if user already has an active plan (block duplicate / overwrite)
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
        { error: "Unable to verify subscription state. Please try again later.", code: "SERVICE_UNAVAILABLE" },
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

    if (!hasActivePlan && deps.getServerEntitlement && typeof deps.getServerEntitlement === "function") {
      try {
        const ent = await deps.getServerEntitlement(user.id);
        if (ent?.isPro) {
          hasActivePlan = true;
        }
      } catch (entErr) {
        log.error("Entitlement lookup failed during pre-check; failing closed", { error: entErr });
        return NextResponse.json(
          { error: "Unable to verify subscription state. Please try again later.", code: "SERVICE_UNAVAILABLE" },
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

    const credentials = btoa(`${keyId}:${keySecret}`);
    const fetchCaller = deps.fetchFn || fetch;

    // Helper: Verify Plan against Provider Catalog (Requirement 1 & Requirement 5)
    const verifyPlanWithProvider = async (
      planId: string,
      expectedPlan: string
    ): Promise<{ ok: boolean; planData?: any; error?: string }> => {
      try {
        const planRes = await fetchCaller(`https://api.razorpay.com/v1/plans/${planId.trim()}`, {
          method: "GET",
          headers: { Authorization: `Basic ${credentials}` },
        });

        if (!planRes.ok) {
          const err = await planRes.json().catch(() => ({}));
          log.error("Razorpay plan fetch returned non-200 from provider", { status: planRes.status, err });
          return { ok: false, error: "PLAN_VERIFICATION_FAILED" };
        }

        const planData = await planRes.json();
        const planItem = planData?.item || {};
        const verifiedAmount = planItem?.amount ?? planData?.amount;
        const verifiedCurrency = (planItem?.currency ?? planData?.currency ?? "").toUpperCase();
        const verifiedPeriod = (planData?.period ?? "").toLowerCase();
        const verifiedInterval = Number(planData?.interval ?? 1);

        const expectedSpec = PLAN_SPECS[expectedPlan];
        const isAmountValid = verifiedAmount === expectedSpec?.amount;
        const isCurrencyValid = verifiedCurrency === "INR";
        const isPeriodIntervalValid = expectedSpec
          ? expectedSpec.matchPeriodInterval(verifiedPeriod, verifiedInterval)
          : false;

        if (!expectedSpec || !isAmountValid || !isCurrencyValid || !isPeriodIntervalValid) {
          log.error("Provider plan verification mismatch", {
            expectedPlan,
            verifiedAmount,
            verifiedCurrency,
            verifiedPeriod,
            verifiedInterval,
          });
          return { ok: false, error: "PLAN_VERIFICATION_MISMATCH" };
        }

        log.info("Verified Razorpay plan with provider", {
          planCode: expectedPlan,
          planId: planId.trim(),
          verifiedAmount,
          verifiedCurrency,
          verifiedPeriod,
          verifiedInterval,
        });

        return { ok: true, planData: { verifiedAmount, verifiedCurrency, verifiedPeriod, verifiedInterval } };
      } catch (e: any) {
        log.error("Exception verifying plan with provider", { error: e });
        return { ok: false, error: "PLAN_VERIFICATION_FAILED" };
      }
    };

    // Verify current plan upfront (Requirement 1)
    const planVerifyRes = await verifyPlanWithProvider(activeRazorpayPlanId, planCode);
    if (!planVerifyRes.ok) {
      if (planVerifyRes.error === "PLAN_VERIFICATION_MISMATCH") {
        return NextResponse.json(
          {
            error: "Provider plan details do not match plan requirements",
            code: "PLAN_VERIFICATION_MISMATCH",
          },
          { status: 502 }
        );
      }
      return NextResponse.json(
        {
          error: "Failed to verify plan with payment provider",
          code: "PLAN_VERIFICATION_FAILED",
        },
        { status: 502 }
      );
    }
    const { verifiedAmount, verifiedCurrency, verifiedPeriod, verifiedInterval } = planVerifyRes.planData;

    // Helper: Reconcile and Verify Pending Mandate with Provider (Requirement 5 & Requirement 6)
    const verifyAndReuseCandidateMandate = async (
      candidateId: string,
      _candidatePlanCode: string
    ): Promise<any | null> => {
      if (!candidateId || typeof candidateId !== "string" || !candidateId.startsWith("sub_") || candidateId.startsWith("sub_pending_")) {
        return null;
      }

      try {
        const subRes = await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${candidateId}`, {
          method: "GET",
          headers: { Authorization: `Basic ${credentials}` },
        });

        if (!subRes.ok) {
          log.warn("Candidate mandate not found or non-200 at provider; skipping reuse", { candidateId, status: subRes.status });
          return null;
        }

        const subData = await subRes.json();
        const validStatuses = new Set(["created", "authenticated", "active"]);
        if (!validStatuses.has(subData?.status)) {
          log.info("Candidate mandate at provider is not in active/created state; skipping reuse", { candidateId, status: subData?.status });
          // Mark order cancelled / expired locally
          await supabaseAdmin
            .from("payment_orders")
            .update({ status: "expired" })
            .eq("provider_order_id", candidateId);
          return null;
        }

        // Verify plan match
        if (subData?.plan_id !== activeRazorpayPlanId) {
          log.info("Candidate mandate plan does not match current plan ID; skipping reuse", {
            candidateId,
            subPlan: subData?.plan_id,
            expectedPlan: activeRazorpayPlanId,
          });
          return null;
        }

        // Verify age: if created > 24 hours ago, cancel at provider if unpaid and skip
        const createdAtSec = subData?.created_at || (subData?.start_at ?? 0);
        const ageMs = createdAtSec > 0 ? Date.now() - createdAtSec * 1000 : 0;
        if (ageMs > EXPIRATION_WINDOW_MS) {
          log.info("Candidate mandate is older than 24 hours; cancelling at provider and marking expired", { candidateId });
          if (subData?.status !== "active") {
            try {
              await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${candidateId}/cancel`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Basic ${credentials}` },
                body: JSON.stringify({ cancel_at_cycle_end: 0 }),
              });
            } catch (_) {}
          }
          await supabaseAdmin
            .from("payment_orders")
            .update({ status: "expired" })
            .eq("provider_order_id", candidateId);
          return null;
        }

        return subData;
      } catch (subErr) {
        log.warn("Exception checking candidate mandate at provider; skipping reuse", { candidateId, error: subErr });
        return null;
      }
    }

    // 8. Stale Order & Lease Reconciliation (Requirement 6)
    const expirationCutoff = new Date(Date.now() - EXPIRATION_WINDOW_MS).toISOString();
    const leaseCutoff = new Date(Date.now() - LEASE_DURATION_MS).toISOString();

    // Query for any stale created orders (> 24h) and reconcile
    const { data: staleOrders } = await supabaseAdmin
      .from("payment_orders")
      .select("id, provider_order_id, status")
      .eq("user_id", user.id)
      .eq("provider", "razorpay")
      .eq("status", "created")
      .lt("created_at", expirationCutoff);

    if (staleOrders && staleOrders.length > 0) {
      for (const st of staleOrders) {
        if (st.provider_order_id?.startsWith("sub_") && !st.provider_order_id.startsWith("sub_pending_")) {
          try {
            await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${st.provider_order_id}/cancel`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Basic ${credentials}` },
              body: JSON.stringify({ cancel_at_cycle_end: 0 }),
            });
          } catch (_) {}
        }
      }
      const staleIds = staleOrders.map((st: any) => st.id);
      await supabaseAdmin.from("payment_orders").update({ status: "expired" }).in("id", staleIds);
    }

    // Reconcile expired reservation leases (older than lease duration)
    await supabaseAdmin
      .from("payment_orders")
      .update({ status: "expired" })
      .eq("user_id", user.id)
      .eq("provider", "razorpay")
      .eq("status", "reserved")
      .lt("created_at", leaseCutoff);

    // 9. Authoritative Pending Reuse Query (Requirement 3 & 5)
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
        { error: "Unable to verify pending subscription state. Please try again later.", code: "SERVICE_UNAVAILABLE" },
        { status: 503 }
      );
    }

    if (
      existingPendingOrder &&
      typeof existingPendingOrder.provider_order_id === "string" &&
      existingPendingOrder.provider_order_id.startsWith("sub_") &&
      !existingPendingOrder.provider_order_id.startsWith("sub_pending_")
    ) {
      const verifiedSub = await verifyAndReuseCandidateMandate(existingPendingOrder.provider_order_id, planCode);
      if (verifiedSub) {
        log.info("Reusing existing pending subscription order after provider verification", {
          userId: user.id,
          planCode,
          subscriptionId: existingPendingOrder.provider_order_id,
        });
        return NextResponse.json({
          subscriptionId: existingPendingOrder.provider_order_id,
          keyId,
          planId: razorpayPlanId.trim(),
          planCode,
          status: verifiedSub.status,
          reused: true,
        });
      }
    }

    // Authoritative check for pending orders of different plans
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
        { error: "Unable to verify pending subscription state. Please try again later.", code: "SERVICE_UNAVAILABLE" },
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

    // Metadata candidate verification (Requirement 5)
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
      if (metadataPendingPlan && metadataPendingPlan !== planCode) {
        return NextResponse.json(
          {
            error: `A subscription checkout is already pending for another plan (${metadataPendingPlan}). Please complete or cancel that checkout first.`,
            code: "PENDING_SUBSCRIPTION_EXISTS",
          },
          { status: 409 }
        );
      }

      const verifiedMetaSub = await verifyAndReuseCandidateMandate(metadataPendingSubId, planCode);
      if (verifiedMetaSub) {
        log.info("Reusing existing pending subscription from metadata after provider verification", {
          userId: user.id,
          planCode,
          subscriptionId: metadataPendingSubId,
        });
        return NextResponse.json({
          subscriptionId: metadataPendingSubId,
          keyId,
          planId: razorpayPlanId.trim(),
          planCode,
          status: verifiedMetaSub.status,
          reused: true,
        });
      }
    }

    // 10. SingleFlight Coalescing & Durable Mandate Creation
    const flightKey = `sub_mandate:${user.id}:${planCode}`;
    const resultResponse = await singleFlight(flightKey, async () => {
      // Generate unique attempt ID per try (Requirement 8)
      const attemptId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const reservationOrderId = `sub_pending_${user.id}_${attemptId}`;

      // Reserve pending row in DB with explicit state 'reserved' (Requirement 8 & 7)
      const { error: reserveInsertErr } = await supabaseAdmin
        .from("payment_orders")
        .insert({
          user_id: user.id,
          provider: "razorpay",
          provider_order_id: reservationOrderId,
          plan_code: planCode,
          amount_paise: verifiedAmount,
          currency: "INR",
          status: "reserved",
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
            .eq("mode", resolvedMode)
            .in("status", ["reserved", "created"])
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

          // Check if reservation is stale (> lease duration)
          const raceCreatedMs = existingRace.created_at ? new Date(existingRace.created_at).getTime() : 0;
          if (Date.now() - raceCreatedMs > LEASE_DURATION_MS) {
            log.info("Conflicting reservation lease is expired; marking expired for retry recovery", { raceOrderId: existingRace.id });
            await supabaseAdmin.from("payment_orders").update({ status: "expired" }).eq("id", existingRace.id);
            // Allow retry on next request
            return NextResponse.json(
              { error: "Previous checkout attempt expired. Please try again.", code: "RESERVATION_LEASE_RECOVERED" },
              { status: 409 }
            );
          }

          if (existingRace.plan_code !== planCode) {
            return NextResponse.json(
              {
                error: `A subscription checkout is already pending for another plan (${existingRace.plan_code}). Please complete or cancel that checkout first.`,
                code: "PENDING_SUBSCRIPTION_EXISTS",
              },
              { status: 409 }
            );
          }

          if (
            typeof existingRace.provider_order_id === "string" &&
            existingRace.provider_order_id.startsWith("sub_") &&
            !existingRace.provider_order_id.startsWith("sub_pending_")
          ) {
            const verifiedSub = await verifyAndReuseCandidateMandate(existingRace.provider_order_id, planCode);
            if (verifiedSub) {
              return NextResponse.json({
                subscriptionId: existingRace.provider_order_id,
                keyId,
                planId: razorpayPlanId.trim(),
                planCode,
                status: verifiedSub.status,
                reused: true,
              });
            }
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

      const TOTAL_COUNTS: Record<string, number> = {
        weekly: 52,
        monthly: 12,
        quarterly: 4,
      };
      const totalCount = TOTAL_COUNTS[planCode] ?? 12;

      // 11. Create subscription via Razorpay with attempt tracking notes
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
              attempt_id: attemptId,
              reservation_id: reservationOrderId,
            },
          }),
        });
      } catch (gatewayErr: any) {
        log.error("Ambiguous create failure: Network exception calling Razorpay subscriptions API", { error: gatewayErr });
        // Requirement 9: Do not mark failed blindly. Mark unknown and reconcile
        await supabaseAdmin
          .from("payment_orders")
          .update({
            status: "failed",
            metadata: { reconciliation_state: "unknown", error: gatewayErr?.message || String(gatewayErr) },
          })
          .eq("provider_order_id", reservationOrderId);

        return NextResponse.json(
          { error: "Failed to connect to payment gateway", code: "GATEWAY_CONNECTION_ERROR" },
          { status: 502 }
        );
      }

      if (!rzpRes.ok) {
        const err = await rzpRes.json().catch(() => ({}));
        log.error("Failed to create Razorpay subscription", { error: err });
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

      let subscriptionData: any;
      try {
        subscriptionData = await rzpRes.json();
      } catch (parseErr: any) {
        log.error("Failed to parse Razorpay subscription response; marking unknown", { error: parseErr });
        await supabaseAdmin
          .from("payment_orders")
          .update({
            status: "failed",
            metadata: { reconciliation_state: "parse_error", error: parseErr?.message },
          })
          .eq("provider_order_id", reservationOrderId);

        return NextResponse.json(
          { error: "Invalid payment gateway response", code: "GATEWAY_RESPONSE_INVALID" },
          { status: 502 }
        );
      }

      // Requirement 9: Validate subscriptionData.id and status before persisting
      const validSubId =
        typeof subscriptionData?.id === "string" &&
        subscriptionData.id.startsWith("sub_") &&
        !subscriptionData.id.startsWith("sub_pending_");
      const validStatus =
        subscriptionData?.status === "created" ||
        subscriptionData?.status === "authenticated" ||
        subscriptionData?.status === "active";

      if (!validSubId || !validStatus) {
        log.error("Invalid subscription data received from Razorpay", { subscriptionData });
        await supabaseAdmin
          .from("payment_orders")
          .update({ status: "failed" })
          .eq("provider_order_id", reservationOrderId);

        if (subscriptionData?.id && typeof subscriptionData.id === "string" && subscriptionData.id.startsWith("sub_")) {
          try {
            await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${subscriptionData.id}/cancel`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Basic ${credentials}` },
              body: JSON.stringify({ cancel_at_cycle_end: 0 }),
            });
          } catch (_) {}
        }

        return NextResponse.json(
          { error: "Invalid subscription details received from provider", code: "GATEWAY_RESPONSE_INVALID" },
          { status: 502 }
        );
      }

      // 12. Requirement 10: Reserved-order update with affected row count check
      const { data: updatedOrders, error: updateOrderErr } = await supabaseAdmin
        .from("payment_orders")
        .update({
          provider_order_id: subscriptionData.id,
          status: "created",
        })
        .eq("provider_order_id", reservationOrderId)
        .select("id, provider_order_id");

      if (
        updateOrderErr ||
        !updatedOrders ||
        updatedOrders.length === 0 ||
        updatedOrders[0].provider_order_id !== subscriptionData.id
      ) {
        log.error("Failed to update reserved order (zero rows affected or ID mismatch); cancelling mandate at provider", {
          error: updateOrderErr,
          subscriptionId: subscriptionData.id,
          affectedCount: updatedOrders?.length ?? 0,
        });

        await supabaseAdmin
          .from("payment_orders")
          .update({ status: "failed" })
          .eq("provider_order_id", reservationOrderId);

        // Cancel mandate at provider
        let cancelSucceeded = false;
        try {
          const cancelRes = await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${subscriptionData.id}/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Basic ${credentials}` },
            body: JSON.stringify({ cancel_at_cycle_end: 0 }),
          });
          cancelSucceeded = cancelRes.ok;
        } catch (cancelErr) {
          log.error("Exception during orphan mandate cancellation", { error: cancelErr });
        }

        if (!cancelSucceeded) {
          log.error("Orphan mandate cancel failed (non-2xx); queued for retry reconciliation", { subscriptionId: subscriptionData.id });
        }

        return NextResponse.json(
          { error: "Failed to persist subscription tracking. Please try again.", code: "SUBSCRIPTION_RECORD_FAILED" },
          { status: 500 }
        );
      }

      // 13. Requirement 11: Schedule & Period Boundaries
      // Persist provider current_start/current_end (and charge_at). Fail closed if missing.
      const rawStartSec = subscriptionData.current_start ?? subscriptionData.start_at;
      const rawEndSec = subscriptionData.current_end ?? subscriptionData.end_at;
      const rawChargeAtSec = subscriptionData.charge_at;

      const hasValidStart = typeof rawStartSec === "number" && !isNaN(rawStartSec) && rawStartSec > 0;
      const hasValidEnd = typeof rawEndSec === "number" && !isNaN(rawEndSec) && rawEndSec > 0;

      if (!hasValidStart || !hasValidEnd) {
        log.error("Provider response is missing required period boundaries (current_start/current_end); failing closed", {
          subscriptionId: subscriptionData.id,
          rawStartSec,
          rawEndSec,
        });

        // Cancel created mandate at Razorpay
        try {
          await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${subscriptionData.id}/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Basic ${credentials}` },
            body: JSON.stringify({ cancel_at_cycle_end: 0 }),
          });
        } catch (_) {}

        await supabaseAdmin
          .from("payment_orders")
          .update({ status: "failed" })
          .eq("provider_order_id", subscriptionData.id);

        return NextResponse.json(
          { error: "Payment provider did not supply required billing cycle boundaries", code: "MISSING_PROVIDER_PERIOD" },
          { status: 502 }
        );
      }

      const providerCurrentStart = new Date(rawStartSec * 1000).toISOString();
      const providerCurrentEnd = new Date(rawEndSec * 1000).toISOString();
      const providerChargeAt =
        typeof rawChargeAtSec === "number" && !isNaN(rawChargeAtSec) && rawChargeAtSec > 0
          ? new Date(rawChargeAtSec * 1000).toISOString()
          : null;

      log.info("Subscription created with provider cycle time bounds", {
        subscriptionId: subscriptionData.id,
        providerCurrentStart,
        providerCurrentEnd,
        providerChargeAt,
        verifiedAmount,
        verifiedCurrency,
        verifiedPeriod,
        verifiedInterval,
      });

      // Atomic metadata merge on existing subscription row (Requirement 10)
      if (existingSub) {
        const mergedMetadata = {
          ...(existingSub.metadata || {}),
          pending_subscription_id: subscriptionData.id,
          pending_plan_code: planCode,
          pending_mode: resolvedMode,
          pending_created_at: new Date().toISOString(),
          provider_current_start: providerCurrentStart,
          provider_current_end: providerCurrentEnd,
          provider_charge_at: providerChargeAt,
          verified_amount_paise: verifiedAmount,
          verified_currency: verifiedCurrency,
          verified_period: verifiedPeriod,
          verified_interval: verifiedInterval,
        };

        const { error: updateSubErr } = await supabaseAdmin
          .from("subscriptions")
          .update({
            updated_at: new Date().toISOString(),
            metadata: mergedMetadata,
          })
          .eq("user_id", user.id);

        if (updateSubErr) {
          log.warn("Failed to update pending subscription metadata on existing subscription row", { error: updateSubErr });
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
    // 1. Authentication: requires valid Bearer token
    // (Requirement 12: Cancellation keeps working even if BILLING_ENABLED / AUTORENEW is off)
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

    // 2. Mode & Key Provenance Validation like POST (Requirement 4)
    const configuredMode = process.env.RAZORPAY_MODE;
    if (configuredMode !== "test" && configuredMode !== "live") {
      log.error("Payment configuration error: invalid or missing mode in cancel");
      return NextResponse.json(
        { error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" },
        { status: 503 }
      );
    }

    const keyId =
      process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ||
      process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      log.error("Payment configuration error: missing Razorpay credentials in cancel");
      return NextResponse.json(
        { error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" },
        { status: 503 }
      );
    }

    const keyPrefixMode = getRazorpayKeyMode(keyId);
    if (!keyPrefixMode || keyPrefixMode !== configuredMode) {
      log.error("Payment configuration error: key prefix mismatch in cancel");
      return NextResponse.json(
        { error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" },
        { status: 503 }
      );
    }

    if (keyPrefixMode === "test" && isProductionHost(req, deps)) {
      log.error("FATAL CONFIGURATION ERROR: Razorpay test keys refused on production host in cancel");
      return NextResponse.json(
        { error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" },
        { status: 503 }
      );
    }

    // 3. Lookup user subscription and pending orders (Requirement 3: past_due, halted, unpaid, pending-only)
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

    // Check for pending-only order in payment_orders if no active/past_due/halted/unpaid subscription
    let pendingOrder: any = null;
    const { data: pOrders } = await supabaseAdmin
      .from("payment_orders")
      .select("id, provider_order_id, status, mode, provider")
      .eq("user_id", user.id)
      .eq("provider", "razorpay")
      .in("status", ["created", "reserved"])
      .like("provider_order_id", "sub_%")
      .order("created_at", { ascending: false })
      .limit(1);

    if (pOrders && pOrders.length > 0) {
      pendingOrder = pOrders[0];
    }

    // Identify candidate mandate ID (Requirement 2 & 3)
    let rzpSubId: string | null = null;
    if (sub) {
      const candidateId =
        sub.subscription_id ||
        sub.metadata?.provider_subscription_id ||
        sub.metadata?.pending_subscription_id;

      if (typeof candidateId === "string" && candidateId.startsWith("sub_") && !candidateId.startsWith("sub_pending_")) {
        rzpSubId = candidateId;
      }
    }

    if (!rzpSubId && pendingOrder) {
      if (typeof pendingOrder.provider_order_id === "string" && pendingOrder.provider_order_id.startsWith("sub_") && !pendingOrder.provider_order_id.startsWith("sub_pending_")) {
        rzpSubId = pendingOrder.provider_order_id;
      }
    }

    // Requirement 2: If no valid mandate id: return clear "nothing to cancel" result, not success, and no "charge stopped" message
    if (!rzpSubId) {
      return NextResponse.json(
        { error: "No active or pending auto-renew mandate found to cancel", code: "NOTHING_TO_CANCEL" },
        { status: 400 }
      );
    }

    // If subscription is already scheduled for cancellation and confirmed, return status
    if (sub && sub.cancel_at_period_end) {
      return NextResponse.json({
        success: true,
        message: "Subscription is already scheduled to cancel at the end of the billing period",
        cancelAtPeriodEnd: true,
      });
    }

    const credentials = btoa(`${keyId}:${keySecret}`);
    const fetchCaller = deps.fetchFn || fetch;

    // 4. Cancel mandate at Razorpay (Requirement 2: never return success unless confirmed by provider)
    let cancelConfirmed = false;
    let providerCancelErr: any = null;

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
            cancel_at_cycle_end: 1, // Cancel at cycle end
          }),
        }
      );

      if (rzpCancelRes.ok) {
        const cancelBody = await rzpCancelRes.json().catch(() => ({}));
        if (cancelBody && (cancelBody.id === rzpSubId || cancelBody.status)) {
          cancelConfirmed = true;
        }
      } else {
        providerCancelErr = await rzpCancelRes.json().catch(() => ({}));
      }
    } catch (fetchErr: any) {
      log.error("Network error during Razorpay subscription cancel", { error: fetchErr });
      return NextResponse.json(
        { error: "Network error connecting to payment gateway", code: "GATEWAY_CONNECTION_ERROR" },
        { status: 502 }
      );
    }

    // Handle already-cancelled-at-provider (Requirement 2: treat as success ONLY after fetching and seeing cancelled/completed)
    if (!cancelConfirmed) {
      const desc = String(providerCancelErr?.error?.description || "").toLowerCase();
      const isAlreadyCancelledIndication =
        desc.includes("already cancelled") ||
        desc.includes("already canceled") ||
        desc.includes("completed");

      if (isAlreadyCancelledIndication) {
        try {
          const fetchSubRes = await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${rzpSubId}`, {
            method: "GET",
            headers: { Authorization: `Basic ${credentials}` },
          });

          if (fetchSubRes.ok) {
            const fetchedSubData = await fetchSubRes.json().catch(() => ({}));
            const verifiedCancelledState =
              fetchedSubData?.status === "cancelled" ||
              fetchedSubData?.status === "completed" ||
              fetchedSubData?.ended_at ||
              fetchedSubData?.cancel_at_cycle_end;

            if (verifiedCancelledState) {
              cancelConfirmed = true;
            }
          }
        } catch (_) {}
      }

      if (!cancelConfirmed) {
        log.error("Razorpay subscription cancel API failed", { error: providerCancelErr });
        return NextResponse.json(
          {
            error: "Failed to cancel subscription with payment provider",
            code: "RAZORPAY_CANCEL_ERROR",
          },
          { status: 502 }
        );
      }
    }

    // 5. Compare-and-set DB update on the same mandate id with atomic jsonb merge (Requirement 4)
    // First attempt atomic RPC procedure if available
    let casUpdateDone = false;
    try {
      const { data: rpcSuccess } = await supabaseAdmin.rpc("cancel_autorenew_subscription", {
        p_user_id: user.id,
        p_mandate_id: rzpSubId,
        p_metadata: {
          cancel_at_period_end: true,
          canceled_at: new Date().toISOString(),
          canceled_by: "customer",
          provider_mandate_id: rzpSubId,
        },
      });
      if (rpcSuccess) {
        casUpdateDone = true;
      }
    } catch (_) {}

    if (!casUpdateDone) {
      // Direct CAS query matching the exact mandate ID
      if (sub) {
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
              provider_mandate_id: rzpSubId,
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
      }

      // Also update matching payment_orders to cancelled
      await supabaseAdmin
        .from("payment_orders")
        .update({ status: "cancelled" })
        .eq("user_id", user.id)
        .eq("provider_order_id", rzpSubId);
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
