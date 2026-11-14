import { createClient } from "@supabase/supabase-js";
import { getRazorpayKeyMode } from "../../src/lib/billing/mode";
import { verifyUserNotBanned } from "../../src/lib/admin/auth";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { safeLog } from "./_logger";

const CORS_OPTIONS = {
  allowedMethods: "POST, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

export interface BillingSubscriptionDeps {
  getSupabaseAdmin?: () => any;
  verifyUserNotBanned?: (supabaseAdmin: any, userId: string, metadata?: any) => Promise<any>;
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

      // Total count calculation:
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

      const { data: existingSub, error: selectErr } = await supabaseAdmin
        .from("subscriptions")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();

      if (selectErr) {
        safeLog.warn(
          "[Netlify /billing-razorpay-subscription] Subscription lookup error during creation:",
          selectErr
        );
      }

      let recordError: any = null;
      if (existingSub) {
        const { error: updateErr } = await supabaseAdmin
          .from("subscriptions")
          .update({
            subscription_id: subscriptionData.id,
            plan_id: planCode,
            provider: "razorpay",
            updated_at: new Date().toISOString(),
            metadata: {
              ...(existingSub.metadata || {}),
              razorpay_subscription_id: subscriptionData.id,
              plan_code: planCode,
            },
          })
          .eq("user_id", user.id);
        recordError = updateErr;
      } else {
        const { error: insertErr } = await supabaseAdmin
          .from("subscriptions")
          .insert({
            user_id: user.id,
            provider: "razorpay",
            subscription_id: subscriptionData.id,
            plan_id: planCode,
            currency: "INR",
            status: "unpaid",
            metadata: {
              razorpay_subscription_id: subscriptionData.id,
              plan_code: planCode,
            },
          });
        recordError = insertErr;
      }

      if (recordError) {
        safeLog.error(
          "[Netlify /billing-razorpay-subscription] Failed to store subscription id on user row:",
          recordError
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
