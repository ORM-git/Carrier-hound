import { createClient } from "@supabase/supabase-js";
import { getRazorpayKeyMode } from "../../src/lib/billing/mode";
import { normalizePlanCode } from "../../src/lib/billing/quota";
import { PLAN_PRICING } from "../../src/config/plans";
import { verifyUserNotBanned } from "../../src/lib/admin/auth";
import { singleFlight } from "../../src/lib/cache/singleFlight";
import { validateRazorpayPlan } from "../../src/lib/billing/validatePlan";
import { ensureOrderConsent } from "../../src/lib/billing/orderConsent";
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
  configuredMode?: "test" | "live";
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

  const hostHeader = headers.host || headers.Host;
  if (hostHeader) {
    const parts = hostHeader.split(",");
    for (const part of parts) {
      if (matchesProd(part)) return true;
    }
  }

  if (event?.rawUrl) {
    try {
      const url = new URL(event.rawUrl);
      if (matchesProd(url.hostname) || matchesProd(url.host)) return true;
    } catch {
      // ignore
    }
  }

  const xForwardedHost = headers["x-forwarded-host"] || headers["X-Forwarded-Host"];
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
          body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
        } catch {}
      }

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
      } catch {
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

      const banChecker = deps.verifyUserNotBanned || verifyUserNotBanned;
      const banResult = await banChecker(supabaseAdmin, user.id, user.user_metadata);
      if (banResult.isBlocked) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: "Account suspended", code: "USER_BLOCKED" }),
        };
      }

      // Handle Cancellation action (POST with action: "cancel" or DELETE)
      if (event.httpMethod === "DELETE" || body?.action === "cancel") {
        const { data: sub, error: subError } = await supabaseAdmin
          .from("subscriptions")
          .select("id, user_id, subscription_id, status, cancel_at_period_end, current_period_end, metadata")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (subError) {
          safeLog.error("[Netlify /subscription cancel] Failed to query subscription:", subError);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "Failed to query subscription", code: "DATABASE_ERROR" }),
          };
        }

        if (!sub || (sub.status !== "active" && sub.status !== "trialing" && sub.status !== "in_grace_period")) {
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: "No active subscription found to cancel", code: "NO_ACTIVE_SUBSCRIPTION" }),
          };
        }

        if (sub.cancel_at_period_end) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              success: true,
              cancelAtPeriodEnd: true,
              currentPeriodEnd: sub.current_period_end,
              message: "Subscription is already set to cancel at the end of the billing period",
            }),
          };
        }

        const rzpSubId = sub.subscription_id || sub.metadata?.razorpay_subscription_id;

        // Fail-closed requirement: must be a recurring Razorpay subscription
        if (!rzpSubId || typeof rzpSubId !== "string" || !rzpSubId.startsWith("sub_")) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: "No active recurring subscription mandate found to cancel",
              code: "NOT_A_RECURRING_SUBSCRIPTION",
            }),
          };
        }

        const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID;
        const keySecret = process.env.RAZORPAY_KEY_SECRET;

        // Fail closed if payment credentials are not configured: keep DB unchanged
        if (!keyId || !keySecret) {
          safeLog.error("[Netlify /subscription cancel] Missing Razorpay credentials");
          return {
            statusCode: 503,
            headers,
            body: JSON.stringify({
              error: "Payment gateway credentials are not configured",
              code: "RAZORPAY_CONFIG_ERROR",
            }),
          };
        }

        const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
        const timeoutMs = (deps as any)?.timeoutMs ?? 10000;
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
        } catch (callErr: any) {
          clearTimeout(timer);
          const isTimeout =
            callErr?.name === "AbortError" ||
            callErr?.message?.toLowerCase().includes("timeout") ||
            callErr?.message?.toLowerCase().includes("abort");

          safeLog.error(
            "[Netlify /subscription cancel] Razorpay cancel API network error or timeout (DB state kept intact):",
            callErr
          );

          return {
            statusCode: isTimeout ? 504 : 502,
            headers,
            body: JSON.stringify({
              error: isTimeout
                ? "Payment gateway cancellation request timed out. Please try again."
                : "Failed to communicate with payment gateway. Please try again.",
              code: isTimeout ? "GATEWAY_TIMEOUT" : "GATEWAY_ERROR",
            }),
          };
        } finally {
          clearTimeout(timer);
        }

        // Fail closed on non-2xx response: do NOT mark in DB
        if (!rzpCancelRes.ok) {
          const rzpErr = await rzpCancelRes.json().catch(() => ({}));
          safeLog.error(
            "[Netlify /subscription cancel] Razorpay API rejected subscription cancellation (DB state kept intact):",
            { status: rzpCancelRes.status, error: rzpErr }
          );

          return {
            statusCode: 502,
            headers,
            body: JSON.stringify({
              error:
                rzpErr?.error?.description ||
                "Payment gateway rejected subscription cancellation. Please try again.",
              code: "RAZORPAY_CANCEL_FAILED",
              gatewayStatus: rzpCancelRes.status,
            }),
          };
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
          safeLog.error("[Netlify /subscription cancel] DB update failed after Razorpay confirmed cancel:", updateErr);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "Failed to update subscription cancellation in database", code: "DATABASE_ERROR" }),
          };
        }

        safeLog.info(
          "[Netlify /subscription cancel] Subscription cancelled confirmed by Razorpay and updated in DB:",
          JSON.stringify({
            userId: user.id,
            subscriptionId: rzpSubId,
          })
        );

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            cancelAtPeriodEnd: true,
            currentPeriodEnd: sub.current_period_end,
            message: "Subscription will cancel at the end of the current billing period",
          }),
        };
      }

      // 1. Feature Flag Checks: NEXT_PUBLIC_AUTORENEW_ENABLED and NEXT_PUBLIC_BILLING_ENABLED
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

      // Mode and key validation
      const configuredMode = process.env.RAZORPAY_MODE || (deps.configuredMode ?? "test");
      if (configuredMode !== "test" && configuredMode !== "live") {
        safeLog.error("[Netlify /billing-razorpay-subscription] Invalid or missing RAZORPAY_MODE");
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
        process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID;
      const keySecret = process.env.RAZORPAY_KEY_SECRET;

      if (!keyId || !keySecret) {
        safeLog.error("[Netlify /billing-razorpay-subscription] Missing Razorpay credentials");
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
          "[Netlify /billing-razorpay-subscription] Key prefix does not match configured mode"
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
          "[Netlify /billing-razorpay-subscription] FATAL: Razorpay test keys refused on production host"
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

      // Plan code validation: Flat Rs 499 monthly plan ONLY
      const rawPlan = body?.planCode || body?.planId || "monthly";
      const planCode = normalizePlanCode(rawPlan);

      if (planCode !== "monthly") {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Only the flat Rs 499 monthly auto-renew subscription is supported",
            code: "UNSUPPORTED_PLAN",
          }),
        };
      }

      // Explicit auto-renew consent validation (Blocker 2)
      const consent = body?.consent;
      if (
        !consent ||
        typeof consent !== "object" ||
        consent.agreed !== true ||
        typeof consent.version !== "string" ||
        !consent.version.trim() ||
        typeof consent.timestamp !== "string" ||
        Number.isNaN(Date.parse(consent.timestamp))
      ) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Explicit auto-renew consent is required to create a subscription",
            code: "CONSENT_REQUIRED",
          }),
        };
      }

      const consentTimestampMs = Date.parse(consent.timestamp);
      if (
        consentTimestampMs > Date.now() + 5 * 60 * 1000 ||
        consentTimestampMs < Date.now() - 24 * 60 * 60 * 1000
      ) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Invalid consent timestamp",
            code: "INVALID_CONSENT_TIMESTAMP",
          }),
        };
      }

      const consentRecord = {
        agreed: true,
        version: consent.version.trim(),
        timestamp: new Date(consentTimestampMs).toISOString(),
        recorded_at: new Date().toISOString(),
      };

      // Plan ID from environment variables only — NEVER hardcoded
      const razorpayPlanId = process.env.RAZORPAY_AUTORENEW_PLAN_MONTHLY;

      if (!razorpayPlanId || !razorpayPlanId.trim()) {
        safeLog.error(
          "[Netlify /billing-razorpay-subscription] RAZORPAY_AUTORENEW_PLAN_MONTHLY missing"
        );
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "Subscription plan is not configured on server",
            code: "PLAN_NOT_CONFIGURED",
          }),
        };
      }

      // Validate plan attributes from Razorpay API before use (Blocker 4)
      const planValidation = await validateRazorpayPlan(
        razorpayPlanId,
        keyId,
        keySecret,
        { fetchFn: deps.fetchFn, timeoutMs: (deps as any)?.planValidationTimeoutMs }
      );

      if (!planValidation.valid) {
        safeLog.error(
          "[Netlify /billing-razorpay-subscription] Razorpay plan validation failed:",
          planValidation.error
        );
        return {
          statusCode: planValidation.code === "PLAN_NOT_CONFIGURED" ? 503 : 502,
          headers,
          body: JSON.stringify({
            error: planValidation.error || "Subscription plan validation failed",
            code: planValidation.code || "PLAN_INVALID",
          }),
        };
      }

      const amountInPaise = PLAN_PRICING.monthly.price_paise; // 49900 paise = Rs 499
      const totalCount = 12;

      // Single flight coalescing
      const flightKey = `sub_create:${user.id}:${planCode}`;
      return await singleFlight(flightKey, async () => {
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
          return {
            statusCode: 409,
            headers,
            body: JSON.stringify({
              error: "You already have an active subscription.",
              code: "ACTIVE_SUBSCRIPTION_EXISTS",
            }),
          };
        }

        const { data: existingPendingOrder } = await supabaseAdmin
          .from("payment_orders")
          .select("provider_order_id, plan_code, mode, created_at, metadata")
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
          if (!(await ensureOrderConsent(supabaseAdmin, user.id, existingPendingOrder, consentRecord))) {
            safeLog.error("[Netlify /billing-razorpay-subscription] Failed to record consent on reused pending order");
            return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
              error: "Failed to record subscription consent. Please try again.",
              code: "CONSENT_RECORD_FAILED",
            }),
          };
          }
          safeLog.info(
            "[Netlify /billing-razorpay-subscription] Reusing existing pending mandate:",
            existingPendingOrder.provider_order_id
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
            safeLog.warn(
              "[Netlify /billing-razorpay-subscription] Unique constraint collision on payment_orders; fetching existing order:",
              orderInsertErr
            );
            const { data: existingRace } = await supabaseAdmin
              .from("payment_orders")
              .select("provider_order_id, plan_code, mode, metadata")
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
              if (!(await ensureOrderConsent(supabaseAdmin, user.id, existingRace, consentRecord))) {
                safeLog.error("[Netlify /billing-razorpay-subscription] Failed to record consent on race-reused order");
                return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
              error: "Failed to record subscription consent. Please try again.",
              code: "CONSENT_RECORD_FAILED",
            }),
          };
              }
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
            "[Netlify /billing-razorpay-subscription] Failed to insert pending subscription:",
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
                pending_consent: consentRecord,
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
