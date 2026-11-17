import { createClient } from "@supabase/supabase-js";
import { getRazorpayKeyMode } from "../../src/lib/billing/mode";
import { verifyUserNotBanned } from "../../src/lib/admin/auth";
import { singleFlight } from "../../src/lib/cache/singleFlight";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { safeLog } from "./_logger";

const CORS_OPTIONS = {
  allowedMethods: "POST, OPTIONS",
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

    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    if (process.env.NEXT_PUBLIC_AUTORENEW_ENABLED !== "true") {
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

    try {
      const authHeader = event.headers?.authorization || event.headers?.Authorization;
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
      } catch (err: any) {
        safeLog.error("[Netlify /billing-razorpay-subscription] Admin init error:", err);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({
            error: "Supabase service configuration missing",
            code: "NETLIFY_SUBSCRIPTION_SUPABASE_CONFIG_MISSING",
          }),
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

      // Server-authoritative mode & key validation
      const configuredMode = process.env.RAZORPAY_MODE;
      if (configuredMode !== "test" && configuredMode !== "live") {
        safeLog.error(
          "[Netlify /billing-razorpay-subscription] Payment configuration error: invalid or missing mode"
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

      const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID;
      const keySecret = process.env.RAZORPAY_KEY_SECRET;

      if (!keyId || !keySecret) {
        safeLog.error(
          "[Netlify /billing-razorpay-subscription] Payment configuration error: missing credentials"
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

      const resolvedMode = getRazorpayKeyMode(keyId);
      const expectedPrefix = configuredMode === "test" ? "rzp_test_" : "rzp_live_";
      if (!keyId.startsWith(expectedPrefix) || resolvedMode !== configuredMode) {
        safeLog.error(
          "[Netlify /billing-razorpay-subscription] Payment configuration error: key prefix does not match configured mode"
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

      if (
        isProductionHost(event, deps) &&
        (keyId.startsWith("rzp_test_") || configuredMode === "test")
      ) {
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

      let body: any = {};
      if (event.body) {
        try {
          body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
        } catch {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: "Invalid JSON request body" }),
          };
        }
      }

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

      // Map planCode to Razorpay plan ID from env
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

      // Check if user already has an active plan (block duplicate / overwrite)
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

      // Idempotent pending attempts: before creating a subscription, check for an existing pending
      // payment_orders row (status created) or metadata.pending_subscription_id for this user and plan;
      // reuse it or return 409, never create a second mandate.
      const { data: existingPendingOrder, error: pendingOrderErr } = await supabaseAdmin
        .from("payment_orders")
        .select("id, provider_order_id, plan_code, status, created_at, mode")
        .eq("user_id", user.id)
        .eq("status", "created")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (pendingOrderErr) {
        safeLog.error("[Netlify /billing-razorpay-subscription] Failed to check pending payment_orders; failing closed:", pendingOrderErr);
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "Unable to verify pending order state. Please try again later.",
            code: "SERVICE_UNAVAILABLE",
          }),
        };
      }

      const isSubMandate =
        typeof existingPendingOrder?.provider_order_id === "string" &&
        existingPendingOrder.provider_order_id.startsWith("sub_");
      const isMatchingMode =
        resolvedMode === "live"
          ? existingPendingOrder?.mode === "live"
          : existingPendingOrder?.mode !== "live";

      if (existingPendingOrder && isSubMandate && isMatchingMode) {
        if (existingPendingOrder.plan_code === planCode) {
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
        } else {
          return {
            statusCode: 409,
            headers,
            body: JSON.stringify({
              error: `A subscription checkout is already pending for another plan (${existingPendingOrder.plan_code}). Please complete or cancel that checkout first.`,
              code: "PENDING_SUBSCRIPTION_EXISTS",
            }),
          };
        }
      }

      const metadataPendingSubId = existingSub?.metadata?.pending_subscription_id;
      const metadataPendingPlan = existingSub?.metadata?.pending_plan_code;
      const metadataPendingMode = existingSub?.metadata?.pending_mode;
      const isMetaSub =
        typeof metadataPendingSubId === "string" && metadataPendingSubId.startsWith("sub_");
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

      // Atomic Double-Tab Coalescing via singleFlight
      const flightKey = `sub_mandate:${user.id}:${planCode}`;
      return await singleFlight(flightKey, async () => {
        // Re-check pending orders inside flight in case another tab or request settled just before
        const { data: racePendingOrder } = await supabaseAdmin
          .from("payment_orders")
          .select("provider_order_id, plan_code, mode")
          .eq("user_id", user.id)
          .eq("status", "created")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const isRaceSub =
          typeof racePendingOrder?.provider_order_id === "string" &&
          racePendingOrder.provider_order_id.startsWith("sub_");
        const isRaceMatchingMode =
          resolvedMode === "live"
            ? racePendingOrder?.mode === "live"
            : racePendingOrder?.mode !== "live";

        if (isRaceSub && isRaceMatchingMode && racePendingOrder.plan_code === planCode) {
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

        const TOTAL_COUNTS: Record<string, number> = {
          weekly: 52,
          monthly: 12,
          quarterly: 4,
        };
        const totalCount = TOTAL_COUNTS[planCode] ?? 12;

        const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
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
          safeLog.error(
            "[Netlify /billing-razorpay-subscription] Failed to create Razorpay subscription:",
            err
          );
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
          if (
            orderInsertErr.code === "23505" ||
            orderInsertErr.message?.includes("duplicate") ||
            orderInsertErr.message?.includes("unique")
          ) {
            safeLog.warn(
              "[Netlify /billing-razorpay-subscription] Unique constraint collision on payment_orders; fetching and reusing existing pending order:",
              orderInsertErr
            );
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
            "[Netlify /billing-razorpay-subscription] Failed to insert pending subscription into payment_orders:",
            orderInsertErr
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
