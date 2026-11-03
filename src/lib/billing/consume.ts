import { createClient } from "@supabase/supabase-js";
import { getServerEntitlement } from "./serverEntitlement";
import { getPlanQuota, PLAN_DEFINITIONS, getStartOfIstDay } from "./quota";

export { getStartOfIstDay };

export type QuotaKind = "resume_tailor" | "cover_letter";
export type QuotaSource = "plan" | "addon";

export interface ConsumeResult {
  success: boolean;
  source?: QuotaSource;
  credit_id?: string | null;
  alreadyConsumed?: boolean;
  code?: "PRO_REQUIRED" | "DAILY_LIMIT_REACHED" | "QUOTA_EXHAUSTED" | "DATABASE_ERROR";
  error?: string;
}

export interface RefundResult {
  success: boolean;
  refunded: boolean;
  source?: QuotaSource;
  credit_id?: string | null;
  error?: string;
}

/**
 * Evaluates whether daily usage events have reached or exceeded the daily cap.
 */
export function isDailyCapExceeded(todayEventCount: number, cap: number = 30): boolean {
  return todayEventCount >= cap;
}

/**
 * Pure decision helper: Determines whether to consume from the active subscription plan or add-on packs.
 */
export function determineQuotaSource(
  kind: QuotaKind,
  resumesRemaining: number,
  coverLettersRemaining: number,
  addonSetsRemaining: number
): { source: QuotaSource | null; code?: "QUOTA_EXHAUSTED" } {
  if (kind === "resume_tailor") {
    if (resumesRemaining > 0) return { source: "plan" };
  } else if (kind === "cover_letter") {
    if (coverLettersRemaining > 0) return { source: "plan" };
  }

  if (addonSetsRemaining > 0) {
    return { source: "addon" };
  }

  return { source: null, code: "QUOTA_EXHAUSTED" };
}

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase service role configuration");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

/**
 * Consumes one unit of resume_tailor or cover_letter quota atomically.
 * Execution Order:
 * 1. Pro Entitlement check (Fail closed for free users)
 * 2. Plan quota calculation to determine stepped period start and kind quota
 * 3. Atomic Postgres RPC execution taking per-user advisory lock:
 *    - Validates idempotency key (returns existing result without re-burning)
 *    - Checks 30/day IST daily cap across plan & addon usage
 *    - Consumes from plan quota if remaining for current period
 *    - Falls back to earliest-expiring non-expired add-on set decremented atomically
 *    - Records exact decremented credit_id on plan_usage_events
 */
