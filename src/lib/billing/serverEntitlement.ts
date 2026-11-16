import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ProAccessStatus } from "./types";
import { singleFlight } from "@/lib/cache/singleFlight";

import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "billing/serverEntitlement" } });

let cachedAdminClient: SupabaseClient | null = null;
let cachedAdminKey = "";
const ENTITLEMENT_CACHE_TTL_MS = 15_000;
const entitlementCache = new Map<string, { status: ProAccessStatus; expiresAt: number }>();

function getAdminClient(url: string, key: string): SupabaseClient {
  const cacheKey = `${url}::${key}`;
  if (cachedAdminClient && cachedAdminKey === cacheKey && process.env.NODE_ENV !== "test") {
    return cachedAdminClient;
  }
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  cachedAdminClient = client;
  cachedAdminKey = cacheKey;
  return client;
}

function resolvePlanName(planId?: string | null): string {
  if (!planId) return "Pro Member";
  const normalized = planId.toLowerCase();
  if (normalized.includes("week")) return "Weekly";
  if (normalized.includes("quarter")) return "Quarterly";
  if (normalized.includes("month") || normalized === "monthly" || normalized === "domestic_monthly_199") return "Monthly";
  return "Pro Member";
}

/**
 * Shared server-side helper: The SINGLE source of truth for Pro entitlement.
 * Reads ONLY from the server-managed Supabase `subscriptions` table.
 * Strictly ignores user_metadata, localStorage, or any client-editable fields.
 */
export async function getServerEntitlement(userId: string): Promise<ProAccessStatus> {
  const freeDefault: ProAccessStatus = {
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
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      "https://szakevhxhwpeskidvtfs.supabase.co";
    const serviceRoleKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      log.warn("[getServerEntitlement] Missing Supabase service credentials on server");
      return freeDefault;
    }

    if (process.env.NODE_ENV !== "test") {
      const cached = entitlementCache.get(userId);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.status;
      }
    }

    const supabaseAdmin = getAdminClient(supabaseUrl, serviceRoleKey);

    const { data: sub, error } = await singleFlight(`entitlement:${userId}`, async () =>
      supabaseAdmin
        .from("subscriptions")
        .select("status, plan_id, current_period_end, grace_period_end")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    );

    if (error || !sub) {
      if (process.env.NODE_ENV !== "test") {
        entitlementCache.set(userId, { status: freeDefault, expiresAt: Date.now() + ENTITLEMENT_CACHE_TTL_MS });
      }
      return freeDefault;
    }

    const now = new Date();
    const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
    const graceEnd = sub.grace_period_end ? new Date(sub.grace_period_end) : null;

    // 1. In Grace Period check (7 days past expiration)
    if (sub.status === "in_grace_period" && graceEnd) {
      const diffMs = graceEnd.getTime() - now.getTime();
      const daysLeft = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

      if (diffMs > 0) {
        const result: ProAccessStatus = {
          isPro: true,
          status: "in_grace_period",
          planName: resolvePlanName(sub.plan_id),
          inGracePeriod: true,
          graceDaysLeft: daysLeft,
          expirationDate: graceEnd.toISOString(),
        };
        if (process.env.NODE_ENV !== "test") {
          entitlementCache.set(userId, { status: result, expiresAt: Date.now() + ENTITLEMENT_CACHE_TTL_MS });
        }
        return result;
      }
    }

    // 2. Active or Trialing subscription check
    if (sub.status === "active" || sub.status === "trialing") {
      if (!periodEnd || periodEnd > now) {
        const result: ProAccessStatus = {
          isPro: true,
          status: sub.status,
          planName: resolvePlanName(sub.plan_id),
          inGracePeriod: false,
          expirationDate: periodEnd ? periodEnd.toISOString() : undefined,
        };
        if (process.env.NODE_ENV !== "test") {
          entitlementCache.set(userId, { status: result, expiresAt: Date.now() + ENTITLEMENT_CACHE_TTL_MS });
        }
        return result;
      }
    }
  } catch (err) {
    log.error("[getServerEntitlement] Unexpected error checking entitlement:", { error: err });
  }

  return freeDefault;
}
