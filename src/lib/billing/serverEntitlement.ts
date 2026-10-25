import { createClient } from "@supabase/supabase-js";
import { ProAccessStatus, PLAN_DOMESTIC, PLAN_INTERNATIONAL, UserTier } from "./types";
import { verifyLaunchPass } from "./launchPass";

export interface ServerEntitlementOptions {
  launchPass?: string | null;
  env?: Record<string, any>;
  headers?: Headers | Record<string, any>;
}

/**
 * Shared server-side helper: The SINGLE source of truth for Pro entitlement.
 * Reads server-managed Supabase `subscriptions` table and validates server-signed launch passes.
 * Strictly ignores user_metadata, localStorage, query params, or any client-editable fields.
 * Fails closed to tier="none" on any missing credentials, error, or unverified state.
 */
export async function getServerEntitlement(
  userId: string,
  options?: ServerEntitlementOptions
): Promise<ProAccessStatus> {
  const freeDefault: ProAccessStatus = {
    tier: "none",
    canAccessListings: false,
    canAccessScores: false,
    canAccessAi: false,
    isPro: false,
    status: "none",
    planName: "Free Tier",
    inGracePeriod: false,
  };

  if (!userId || typeof userId !== "string") {
    return freeDefault;
  }

  try {
    const supabaseUrl =
      options?.env?.NEXT_PUBLIC_SUPABASE_URL ||
      options?.env?.SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      "https://szakevhxhwpeskidvtfs.supabase.co";
    const serviceRoleKey =
      options?.env?.SUPABASE_SERVICE_ROLE_KEY ||
      options?.env?.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY;

    if (supabaseUrl && serviceRoleKey) {
      const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false },
      });

      const { data: sub, error } = await supabaseAdmin
        .from("subscriptions")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!error && sub) {
        const now = new Date();
        const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
        const graceEnd = sub.grace_period_end ? new Date(sub.grace_period_end) : null;

        const isListingsOnly = Boolean(sub.plan_id && sub.plan_id.includes("listings"));
        const tier: UserTier = isListingsOnly ? "listings" : "ai";

        // 1. In Grace Period check (7 days past expiration)
        if (sub.status === "in_grace_period" && graceEnd) {
          const diffMs = graceEnd.getTime() - now.getTime();
          const daysLeft = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

          if (diffMs > 0) {
            return {
              tier,
              canAccessListings: true,
              canAccessScores: tier === "ai",
              canAccessAi: tier === "ai",
              isPro: true,
              status: "in_grace_period",
              planName:
                sub.plan_id === PLAN_INTERNATIONAL.id
                  ? PLAN_INTERNATIONAL.name
                  : isListingsOnly
                  ? "Listings Pass"
                  : PLAN_DOMESTIC.name,
              inGracePeriod: true,
              graceDaysLeft: daysLeft,
              expirationDate: graceEnd.toISOString(),
            };
          }
        }

        // 2. Active or Trialing subscription check
        if (sub.status === "active" || sub.status === "trialing") {
          if (!periodEnd || periodEnd > now) {
            return {
              tier,
              canAccessListings: true,
              canAccessScores: tier === "ai",
              canAccessAi: tier === "ai",
              isPro: true,
              status: sub.status,
              planName:
                sub.plan_id === PLAN_INTERNATIONAL.id
                  ? PLAN_INTERNATIONAL.name
                  : isListingsOnly
                  ? "Listings Pass"
                  : PLAN_DOMESTIC.name,
              inGracePeriod: false,
              expirationDate: periodEnd ? periodEnd.toISOString() : undefined,
            };
          }
        }
      }
    }
  } catch (err) {
    console.error("[getServerEntitlement] Unexpected error checking subscription DB:", err);
  }

  // 3. Fallback to server-signed launch pass verification (No customer payments mode)
  try {
    let launchPass = options?.launchPass;
    if (!launchPass && options?.headers) {
      if (typeof (options.headers as Headers).get === "function") {
        launchPass = (options.headers as Headers).get("x-cm-launch-pass");
        if (!launchPass) {
          const cookieHeader = (options.headers as Headers).get("cookie") || "";
          const match = cookieHeader.match(/cm_launch_pass=([^;]+)/);
          if (match) launchPass = decodeURIComponent(match[1].trim());
        }
      } else {
        const h = options.headers as Record<string, string>;
        launchPass = h["x-cm-launch-pass"] || h["X-CM-LAUNCH-PASS"];
        if (!launchPass && (h["cookie"] || h["Cookie"])) {
          const cookieHeader = h["cookie"] || h["Cookie"] || "";
          const match = cookieHeader.match(/cm_launch_pass=([^;]+)/);
          if (match) launchPass = decodeURIComponent(match[1].trim());
        }
      }
    }

    if (launchPass) {
      const passResult = await verifyLaunchPass(launchPass, userId, options?.env);
      if (passResult.valid && passResult.tier) {
        const tier = passResult.tier;
        return {
          tier,
          canAccessListings: true,
          canAccessScores: tier === "ai",
          canAccessAi: tier === "ai",
          isPro: true,
          status: "active",
          planName: tier === "ai" ? "Launch AI Pass" : "Launch Listings Pass",
          inGracePeriod: false,
          expirationDate: passResult.expiresAt,
        };
      }
    }
  } catch (passErr) {
    console.error("[getServerEntitlement] Error checking launch pass:", passErr);
  }

  return freeDefault;
}
