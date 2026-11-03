import { createClient } from "@supabase/supabase-js";
import { resolveOrderPricing } from "../../src/lib/billing/quota";
import { getServerEntitlement } from "../../src/lib/billing/serverEntitlement";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { safeLog } from "./_logger";

const CORS_OPTIONS = {
  allowedMethods: "POST, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

export interface BillingOrderDeps {
  getSupabaseAdmin?: () => any;
  getServerEntitlement?: (userId: string) => Promise<any>;
  fetchFn?: typeof fetch;
}

function getDefaultSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase service configuration missing");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

export function createHandler(deps: BillingOrderDeps = {}) {
  const adminGetter = deps.getSupabaseAdmin || getDefaultSupabaseAdmin;
  const entitlementChecker = deps.getServerEntitlement || getServerEntitlement;
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
        safeLog.error("[Netlify /billing-razorpay-order] Admin init error:", err);
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

      const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID;
      const keySecret = process.env.RAZORPAY_KEY_SECRET;

      if (!keyId || !keySecret || !keyId.startsWith("rzp_test_")) {
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "test keys not configured",
            code: "RAZORPAY_TEST_KEYS_NOT_CONFIGURED",
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

      const pricing = resolveOrderPricing({
        planCode: body.planCode,
        planId: body.planId || (!body.addonCode && !body.planCode ? "monthly" : undefined),
        addonCode: body.addonCode,
      });

      if (!pricing) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Invalid plan or addon code" }),
        };
      }

      // Add-ons require active Pro subscription
      if (pricing.type === "addon") {
        const entitlement = await entitlementChecker(user.id);
        if (!entitlement?.isPro) {
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({
              error: "Add-on packs require an active Pro subscription",
              code: "PRO_REQUIRED",
            }),
          };
        }
      }

      const amountInPaise = pricing.amount_paise;
      const currency = pricing.currency;
      const receipt = `rcpt_${user.id.slice(0, 8)}_${Date.now()}`;

      const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
      const rzpRes = await fetchCaller("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({
          amount: amountInPaise,
          currency,
          receipt,
          notes: {
            user_id: user.id,
            email: user.email || "",
            type: pricing.type,
            code: pricing.code,
          },
        }),
      });

      if (!rzpRes.ok) {
        const err = await rzpRes.json().catch(() => ({}));
        return {
          statusCode: rzpRes.status || 500,
          headers,
          body: JSON.stringify({ error: err.error?.description || "Failed to create Razorpay order" }),
        };
      }

      const orderData: any = await rzpRes.json();

      // Record in payment_orders table with status 'created' - fail closed if insert fails
      const { error: insertErr } = await supabaseAdmin.from("payment_orders").insert({
        user_id: user.id,
        provider: "razorpay",
        provider_order_id: orderData.id,
        plan_code: pricing.type === "plan" ? pricing.code : null,
        addon_code: pricing.type === "addon" ? pricing.code : null,
        amount_paise: amountInPaise,
        currency,
        status: "created",
      });

      if (insertErr) {
        safeLog.error("[Netlify /billing-razorpay-order] payment_orders insert failed:", insertErr);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({
            error: "Failed to initialize order tracking. Please try again.",
            code: "ORDER_RECORD_FAILED",
          }),
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          orderId: orderData.id,
          amount: orderData.amount,
          currency: orderData.currency,
          keyId,
        }),
      };
    } catch (err: any) {
      safeLog.error("[Netlify /billing-razorpay-order]", err);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err?.message || "Internal server error" }),
      };
    }
  };
}

export const handler = createHandler();
