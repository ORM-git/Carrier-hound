import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { resolveOrderPricing } from "@/lib/billing/quota";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";
import { getRazorpayKeyMode } from "@/lib/billing/mode";

import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";

import { createLogger } from "@/lib/observability/logger";

const baseLog = createLogger({ context: { route: "/api/billing/razorpay/order" } });

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
    if (process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") {
      return NextResponse.json(
        { error: "Billing is currently unavailable", code: "BILLING_DISABLED" },
        { status: 503 }
      );
    }

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

      // Verify user session token
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

    // Server-authoritative mode & key validation (Audit Blocker B2)
    // 1. Explicit env var RAZORPAY_MODE is strictly required: allowed values "test" or "live".
    // If unset or any other value, return 503 with generic config error (never env var name or value).
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

    const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      log.error("Payment configuration error: missing credentials");
      return NextResponse.json(
        {
          error: "Payment configuration error",
          code: "RAZORPAY_CONFIG_ERROR",
        },
        { status: 503 }
      );
    }

    // 2. Mode must match configured key prefix:
    // RAZORPAY_MODE=test requires an rzp_test_ key
    // RAZORPAY_MODE=live requires an rzp_live_ key
    // Any mismatch returns the same 503 config error.
    const resolvedMode = getRazorpayKeyMode(keyId);
    const expectedPrefix = configuredMode === "test" ? "rzp_test_" : "rzp_live_";
    if (!keyId.startsWith(expectedPrefix) || resolvedMode !== configuredMode) {
      log.error("Payment configuration error: key prefix does not match configured mode");
      return NextResponse.json(
        {
          error: "Payment configuration error",
          code: "RAZORPAY_CONFIG_ERROR",
        },
        { status: 503 }
      );
    }

    // 3. On production host (careermonke.com and www.careermonke.com), refuse rzp_test_ keys even if RAZORPAY_MODE=test.
    if (
      isProductionHost(req, deps) &&
      (keyId.startsWith("rzp_test_") || configuredMode === "test")
    ) {
      log.error("FATAL CONFIGURATION ERROR: Razorpay test keys refused on production host");
      return NextResponse.json(
        {
          error: "Payment configuration error",
          code: "RAZORPAY_CONFIG_ERROR",
        },
        { status: 503 }
      );
    }

    const body = await req.json().catch(() => ({}));
    // Resolve server-authoritative price from plans/addon_packs catalog, ignoring any client amount
    const pricing = resolveOrderPricing({
      planCode: body.planCode,
      planId: body.planId || (!body.addonCode && !body.planCode ? "monthly" : undefined),
      addonCode: body.addonCode,
    });

    if (!pricing) {
      return NextResponse.json({ error: "Invalid plan or addon code" }, { status: 400 });
    }

    // Add-ons require active Pro subscription
    if (pricing.type === "addon") {
      const entitlementChecker = deps.getServerEntitlement || getServerEntitlement;
      const entitlement = await entitlementChecker(user.id);
      if (!entitlement?.isPro) {
        return NextResponse.json(
          {
            error: "Add-on packs require an active Pro subscription",
            code: "PRO_REQUIRED",
          },
          { status: 403 }
        );
      }
    }

    const amountInPaise = pricing.amount_paise;
    const currency = pricing.currency;
    const receipt = `rcpt_${user.id.slice(0, 8)}_${Date.now()}`;

    // Call Razorpay REST API
    const credentials = btoa(`${keyId}:${keySecret}`);
    const fetchCaller = deps.fetchFn || fetch;
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
      return NextResponse.json(
        { error: err.error?.description || "Failed to create Razorpay order" },
        { status: rzpRes.status || 500 }
      );
    }

    const orderData = await rzpRes.json();

    // Record order in payment_orders table with status 'created' and resolved server mode
    const { error: insertErr } = await supabaseAdmin.from("payment_orders").insert({
      user_id: user.id,
      provider: "razorpay",
      provider_order_id: orderData.id,
      plan_code: pricing.type === "plan" ? pricing.code : null,
      addon_code: pricing.type === "addon" ? pricing.code : null,
      amount_paise: amountInPaise,
      currency,
      status: "created",
      mode: resolvedMode,
    });

    if (insertErr) {
      log.error("Critical: payment_orders insert failed; failing closed", {
        error: insertErr?.message || String(insertErr),
      });
      return NextResponse.json(
        {
          error: "Failed to initialize order tracking. Please try again.",
          code: "ORDER_RECORD_FAILED",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      orderId: orderData.id,
      amount: orderData.amount,
      currency: orderData.currency,
      keyId,
    });
  } catch (err: any) {
    reportRequestErrorToSentry(req, err);
    return NextResponse.json({ error: err?.message || "Internal server error" }, { status: 500 });
  }
}
