import { createClient } from "@supabase/supabase-js";
import { getRazorpayKeyMode } from "../../src/lib/billing/mode";
import { verifyUserNotBanned } from "../../src/lib/admin/auth";
import { singleFlight } from "../../src/lib/cache/singleFlight";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { safeLog } from "./_logger";

const CORS_OPTIONS = {
  allowedMethods: "POST, DELETE, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

export interface BillingSubscriptionDeps {
  getSupabaseAdmin?: () => any;
  verifyUserNotBanned?: (supabaseAdmin: any, userId: string, metadata?: any) => Promise<any>;
  getServerEntitlement?: (userId: string) => Promise<any>;
  fetchFn?: typeof fetch;
  isProductionHost?: boolean;
}

function isProductionHost(event: any, deps?: BillingSubscriptionDeps): boolean {
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

  const headers = event?.headers || {};

  // 1. Canonical Host header
  const hostHeader = headers.host || headers.Host;
  if (hostHeader) {
    const parts = hostHeader.split(",");
    for (const part of parts) {
      if (matchesProd(part)) return true;
    }
  }

  // 2. Canonical request rawUrl
  if (event?.rawUrl) {
    try {
      const url = new URL(event.rawUrl);
      if (matchesProd(url.hostname) || matchesProd(url.host)) return true;
    } catch {
      // ignore
    }
  }

  // 3. Forwarded host headers
  const xForwardedHost = headers["x-forwarded-host"] || headers["X-Forwarded-Host"];
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

function getDefaultSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase service configuration missing");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

export function createHandler(deps: BillingSubscriptionDeps = {}) {
  const adminGetter = deps.getSupabaseAdmin || getDefaultSupabaseAdmin;
  const fetchCaller = deps.fetchFn || fetch;

  return async function handler(event: any) {
    const preflight = handleCorsPreflight(event, CORS_OPTIONS);
    if (preflight) return preflight;

    const headers = {
      "Content-Type": "application/json",
      ...buildCorsHeaders(event, CORS_OPTIONS),
    };

    if (event.httpMethod !== "POST" && event.httpMethod !== "DELETE") {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    try {
      let body: any = {};
      if (event.body) {
        try {
          body = JSON.parse(event.body);
        } catch {
          body = {};
        }
      }

      const isCancelAction = event.httpMethod === "DELETE" || body?.action === "cancel";

      // 1. Feature Flag Check
      if (!isCancelAction && process.env.NEXT_PUBLIC_AUTORENEW_ENABLED !== "true") {
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "Auto-renew subscriptions are currently unavailable",
            code: "AUTORENEW_DISABLED",
          }),
        };
      }

      // Base billing enabled flag check (cancellation remains permitted even if billing is disabled)
      if (!isCancelAction && process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") {
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "Billing is currently unavailable",
            code: "BILLING_DISABLED",
          }),
        };
      }

      // 2. Authentication: requires valid Bearer token
      const authHeader =
        event.headers?.authorization ||
        event.headers?.Authorization ||
        event.headers?.AUTHORIZATION;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ error: "Missing or invalid authorization header" }),
        };
      }

      const token = authHeader.replace("Bearer ", "").trim();
      let supabaseAdmin: any;
      try {
        supabaseAdmin = adminGetter();
      } catch (adminErr: any) {
        safeLog.error("[Netlify /billing-razorpay-subscription] Supabase init error:", adminErr);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: "Supabase service configuration missing" }),
        };
      }

      const {
        data: { user },
        error: userError,
      } = await supabaseAdmin.auth.getUser(token);

      if (userError || !user) {
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ error: "Invalid user session token" }),
        };
      }

      // 3. Server-authoritative mode & key validation
      const configuredMode = process.env.RAZORPAY_MODE;
      if (configuredMode !== "test" && configuredMode !== "live") {
        safeLog.error("[Netlify /billing-razorpay-subscription] Payment configuration error: invalid or missing mode");
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({ error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" }),
        };
      }

      const keyId =
        process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ||
        process.env.RAZORPAY_KEY_ID;
      const keySecret = process.env.RAZORPAY_KEY_SECRET;

      if (!keyId || !keySecret) {
        safeLog.error("[Netlify /billing-razorpay-subscription] Payment configuration error: missing Razorpay credentials");
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({ error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" }),
        };
      }

      const keyPrefixMode = getRazorpayKeyMode(keyId);
      if (!keyPrefixMode) {
        safeLog.error("[Netlify /billing-razorpay-subscription] Payment configuration error: unrecognized key prefix");
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({ error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" }),
        };
      }

      if (keyPrefixMode !== configuredMode) {
        safeLog.error("[Netlify /billing-razorpay-subscription] Payment configuration error: key prefix does not match configured mode");
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({ error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" }),
        };
      }

      const resolvedMode = keyPrefixMode;

      if (keyPrefixMode === "test" && isProductionHost(event, deps)) {
        safeLog.error("[Netlify /billing-razorpay-subscription] FATAL CONFIGURATION ERROR: Razorpay test keys refused on production host");
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({ error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" }),
        };
      }

      const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

      // =========================================================================
      // CANCELLATION FLOW (DELETE or action=cancel)
      // =========================================================================
      if (isCancelAction) {
        // Query subscription (covers active, trialing, in_grace_period, past_due, halted, unpaid)
        const { data: sub, error: subErr } = await supabaseAdmin
          .from("subscriptions")
          .select("id, user_id, provider, subscription_id, status, current_period_end, cancel_at_period_end, metadata")
          .eq("user_id", user.id)
          .maybeSingle();

        if (subErr) {
          safeLog.error("[Netlify /billing-razorpay-subscription] Failed to query subscription for cancellation; failing closed:", subErr);
          return {
            statusCode: 503,
            headers,
            body: JSON.stringify({
              error: "Unable to verify subscription state. Please try again later.",
              code: "SERVICE_UNAVAILABLE",
            }),
          };
        }

        // Check for pending-only order in payment_orders
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

        // Identify candidate mandate ID
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
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: "No active or pending auto-renew mandate found to cancel",
              code: "NOTHING_TO_CANCEL",
            }),
          };
        }

        // If already scheduled for cancellation and confirmed, return status
        if (sub && sub.cancel_at_period_end) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              success: true,
              message: "Subscription is already scheduled to cancel at the end of the billing period",
              cancelAtPeriodEnd: true,
            }),
          };
        }

        // Cancel mandate at Razorpay (Requirement 2)
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
                cancel_at_cycle_end: 1,
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
          safeLog.error("[Netlify /billing-razorpay-subscription] Network error during Razorpay subscription cancel:", fetchErr);
          return {
            statusCode: 502,
            headers,
            body: JSON.stringify({
              error: "Network error connecting to payment gateway",
              code: "GATEWAY_CONNECTION_ERROR",
            }),
          };
        }

        // Handle already-cancelled-at-provider (Requirement 2: verify at provider)
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
            safeLog.error("[Netlify /billing-razorpay-subscription] Razorpay subscription cancel API failed:", providerCancelErr);
            return {
              statusCode: 502,
              headers,
              body: JSON.stringify({
                error: providerCancelErr?.error?.description || "Failed to cancel subscription with payment provider",
                code: "RAZORPAY_CANCEL_ERROR",
              }),
            };
          }
        }

        // Compare-and-set DB update on the same mandate id via cancel_autorenew_subscription RPC only (Requirement D)
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
          safeLog.error("[Netlify /billing-razorpay-subscription] Failed to cancel subscription in DB via cancel_autorenew_subscription RPC:", rpcErr);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
              error: "Failed to update subscription status in database",
              code: "DATABASE_ERROR",
            }),
          };
        }

        safeLog.info(
          "[Netlify /billing-razorpay-subscription] Customer subscription successfully scheduled for cancellation at period end:",
          JSON.stringify({ userId: user.id, subscriptionId: rzpSubId })
        );

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            message: "Subscription auto-renew canceled. You retain Pro access until the end of your billing cycle.",
            cancelAtPeriodEnd: true,
          }),
        };
      }

      // =========================================================================
      // CHECKOUT / MANDATE CREATION FLOW (POST)
      // =========================================================================
      const planCode = body?.planCode;
      if (planCode !== "weekly" && planCode !== "monthly" && planCode !== "quarterly") {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Invalid plan code: must be one of weekly, monthly, quarterly",
          }),
        };
      }

      // Fail-closed server ban check
      const banChecker = deps.verifyUserNotBanned || verifyUserNotBanned;
      const banCheck = await banChecker(supabaseAdmin, user.id, user.user_metadata);
      if (banCheck?.isBlocked) {
        return {
          statusCode: banCheck.isServiceUnavailable ? 503 : 403,
          headers,
          body: JSON.stringify({
            error: banCheck.error || "Account suspended. Access revoked by administrator.",
            code: "USER_BLOCKED",
          }),
        };
      }

      let razorpayPlanId: string | undefined;
      if (planCode === "weekly") {
        razorpayPlanId = process.env.RAZORPAY_AUTORENEW_PLAN_WEEKLY;
      } else if (planCode === "monthly") {
        razorpayPlanId = process.env.RAZORPAY_AUTORENEW_PLAN_MONTHLY;
      } else if (planCode === "quarterly") {
        razorpayPlanId = process.env.RAZORPAY_AUTORENEW_PLAN_QUARTERLY;
      }

      if (!razorpayPlanId || typeof razorpayPlanId !== "string" || !razorpayPlanId.trim()) {
        safeLog.error("[Netlify /billing-razorpay-subscription] Payment configuration error: missing Razorpay plan ID for planCode:", planCode);
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({ error: "Payment configuration error", code: "RAZORPAY_CONFIG_ERROR" }),
        };
      }
      const activeRazorpayPlanId: string = razorpayPlanId.trim();

      // Check if user already has an active plan
      const { data: existingSub, error: selectErr } = await supabaseAdmin
        .from("subscriptions")
        .select("id, status, plan_id, subscription_id, current_period_end, grace_period_end, metadata")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (selectErr) {
        safeLog.error("[Netlify /billing-razorpay-subscription] Subscription lookup error during pre-check; failing closed:", selectErr);
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "Unable to verify subscription state. Please try again later.",
            code: "SERVICE_UNAVAILABLE",
          }),
        };
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
          safeLog.error("[Netlify /billing-razorpay-subscription] Entitlement lookup failed; failing closed:", entErr);
          return {
            statusCode: 503,
            headers,
            body: JSON.stringify({
              error: "Unable to verify subscription state. Please try again later.",
              code: "SERVICE_UNAVAILABLE",
            }),
          };
        }
      }

      if (hasActivePlan) {
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({
            error: "You already have an active subscription plan. Please manage your existing subscription in account settings.",
            code: "ACTIVE_PLAN_EXISTS",
          }),
        };
      }

      // Helper: Verify Plan with Provider (Requirement 1 & 5)
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
            safeLog.error("[Netlify /billing-razorpay-subscription] Razorpay plan fetch returned non-200:", { status: planRes.status, err });
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
            safeLog.error("[Netlify /billing-razorpay-subscription] Provider plan verification mismatch:", {
              expectedPlan,
              verifiedAmount,
              verifiedCurrency,
              verifiedPeriod,
              verifiedInterval,
            });
            return { ok: false, error: "PLAN_VERIFICATION_MISMATCH" };
          }

          return { ok: true, planData: { verifiedAmount, verifiedCurrency, verifiedPeriod, verifiedInterval } };
        } catch (e: any) {
          safeLog.error("[Netlify /billing-razorpay-subscription] Exception verifying plan with provider:", e);
          return { ok: false, error: "PLAN_VERIFICATION_FAILED" };
        }
      };

      // Verify current plan upfront (Requirement 1)
      const planVerifyRes = await verifyPlanWithProvider(activeRazorpayPlanId, planCode);
      if (!planVerifyRes.ok) {
        return {
          statusCode: 502,
          headers,
          body: JSON.stringify({
            error: planVerifyRes.error === "PLAN_VERIFICATION_MISMATCH"
              ? `Provider plan details do not match ${planCode} plan requirements`
              : "Failed to verify plan with payment provider",
            code: planVerifyRes.error || "PLAN_VERIFICATION_FAILED",
          }),
        };
      }
      const { verifiedAmount, verifiedCurrency, verifiedPeriod, verifiedInterval } = planVerifyRes.planData;

      // Helper: Verify and Reuse Candidate Mandate (Requirement 5 & 6 & Reviewer E)
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
              safeLog.info("Candidate mandate does not exist at provider (404); marking expired", JSON.stringify({ candidateId }));
              await supabaseAdmin
                .from("payment_orders")
                .update({ status: "expired" })
                .eq("provider_order_id", candidateId);
              return null;
            }
            safeLog.error("Provider returned non-200 while fetching candidate mandate; failing closed", { candidateId, status: subRes.status });
            return { ok: false, error: "PROVIDER_VERIFICATION_FAILED", status: 502 };
          }

          const subData = await subRes.json();
          const validStatuses = new Set(["created", "authenticated", "active"]);
          if (!validStatuses.has(subData?.status)) {
            await supabaseAdmin
              .from("payment_orders")
              .update({ status: "expired" })
              .eq("provider_order_id", candidateId);
            return null;
          }

          if (subData?.plan_id !== activeRazorpayPlanId) {
            return null;
          }

          const createdAtSec = subData?.created_at || (subData?.start_at ?? 0);
          const ageMs = createdAtSec > 0 ? Date.now() - createdAtSec * 1000 : 0;
          if (ageMs > EXPIRATION_WINDOW_MS) {
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

          return { ok: true, subData };
        } catch (subErr) {
          safeLog.error("Network exception checking candidate mandate at provider; failing closed", { candidateId, error: subErr });
          return { ok: false, error: "GATEWAY_CONNECTION_ERROR", status: 502 };
        }
      };

      // Stale Order & Lease Reconciliation (Requirement 6 & Reviewer E)
      const expirationCutoff = new Date(Date.now() - EXPIRATION_WINDOW_MS).toISOString();
      const leaseCutoff = new Date(Date.now() - LEASE_DURATION_MS).toISOString();

      const { data: staleOrders } = await supabaseAdmin
        .from("payment_orders")
        .select("id, provider_order_id, status")
        .eq("user_id", user.id)
        .eq("provider", "razorpay")
        .eq("mode", resolvedMode)
        .eq("recurring_kind", "recurring")
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

      await supabaseAdmin
        .from("payment_orders")
        .update({ status: "expired" })
        .eq("user_id", user.id)
        .eq("provider", "razorpay")
        .eq("mode", resolvedMode)
        .eq("recurring_kind", "recurring")
        .eq("status", "reserved")
        .lt("created_at", leaseCutoff);

      // Authoritative Pending Reuse Query (Requirement 3 & 5 & Reviewer B)
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
        safeLog.error("[Netlify /billing-razorpay-subscription] Authoritative pending query failed; failing closed:", pendingOrderErr);
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "Unable to verify pending subscription state. Please try again later.",
            code: "SERVICE_UNAVAILABLE",
          }),
        };
      }

      if (
        existingPendingOrder &&
        typeof existingPendingOrder.provider_order_id === "string" &&
        existingPendingOrder.provider_order_id.startsWith("sub_") &&
        !existingPendingOrder.provider_order_id.startsWith("sub_pending_")
      ) {
        const verifiedSubRes = await verifyAndReuseCandidateMandate(existingPendingOrder.provider_order_id, planCode);
        if (verifiedSubRes && !verifiedSubRes.ok) {
          return {
            statusCode: verifiedSubRes.status,
            headers,
            body: JSON.stringify({
              error: "Failed to verify existing mandate with payment provider",
              code: verifiedSubRes.error,
            }),
          };
        }
        if (verifiedSubRes?.ok) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              subscriptionId: existingPendingOrder.provider_order_id,
              keyId,
              planId: razorpayPlanId.trim(),
              planCode,
              status: verifiedSubRes.subData.status,
              reused: true,
            }),
          };
        }
      }

      // Check for pending orders of different plans
      const { data: otherPendingOrder, error: otherPendingErr } = await supabaseAdmin
        .from("payment_orders")
        .select("id, plan_code, provider_order_id")
        .eq("user_id", user.id)
        .eq("provider", "razorpay")
        .eq("mode", resolvedMode)
        .eq("recurring_kind", "recurring")
        .eq("status", "created")
        .neq("plan_code", planCode)
        .like("provider_order_id", "sub_%")
        .gte("created_at", expirationCutoff)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (otherPendingErr) {
        safeLog.error("[Netlify /billing-razorpay-subscription] Authoritative other pending plans query failed:", otherPendingErr);
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "Unable to verify pending subscription state. Please try again later.",
            code: "SERVICE_UNAVAILABLE",
          }),
        };
      }

      if (otherPendingOrder) {
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({
            error: `A checkout is already pending for another plan (${otherPendingOrder.plan_code}). Please complete or cancel that checkout first.`,
            code: "PENDING_SUBSCRIPTION_EXISTS",
          }),
        };
      }

      // Metadata candidate verification
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
          return {
            statusCode: 409,
            headers,
            body: JSON.stringify({
              error: `A subscription checkout is already pending for another plan (${metadataPendingPlan}). Please complete or cancel that checkout first.`,
              code: "PENDING_SUBSCRIPTION_EXISTS",
            }),
          };
        }

        const verifiedMetaRes = await verifyAndReuseCandidateMandate(metadataPendingSubId, planCode);
        if (verifiedMetaRes && !verifiedMetaRes.ok) {
          return {
            statusCode: verifiedMetaRes.status,
            headers,
            body: JSON.stringify({
              error: "Failed to verify existing mandate with payment provider",
              code: verifiedMetaRes.error,
            }),
          };
        }
        if (verifiedMetaRes?.ok) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              subscriptionId: metadataPendingSubId,
              keyId,
              planId: razorpayPlanId.trim(),
              planCode,
              status: verifiedMetaRes.subData.status,
              reused: true,
            }),
          };
        }
      }

      // SingleFlight Coalescing & Durable Mandate Creation
      const flightKey = `sub_mandate:${user.id}:${planCode}`;
      const result = await singleFlight(flightKey, async () => {
        // Unique attempt ID per try (Requirement 8)
        const attemptId = (await import("crypto")).randomUUID().replace(/-/g, "").slice(0, 16);
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
              return {
                statusCode: 409,
                headers,
                body: JSON.stringify({
                  error: "A subscription checkout is already in progress. Please try again.",
                  code: "PENDING_SUBSCRIPTION_EXISTS",
                }),
              };
            }

            const raceCreatedMs = existingRace.created_at ? new Date(existingRace.created_at).getTime() : 0;
            if (Date.now() - raceCreatedMs > LEASE_DURATION_MS) {
              await supabaseAdmin.from("payment_orders").update({ status: "expired" }).eq("id", existingRace.id);
              return {
                statusCode: 409,
                headers,
                body: JSON.stringify({
                  error: "Previous checkout attempt expired. Please try again.",
                  code: "RESERVATION_LEASE_RECOVERED",
                }),
              };
            }

            if (existingRace.plan_code !== planCode) {
              return {
                statusCode: 409,
                headers,
                body: JSON.stringify({
                  error: `A subscription checkout is already pending for another plan (${existingRace.plan_code}). Please complete or cancel that checkout first.`,
                  code: "PENDING_SUBSCRIPTION_EXISTS",
                }),
              };
            }

            if (
              typeof existingRace.provider_order_id === "string" &&
              existingRace.provider_order_id.startsWith("sub_") &&
              !existingRace.provider_order_id.startsWith("sub_pending_")
            ) {
              const verifiedSubRes = await verifyAndReuseCandidateMandate(existingRace.provider_order_id, planCode);
              if (verifiedSubRes && !verifiedSubRes.ok) {
                return {
                  statusCode: verifiedSubRes.status,
                  headers,
                  body: JSON.stringify({
                    error: "Failed to verify existing mandate with payment provider",
                    code: verifiedSubRes.error,
                  }),
                };
              }
              if (verifiedSubRes?.ok) {
                return {
                  statusCode: 200,
                  headers,
                  body: JSON.stringify({
                    subscriptionId: existingRace.provider_order_id,
                    keyId,
                    planId: razorpayPlanId.trim(),
                    planCode,
                    status: verifiedSubRes.subData.status,
                    reused: true,
                  }),
                };
              }
            }

            return {
              statusCode: 409,
              headers,
              body: JSON.stringify({
                error: "A subscription checkout is already in progress. Please complete the pending payment.",
                code: "PENDING_SUBSCRIPTION_EXISTS",
              }),
            };
          }

          safeLog.error(
            "[Netlify /billing-razorpay-subscription] Failed to insert pending subscription reservation:",
            reserveInsertErr
          );
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
              error: "Failed to initialize subscription tracking. Please try again.",
              code: "SUBSCRIPTION_RECORD_FAILED",
            }),
          };
        }

        const TOTAL_COUNTS: Record<string, number> = {
          weekly: 52,
          monthly: 12,
          quarterly: 4,
        };
        const totalCount = TOTAL_COUNTS[planCode] ?? 12;

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
          safeLog.error("[Netlify /billing-razorpay-subscription] Network exception calling Razorpay subscriptions API:", gatewayErr);
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

          return {
            statusCode: 502,
            headers,
            body: JSON.stringify({
              error: "Failed to connect to payment gateway",
              code: "GATEWAY_CONNECTION_ERROR",
            }),
          };
        }

        if (!rzpRes.ok) {
          const err = await rzpRes.json().catch(() => ({}));
          safeLog.error("[Netlify /billing-razorpay-subscription] Failed to create Razorpay subscription:", err);
          await supabaseAdmin
            .from("payment_orders")
            .update({ status: "failed" })
            .eq("provider_order_id", reservationOrderId);

          return {
            statusCode: rzpRes.status || 502,
            headers,
            body: JSON.stringify({
              error: err?.error?.description || "Failed to initialize payment gateway subscription",
              code: "RAZORPAY_SUBSCRIPTION_ERROR",
            }),
          };
        }

        let subscriptionData: any;
        try {
          subscriptionData = await rzpRes.json();
        } catch (parseErr: any) {
          safeLog.error("[Netlify /billing-razorpay-subscription] Failed to parse Razorpay subscription response:", parseErr);
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

          return {
            statusCode: 502,
            headers,
            body: JSON.stringify({
              error: "Invalid payment gateway response",
              code: "GATEWAY_RESPONSE_INVALID",
            }),
          };
        }

        // Validate subscriptionData.id and status before persisting (Requirement 9)
        const validSubId =
          typeof subscriptionData?.id === "string" &&
          subscriptionData.id.startsWith("sub_") &&
          !subscriptionData.id.startsWith("sub_pending_");
        const validStatus =
          subscriptionData?.status === "created" ||
          subscriptionData?.status === "authenticated" ||
          subscriptionData?.status === "active";

        if (!validSubId || !validStatus) {
          safeLog.error("[Netlify /billing-razorpay-subscription] Invalid subscription data received from Razorpay:", subscriptionData);
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

          return {
            statusCode: 502,
            headers,
            body: JSON.stringify({
              error: "Invalid subscription details received from provider",
              code: "GATEWAY_RESPONSE_INVALID",
            }),
          };
        }

        // Reserved-order update with status/lease/owner CAS (Requirement F)
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
          safeLog.error("[Netlify /billing-razorpay-subscription] Failed to complete reservation via status/lease/owner CAS; cancelling mandate at provider:", {
            error: updateOrderErr,
            subscriptionId: subscriptionData.id,
            affectedCount: updatedOrders?.length ?? 0,
          });

          // Cancel mandate at provider to prevent orphan
          try {
            await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${subscriptionData.id}/cancel`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Basic ${credentials}` },
              body: JSON.stringify({ cancel_at_cycle_end: 0 }),
            });
          } catch (cancelErr) {
            safeLog.error("[Netlify /billing-razorpay-subscription] Exception during orphan mandate cancellation:", cancelErr);
          }

          return {
            statusCode: 409,
            headers,
            body: JSON.stringify({
              error: "Reservation lease expired or was preempted",
              code: "RESERVATION_CAS_FAILED",
            }),
          };
        }

        // Schedule & Period Boundaries (Requirement 11)
        const rawStartSec = subscriptionData.current_start ?? subscriptionData.start_at;
        const rawEndSec = subscriptionData.current_end ?? subscriptionData.end_at;
        const rawChargeAtSec = subscriptionData.charge_at;

        const hasValidStart = typeof rawStartSec === "number" && !isNaN(rawStartSec) && rawStartSec > 0;
        const hasValidEnd = typeof rawEndSec === "number" && !isNaN(rawEndSec) && rawEndSec > 0;

        if (!hasValidStart || !hasValidEnd) {
          safeLog.error("[Netlify /billing-razorpay-subscription] Provider response is missing required period boundaries; failing closed:", {
            subscriptionId: subscriptionData.id,
            rawStartSec,
            rawEndSec,
          });

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

          return {
            statusCode: 502,
            headers,
            body: JSON.stringify({
              error: "Payment provider did not supply required billing cycle boundaries",
              code: "MISSING_PROVIDER_PERIOD",
            }),
          };
        }

        const providerCurrentStart = new Date(rawStartSec * 1000).toISOString();
        const providerCurrentEnd = new Date(rawEndSec * 1000).toISOString();
        const providerChargeAt =
          typeof rawChargeAtSec === "number" && !isNaN(rawChargeAtSec) && rawChargeAtSec > 0
            ? new Date(rawChargeAtSec * 1000).toISOString()
            : null;

        safeLog.info(
          "[Netlify /billing-razorpay-subscription] Subscription created with provider cycle bounds:",
          JSON.stringify({
            subscriptionId: subscriptionData.id,
            providerCurrentStart,
            providerCurrentEnd,
            providerChargeAt,
            verifiedAmount,
            verifiedCurrency,
            verifiedPeriod,
            verifiedInterval,
          })
        );

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
            safeLog.warn("[Netlify /billing-razorpay-subscription] Failed to update pending subscription metadata:", updateSubErr);
          }
        }

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            subscriptionId: subscriptionData.id,
            keyId,
            planId: razorpayPlanId.trim(),
            planCode,
            status: subscriptionData.status,
            currentStart: providerCurrentStart,
            currentEnd: providerCurrentEnd,
          }),
        };
      });

      return result;
    } catch (err: any) {
      safeLog.error("[Netlify /billing-razorpay-subscription]", err);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err?.message || "Internal server error" }),
      };
    }
  };
}

export const handler = createHandler();
