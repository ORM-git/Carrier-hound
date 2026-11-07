import { createClient } from "@supabase/supabase-js";
import { ProAccessStatus } from "./types";

import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "billing/serverEntitlement" } });

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

    if (error || !sub) {
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
        return {
          isPro: true,
          status: "in_grace_period",
          planName: resolvePlanName(sub.plan_id),
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
          isPro: true,
          status: sub.status,
          planName: resolvePlanName(sub.plan_id),
          inGracePeriod: false,
          expirationDate: periodEnd ? periodEnd.toISOString() : undefined,
        };
      }
    }
  } catch (err) {
    log.error("[getServerEntitlement] Unexpected error checking entitlement:", { error: err });
  }

  return freeDefault;
}
