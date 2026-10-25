import { createClient } from "@supabase/supabase-js";
import { ProAccessStatus, PLAN_DOMESTIC, PLAN_INTERNATIONAL, UserTier } from "./types";
import { verifyLaunchPass } from "./launchPass";

export interface ServerEntitlementOptions {
  launchPass?: string | null;
  env?: Record<string, any>;
  headers?: Headers | Record<string, any> | null;
  supabaseClient?: any;
}

async function computeSha256Hex(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(str));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Shared server-side helper: The SINGLE source of truth for Pro entitlement.
 * 
 * 1. Checks server-managed Supabase `subscriptions` table for active/trialing/grace-period paid subscribers.
 * 2. If no paid subscription, verifies server-signed launch passes AND requires server-side registry confirmation.
 * 3. Fails closed to tier="none" on any missing credentials, unverified state, or missing server registry.
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
    }
  } catch (err) {
    console.error("[getServerEntitlement] Unexpected error checking subscription DB:", err);
  }

  // 3. Fallback to server-signed launch pass verification (No customer payments mode)
  // CRITICAL SECURITY CONTROL:
  // Stateless signed tokens alone do NOT grant access without server-side registry confirmation.
  // Missing registry schema or missing grant record fails closed to freeDefault.
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
        // Server-Side Registry Validation:
        // A proposed SQL file is not deployed protection. Verify token hash against public.launch_passes.
        let registryConfirmed = false;
        if (supabaseAdmin) {
          try {
            const tokenHash = await computeSha256Hex(launchPass);
            const { data: regEntry, error: regError } = await supabaseAdmin
              .from("launch_passes")
              .select("id, revoked_at, expires_at")
              .eq("token_hash", tokenHash)
              .eq("user_id", userId)
              .maybeSingle();

            if (!regError && regEntry && !regEntry.revoked_at) {
              const expTime = new Date(regEntry.expires_at).getTime();
              if (Date.now() <= expTime) {
                registryConfirmed = true;
              }
            }
          } catch {
            registryConfirmed = false;
          }
        }

        // When registry is missing/unmigrated or token is not confirmed in the registry:
        // Fail closed. Stateless tokens must not bypass the server registry.
        if (!registryConfirmed) {
          return freeDefault;
        }

        const tier = passResult.tier;
        return {
          tier,
          canAccessListings: true,
          canAccessScores: tier === "ai",
          canAccessAi: tier === "ai",
          isPro: true,
          status: "none", // Separate from paid subscription
          accessSource: "launch_pass",
          planName: tier === "ai" ? "Launch Access (AI Tier)" : "Launch Access (Listings Tier)",
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
