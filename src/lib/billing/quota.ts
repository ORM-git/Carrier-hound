import { createClient } from "@supabase/supabase-js";
import { getServerEntitlement } from "./serverEntitlement";

export type PlanCode = "weekly" | "monthly" | "quarterly";

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  duration_days: number;
  price_paise: number;
  resume_quota: number;
  cover_letter_quota: number;
  quota_period_days: number;
  daily_generation_cap: number;
  sort_order: number;
  is_active: boolean;
}

export const PLAN_DEFINITIONS: Record<PlanCode, PlanDefinition> = {
  weekly: {
    code: "weekly",
    name: "Weekly",
    duration_days: 7,
    price_paise: 49900,
    resume_quota: 15,
    cover_letter_quota: 15,
    quota_period_days: 7,
    daily_generation_cap: 30,
    sort_order: 1,
    is_active: true,
  },
  monthly: {
    code: "monthly",
    name: "Monthly",
    duration_days: 30,
    price_paise: 149900,
    resume_quota: 60,
    cover_letter_quota: 60,
    quota_period_days: 30,
    daily_generation_cap: 30,
    sort_order: 2,
    is_active: true,
  },
  quarterly: {
    code: "quarterly",
    name: "Quarterly",
    duration_days: 90,
    price_paise: 399900,
    resume_quota: 60,
    cover_letter_quota: 60,
    quota_period_days: 30,
    daily_generation_cap: 30,
    sort_order: 3,
    is_active: true,
  },
};

export interface AddonPackDefinition {
  code: string;
  name: string;
  price_paise: number;
  sets: number;
  validity_days: number;
  is_active: boolean;
}

export const ADDON_PACK_DEFINITIONS: Record<string, AddonPackDefinition> = {
  addon_10: {
    code: "addon_10",
    name: "10 Extra Sets",
    price_paise: 14900,
    sets: 10,
    validity_days: 60,
    is_active: true,
  },
  addon_30: {
    code: "addon_30",
    name: "30 Extra Sets",
    price_paise: 39900,
    sets: 30,
    validity_days: 60,
    is_active: true,
  },
  addon_60: {
    code: "addon_60",
    name: "60 Extra Sets",
    price_paise: 69900,
    sets: 60,
    validity_days: 60,
    is_active: true,
  },
};

export interface ResolvedOrderPricing {
  type: "plan" | "addon";
  code: string;
  name: string;
  amount_paise: number;
  currency: "INR";
  duration_days?: number;
  sets?: number;
}

/**
 * Server-authoritative order price resolution.
 * Ignores any client-supplied amount; retrieves exact price_paise from plans/addon_packs catalog.
 */
export function resolveOrderPricing(input: {
  planCode?: string | null;
  planId?: string | null;
  addonCode?: string | null;
}): ResolvedOrderPricing | null {
  if (input.addonCode) {
    const addon = ADDON_PACK_DEFINITIONS[input.addonCode];
    if (!addon) return null;
    return {
      type: "addon",
      code: addon.code,
      name: addon.name,
      amount_paise: addon.price_paise,
      currency: "INR",
      sets: addon.sets,
    };
  }

  const rawPlan = input.planCode || input.planId;
  if (rawPlan) {
    const normalized = rawPlan.toLowerCase().trim();
    let code: PlanCode | null = null;
    if (normalized === "weekly" || normalized.includes("week")) {
      code = "weekly";
    } else if (normalized === "quarterly" || normalized.includes("quarter") || normalized.includes("3_month")) {
      code = "quarterly";
    } else if (
      normalized === "monthly" ||
      normalized.includes("month") ||
      normalized === "domestic_monthly_199" ||
      normalized === "intl_monthly_9"
    ) {
      code = "monthly";
    } else {
      return null;
    }

    const plan = PLAN_DEFINITIONS[code];
    if (!plan) return null;
    return {
      type: "plan",
      code: plan.code,
      name: plan.name,
      amount_paise: plan.price_paise,
      currency: "INR",
      duration_days: plan.duration_days,
    };
  }

  return null;
}

