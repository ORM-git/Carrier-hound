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

function checkMandateOwnership(
  entity: any,
  expectedUserId: string
): { matches: boolean; mismatch: boolean; ownerId?: string } {
  const ownerId = entity?.notes?.user_id || entity?.notes?.userId || entity?.customer_id;
  if (!ownerId) {
    return { matches: true, mismatch: false };
  }
  if (ownerId === expectedUserId) {
    return { matches: true, mismatch: false, ownerId };
  }
  return { matches: false, mismatch: true, ownerId };
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

    // Helper: Paginated Provider Mandates Lookup (Issue 1)
    // Paginates through subscriptions?plan_id=... with skip/count until exhausted or match found.
    // Upper bound MAX_PAGES throws/fails closed instead of assuming absent.
    const findProviderMandatesByPlan = async (
      candidateReservationId?: string | null
    ): Promise<{
      activeMatch?: any;
      stoppedMatch?: any;
      lookupFailed?: boolean;
      ownershipMismatch?: boolean;
      paginationExhausted?: boolean;
      error?: string;
    }> => {
      const PAGE_SIZE = 20;
      const MAX_PAGES = 10;
      let skip = 0;
      let pagesFetched = 0;
      let activeMatch: any = null;
      let stoppedMatch: any = null;
      let paginationExhausted = false;

      while (pagesFetched < MAX_PAGES) {
        pagesFetched++;
        let listRes: Response;
        try {
          listRes = await fetchCaller(
            `https://api.razorpay.com/v1/subscriptions?plan_id=${encodeURIComponent(razorpayPlanId.trim())}&count=${PAGE_SIZE}&skip=${skip}`,
            {
              method: "GET",
              headers: { Authorization: `Basic ${credentials}` },
            }
          );
        } catch (err: any) {
          log.error("Network exception listing provider subscriptions mid-pagination", { error: err, skip, pagesFetched });
          return { lookupFailed: true, error: err?.message || "GATEWAY_CONNECTION_ERROR" };
        }

        if (!listRes.ok) {
          log.error("Provider returned non-200 while listing subscriptions mid-pagination", { status: listRes.status, skip });
          return { lookupFailed: true, error: `Provider list returned ${listRes.status}` };
        }

        const listData = await listRes.json().catch(() => ({}));
        const items = Array.isArray(listData?.items) ? listData.items : [];

        for (const item of items) {
          const ownership = checkMandateOwnership(item, user.id);
          const matchesReservation = Boolean(
            candidateReservationId && item?.notes?.reservation_id === candidateReservationId
          );

          if (ownership.mismatch) {
            if (matchesReservation) {
              log.error("Mandate ownership mismatch: reservation matches but owned by different user", {
                entityId: item?.id,
                expectedUserId: user.id,
                actualUserId: ownership.ownerId,
              });
              return { ownershipMismatch: true, error: "MANDATE_OWNERSHIP_MISMATCH" };
            }
            continue;
          }

          if (ownership.matches || matchesReservation) {
            const isStopped =
              (item?.status === "cancelled" || item?.ended_at != null) &&
              item?.cancel_at_cycle_end !== 1 &&
              item?.cancel_at_cycle_end !== true;

            if (!isStopped) {
              activeMatch = item;
              break;
            } else if (!stoppedMatch) {
              stoppedMatch = item;
            }
          }
        }

        if (activeMatch) {
          break;
        }

        if (items.length < PAGE_SIZE) {
          paginationExhausted = true;
          break;
        }

        skip += PAGE_SIZE;
      }

      if (activeMatch) {
        return { activeMatch };
      }

      if (!paginationExhausted) {
        log.error("Provider subscriptions pagination limit reached without exhausting; failing closed", {
          pagesFetched,
          maxPages: MAX_PAGES,
          userId: user.id,
        });
        return { lookupFailed: true, error: "PROVIDER_PAGINATION_LIMIT_EXCEEDED" };
      }

      return { paginationExhausted: true, stoppedMatch };
    };

    // Helper: Reconcile and Verify Pending Mandate with Provider (Requirement 5 & Requirement 6 & Reviewer E)
    const verifyAndReuseCandidateMandate = async (
      candidateId: string,
      _candidatePlanCode: string
    ): Promise<{ ok: true; subData: any } | { ok: false; error: string; status: number } | null> => {
      if (!candidateId || typeof candidateId !== "string" || !candidateId.startsWith("sub_") || candidateId.startsWith("sub_pending_")) {
        return null;
      }

      try {
        const subRes = await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${candidateId}`, {
          method: "GET",
          headers: { Authorization: `Basic ${credentials}` },
        });

        if (!subRes.ok) {
          if (subRes.status === 404) {
            log.info("Candidate mandate does not exist at provider (404); marking expired", { candidateId });
            await supabaseAdmin
              .from("payment_orders")
              .update({ status: "expired" })
              .eq("provider_order_id", candidateId);
            return null;
          }
          // Reviewer E: Non-200 / provider fetch failure must FAIL CLOSED, never skip and recreate!
          log.error("Provider returned non-200 while fetching candidate mandate; failing closed", { candidateId, status: subRes.status });
          return { ok: false, error: "PROVIDER_VERIFICATION_FAILED", status: 502 };
        }

        const subData = await subRes.json();
        const ownership = checkMandateOwnership(subData, user.id);
        if (ownership.mismatch) {
          log.error("Mandate ownership mismatch: candidate mandate does not belong to user", {
            candidateId,
            expectedUserId: user.id,
            actualUserId: ownership.ownerId,
          });
          return { ok: false, error: "MANDATE_OWNERSHIP_MISMATCH", status: 403 };
        }

        const validStatuses = new Set(["created", "authenticated", "active"]);
        if (!validStatuses.has(subData?.status)) {
          log.info("Candidate mandate at provider is not in active/created state; skipping reuse", { candidateId, status: subData?.status });
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

        // Verify age: if created > 24 hours ago, cancel at provider first and verify stopped (Reviewer 4)
        const createdAtSec = subData?.created_at || (subData?.start_at ?? 0);
        const ageMs = createdAtSec > 0 ? Date.now() - createdAtSec * 1000 : 0;
        if (ageMs > EXPIRATION_WINDOW_MS) {
          log.info("Candidate mandate is older than 24 hours; cancelling at provider first", { candidateId });
          let cancelConfirmed = false;
          try {
            const cancelRes = await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${candidateId}/cancel`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Basic ${credentials}` },
              body: JSON.stringify({ cancel_at_cycle_end: 0 }),
            });
            if (cancelRes.ok) {
              const cancelData = await cancelRes.json().catch(() => ({}));
              if (
                cancelData?.id === candidateId &&
                (cancelData?.status === "cancelled" || cancelData?.ended_at != null) &&
                cancelData?.cancel_at_cycle_end !== 1 &&
                cancelData?.cancel_at_cycle_end !== true
              ) {
                cancelConfirmed = true;
              }
            }
          } catch (_) {}

          if (cancelConfirmed) {
            await supabaseAdmin
              .from("payment_orders")
              .update({ status: "expired", updated_at: new Date().toISOString() })
              .eq("provider_order_id", candidateId);
            return null;
          } else {
            // Reviewer 4: On network/non-2xx keep the row protected as unknown
            await supabaseAdmin.rpc("record_subscription_reconciliation", {
              p_user_id: user.id,
              p_provider_subscription_id: candidateId,
              p_reservation_order_id: null,
              p_reconciliation_state: "pending",
              p_failure_reason: "STALE_CANDIDATE_CANCEL_FAILED",
              p_recovery_outcome: "protected_as_unknown",
              p_metadata: { candidateId, status: subData?.status },
            }).catch(() => null);

            await supabaseAdmin
              .from("payment_orders")
              .update({
                status: "unknown",
                updated_at: new Date().toISOString(),
                metadata: {
                  reconciliation_required: true,
                  reconciliation_state: "pending",
                  reason: "stale_candidate_cancel_failed",
                  candidateId,
                },
              })
              .eq("provider_order_id", candidateId);

            return { ok: false, error: "STALE_CANDIDATE_CANCEL_FAILED", status: 502 };
          }
        }

        return { ok: true, subData };
      } catch (subErr) {
        log.error("Network exception checking candidate mandate at provider; failing closed", { candidateId, error: subErr });
        return { ok: false, error: "GATEWAY_CONNECTION_ERROR", status: 502 };
      }
    };

    // Item 1 & 5: Verifies whether an obligation can be safely released.
    // NEVER releases on age alone. Only returns safeToRelease=true if:
    // 1. Provider confirms 404 (mandate does not exist at provider), OR
    // 2. Provider response matches ID AND status is confirmed stopped (status === 'cancelled' or ended_at != null).
    // cancel_at_cycle_end: 1 / true is explicitly NOT stopped!
    const confirmMandateStoppedOrNonexistentAtProvider = async (
      candidateId: string | null | undefined,
      metadataProviderSubId: string | null | undefined
    ): Promise<{
      safeToRelease: boolean;
      matchedId?: string;
      activeMatch?: any;
      lookupFailed?: boolean;
      ownershipMismatch?: boolean;
      error?: string;
    }> => {
      const targetSubId =
        candidateId?.startsWith("sub_") && !candidateId.startsWith("sub_pending_")
          ? candidateId
          : metadataProviderSubId?.startsWith("sub_") && !metadataProviderSubId.startsWith("sub_pending_")
          ? metadataProviderSubId
          : null;

      if (targetSubId) {
        try {
          const getRes = await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${targetSubId}`, {
            method: "GET",
            headers: { Authorization: `Basic ${credentials}` },
          });

          if (getRes.status === 404) {
            return { safeToRelease: true, matchedId: targetSubId };
          }

          if (getRes.ok) {
            const data = await getRes.json().catch(() => ({}));
            if (data?.id === targetSubId) {
              const ownership = checkMandateOwnership(data, user.id);
              if (ownership.mismatch) {
                log.error("Mandate ownership mismatch: target subscription does not belong to user", {
                  targetSubId,
                  expectedUserId: user.id,
                  actualUserId: ownership.ownerId,
                });
                return { safeToRelease: false, matchedId: targetSubId, ownershipMismatch: true };
              }

              if (data.cancel_at_cycle_end === 1 || data.cancel_at_cycle_end === true) {
                return { safeToRelease: false, matchedId: targetSubId, activeMatch: data };
              }
              if (data.status === "cancelled" || data.ended_at != null) {
                return { safeToRelease: true, matchedId: targetSubId };
              }
            }
          } else {
            return { safeToRelease: false, matchedId: targetSubId, lookupFailed: true };
          }

          // Try cancelling at provider
          const cancelRes = await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${targetSubId}/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Basic ${credentials}` },
            body: JSON.stringify({ cancel_at_cycle_end: 0 }),
          });

          if (cancelRes.ok) {
            const cancelData = await cancelRes.json().catch(() => ({}));
            if (
              cancelData?.id === targetSubId &&
              (cancelData?.status === "cancelled" || cancelData?.ended_at != null) &&
              cancelData?.cancel_at_cycle_end !== 1 &&
              cancelData?.cancel_at_cycle_end !== true
            ) {
              return { safeToRelease: true, matchedId: targetSubId };
            }
          }
        } catch (_) {
          return { safeToRelease: false, matchedId: targetSubId, lookupFailed: true };
        }

        return { safeToRelease: false, matchedId: targetSubId };
      }

      // Placeholder reservation: paginated query for subscriptions with plan_id
      const lookup = await findProviderMandatesByPlan(candidateId);
      if (lookup.lookupFailed) {
        return { safeToRelease: false, lookupFailed: true, error: lookup.error };
      }
      if (lookup.ownershipMismatch) {
        return { safeToRelease: false, ownershipMismatch: true };
      }
      if (lookup.activeMatch) {
        return { safeToRelease: false, matchedId: lookup.activeMatch.id, activeMatch: lookup.activeMatch };
      }
      if (lookup.paginationExhausted) {
        return { safeToRelease: true, matchedId: lookup.stoppedMatch?.id };
      }

      return { safeToRelease: false };
    };

    // 8. Stale Order & Lease Reconciliation (Requirement 6 & Reviewer 4)
    const expirationCutoff = new Date(Date.now() - EXPIRATION_WINDOW_MS).toISOString();
    const leaseCutoff = new Date(Date.now() - LEASE_DURATION_MS).toISOString();

    // Query for any stale created orders (> 24h) and reconcile (mode-filtered, recurring-kind only)
    const { data: staleOrders } = await supabaseAdmin
      .from("payment_orders")
      .select("id, provider_order_id, status, metadata")
      .eq("user_id", user.id)
      .eq("provider", "razorpay")
      .eq("mode", resolvedMode)
      .eq("recurring_kind", "recurring")
      .eq("status", "created")
      .lt("created_at", expirationCutoff);

    if (staleOrders && staleOrders.length > 0) {
      for (const st of staleOrders) {
        if (st.provider_order_id?.startsWith("sub_") && !st.provider_order_id.startsWith("sub_pending_")) {
          const providerCheck = await confirmMandateStoppedOrNonexistentAtProvider(
            st.provider_order_id,
            (st as any).metadata?.provider_subscription_id
          );

          if (providerCheck.safeToRelease) {
            await supabaseAdmin
              .from("payment_orders")
              .update({ status: "expired", updated_at: new Date().toISOString() })
              .eq("id", st.id);
          } else {
            // Reviewer 4: On network/non-2xx keep the row protected as unknown
            await supabaseAdmin.rpc("record_subscription_reconciliation", {
              p_user_id: user.id,
              p_provider_subscription_id: providerCheck.matchedId || st.provider_order_id,
              p_reservation_order_id: null,
              p_reconciliation_state: "pending",
              p_failure_reason: "STALE_ORDER_CANCEL_FAILED",
              p_recovery_outcome: "protected_as_unknown",
              p_metadata: { order_id: st.id },
            }).catch(() => null);

            await supabaseAdmin
              .from("payment_orders")
              .update({
                status: "unknown",
                updated_at: new Date().toISOString(),
                metadata: {
                  reconciliation_required: true,
                  reconciliation_state: "pending",
                  reason: "stale_order_cancel_non_200",
                  order_id: st.id,
                },
              })
              .eq("id", st.id);
          }
        }
      }
    }

    // Reconcile expired reservation leases (older than lease duration) - mode and recurring-kind filtered
    // Reviewer 4 & Item 1: Lease expiry must reconcile with provider before releasing; never release on age alone!
    const { data: expiredLeases } = await supabaseAdmin
      .from("payment_orders")
      .select("id, provider_order_id, status, metadata")
      .eq("user_id", user.id)
      .eq("provider", "razorpay")
      .eq("mode", resolvedMode)
      .eq("recurring_kind", "recurring")
      .eq("status", "reserved")
      .lt("created_at", leaseCutoff);

    if (expiredLeases && expiredLeases.length > 0) {
      for (const lease of expiredLeases) {
        const providerCheck = await confirmMandateStoppedOrNonexistentAtProvider(
          lease.provider_order_id,
          (lease as any).metadata?.provider_subscription_id
        );

        if (providerCheck.safeToRelease) {
          await supabaseAdmin
            .from("payment_orders")
            .update({ status: "expired", updated_at: new Date().toISOString() })
            .eq("id", lease.id);
        } else {
          // Keep protected as unknown
          await supabaseAdmin.rpc("record_subscription_reconciliation", {
            p_user_id: user.id,
            p_provider_subscription_id:
              providerCheck.matchedId ||
              (lease.provider_order_id?.startsWith("sub_") && !lease.provider_order_id.startsWith("sub_pending_")
                ? lease.provider_order_id
                : null),
            p_reservation_order_id: lease.provider_order_id,
            p_reconciliation_state: "pending",
            p_failure_reason: "LEASE_EXPIRY_CANCEL_UNVERIFIED",
            p_recovery_outcome: "obligation_kept_as_unknown",
            p_metadata: { plan_code: planCode, mode: resolvedMode },
          }).catch(() => null);

          await supabaseAdmin
            .from("payment_orders")
            .update({
              status: "unknown",
              updated_at: new Date().toISOString(),
              metadata: {
                reconciliation_required: true,
                reconciliation_state: "pending",
                reason: "lease_expiry_cancel_unverified",
              },
            })
            .eq("id", lease.id);
        }
      }
    }

    // 9. Authoritative Pending Reuse Query (Requirement 3 & 5 & Reviewer B)
    const { data: existingPendingOrder, error: pendingOrderErr } = await supabaseAdmin
      .from("payment_orders")
      .select("id, provider_order_id, plan_code, status, created_at, mode, provider")
      .eq("user_id", user.id)
      .eq("provider", "razorpay")
      .eq("mode", resolvedMode)
      .eq("plan_code", planCode)
      .eq("recurring_kind", "recurring")
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
      const verifiedSubRes = await verifyAndReuseCandidateMandate(existingPendingOrder.provider_order_id, planCode);
      if (verifiedSubRes && !verifiedSubRes.ok) {
        return NextResponse.json(
          { error: "Failed to verify existing mandate with payment provider", code: verifiedSubRes.error },
          { status: verifiedSubRes.status }
        );
      }
      if (verifiedSubRes?.ok) {
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
          status: verifiedSubRes.subData.status,
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
      .eq("recurring_kind", "recurring")
      .in("status", ["reserved", "created", "unknown"])
      .neq("plan_code", planCode)
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

      const verifiedMetaRes = await verifyAndReuseCandidateMandate(metadataPendingSubId, planCode);
      if (verifiedMetaRes && !verifiedMetaRes.ok) {
        return NextResponse.json(
          { error: "Failed to verify existing mandate with payment provider", code: verifiedMetaRes.error },
          { status: verifiedMetaRes.status }
        );
      }
      if (verifiedMetaRes?.ok) {
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
          status: verifiedMetaRes.subData.status,
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

      // Reserve pending row in DB with explicit state 'reserved' and recurring_kind (Requirement B & 7)
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
          recurring_kind: "recurring",
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
            .eq("recurring_kind", "recurring")
            .in("status", ["reserved", "created", "unknown"])
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
          // Item 1 & 5: Never release on age alone. In the unique-collision branch, only release after
          // provider confirms no mandate exists (or it is confirmed stopped, matching ID).
          const raceCreatedMs = existingRace.created_at ? new Date(existingRace.created_at).getTime() : 0;
          if (Date.now() - raceCreatedMs > LEASE_DURATION_MS) {
            const providerCheck = await confirmMandateStoppedOrNonexistentAtProvider(
              existingRace.provider_order_id,
              (existingRace as any).metadata?.provider_subscription_id
            );

            if (providerCheck.ownershipMismatch) {
              return NextResponse.json(
                { error: "Mandate does not belong to authenticated user", code: "MANDATE_OWNERSHIP_MISMATCH" },
                { status: 403 }
              );
            }

            if (providerCheck.lookupFailed) {
              return NextResponse.json(
                { error: "Unable to verify existing subscription state with payment provider", code: "GATEWAY_CONNECTION_ERROR" },
                { status: 502 }
              );
            }

            if (providerCheck.activeMatch) {
              await supabaseAdmin.from("payment_orders").update({
                status: "created",
                provider_order_id: providerCheck.activeMatch.id,
                updated_at: new Date().toISOString(),
              }).eq("id", existingRace.id);

              return NextResponse.json({
                subscriptionId: providerCheck.activeMatch.id,
                keyId,
                planId: razorpayPlanId.trim(),
                planCode,
                status: providerCheck.activeMatch.status,
                reused: true,
              });
            }

            if (providerCheck.safeToRelease) {
              log.info("Conflicting reservation lease verified stopped at provider; marking expired for retry recovery", { raceOrderId: existingRace.id });
              await supabaseAdmin.from("payment_orders").update({ status: "expired", updated_at: new Date().toISOString() }).eq("id", existingRace.id);
              // Allow retry on next request
              return NextResponse.json(
                { error: "Previous checkout attempt expired. Please try again.", code: "RESERVATION_LEASE_RECOVERED" },
                { status: 409 }
              );
            } else {
              log.warn("Conflicting reservation could not be verified stopped at provider; keeping protected as unknown", { raceOrderId: existingRace.id });
              await supabaseAdmin.from("payment_orders").update({
                status: "unknown",
                updated_at: new Date().toISOString(),
                metadata: {
                  reconciliation_required: true,
                  reconciliation_state: "pending",
                  reason: "collision_expiry_cancel_unverified",
                },
              }).eq("id", existingRace.id);

              await supabaseAdmin.rpc("record_subscription_reconciliation", {
                p_user_id: user.id,
                p_provider_subscription_id:
                  providerCheck.matchedId ||
                  (existingRace.provider_order_id?.startsWith("sub_") && !existingRace.provider_order_id.startsWith("sub_pending_")
                    ? existingRace.provider_order_id
                    : null),
                p_reservation_order_id: existingRace.provider_order_id,
                p_reconciliation_state: "pending",
                p_failure_reason: "COLLISION_LEASE_UNVERIFIED_STOPPED",
                p_recovery_outcome: "obligation_kept_as_unknown",
                p_metadata: { plan_code: planCode, mode: resolvedMode },
              }).catch(() => null);

              return NextResponse.json(
                {
                  error: "A subscription checkout is already in progress. Please complete the pending payment or try again later.",
                  code: "PENDING_SUBSCRIPTION_EXISTS",
                },
                { status: 409 }
              );
            }
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
            const verifiedSubRes = await verifyAndReuseCandidateMandate(existingRace.provider_order_id, planCode);
            if (verifiedSubRes && !verifiedSubRes.ok) {
              return NextResponse.json(
                { error: "Failed to verify existing mandate with payment provider", code: verifiedSubRes.error },
                { status: verifiedSubRes.status }
              );
            }
            if (verifiedSubRes?.ok) {
              return NextResponse.json({
                subscriptionId: existingRace.provider_order_id,
                keyId,
                planId: razorpayPlanId.trim(),
                planCode,
                status: verifiedSubRes.subData.status,
                reused: true,
              });
            }
          }

          // Check if a mandate was already created at the provider for this pending reservation
          const raceCheck = await findProviderMandatesByPlan(existingRace.provider_order_id);
          if (raceCheck.lookupFailed) {
            return NextResponse.json(
              { error: "Unable to verify existing subscription state with payment provider", code: "GATEWAY_CONNECTION_ERROR" },
              { status: 502 }
            );
          }
          if (raceCheck.ownershipMismatch) {
            return NextResponse.json(
              { error: "Mandate does not belong to authenticated user", code: "MANDATE_OWNERSHIP_MISMATCH" },
              { status: 403 }
            );
          }
          if (raceCheck.activeMatch) {
            await supabaseAdmin.from("payment_orders").update({
              status: "created",
              provider_order_id: raceCheck.activeMatch.id,
              updated_at: new Date().toISOString(),
            }).eq("id", existingRace.id);

            return NextResponse.json({
              subscriptionId: raceCheck.activeMatch.id,
              keyId,
              planId: razorpayPlanId.trim(),
              planCode,
              status: raceCheck.activeMatch.status,
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

      const TOTAL_COUNTS: Record<string, number> = {
        weekly: 52,
        monthly: 12,
        quarterly: 4,
      };
      const totalCount = TOTAL_COUNTS[planCode] ?? 12;

      // Pre-create check: verify if an active mandate already exists at provider
      const existingMandateLookup = await findProviderMandatesByPlan(reservationOrderId);
      if (existingMandateLookup.lookupFailed) {
        log.error("Provider lookup failed while verifying mandates prior to create; failing closed", {
          userId: user.id,
          error: existingMandateLookup.error,
        });
        await supabaseAdmin
          .from("payment_orders")
          .update({
            status: "unknown",
            updated_at: new Date().toISOString(),
            metadata: {
              reconciliation_required: true,
              reconciliation_state: "unknown",
              reason: "provider_lookup_failed_mid_pagination",
              error: existingMandateLookup.error,
              reservation_id: reservationOrderId,
            },
          })
          .eq("provider_order_id", reservationOrderId);

        return NextResponse.json(
          { error: "Failed to verify existing subscriptions with payment provider", code: "GATEWAY_CONNECTION_ERROR" },
          { status: 502 }
        );
      }

      if (existingMandateLookup.ownershipMismatch) {
        return NextResponse.json(
          { error: "Mandate does not belong to authenticated user", code: "MANDATE_OWNERSHIP_MISMATCH" },
          { status: 403 }
        );
      }

      if (existingMandateLookup.activeMatch) {
        const activeSub = existingMandateLookup.activeMatch;
        log.info("Found existing active mandate at provider; reusing without creating duplicate", {
          userId: user.id,
          subscriptionId: activeSub.id,
        });

        await supabaseAdmin
          .from("payment_orders")
          .update({
            status: "created",
            provider_order_id: activeSub.id,
            updated_at: new Date().toISOString(),
            metadata: {
              provider_subscription_id: activeSub.id,
              reused_from_provider_lookup: true,
              reused_at: new Date().toISOString(),
            },
          })
          .eq("provider_order_id", reservationOrderId);

        return NextResponse.json({
          subscriptionId: activeSub.id,
          keyId,
          planId: razorpayPlanId.trim(),
          planCode,
          status: activeSub.status,
          reused: true,
        });
      }

      // 11. Create subscription via Razorpay with attempt tracking notes and idempotency keys
      const mandateNonce = crypto.randomUUID();
      let rzpRes: Response;
      try {
        rzpRes = await fetchCaller("https://api.razorpay.com/v1/subscriptions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${credentials}`,
            "X-Razorpay-Idempotency-Key": reservationOrderId,
            "Idempotency-Key": reservationOrderId,
          },
          body: JSON.stringify({
            plan_id: razorpayPlanId.trim(),
            total_count: totalCount,
            customer_notify: true,
            notes: {
              user_id: user.id,
              userId: user.id,
              email: user.email || "",
              plan_code: planCode,
              attempt_id: attemptId,
              reservation_id: reservationOrderId,
              nonce: mandateNonce,
            },
          }),
        });
      } catch (gatewayErr: any) {
        log.error("Ambiguous create failure: Network exception calling Razorpay subscriptions API", { error: gatewayErr });
        // Requirement E: Unknown create states stay protected until reconciled, with a durable reconciliation record, not a log line
        await supabaseAdmin
          .from("payment_orders")
          .update({
            status: "unknown",
            updated_at: new Date().toISOString(),
            metadata: {
              reconciliation_required: true,
              reconciliation_state: "unknown",
              attempt_id: attemptId,
              reservation_id: reservationOrderId,
              plan_code: planCode,
              mode: resolvedMode,
              error: gatewayErr?.message || String(gatewayErr),
              recorded_at: new Date().toISOString(),
            },
          })
          .eq("provider_order_id", reservationOrderId)
          .eq("user_id", user.id);

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
        log.error("Failed to parse Razorpay subscription response; marking unknown with durable reconciliation record", { error: parseErr });
        await supabaseAdmin
          .from("payment_orders")
          .update({
            status: "unknown",
            updated_at: new Date().toISOString(),
            metadata: {
              reconciliation_required: true,
              reconciliation_state: "unknown",
              attempt_id: attemptId,
              reservation_id: reservationOrderId,
              plan_code: planCode,
              mode: resolvedMode,
              error: parseErr?.message || String(parseErr),
              recorded_at: new Date().toISOString(),
            },
          })
          .eq("provider_order_id", reservationOrderId)
          .eq("user_id", user.id);

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
        let cancelConfirmed = false;

        if (subscriptionData?.id && typeof subscriptionData.id === "string" && subscriptionData.id.startsWith("sub_")) {
          try {
            const cancelRes = await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${subscriptionData.id}/cancel`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Basic ${credentials}` },
              body: JSON.stringify({ cancel_at_cycle_end: 0 }),
            });
            if (cancelRes.ok) {
              const cancelData = await cancelRes.json().catch(() => ({}));
              if (
                cancelData?.id === subscriptionData.id &&
                (cancelData?.status === "cancelled" || cancelData?.ended_at != null) &&
                cancelData?.cancel_at_cycle_end !== 1 &&
                cancelData?.cancel_at_cycle_end !== true
              ) {
                cancelConfirmed = true;
              }
            }
          } catch (_) {}
        } else {
          cancelConfirmed = true;
        }

        if (cancelConfirmed) {
          await supabaseAdmin.rpc("record_subscription_reconciliation", {
            p_user_id: user.id,
            p_provider_subscription_id: subscriptionData?.id || null,
            p_reservation_order_id: reservationOrderId,
            p_reconciliation_state: "resolved",
            p_failure_reason: "INVALID_SUBSCRIPTION_DATA",
            p_recovery_outcome: "cancelled_invalid_data",
            p_metadata: { plan_code: planCode, mode: resolvedMode },
          }).catch(() => null);

          await supabaseAdmin
            .from("payment_orders")
            .update({ status: "failed", updated_at: new Date().toISOString() })
            .eq("provider_order_id", reservationOrderId);
        } else {
          // Reviewer 5: Invalid-ID or boundary failures must keep the obligation until verified stopped
          await supabaseAdmin.rpc("record_subscription_reconciliation", {
            p_user_id: user.id,
            p_provider_subscription_id: subscriptionData?.id || null,
            p_reservation_order_id: reservationOrderId,
            p_reconciliation_state: "pending",
            p_failure_reason: "INVALID_SUBSCRIPTION_DATA_CANCEL_UNVERIFIED",
            p_recovery_outcome: "obligation_kept_as_unknown",
            p_metadata: { plan_code: planCode, mode: resolvedMode },
          }).catch(() => null);

          await supabaseAdmin
            .from("payment_orders")
            .update({
              status: "unknown",
              provider_order_id: subscriptionData.id,
              updated_at: new Date().toISOString(),
              metadata: {
                reconciliation_required: true,
                reconciliation_state: "pending",
                error: "Invalid subscription details and cancel unverified",
              },
            })
            .eq("provider_order_id", reservationOrderId);
        }

        return NextResponse.json(
          { error: "Invalid subscription details received from provider", code: "GATEWAY_RESPONSE_INVALID" },
          { status: 502 }
        );
      }

      // 12. Requirement F: Reservation completion needs status/lease/owner compare-and-swap, no JS-merged metadata overwrite
      const { data: updatedOrders, error: updateOrderErr } = await supabaseAdmin
        .from("payment_orders")
        .update({
          provider_order_id: subscriptionData.id,
          status: "created",
          updated_at: new Date().toISOString(),
        })
        .eq("provider_order_id", reservationOrderId)
        .eq("user_id", user.id)
        .eq("status", "reserved")
        .gte("created_at", leaseCutoff)
        .select("id, provider_order_id, status");

      if (
        updateOrderErr ||
        !updatedOrders ||
        updatedOrders.length !== 1 ||
        updatedOrders[0].provider_order_id !== subscriptionData.id
      ) {
        log.error("Failed to complete reservation via status/lease/owner CAS; cancelling mandate at provider", {
          error: updateOrderErr,
          subscriptionId: subscriptionData.id,
          affectedCount: updatedOrders?.length ?? 0,
        });

        // Cancel mandate at provider to prevent orphan
        let cancelConfirmed = false;
        try {
          const cancelRes = await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${subscriptionData.id}/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Basic ${credentials}` },
            body: JSON.stringify({ cancel_at_cycle_end: 0 }),
          });
          if (cancelRes.ok) {
            const cancelData = await cancelRes.json().catch(() => ({}));
            if (
              cancelData?.id === subscriptionData.id &&
              (cancelData?.status === "cancelled" || cancelData?.ended_at != null) &&
              cancelData?.cancel_at_cycle_end !== 1 &&
              cancelData?.cancel_at_cycle_end !== true
            ) {
              cancelConfirmed = true;
            }
          }
        } catch (cancelErr) {
          log.error("Exception during orphan mandate cancellation", { error: cancelErr });
        }

        const recoveryOutcome = cancelConfirmed
          ? "cancelled_at_provider_cas_preempted"
          : "provider_cancel_failed_needs_reconciliation";
        const reconciliationState = cancelConfirmed ? "resolved" : "pending";

        // Reviewer 5: After a CAS failure persist the provider subscription ID and the recovery outcome
        await supabaseAdmin.rpc("record_subscription_reconciliation", {
          p_user_id: user.id,
          p_provider_subscription_id: subscriptionData.id,
          p_reservation_order_id: reservationOrderId,
          p_reconciliation_state: reconciliationState,
          p_failure_reason: "CAS_PREEMPTED_OR_LEASE_EXPIRED",
          p_recovery_outcome: recoveryOutcome,
          p_metadata: {
            plan_code: planCode,
            mode: resolvedMode,
            error: updateOrderErr?.message || "Affected rows is not 1",
            subscription_data: subscriptionData,
          },
        }).catch(() => null);

        if (!cancelConfirmed) {
          await supabaseAdmin
            .from("payment_orders")
            .update({
              status: "unknown",
              provider_order_id: subscriptionData.id,
              updated_at: new Date().toISOString(),
              metadata: {
                reconciliation_required: true,
                reconciliation_state: "pending",
                attempt_id: attemptId,
                reservation_id: reservationOrderId,
                provider_subscription_id: subscriptionData.id,
                plan_code: planCode,
                mode: resolvedMode,
                error: "CAS preempted and provider cancel failed",
              },
            })
            .eq("provider_order_id", reservationOrderId)
            .eq("user_id", user.id);
        }

        return NextResponse.json(
          { error: "Reservation lease expired or was preempted", code: "RESERVATION_CAS_FAILED" },
          { status: 409 }
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
        let cancelConfirmed = false;
        try {
          const cancelRes = await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${subscriptionData.id}/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Basic ${credentials}` },
            body: JSON.stringify({ cancel_at_cycle_end: 0 }),
          });
          if (cancelRes.ok) {
            const cancelData = await cancelRes.json().catch(() => ({}));
            if (
              cancelData?.id === subscriptionData.id &&
              (cancelData?.status === "cancelled" || cancelData?.ended_at != null) &&
              cancelData?.cancel_at_cycle_end !== 1 &&
              cancelData?.cancel_at_cycle_end !== true
            ) {
              cancelConfirmed = true;
            }
          }
        } catch (_) {}

        if (cancelConfirmed) {
          await supabaseAdmin.rpc("record_subscription_reconciliation", {
            p_user_id: user.id,
            p_provider_subscription_id: subscriptionData.id,
            p_reservation_order_id: reservationOrderId,
            p_reconciliation_state: "resolved",
            p_failure_reason: "MISSING_PROVIDER_PERIOD",
            p_recovery_outcome: "cancelled_at_provider_invalid_boundary",
            p_metadata: { plan_code: planCode, mode: resolvedMode },
          }).catch(() => null);

          await supabaseAdmin
            .from("payment_orders")
            .update({ status: "failed", updated_at: new Date().toISOString() })
            .eq("provider_order_id", subscriptionData.id);
        } else {
          // Reviewer 5: Boundary failures must keep the obligation until verified stopped
          await supabaseAdmin.rpc("record_subscription_reconciliation", {
            p_user_id: user.id,
            p_provider_subscription_id: subscriptionData.id,
            p_reservation_order_id: reservationOrderId,
            p_reconciliation_state: "pending",
            p_failure_reason: "MISSING_PROVIDER_PERIOD_CANCEL_FAILED",
            p_recovery_outcome: "provider_cancel_failed_obligation_kept",
            p_metadata: { plan_code: planCode, mode: resolvedMode },
          }).catch(() => null);

          await supabaseAdmin
            .from("payment_orders")
            .update({
              status: "unknown",
              updated_at: new Date().toISOString(),
              metadata: {
                reconciliation_required: true,
                reconciliation_state: "pending",
                error: "Missing period boundaries and cancel failed",
              },
            })
            .eq("provider_order_id", subscriptionData.id);
        }

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

      // Reviewer 7: Persist provider period bounds in payment_orders.metadata for brand-new and existing subscriptions
      const orderMetadata = {
        provider_current_start: providerCurrentStart,
        provider_current_end: providerCurrentEnd,
        provider_charge_at: providerChargeAt,
        provider_customer_id: subscriptionData.customer_id || null,
        provider_subscription_id: subscriptionData.id,
        nonce: mandateNonce,
        verified_amount_paise: verifiedAmount,
        verified_currency: verifiedCurrency,
        verified_period: verifiedPeriod,
        verified_interval: verifiedInterval,
        plan_code: planCode,
        mode: resolvedMode,
        attempt_id: attemptId,
        reservation_id: reservationOrderId,
      };

      const { error: updateOrderMetaErr } = await supabaseAdmin
        .from("payment_orders")
        .update({
          metadata: orderMetadata,
          updated_at: new Date().toISOString(),
        })
        .eq("provider_order_id", subscriptionData.id);

      // Reviewer 6: Replace JS-merged existingSub.metadata write with a transactional JSON merge (jsonb || in SQL)
      let mergeSubErr: any = null;
      if (existingSub) {
        const pendingMetadata = {
          pending_subscription_id: subscriptionData.id,
          pending_plan_code: planCode,
          pending_mode: resolvedMode,
          pending_created_at: new Date().toISOString(),
          provider_current_start: providerCurrentStart,
          provider_current_end: providerCurrentEnd,
          provider_charge_at: providerChargeAt,
          provider_customer_id: subscriptionData.customer_id || null,
          nonce: mandateNonce,
          verified_amount_paise: verifiedAmount,
          verified_currency: verifiedCurrency,
          verified_period: verifiedPeriod,
          verified_interval: verifiedInterval,
        };

        const { error } = await supabaseAdmin.rpc("merge_subscription_metadata", {
          p_user_id: user.id,
          p_metadata: pendingMetadata,
        });
        mergeSubErr = error;
      }

      // Item 6: Do not return checkout success if period or mandate metadata write fails.
      // Surface error and keep order unreleased.
      if (updateOrderMetaErr || mergeSubErr) {
        const metaErr = updateOrderMetaErr || mergeSubErr;
        log.error("Failed to persist period or mandate metadata; failing closed", { error: metaErr });

        const failedOrderMetadata = Object.assign({}, orderMetadata, {
          reconciliation_required: true,
          reconciliation_state: "pending",
          error: metaErr?.message || String(metaErr),
        });

        await supabaseAdmin
          .from("payment_orders")
          .update({
            status: "unknown",
            updated_at: new Date().toISOString(),
            metadata: failedOrderMetadata,
          })
          .eq("provider_order_id", subscriptionData.id);

        await supabaseAdmin.rpc("record_subscription_reconciliation", {
          p_user_id: user.id,
          p_provider_subscription_id: subscriptionData.id,
          p_reservation_order_id: reservationOrderId,
          p_reconciliation_state: "pending",
          p_failure_reason: "METADATA_WRITE_FAILED",
          p_recovery_outcome: "order_kept_unreleased_unknown",
          p_metadata: { error: metaErr?.message || String(metaErr) },
        }).catch(() => null);

        return NextResponse.json(
          { error: "Failed to persist subscription metadata. Please try again.", code: "METADATA_WRITE_FAILED" },
          { status: 500 }
        );
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
    // Item 2: Make DELETE also find "unknown" rows
    let pendingOrder: any = null;
    const { data: pOrders } = await supabaseAdmin
      .from("payment_orders")
      .select("id, provider_order_id, status, mode, provider, metadata")
      .eq("user_id", user.id)
      .eq("provider", "razorpay")
      .in("status", ["created", "reserved", "unknown"])
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
      const candidatePendingId =
        (typeof pendingOrder.provider_order_id === "string" &&
        pendingOrder.provider_order_id.startsWith("sub_") &&
        !pendingOrder.provider_order_id.startsWith("sub_pending_")
          ? pendingOrder.provider_order_id
          : null) ||
        (typeof pendingOrder.metadata?.provider_subscription_id === "string" &&
        pendingOrder.metadata.provider_subscription_id.startsWith("sub_") &&
        !pendingOrder.metadata.provider_subscription_id.startsWith("sub_pending_")
          ? pendingOrder.metadata.provider_subscription_id
          : null);

      if (candidatePendingId) {
        rzpSubId = candidatePendingId;
      }
    }

    // Requirement 2: If no valid mandate id: return clear "nothing to cancel" result, not success, and no "charge stopped" message
    if (!rzpSubId) {
      return NextResponse.json(
        { error: "No active or pending auto-renew mandate found to cancel", code: "NOTHING_TO_CANCEL" },
        { status: 400 }
      );
    }

    const credentials = btoa(`${keyId}:${keySecret}`);
    const fetchCaller = deps.fetchFn || fetch;

    // 4. Pre-flight verify ownership and stopped status with provider before cancel (Issue 1)
    let cancelConfirmed = false;
    let providerCancelErr: any = null;

    try {
      const fetchSubRes = await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${rzpSubId}`, {
        method: "GET",
        headers: { Authorization: `Basic ${credentials}` },
      });

      if (!fetchSubRes.ok) {
        if (fetchSubRes.status === 404) {
          log.info("Subscription to cancel does not exist at provider (404)", { rzpSubId });
          return NextResponse.json(
            { error: "No active or pending auto-renew mandate found to cancel", code: "NOTHING_TO_CANCEL" },
            { status: 400 }
          );
        }
        log.error("Failed to verify mandate at provider before cancel; failing closed", { rzpSubId, status: fetchSubRes.status });
        return NextResponse.json(
          { error: "Failed to verify mandate with payment provider", code: "GATEWAY_CONNECTION_ERROR" },
          { status: 502 }
        );
      }

      const subData = await fetchSubRes.json().catch(() => ({}));
      const ownership = checkMandateOwnership(subData, user.id);
      if (ownership.mismatch) {
        log.error("Mandate ownership mismatch on cancellation: subscription does not belong to user", {
          subscriptionId: rzpSubId,
          expectedUserId: user.id,
          actualUserId: ownership.ownerId,
        });
        return NextResponse.json(
          { error: "Mandate does not belong to authenticated user", code: "MANDATE_OWNERSHIP_MISMATCH" },
          { status: 403 }
        );
      }

      const alreadyStopped =
        subData &&
        subData.id === rzpSubId &&
        (subData.status === "cancelled" ||
          subData.status === "completed" ||
          subData.ended_at != null ||
          subData.cancel_at_cycle_end === 1 ||
          subData.cancel_at_cycle_end === true);

      if (alreadyStopped) {
        cancelConfirmed = true;
      }
    } catch (preCheckErr: any) {
      log.error("Network error during pre-cancel mandate verification", { error: preCheckErr });
      return NextResponse.json(
        { error: "Network error connecting to payment gateway", code: "GATEWAY_CONNECTION_ERROR" },
        { status: 502 }
      );
    }

    // Cancel mandate at Razorpay (Requirement 2: never return success unless confirmed by provider)
    if (!cancelConfirmed) {
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
          const confirmedStopped =
            cancelBody &&
            cancelBody.id === rzpSubId &&
            (cancelBody.status === "cancelled" ||
              cancelBody.cancel_at_cycle_end === 1 ||
              cancelBody.cancel_at_cycle_end === true ||
              cancelBody.ended_at != null);

          if (confirmedStopped) {
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
    }

    // Handle already-cancelled-at-provider (Requirement 2 & D: treat as success ONLY after fetching and seeing confirmed stopped charge)
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
              fetchedSubData &&
              fetchedSubData.id === rzpSubId &&
              (fetchedSubData.status === "cancelled" ||
                fetchedSubData.status === "completed" ||
                fetchedSubData.ended_at != null ||
                fetchedSubData.cancel_at_cycle_end === 1 ||
                fetchedSubData.cancel_at_cycle_end === true);

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

    // 5. Compare-and-set DB update on the same mandate id via cancel_autorenew_subscription RPC only (Requirement D)
    const { data: rpcSuccess, error: rpcErr } = await supabaseAdmin.rpc("cancel_autorenew_subscription", {
      p_user_id: user.id,
      p_mandate_id: rzpSubId,
      p_metadata: {
        cancel_at_period_end: true,
        canceled_at: new Date().toISOString(),
        canceled_by: "customer",
        provider_mandate_id: rzpSubId,
      },
    });

    if (rpcErr || !rpcSuccess) {
      log.error("Failed to cancel subscription in DB via cancel_autorenew_subscription RPC", { error: rpcErr });
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
