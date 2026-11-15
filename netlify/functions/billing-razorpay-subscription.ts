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

  // 1. Canonical Host header (must not be overridden by caller-supplied forwarding headers)
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

  // 3. Forwarded host headers (caller-supplied header must never override a production Host or URL)
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

      if (process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") {
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "Billing is currently unavailable",
            code: "BILLING_DISABLED",
          }),
        };
      }

      // 2. Authentication
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

      // =========================================================================
      // CANCELLATION FLOW (Requirement 4)
      // =========================================================================
      if (isCancelAction) {
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

        if (!sub || (sub.status !== "active" && sub.status !== "trialing" && sub.status !== "in_grace_period")) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: "No active subscription found to cancel",
              code: "NO_ACTIVE_SUBSCRIPTION",
            }),
          };
        }

        if (sub.cancel_at_period_end) {
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

        const keyId =
          process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ||
          process.env.RAZORPAY_KEY_ID;
        const keySecret = process.env.RAZORPAY_KEY_SECRET;
        const credentials = keyId && keySecret ? Buffer.from(`${keyId}:${keySecret}`).toString("base64") : "";

        const rzpSubId =
          sub.subscription_id ||
          sub.metadata?.pending_subscription_id ||
          sub.metadata?.provider_subscription_id;

        if (sub.provider === "razorpay" && rzpSubId && rzpSubId.startsWith("sub_")) {
          if (!keyId || !keySecret) {
            safeLog.error("[Netlify /billing-razorpay-subscription] Missing Razorpay credentials for subscription cancel");
            return {
              statusCode: 503,
              headers,
              body: JSON.stringify({
                error: "Payment gateway configuration missing",
                code: "RAZORPAY_CONFIG_ERROR",
              }),
            };
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
                safeLog.error("[Netlify /billing-razorpay-subscription] Razorpay cancel API error:", cancelErr);
                return {
                  statusCode: rzpCancelRes.status || 502,
                  headers,
                  body: JSON.stringify({
                    error: cancelErr?.error?.description || "Failed to cancel subscription with payment provider",
                    code: "RAZORPAY_CANCEL_ERROR",
                  }),
                };
              }
            }
          } catch (fetchErr: any) {
            safeLog.error("[Netlify /billing-razorpay-subscription] Network error calling Razorpay cancel:", fetchErr);
            return {
              statusCode: 502,
              headers,
              body: JSON.stringify({
                error: "Network error connecting to payment gateway",
                code: "GATEWAY_CONNECTION_ERROR",
              }),
            };
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
          safeLog.error("[Netlify /billing-razorpay-subscription] Failed to update subscription in DB after cancellation:", dbUpdateErr);
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
          "[Netlify /billing-razorpay-subscription] Subscription successfully scheduled for cancellation at period end",
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
      // MANDATE CREATION FLOW
      // =========================================================================

      // 3. Server-authoritative mode & key validation
      const configuredMode = process.env.RAZORPAY_MODE;
      if (configuredMode !== "test" && configuredMode !== "live") {
        safeLog.error(
          "[Netlify /billing-razorpay-subscription] Payment configuration error: invalid or missing RAZORPAY_MODE"
        );
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "Payment configuration error",
            code: "RAZORPAY_CONFIG_ERROR",
          }),
        };
      }

      const keyId =
        process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ||
        process.env.RAZORPAY_KEY_ID;
      const keySecret = process.env.RAZORPAY_KEY_SECRET;

      if (!keyId || !keySecret) {
        safeLog.error(
          "[Netlify /billing-razorpay-subscription] Payment configuration error: missing Razorpay credentials"
        );
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "Payment configuration error",
            code: "RAZORPAY_CONFIG_ERROR",
          }),
        };
      }

      const keyPrefixMode = getRazorpayKeyMode(keyId);
      if (!keyPrefixMode) {
        safeLog.error(
          "[Netlify /billing-razorpay-subscription] Payment configuration error: unrecognized key prefix"
        );
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "Payment configuration error",
            code: "RAZORPAY_CONFIG_ERROR",
          }),
        };
      }

      if (keyPrefixMode !== configuredMode) {
        safeLog.error(
          "[Netlify /billing-razorpay-subscription] Payment configuration error: key prefix does not match RAZORPAY_MODE"
        );
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "Payment configuration error",
            code: "RAZORPAY_CONFIG_ERROR",
          }),
        };
      }

      const resolvedMode = keyPrefixMode;

      if (keyPrefixMode === "test" && isProductionHost(event, deps)) {
        safeLog.error(
          "[Netlify /billing-razorpay-subscription] FATAL CONFIGURATION ERROR: Razorpay test keys refused on production host"
        );
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "Payment configuration error",
            code: "RAZORPAY_CONFIG_ERROR",
          }),
        };
      }

      // 4. Validate planCode in {weekly, monthly, quarterly}
      const planCode = body.planCode;
      if (planCode !== "weekly" && planCode !== "monthly" && planCode !== "quarterly") {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Invalid plan code: must be one of weekly, monthly, quarterly",
          }),
        };
      }

      // 5. Fail-closed server ban check
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
        safeLog.error(
          "[Netlify /billing-razorpay-subscription] Payment configuration error: missing plan ID for planCode",
          planCode
        );
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "Payment configuration error",
            code: "RAZORPAY_CONFIG_ERROR",
          }),
        };
      }

      // 7. Check if user already has an active plan (block duplicate / overwrite)
      const { data: existingSub, error: selectErr } = await supabaseAdmin
        .from("subscriptions")
        .select("id, status, plan_id, subscription_id, current_period_end, grace_period_end, metadata")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (selectErr) {
        safeLog.error(
          "[Netlify /billing-razorpay-subscription] Subscription lookup error during pre-check; failing closed:",
          selectErr
        );
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
          safeLog.error("[Netlify /billing-razorpay-subscription] Entitlement check error; failing closed:", entErr);
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

      // 8. Requirement 3: Authoritative Pending Reuse Query (zero JS filtering, handles query errors fail-closed)
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
        safeLog.error("[Netlify /billing-razorpay-subscription] Failed to check pending payment_orders; failing closed:", pendingOrderErr);
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
        safeLog.info(
          "[Netlify /billing-razorpay-subscription] Reusing existing pending subscription order for user and plan",
          JSON.stringify({
            userId: user.id,
            planCode,
            subscriptionId: existingPendingOrder.provider_order_id,
          })
        );
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            subscriptionId: existingPendingOrder.provider_order_id,
            keyId,
            planId: razorpayPlanId.trim(),
            planCode,
            status: "created",
            reused: true,
          }),
        };
      }

      // Authoritative check for other pending plans
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
        safeLog.error("[Netlify /billing-razorpay-subscription] Failed to query other pending plans; failing closed:", otherPendingErr);
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
          safeLog.info(
            "[Netlify /billing-razorpay-subscription] Reusing existing pending subscription from metadata",
            JSON.stringify({
              userId: user.id,
              planCode,
              subscriptionId: metadataPendingSubId,
            })
          );
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              subscriptionId: metadataPendingSubId,
              keyId,
              planId: razorpayPlanId.trim(),
              planCode,
              status: "created",
              reused: true,
            }),
          };
        } else {
          return {
            statusCode: 409,
            headers,
            body: JSON.stringify({
              error: `A subscription checkout is already pending for another plan (${metadataPendingPlan}). Please complete or cancel that checkout first.`,
              code: "PENDING_SUBSCRIPTION_EXISTS",
            }),
          };
        }
      }

      // 9. Atomic Double-Tab Coalescing via singleFlight
      const flightKey = `sub_mandate:${user.id}:${planCode}`;
      return await singleFlight(flightKey, async () => {
        // Re-check pending orders inside flight
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
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              subscriptionId: racePendingOrder.provider_order_id,
              keyId,
              planId: razorpayPlanId.trim(),
              planCode,
              status: "created",
              reused: true,
            }),
          };
        }

        const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

        // 10. Requirement 1: Provider Plan Verification
        let planRes: Response;
        try {
          planRes = await fetchCaller(`https://api.razorpay.com/v1/plans/${razorpayPlanId.trim()}`, {
            method: "GET",
            headers: {
              Authorization: `Basic ${credentials}`,
            },
          });
        } catch (planFetchErr: any) {
          safeLog.error("[Netlify /billing-razorpay-subscription] Network error fetching plan; failing closed:", planFetchErr);
          return {
            statusCode: 502,
            headers,
            body: JSON.stringify({
              error: "Failed to verify plan with payment provider",
              code: "PLAN_VERIFICATION_FAILED",
            }),
          };
        }

        if (!planRes.ok) {
          const planErr = await planRes.json().catch(() => ({}));
          safeLog.error("[Netlify /billing-razorpay-subscription] Plan fetch non-200 from provider; failing closed:", planErr);
          return {
            statusCode: 502,
            headers,
            body: JSON.stringify({
              error: "Failed to verify plan with payment provider",
              code: "PLAN_VERIFICATION_FAILED",
            }),
          };
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
          safeLog.error("[Netlify /billing-razorpay-subscription] Provider plan verification failed mismatch:", {
            planCode,
            razorpayPlanId: razorpayPlanId.trim(),
            expectedAmount: expectedSpec?.amount,
            verifiedAmount,
            verifiedCurrency,
            verifiedPeriod,
            verifiedInterval,
          });
          return {
            statusCode: 502,
            headers,
            body: JSON.stringify({
              error: `Provider plan details do not match ${planCode} plan requirements`,
              code: "PLAN_VERIFICATION_MISMATCH",
            }),
          };
        }

        safeLog.info(
          "[Netlify /billing-razorpay-subscription] Verified Razorpay plan with provider:",
          JSON.stringify({
            planCode,
            razorpayPlanId: razorpayPlanId.trim(),
            verifiedAmount,
            verifiedCurrency,
            verifiedPeriod,
            verifiedInterval,
          })
        );

        // 11. Requirement 2: Durable Mandate Creation
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
            safeLog.warn(
              "[Netlify /billing-razorpay-subscription] Unique constraint collision on pending subscription reservation:",
              reserveInsertErr
            );

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
              safeLog.error("[Netlify /billing-razorpay-subscription] Conflicting order lookup failed; failing closed:", raceFetchErr);
              return {
                statusCode: 409,
                headers,
                body: JSON.stringify({
                  error: "A subscription checkout is already in progress. Please try again.",
                  code: "PENDING_SUBSCRIPTION_EXISTS",
                }),
              };
            }

            // Unique-collision path must check plan equality, never reuse a different plan
            if (existingRace.plan_code !== planCode) {
              safeLog.warn("[Netlify /billing-razorpay-subscription] Collision with different plan; refusing reuse:", {
                requestedPlan: planCode,
                existingPlan: existingRace.plan_code,
              });
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
              return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                  subscriptionId: existingRace.provider_order_id,
                  keyId,
                  planId: razorpayPlanId.trim(),
                  planCode,
                  status: "created",
                  reused: true,
                }),
              };
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
              },
            }),
          });
        } catch (gatewayErr: any) {
          safeLog.error("[Netlify /billing-razorpay-subscription] Network exception calling Razorpay subscriptions API:", gatewayErr);
          await supabaseAdmin
            .from("payment_orders")
            .update({ status: "failed" })
            .eq("provider_order_id", reservationOrderId);

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
          safeLog.error(
            "[Netlify /billing-razorpay-subscription] Failed to create Razorpay subscription:",
            err
          );
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

        const subscriptionData: any = await rzpRes.json();

        // Update reserved order with real Razorpay subscription ID
        const { error: updateOrderErr } = await supabaseAdmin
          .from("payment_orders")
          .update({
            provider_order_id: subscriptionData.id,
            status: "created",
          })
          .eq("provider_order_id", reservationOrderId);

        if (updateOrderErr) {
          safeLog.error(
            "[Netlify /billing-razorpay-subscription] Failed to update reserved order with provider subscription ID; cancelling mandate:",
            updateOrderErr
          );
          await supabaseAdmin
            .from("payment_orders")
            .update({ status: "failed" })
            .eq("provider_order_id", reservationOrderId);

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
            safeLog.error("[Netlify /billing-razorpay-subscription] Failed to cancel orphan mandate in Razorpay:", cancelErr);
          }

          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
              error: "Failed to persist subscription tracking. Please try again.",
              code: "SUBSCRIPTION_RECORD_FAILED",
            }),
          };
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

        safeLog.info(
          "[Netlify /billing-razorpay-subscription] Subscription created with provider cycle bounds:",
          JSON.stringify({
            subscriptionId: subscriptionData.id,
            providerCurrentStart,
            providerCurrentEnd,
            verifiedAmount,
            verifiedCurrency,
            verifiedPeriod,
            verifiedInterval,
          })
        );

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
            safeLog.warn(
              "[Netlify /billing-razorpay-subscription] Failed to update pending subscription metadata:",
              updateErr
            );
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