export async function consumeSet(
  userId: string,
  kind: QuotaKind,
  idempotencyKey: string,
  now: Date = new Date()
): Promise<ConsumeResult> {
  if (!userId || typeof userId !== "string") {
    return { success: false, code: "PRO_REQUIRED", error: "Valid user ID required" };
  }

  if (kind !== "resume_tailor" && kind !== "cover_letter") {
    return { success: false, code: "QUOTA_EXHAUSTED", error: `Invalid quota kind '${kind}'` };
  }

  if (!idempotencyKey || typeof idempotencyKey !== "string") {
    return { success: false, code: "DATABASE_ERROR", error: "Idempotency key required" };
  }

  try {
    // 1. Pro Entitlement Check - Fail closed
    const entitlement = await getServerEntitlement(userId);
    if (!entitlement.isPro) {
      return {
        success: false,
        code: "PRO_REQUIRED",
        error: "CareerMonke Pro subscription required for AI resume and cover letter quota.",
      };
    }

    const supabaseAdmin = getSupabaseAdmin();

    // 2. Resolve quota period and plan parameters
    const quota = await getPlanQuota(userId, now);
    const planDef = quota.planCode ? PLAN_DEFINITIONS[quota.planCode] : null;
    const kindQuota =
      kind === "resume_tailor"
        ? (planDef?.resume_quota ?? 0)
        : (planDef?.cover_letter_quota ?? 0);

    const periodStart = quota.periodStart || now.toISOString();
    const dayStart = getStartOfIstDay(now).toISOString();

    // 3. Primary Atomic RPC: consume_user_set (advisory lock + IST cap + plan + addon in one transaction)
    try {
      const { data: userSetRes, error: userSetErr } = await supabaseAdmin.rpc("consume_user_set", {
        p_user_id: userId,
        p_kind: kind,
        p_idempotency_key: idempotencyKey,
        p_period_start: periodStart,
        p_quota: kindQuota,
        p_daily_cap: 30,
        p_day_start: dayStart,
      });

      if (!userSetErr && userSetRes) {
        if (userSetRes.success) {
          return {
            success: true,
            source: userSetRes.source as QuotaSource,
            credit_id: userSetRes.credit_id || null,
            alreadyConsumed: Boolean(userSetRes.already_consumed),
          };
        }
        return {
          success: false,
          code: userSetRes.code || "QUOTA_EXHAUSTED",
          error: userSetRes.error || "Quota consumption rejected",
        };
      }
    } catch {
      // Fall through to individual atomic RPCs if consume_user_set not yet present
    }

    // 4. Secondary Atomic RPC path: consume_plan_set followed by consume_addon_set
    try {
      const { data: planRes, error: planErr } = await supabaseAdmin.rpc("consume_plan_set", {
        p_user_id: userId,
        p_kind: kind,
        p_idempotency_key: idempotencyKey,
        p_period_start: periodStart,
        p_quota: kindQuota,
        p_daily_cap: 30,
        p_day_start: dayStart,
      });

      if (!planErr && planRes) {
        if (planRes.success) {
          return {
            success: true,
            source: "plan",
            alreadyConsumed: Boolean(planRes.already_consumed),
          };
        }

        if (planRes.code === "DAILY_LIMIT_REACHED") {
          return {
            success: false,
            code: "DAILY_LIMIT_REACHED",
            error: planRes.error || "Daily fair-use limit of 30 generations reached.",
          };
        }
      }

      // If plan quota is exhausted, attempt atomic addon consume
      const { data: addonRes, error: addonErr } = await supabaseAdmin.rpc("consume_addon_set", {
        p_user_id: userId,
        p_kind: kind,
        p_idempotency_key: idempotencyKey,
        p_daily_cap: 30,
        p_day_start: dayStart,
      });

      if (!addonErr && addonRes) {
        if (addonRes.success) {
          return {
            success: true,
            source: "addon",
            credit_id: addonRes.credit_id || null,
            alreadyConsumed: Boolean(addonRes.already_consumed),
          };
        }

        return {
          success: false,
          code: addonRes.code || "QUOTA_EXHAUSTED",
          error: addonRes.error || "Plan quota finished and no active add-on credits available.",
        };
      }
    } catch (rpcErr) {
      console.error("[consumeSet] RPC execution error:", rpcErr);
    }

    // Fail closed: No non-atomic fallback allowed on quota money path
    return {
      success: false,
      code: "DATABASE_ERROR",
      error: "Quota service temporarily unavailable. Please try again.",
    };
  } catch (err: any) {
    console.error("[consumeSet] Unexpected error:", err);
    return { success: false, code: "DATABASE_ERROR", error: err?.message || "Internal consume error" };
  }
}

/**
 * Refunds a consumed set on upstream AI generation or validation failure.
 * - Restores the exact decremented user_addon_credits row (never exceeds sets_total).
 * - Deletes the recorded plan_usage_events row.
 */
export async function refundSet(
  userId: string,
  idempotencyKey: string,
  now: Date = new Date()
): Promise<RefundResult> {
  if (!userId || !idempotencyKey) {
    return { success: false, refunded: false, error: "Missing userId or idempotencyKey" };
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();

    // 1. Attempt atomic Postgres RPC refund
    try {
      const { data: rpcRes, error: rpcErr } = await supabaseAdmin.rpc("refund_plan_or_addon_set", {
        p_user_id: userId,
        p_idempotency_key: idempotencyKey,
      });

      if (!rpcErr && rpcRes && rpcRes.success) {
        return {
          success: true,
          refunded: Boolean(rpcRes.refunded),
          source: rpcRes.source as QuotaSource,
          credit_id: rpcRes.credit_id || null,
        };
      }
    } catch {
      // Fall through to exact row restoration if RPC not yet registered
    }

    // 2. Fallback: Restore exact credit row from usage event and delete event
    const { data: event, error: selectErr } = await supabaseAdmin
      .from("plan_usage_events")
      .select("id, source, credit_id")
      .eq("user_id", userId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (selectErr || !event) {
      return { success: true, refunded: false };
    }

    if (event.source === "addon" && event.credit_id) {
      // Fetch the exact credit row that was decremented
      const { data: credit } = await supabaseAdmin
        .from("user_addon_credits")
        .select("id, sets_remaining, sets_total")
        .eq("id", event.credit_id)
        .eq("user_id", userId)
        .maybeSingle();

      if (credit) {
        // Guarantee restoration never exceeds sets_total
        const restoredSets = Math.min(credit.sets_total, credit.sets_remaining + 1);
        await supabaseAdmin
          .from("user_addon_credits")
          .update({ sets_remaining: restoredSets })
          .eq("id", credit.id);
      }
    }

    await supabaseAdmin
      .from("plan_usage_events")
      .delete()
      .eq("id", event.id);

    return {
      success: true,
      refunded: true,
      source: event.source as QuotaSource,
      credit_id: event.credit_id || null,
    };
  } catch (err: any) {
    console.error("[refundSet] Unexpected error:", err);
    return { success: false, refunded: false, error: err?.message };
  }
}
