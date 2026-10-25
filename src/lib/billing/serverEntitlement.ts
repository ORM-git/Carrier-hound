import { createClient } from "@supabase/supabase-js";
import { ProAccessStatus, PLAN_DOMESTIC, PLAN_INTERNATIONAL, UserTier } from "./types";

export interface ServerEntitlementOptions {
  launchPass?: string | null;
  env?: Record<string, any>;
  headers?: Headers | Record<string, any> | null;
  supabaseClient?: any;
}

/**
 * Shared server-side helper: The SINGLE source of truth for Pro entitlement.
 * 
 * 1. Checks server-managed Supabase `subscriptions` table for active/trialing/grace-period paid subscribers.
 *    Existing paid subscribers retain their full rights completely unchanged.
 * 2. Otherwise verifies simple server-backed launch access:
 *    - Server launch policy must be explicitly enabled (launch_policy.is_enabled = true).
 *    - User must have a valid server-stored selection (user_launch_access.tier IN ('listings', 'ai')).
 *    - User must NOT be revoked for abuse (user_launch_access.revoked_at IS NULL).
 * 3. Fails closed to tier="none" on any missing credentials, unverified state, lookup error, or missing policy.
 * 4. Old signed-pass path is superseded and disabled. No client flags or forgeable tokens can grant access.
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
    accessSource: "none",
    planName: "Free Tier",
    inGracePeriod: false,
  };

  if (!userId || typeof userId !== "string") {
    return freeDefault;
  }

  let supabaseAdmin: any = options?.supabaseClient || null;

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

    if (!supabaseAdmin && supabaseUrl && serviceRoleKey) {
      supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false },
      });
    }

    if (supabaseAdmin) {
      // 1. Existing Paid Subscriptions Check (Highest Precedence)
      const { data: sub, error: subError } = await supabaseAdmin
        .from("subscriptions")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!subError && sub) {
        const now = new Date();
        const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
        const graceEnd = sub.grace_period_end ? new Date(sub.grace_period_end) : null;

        const isListingsOnly = Boolean(sub.plan_id && sub.plan_id.includes("listings"));
        const tier: UserTier = isListingsOnly ? "listings" : "ai";

        // Grace Period check (7 days past expiration)
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
              accessSource: "subscription",
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

        // Active or Trialing subscription check
        if (sub.status === "active" || sub.status === "trialing") {
          if (!periodEnd || periodEnd > now) {
            return {
              tier,
              canAccessListings: true,
              canAccessScores: tier === "ai",
              canAccessAi: tier === "ai",
              isPro: true,
              status: sub.status,
              accessSource: "subscription",
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

      // 2. Server-Backed Launch Access Check (Customer Payments OFF Mode)
      // Requires:
      // a) Server-controlled launch policy is active (launch_policy.is_enabled = true)
      // b) Valid server-stored selection (user_launch_access for this user)
      // c) No server-side abuse revocation (revoked_at IS NULL)
      try {
        const { data: policy, error: policyError } = await supabaseAdmin
          .from("launch_policy")
          .select("is_enabled, allow_ai, allow_listings")
          .limit(1)
          .maybeSingle();

        if (!policyError && policy && policy.is_enabled) {
          const { data: userAccess, error: accessError } = await supabaseAdmin
            .from("user_launch_access")
            .select("id, tier, revoked_at")
            .eq("user_id", userId)
            .maybeSingle();

          if (!accessError && userAccess && !userAccess.revoked_at) {
            const rawTier = userAccess.tier;
            if (rawTier === "ai" || rawTier === "listings") {
              const tier: UserTier =
                rawTier === "ai" && policy.allow_ai !== false ? "ai" : "listings";

              return {
                tier,
                canAccessListings: true,
                canAccessScores: tier === "ai",
                canAccessAi: tier === "ai",
                isPro: true,
                status: "none", // Explicitly not a paid subscription
                accessSource: "launch_access",
                planName:
                  tier === "ai"
                    ? "Launch Access (AI Tier)"
                    : "Launch Access (Listings Tier)",
                inGracePeriod: false,
              };
            }
          }
        }
      } catch (launchAccessErr) {
        // Table unmigrated, lookup error, or policy absent: strictly fails closed
        console.warn("[getServerEntitlement] Launch policy lookup error:", launchAccessErr);
      }
    }
  } catch (err) {
    console.error("[getServerEntitlement] Unexpected error checking entitlement:", err);
  }

  // 3. Fallback: Old signed-pass path is SUPERSEDED and DISABLED.
  // Stateless tokens alone cannot bypass the server database or upgrade access.
  return freeDefault;
}
