import { createClient } from "@supabase/supabase-js";
import { getServerEntitlement } from "./serverEntitlement";
import { PLAN_PRICING, getPlanPricePaise } from "@/config/plans";

import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "billing/quota" } });

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
    duration_days: PLAN_PRICING.weekly.duration_days,
    price_paise: PLAN_PRICING.weekly.price_paise,
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
    duration_days: PLAN_PRICING.monthly.duration_days,
    price_paise: PLAN_PRICING.monthly.price_paise,
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
    duration_days: PLAN_PRICING.quarterly.duration_days,
    price_paise: PLAN_PRICING.quarterly.price_paise,
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
    name: "10 extra generations",
    price_paise: 14900,
    sets: 10,
    validity_days: 60,
    is_active: true,
  },
  addon_30: {
    code: "addon_30",
    name: "30 extra generations",
    price_paise: 39900,
    sets: 30,
    validity_days: 60,
    is_active: true,
  },
  addon_60: {
    code: "addon_60",
    name: "60 extra generations",
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
 * Central plan normalization shared across order pricing and subscription derivation.
 * Ensures "3_month" maps to "quarterly" (2199), not monthly.
 */
export function normalizePlanCode(raw?: string | null): PlanCode | null {
  if (!raw || typeof raw !== "string") return null;
  const rawTrimmed = raw.trim();
  const normalized = rawTrimmed.toLowerCase();
  if (normalized === "weekly" || normalized.includes("week")) {
    return "weekly";
  }
  if (normalized === "quarterly" || normalized.includes("quarter") || normalized.includes("3_month")) {
    return "quarterly";
  }
  if (
    normalized === "monthly" ||
    normalized.includes("month") ||
    normalized === "domestic_monthly_199" ||
    normalized === "intl_monthly_9"
  ) {
    return "monthly";
  }
  return null;
}

/**
 * Server-authoritative order price resolution.
 * Ignores any client-supplied amount; retrieves exact price_paise from plans/addon_packs catalog.
 * Supports first-time monthly purchase (Rs 499) vs repeat monthly purchase (Rs 799).
 */
export function resolveOrderPricing(input: {
  planCode?: string | null;
  planId?: string | null;
  addonCode?: string | null;
  isFirstMonthlyPurchase?: boolean;
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
    const rawTrimmed = rawPlan.trim();
    if (ADDON_PACK_DEFINITIONS[rawTrimmed]) {
      const addon = ADDON_PACK_DEFINITIONS[rawTrimmed];
      return {
        type: "addon",
        code: addon.code,
        name: addon.name,
        amount_paise: addon.price_paise,
        currency: "INR",
        sets: addon.sets,
      };
    }
    const code = normalizePlanCode(rawTrimmed);
    if (!code) {
      return null;
    }

    const plan = PLAN_DEFINITIONS[code];
    if (!plan) return null;

    const isFirst = input.isFirstMonthlyPurchase !== false;
    const amount_paise = getPlanPricePaise(code, isFirst);

    return {
      type: "plan",
      code: plan.code,
      name: plan.name,
      amount_paise,
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
 * Calculates the start of today in Indian Standard Time (IST, UTC+05:30)
 * converted to a UTC Date instance for database timestamp comparisons.
 */
export function getStartOfIstDay(now: Date = new Date()): Date {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffsetMs);
  const istYear = istDate.getUTCFullYear();
  const istMonth = istDate.getUTCMonth();
  const istDay = istDate.getUTCDate();
  return new Date(Date.UTC(istYear, istMonth, istDay) - istOffsetMs);
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
      log.warn("[getPlanQuota] Missing Supabase service credentials on server");
      return FREE_QUOTA_DEFAULT;
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    // 2. Fetch latest subscription record
    const { data: sub, error: subError } = await supabaseAdmin
      .from("subscriptions")
      .select("plan_id, current_period_start, current_period_end, created_at")
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
        .select("code, name, duration_days, price_paise, resume_quota, cover_letter_quota, quota_period_days, daily_generation_cap, sort_order, is_active")
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

    // 7. Query today's generation counts from plan_usage_events over the same IST day window the RPCs use
    let generationsToday = 0;
    const istDayStart = getStartOfIstDay(now).toISOString();
    try {
      const { count, error: usageErr } = await supabaseAdmin
        .from("plan_usage_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("created_at", istDayStart);

      if (!usageErr && typeof count === "number") {
        generationsToday = count;
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
    log.error("[getPlanQuota] Unexpected error:", { error: err });
    return FREE_QUOTA_DEFAULT;
  }
}

export interface MonthlyIntroEligibility {
  isEligible: boolean;
  isFirstMonthlyPurchase: boolean;
  reason?: string;
  reservationId?: string;
}

/**
 * Authoritative, fail-closed first-month intro price eligibility and atomic reservation.
 * Shared by Next.js (/api/billing/razorpay/order) and Netlify (billing-razorpay-order) routes.
 *
 * Rules:
 * 1. Fail-closed: on any DB error, missing admin client, or exception, returns
 *    isFirstMonthlyPurchase: false (charge repeat Rs 799, NEVER the discount).
 * 2. Uses only successful LIVE monthly payment evidence:
 *    - payment_orders with plan_code = 'monthly', status = 'paid', and mode = 'live'.
 *    - Ignores test-mode (mode != 'live'), failed, pending, and unpaid orders.
 * 3. Explicit rule for legacy paid subscriptions:
 *    - subscriptions with normalized plan_id === 'monthly'.
 *    - Must NOT be test mode (metadata->>'mode' !== 'test').
 *    - Must have paid status (active, trialing, in_grace_period, past_due, canceled - NOT unpaid) AND amount > 0.
 * 4. Atomic per-user live promo reservation/claim:
 *    - Two sequential or concurrent monthly orders before first payment cannot both get Rs 499.
 *    - Checks intro_promo_reservations and active pending payment_orders (< 30m old with 49900 paise in live mode).
 *    - Releases cleanly if order is cancelled, failed, or expired (>30m).
 *    - Never alters an order's amount after checkout creation.
 */
export async function checkMonthlyIntroEligibilityAndReserve(
  supabaseAdmin: any,
  userId: string,
  mode: "live" | "test" | string = "live"
): Promise<MonthlyIntroEligibility> {
  // Fail-closed on missing admin client or userId
  if (!supabaseAdmin || !userId || typeof supabaseAdmin.from !== "function") {
    return {
      isEligible: false,
      isFirstMonthlyPurchase: false,
      reason: "ADMIN_CLIENT_UNAVAILABLE",
    };
  }

  const isLive = mode === "live";

  try {
    // 1. Evidence Check A: payment_orders (Only successful LIVE monthly payments count)
    const { data: paidOrders, error: orderErr } = await supabaseAdmin
      .from("payment_orders")
      .select("id, status, mode")
      .eq("user_id", userId)
      .eq("plan_code", "monthly")
      .eq("status", "paid")
      .eq("mode", "live")
      .limit(1);

    if (orderErr) {
      // Fail-closed on any DB order error
      return {
        isEligible: false,
        isFirstMonthlyPurchase: false,
        reason: "DB_ORDER_QUERY_ERROR",
      };
    }

    if (paidOrders && paidOrders.length > 0) {
      return {
        isEligible: false,
        isFirstMonthlyPurchase: false,
        reason: "PRIOR_LIVE_PAID_MONTHLY_ORDER",
      };
    }

    // 2. Evidence Check B: subscriptions (Explicit rule for legacy paid subscriptions)
    const { data: subs, error: subErr } = await supabaseAdmin
      .from("subscriptions")
      .select("id, plan_id, status, amount, metadata")
      .eq("user_id", userId)
      .limit(10);

    if (subErr) {
      // Fail-closed on DB subscription error
      return {
        isEligible: false,
        isFirstMonthlyPurchase: false,
        reason: "DB_SUBSCRIPTION_QUERY_ERROR",
      };
    }

    if (subs && subs.length > 0) {
      const hasLegacyPaidSub = subs.some((s: any) => {
        const isMonthlyPlan = normalizePlanCode(s.plan_id) === "monthly";
        const isNotTest = !s.metadata || s.metadata.mode !== "test";
        const isPaidStatus =
          s.status !== "unpaid" &&
          ["active", "trialing", "in_grace_period", "past_due", "canceled"].includes(s.status);
        const hasPositiveAmount = (s.amount ?? 0) > 0;
        return isMonthlyPlan && isNotTest && isPaidStatus && hasPositiveAmount;
      });

      if (hasLegacyPaidSub) {
        return {
          isEligible: false,
          isFirstMonthlyPurchase: false,
          reason: "LEGACY_PAID_MONTHLY_SUBSCRIPTION",
        };
      }
    }

    // Test mode does not reserve or consume live promo discount
    if (!isLive) {
      return {
        isEligible: true,
        isFirstMonthlyPurchase: true,
        reason: "TEST_MODE_ELIGIBLE",
      };
    }

    // 3. Concurrency & Once-Only Intro Reservation Guard (LIVE mode)
    // Check active pending orders in payment_orders (< 30 minutes old with Rs 499 in live mode)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: pendingOrders, error: pendingErr } = await supabaseAdmin
      .from("payment_orders")
      .select("id, amount_paise, created_at, status")
      .eq("user_id", userId)
      .eq("plan_code", "monthly")
      .eq("status", "created")
      .eq("mode", "live")
      .gte("created_at", thirtyMinutesAgo)
      .limit(5);

    if (pendingErr) {
      // Fail-closed on DB pending query error
      return {
        isEligible: false,
        isFirstMonthlyPurchase: false,
        reason: "DB_PENDING_QUERY_ERROR",
      };
    }

    if (pendingOrders && pendingOrders.some((p: any) => p.amount_paise === 49900)) {
      return {
        isEligible: false,
        isFirstMonthlyPurchase: false,
        reason: "PENDING_PROMO_ORDER_EXISTS",
      };
    }

    // Atomic claim via intro_promo_reservations table if available
    try {
      await supabaseAdmin
        .from("intro_promo_reservations")
        .delete()
        .eq("user_id", userId)
        .or(`status.eq.released,expires_at.lt.${new Date().toISOString()}`);

      const { error: resErr } = await supabaseAdmin
        .from("intro_promo_reservations")
        .insert({
          user_id: userId,
          amount_paise: 49900,
          status: "active",
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        })
        .select("user_id, status")
        .single();

      if (resErr) {
        // If conflict error (e.g. 23505 duplicate key), another concurrent request already reserved it!
        if (
          resErr.code === "23505" ||
          resErr.message?.includes("duplicate") ||
          resErr.message?.includes("unique")
        ) {
          return {
            isEligible: false,
            isFirstMonthlyPurchase: false,
            reason: "CONCURRENT_PROMO_RESERVATION_HELD",
          };
        }
        if (
          !resErr.message?.includes("does not exist") &&
          !resErr.message?.includes("not found")
        ) {
          return {
            isEligible: false,
            isFirstMonthlyPurchase: false,
            reason: "DB_RESERVATION_INSERT_ERROR",
          };
        }
      }
    } catch (claimErr: any) {
      if (
        claimErr?.code === "23505" ||
        claimErr?.message?.includes("duplicate") ||
        claimErr?.message?.includes("unique")
      ) {
        return {
          isEligible: false,
          isFirstMonthlyPurchase: false,
          reason: "CONCURRENT_PROMO_RESERVATION_HELD",
        };
      }
    }

    return {
      isEligible: true,
      isFirstMonthlyPurchase: true,
      reason: "FIRST_MONTH_ELIGIBLE",
    };
  } catch (err) {
    // Fail-closed on ANY unhandled exception: charge repeat price Rs 799, NEVER Rs 499
    return {
      isEligible: false,
      isFirstMonthlyPurchase: false,
      reason: "EXCEPTION_FAIL_CLOSED",
    };
  }
}

/**
 * Safely releases an intro promo reservation (e.g. if order creation fails or user cancels).
 */
export async function releaseMonthlyIntroReservation(
  supabaseAdmin: any,
  userId: string
): Promise<void> {
  if (!supabaseAdmin || !userId || typeof supabaseAdmin.from !== "function") return;
  try {
    await supabaseAdmin
      .from("intro_promo_reservations")
      .delete()
      .eq("user_id", userId)
      .eq("status", "active");
  } catch {
    // Non-fatal cleanup
  }
}

export async function hasEarlierSuccessfulMonthlyPayment(
  supabaseAdmin: any,
  userId: string,
  mode: "live" | "test" | string = "live"
): Promise<boolean> {
  const result = await checkMonthlyIntroEligibilityAndReserve(supabaseAdmin, userId, mode);
  return !result.isFirstMonthlyPurchase;
}