export interface PlanQuotaResult {
  planCode: PlanCode | null;
  periodStart: string | null;
  periodEnd: string | null;
  resumesRemaining: number;
  coverLettersRemaining: number;
  generationsToday: number;
  dailyCap: number;
  addonSetsRemaining: number;
}

export const FREE_QUOTA_DEFAULT: PlanQuotaResult = {
  planCode: null,
  periodStart: null,
  periodEnd: null,
  resumesRemaining: 0,
  coverLettersRemaining: 0,
  generationsToday: 0,
  dailyCap: 0,
  addonSetsRemaining: 0,
};

/**
 * Maps a subscription plan_id (including legacy IDs such as domestic_monthly_199)
 * to a canonical plan code ('weekly', 'monthly', or 'quarterly').
 */
export function mapPlanIdToCode(planId?: string | null): PlanCode {
  if (!planId) return "monthly";
  const normalized = planId.toLowerCase().trim();
  if (normalized === "weekly" || normalized.includes("week")) {
    return "weekly";
  }
  if (normalized === "quarterly" || normalized.includes("quarter")) {
    return "quarterly";
  }
  // Unknown or legacy ids (domestic_monthly_199, intl_monthly_9, etc.) map to monthly
  return "monthly";
}

/**
 * Computes the active quota period bounds by stepping in quota_period_days increments
 * from the subscription start date until reaching the current time window.
 */
export function calculateQuotaPeriod(
  subStart: Date,
  subEnd: Date,
  quotaPeriodDays: number,
  now: Date = new Date()
): { periodStart: Date; periodEnd: Date } {
  const stepMs = Math.max(1, quotaPeriodDays) * 24 * 60 * 60 * 1000;

  if (now.getTime() < subStart.getTime()) {
    return {
      periodStart: new Date(subStart),
      periodEnd: new Date(Math.min(subStart.getTime() + stepMs, subEnd.getTime())),
    };
  }

  const elapsedMs = now.getTime() - subStart.getTime();
  const totalDurationMs = Math.max(0, subEnd.getTime() - subStart.getTime());

  // Clamp stepIndex so periodStart does not exceed subEnd
  const maxStepIndex = Math.max(0, Math.floor((totalDurationMs - 1) / stepMs));
  const stepIndex = Math.min(Math.floor(elapsedMs / stepMs), maxStepIndex);

  const periodStartTime = subStart.getTime() + stepIndex * stepMs;
  const periodEndTime = Math.min(periodStartTime + stepMs, subEnd.getTime());

  return {
    periodStart: new Date(periodStartTime),
    periodEnd: new Date(periodEndTime),
  };
}

/**
 * Sums remaining sets from non-expired user add-on credits.
 */
export function sumValidAddonCredits(
  credits: Array<{ sets_remaining: number; expires_at: string | Date }>,
  now: Date = new Date()
): number {
  const nowMs = now.getTime();
  return credits.reduce((sum, item) => {
    const expMs = new Date(item.expires_at).getTime();
    if (expMs > nowMs && item.sets_remaining > 0) {
      return sum + item.sets_remaining;
    }
    return sum;
  }, 0);
}

/**
 * Core server-side helper: Reads plan quota and credits for a user.
 * - Free users strictly receive zeros.
 * - Pro users resolve plan code, stepping quota period, usage events, and active add-on sets.
 */
