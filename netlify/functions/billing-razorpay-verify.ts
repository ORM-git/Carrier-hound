import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { getRazorpayKeyMode } from "../../src/lib/billing/mode";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { safeLog } from "./_logger";

const CORS_OPTIONS = {
  allowedMethods: "POST, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

export interface BillingVerifyDeps {
  getSupabaseAdmin?: () => any;
  fetchCaller?: typeof fetch;
}

interface VerifyPayload {
  order_id?: string;
  payment_id?: string;
  razorpay_signature?: string;
  razorpay_order_id?: string;
  razorpay_payment_id?: string;
  subscription_id?: string;
  razorpay_subscription_id?: string;
  amount?: number;
  planCode?: string;
  plan_code?: string;
  planId?: string;
  plan_id?: string;
  addonCode?: string;
  addon_code?: string;
}

function getDefaultSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error("Supabase service configuration missing");
  }

  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}

function constantTimeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a.toLowerCase(), "utf8");
  const bufB = Buffer.from(b.trim().toLowerCase(), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifySubscriptionSignature(
  paymentId: string,
  subscriptionId: string,
  signature: string,
  secret: string
): boolean {
  if (!paymentId || !subscriptionId || !signature || !secret) return false;
  const sig1 = crypto.createHmac("sha256", secret).update(`${paymentId}|${subscriptionId}`).digest("hex");
  if (constantTimeCompare(sig1, signature)) return true;
  const sig2 = crypto.createHmac("sha256", secret).update(`${subscriptionId}|${paymentId}`).digest("hex");
  return constantTimeCompare(sig2, signature);
}

export function createHandler(deps: BillingVerifyDeps = {}) {
  const adminGetter = deps.getSupabaseAdmin || getDefaultSupabaseAdmin;
  const fetchCaller = deps.fetchCaller || fetch;

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
        safeLog.error("[Netlify /billing-razorpay-verify] Admin init error:", err);
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

      const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID || "";
      const keySecret = process.env.RAZORPAY_KEY_SECRET;

      if (!keySecret || !keyId) {
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "test keys not configured",
            code: "RAZORPAY_TEST_KEYS_NOT_CONFIGURED",
          }),
        };
      }

      const serverMode = getRazorpayKeyMode(keyId);
      if (serverMode === "unknown") {
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: "test keys not configured",
            code: "RAZORPAY_TEST_KEYS_NOT_CONFIGURED",
          }),
        };
      }

      let body: VerifyPayload = {};
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

      const orderId = body.order_id || body.razorpay_order_id;
      const paymentId = body.payment_id || body.razorpay_payment_id;
      const signature = body.razorpay_signature;

      const rawSubId = (body as any).subscription_id || (body as any).razorpay_subscription_id;
      const isSubscription = Boolean(rawSubId || (orderId && orderId.startsWith("sub_")));
      const subscriptionId = rawSubId || (orderId && orderId.startsWith("sub_") ? orderId : undefined);

      if ((!orderId && !subscriptionId) || !paymentId || !signature) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Missing required order_id, payment_id or razorpay_signature",
          }),
        };
      }

      if (isSubscription && subscriptionId) {
        // 1. Verify subscription HMAC-SHA256 signature
        const isValid = verifySubscriptionSignature(paymentId, subscriptionId, signature, keySecret);
        if (!isValid) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: "Invalid payment signature",
              code: "INVALID_SIGNATURE",
            }),
          };
        }

        // 2. Fetch subscription entity directly from provider by ID
        const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
        let rzpRes: Response;
        try {
          rzpRes = await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${subscriptionId}`, {
            method: "GET",
            headers: {
              Authorization: `Basic ${credentials}`,
            },
          });
        } catch (gatewayErr: any) {
          safeLog.error("[Netlify /billing-razorpay-verify] Network error fetching subscription:", gatewayErr);
          return {
            statusCode: 502,
            headers,
            body: JSON.stringify({
              error: "Failed to verify mandate with provider",
              code: "GATEWAY_CONNECTION_ERROR",
            }),
          };
        }

        if (!rzpRes.ok) {
          safeLog.error("[Netlify /billing-razorpay-verify] Provider returned non-200 for subscription fetch:", rzpRes.status);
          return {
            statusCode: 502,
            headers,
            body: JSON.stringify({
              error: "Failed to verify mandate with provider",
              code: "GATEWAY_CONNECTION_ERROR",
            }),
          };
        }

        let subData: any;
        try {
          subData = await rzpRes.json();
        } catch (parseErr: any) {
          safeLog.error("[Netlify /billing-razorpay-verify] Failed to parse provider response:", parseErr);
          return {
            statusCode: 502,
            headers,
            body: JSON.stringify({
              error: "Invalid payment gateway response",
              code: "GATEWAY_RESPONSE_INVALID",
            }),
          };
        }

        // 3. Ownership Check: provider notes.userId == authenticated user
        const providerUserId = subData?.notes?.userId || subData?.notes?.user_id;
        if (!providerUserId || providerUserId !== user.id) {
          safeLog.warn(
            "[Netlify /billing-razorpay-verify] Mandate ownership mismatch:",
            JSON.stringify({ subscriptionId, sessionUserId: user.id })
          );
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({
              error: "Mandate does not belong to authenticated user",
              code: "MANDATE_OWNERSHIP_MISMATCH",
            }),
          };
        }

        // 4. DB Order and Nonce Check
        const { data: orderRow } = await supabaseAdmin
          .from("payment_orders")
          .select("id, user_id, provider, mode, provider_order_id, plan_code, amount_paise, status, metadata")
          .eq("provider_order_id", subscriptionId)
          .maybeSingle();

        if (orderRow && orderRow.user_id !== user.id) {
          safeLog.warn(
            "[Netlify /billing-razorpay-verify] Mandate order ownership mismatch:",
            JSON.stringify({ subscriptionId, sessionUserId: user.id })
          );
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({
              error: "Mandate does not belong to authenticated user",
              code: "MANDATE_OWNERSHIP_MISMATCH",
            }),
          };
        }

        if (orderRow?.metadata?.nonce && subData?.notes?.nonce) {
          if (orderRow.metadata.nonce !== subData.notes.nonce) {
            safeLog.warn(
              "[Netlify /billing-razorpay-verify] Mandate nonce mismatch:",
              JSON.stringify({ subscriptionId, sessionUserId: user.id })
            );
            return {
              statusCode: 403,
              headers,
              body: JSON.stringify({
                error: "Mandate verification failed: nonce mismatch",
                code: "MANDATE_NONCE_MISMATCH",
              }),
            };
          }
        }

        // 5. Customer ID check
        if (subData?.customer_id) {
          const { data: otherUserSub } = await supabaseAdmin
            .from("subscriptions")
            .select("user_id")
            .eq("customer_id", subData.customer_id)
            .neq("user_id", user.id)
            .maybeSingle();

          if (otherUserSub && otherUserSub.user_id !== user.id) {
            safeLog.warn(
              "[Netlify /billing-razorpay-verify] Customer ownership mismatch:",
              JSON.stringify({ subscriptionId, sessionUserId: user.id })
            );
            return {
              statusCode: 403,
              headers,
              body: JSON.stringify({
                error: "Mandate customer belongs to another user",
                code: "CUSTOMER_OWNERSHIP_MISMATCH",
              }),
            };
          }

          const { data: existingUserSub } = await supabaseAdmin
            .from("subscriptions")
            .select("customer_id")
            .eq("user_id", user.id)
            .maybeSingle();

          if (existingUserSub?.customer_id && existingUserSub.customer_id !== subData.customer_id) {
            safeLog.warn(
              "[Netlify /billing-razorpay-verify] Customer mismatch for user:",
              JSON.stringify({ subscriptionId, sessionUserId: user.id })
            );
            return {
              statusCode: 403,
              headers,
              body: JSON.stringify({
                error: "Mandate customer mismatch for user",
                code: "CUSTOMER_OWNERSHIP_MISMATCH",
              }),
            };
          }
        }

        // 6. DB Record cross-link check
        const { data: crossSub } = await supabaseAdmin
          .from("subscriptions")
          .select("user_id")
          .or(`subscription_id.eq.${subscriptionId},metadata->>razorpay_subscription_id.eq.${subscriptionId},metadata->>subscription_id.eq.${subscriptionId}`)
          .neq("user_id", user.id)
          .maybeSingle();

        if (crossSub && crossSub.user_id !== user.id) {
          safeLog.warn(
            "[Netlify /billing-razorpay-verify] Mandate cross-linked in subscriptions:",
            JSON.stringify({ subscriptionId, sessionUserId: user.id })
          );
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({
              error: "Mandate already attached to another user",
              code: "MANDATE_ATTACHED_TO_ANOTHER_USER",
            }),
          };
        }

        const { data: crossOrder } = await supabaseAdmin
          .from("payment_orders")
          .select("user_id")
          .eq("provider_order_id", subscriptionId)
          .neq("user_id", user.id)
          .maybeSingle();

        if (crossOrder && crossOrder.user_id !== user.id) {
          safeLog.warn(
            "[Netlify /billing-razorpay-verify] Mandate cross-linked in payment_orders:",
            JSON.stringify({ subscriptionId, sessionUserId: user.id })
          );
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({
              error: "Mandate already attached to another user",
              code: "MANDATE_ATTACHED_TO_ANOTHER_USER",
            }),
          };
        }

        // 7. Check mode
        const subMode = orderRow?.mode || (subscriptionId.startsWith("sub_test_") ? "test" : "live");
        if (subMode !== serverMode) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: `Order mode mismatch: cannot verify ${subMode} order with ${serverMode} credentials`,
              code: "MODE_MISMATCH",
            }),
          };
        }

        // 8. Idempotency: already paid returns cleanly
        if (orderRow?.status === "paid") {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              success: true,
              message: "Subscription already verified and active",
              alreadyPaid: true,
              testMode: serverMode === "test",
              isPro: serverMode === "live",
              subscriptionId,
            }),
          };
        }

        // 9. Atomic fulfillment via fulfil_subscription_renewal RPC
        const { data: fulfilRes, error: fulfilErr } = await supabaseAdmin.rpc("fulfil_subscription_renewal", {
          p_razorpay_subscription_id: subscriptionId,
          p_payment_id: paymentId,
          p_expected_mode: serverMode,
        });

        if (fulfilErr) {
          safeLog.error("[Netlify /billing-razorpay-verify] Subscription renewal fulfillment RPC error:", fulfilErr);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
              error: "Subscription fulfillment failed",
              code: "FULFILLMENT_FAILED",
            }),
          };
        }

        if (!fulfilRes || !fulfilRes.success) {
          if (fulfilRes?.code === "MANDATE_ATTACHED_TO_ANOTHER_USER") {
            return {
              statusCode: 403,
              headers,
              body: JSON.stringify({
                error: fulfilRes.error || "Mandate attached to another user",
                code: "MANDATE_ATTACHED_TO_ANOTHER_USER",
              }),
            };
          }
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: fulfilRes?.error || "Subscription fulfillment failed",
              code: fulfilRes?.code || "FULFILLMENT_FAILED",
            }),
          };
        }

        if (subData?.customer_id) {
          await supabaseAdmin
            .from("subscriptions")
            .update({
              customer_id: subData.customer_id,
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", user.id);
        }

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            ...fulfilRes,
            success: true,
            isPro: serverMode === "live",
            testMode: serverMode === "test",
            subscriptionId,
            paymentId,
          }),
        };
      }

      // HMAC-SHA256 signature verification with constant-time comparison for one-time order
      const expectedSignature = crypto
        .createHmac("sha256", keySecret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      if (!constantTimeCompare(expectedSignature, signature)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Invalid payment signature",
            code: "INVALID_SIGNATURE",
          }),
        };
      }

      // Check if order exists for ANY user in payment_orders
      const { data: anyOrder } = await supabaseAdmin
        .from("payment_orders")
        .select("user_id")
        .eq("provider_order_id", orderId!)
        .maybeSingle();

      if (anyOrder && anyOrder.user_id !== user.id) {
        safeLog.warn(
          "[Netlify /billing-razorpay-verify] Order ownership mismatch:",
          JSON.stringify({ orderId, sessionUserId: user.id })
        );
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({
            error: "Payment order belongs to another user",
            code: "ORDER_OWNERSHIP_MISMATCH",
          }),
        };
      }

      // Match the order row in payment_orders table belonging to this user
      const { data: orderRow, error: orderErr } = await supabaseAdmin
        .from("payment_orders")
        .select("*")
        .eq("provider_order_id", orderId!)
        .eq("user_id", user.id)
        .maybeSingle();

      if (orderErr || !orderRow) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({
            error: "Payment order record not found or access denied",
            code: "ORDER_NOT_FOUND",
          }),
        };
      }

      // Check provider
      if (orderRow.provider && orderRow.provider !== "razorpay") {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Invalid payment provider",
            code: "INVALID_PROVIDER",
          }),
        };
      }

      // Check order mode vs server mode
      const orderMode = orderRow.mode || (orderRow.provider_order_id?.startsWith("order_test_") ? "test" : "live");
      if (orderMode !== serverMode) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: `Order mode mismatch: cannot verify ${orderMode} order with ${serverMode} credentials`,
            code: "MODE_MISMATCH",
          }),
        };
      }

      // Symmetric null-safe tamper detection
      const payloadAmount = body.amount;
      if (payloadAmount !== undefined && payloadAmount !== null) {
        const numAmount = Number(payloadAmount);
        if (isNaN(numAmount) || numAmount !== (orderRow.amount_paise ?? null)) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: "Payment amount does not match recorded order amount",
              code: "AMOUNT_MISMATCH",
            }),
          };
        }
      }

      const isAddonOrder = Boolean(orderRow.addon_code);
      const payloadAddon = body.addonCode ?? body.addon_code;
      if (payloadAddon !== undefined && payloadAddon !== null) {
        if (payloadAddon !== (orderRow.addon_code ?? null)) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: "Addon code does not match recorded order",
              code: "ADDON_MISMATCH",
            }),
          };
        }
      }

      const expectedItem = isAddonOrder ? orderRow.addon_code : (orderRow.plan_code ?? null);
      const payloadPlan = body.planCode ?? body.plan_code;
      if (payloadPlan !== undefined && payloadPlan !== null) {
        if (payloadPlan !== expectedItem) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: "Plan code does not match recorded order",
              code: "PLAN_MISMATCH",
            }),
          };
        }
      }

      const payloadPlanId = body.planId ?? body.plan_id;
      if (payloadPlanId !== undefined && payloadPlanId !== null) {
        if (payloadPlanId !== expectedItem) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              error: "Plan ID does not match recorded order",
              code: "PLAN_MISMATCH",
            }),
          };
        }
      }

      if (!orderRow.plan_code && !orderRow.addon_code) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Order record is missing valid plan or addon item",
            code: "INVALID_ORDER_STATE",
          }),
        };
      }

      // Idempotency: a second verify on an already paid order returns without granting again
      if (orderRow.status === "paid") {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            alreadyPaid: true,
            testMode: serverMode === "test",
            isPro: serverMode === "live" && Boolean(orderRow.plan_code),
            message: "Order already verified and paid",
            orderId: orderRow.id,
          }),
        };
      }

      // Atomic fulfillment via Postgres RPC function
      const { data: fulfilRes, error: fulfilErr } = await supabaseAdmin.rpc("fulfil_payment_order", {
        p_provider_order_id: orderId,
        p_user_id: user.id,
        p_expected_mode: serverMode,
      });

      if (fulfilErr) {
        safeLog.error("[Netlify /billing-razorpay-verify] fulfil_payment_order RPC error:", fulfilErr);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({
            error: "Payment fulfillment failed",
            code: "FULFILLMENT_FAILED",
          }),
        };
      }

      if (!fulfilRes || !fulfilRes.success) {
        return {
          statusCode: fulfilRes?.code === "PRO_REQUIRED" ? 403 : 400,
          headers,
          body: JSON.stringify({
            error: fulfilRes?.error || "Payment fulfillment failed",
            code: fulfilRes?.code || "FULFILLMENT_FAILED",
          }),
        };
      }

      if (serverMode === "test") {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            ...fulfilRes,
            testMode: true,
            isPro: false,
          }),
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ...fulfilRes,
          testMode: false,
          isPro: Boolean(fulfilRes.is_pro ?? orderRow.plan_code),
        }),
      };
    } catch (err: any) {
      safeLog.error("[Netlify /billing-razorpay-verify]", err);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err?.message || "Internal server error" }),
      };
    }
  };
}

export const handler = createHandler();