export async function getPlanQuota(
  userId: string,
  now: Date = new Date()
): Promise<PlanQuotaResult> {
  if (!userId || typeof userId !== "string") {
    return FREE_QUOTA_DEFAULT;
  }

  try {
    // 1. Verify Pro entitlement via the single source of truth
    const entitlement = await getServerEntitlement(userId);
    if (!entitlement.isPro) {
      return FREE_QUOTA_DEFAULT;
    }

    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      "https://szakevhxhwpeskidvtfs.supabase.co";
    const serviceRoleKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      console.warn("[getPlanQuota] Missing Supabase service credentials on server");
      return FREE_QUOTA_DEFAULT;
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    // 2. Fetch latest subscription record
    const { data: sub, error: subError } = await supabaseAdmin
      .from("subscriptions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (subError || !sub) {
      return FREE_QUOTA_DEFAULT;
    }

    // 3. Resolve plan code and definition
    const planCode = mapPlanIdToCode(sub.plan_id);
    let plan = PLAN_DEFINITIONS[planCode] || PLAN_DEFINITIONS.monthly;

    // Optional dynamic override from plans table if present
    try {
      const { data: dbPlan } = await supabaseAdmin
        .from("plans")
        .select("*")
        .eq("code", planCode)
        .maybeSingle();
      if (dbPlan) {
        plan = {
          code: dbPlan.code,
          name: dbPlan.name,
          duration_days: dbPlan.duration_days,
          price_paise: dbPlan.price_paise,
          resume_quota: dbPlan.resume_quota,
          cover_letter_quota: dbPlan.cover_letter_quota,
          quota_period_days: dbPlan.quota_period_days ?? 30,
          daily_generation_cap: dbPlan.daily_generation_cap ?? 30,
          sort_order: dbPlan.sort_order ?? 0,
          is_active: dbPlan.is_active ?? true,
        };
      }
    } catch {
      // Fallback cleanly to PLAN_DEFINITIONS if plans table does not exist yet
    }

    // 4. Calculate stepped quota period
    const subStart = new Date(sub.current_period_start || sub.created_at || now.toISOString());
    const subEnd = sub.current_period_end
      ? new Date(sub.current_period_end)
      : new Date(subStart.getTime() + plan.duration_days * 24 * 60 * 60 * 1000);

    const { periodStart, periodEnd } = calculateQuotaPeriod(
      subStart,
      subEnd,
      plan.quota_period_days,
      now
    );

    // 5. Query plan usage events since current period start
    let resumesUsed = 0;
    let coverLettersUsed = 0;
    try {
      const { data: events } = await supabaseAdmin
        .from("plan_usage_events")
        .select("kind")
        .eq("user_id", userId)
        .eq("source", "plan")
        .gte("created_at", periodStart.toISOString());

      if (events && Array.isArray(events)) {
        for (const ev of events) {
          if (ev.kind === "resume_tailor") resumesUsed++;
          else if (ev.kind === "cover_letter") coverLettersUsed++;
        }
      }
    } catch {
      // Table may not exist yet on unmigrated instances
    }

    const resumesRemaining = Math.max(0, plan.resume_quota - resumesUsed);
    const coverLettersRemaining = Math.max(0, plan.cover_letter_quota - coverLettersUsed);

    // 6. Query non-expired add-on credits
    let addonSetsRemaining = 0;
    try {
      const { data: addonCredits } = await supabaseAdmin
        .from("user_addon_credits")
        .select("sets_remaining, expires_at")
        .eq("user_id", userId)
        .gt("expires_at", now.toISOString())
        .gt("sets_remaining", 0);

      if (addonCredits && Array.isArray(addonCredits)) {
        addonSetsRemaining = sumValidAddonCredits(addonCredits, now);
      }
    } catch {
      // Table may not exist yet
    }

    // 7. Query today's generation counts from ai_usage_quotas
    let generationsToday = 0;
    const today = now.toISOString().split("T")[0];
    try {
      const { data: quotaRows } = await supabaseAdmin
        .from("ai_usage_quotas")
        .select("count")
        .eq("user_id", userId)
        .eq("period_date", today);

      if (quotaRows && Array.isArray(quotaRows)) {
        generationsToday = quotaRows.reduce((acc, row) => acc + (row.count || 0), 0);
      }
    } catch {
      // Graceful fallback
    }

    const dailyCap = plan.daily_generation_cap || 30;

    return {
      planCode,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      resumesRemaining,
      coverLettersRemaining,
      generationsToday,
      dailyCap,
      addonSetsRemaining,
    };
  } catch (err) {
    console.error("[getPlanQuota] Unexpected error:", err);
    return FREE_QUOTA_DEFAULT;
  }
}
