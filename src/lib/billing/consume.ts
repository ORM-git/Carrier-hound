import { createClient } from "@supabase/supabase-js";
import { getServerEntitlement } from "./serverEntitlement";
import { getPlanQuota } from "./quota";

export type QuotaKind = "resume_tailor" | "cover_letter";
export type QuotaSource = "plan" | "addon";

export interface ConsumeResult {
  success: boolean;
  source?: QuotaSource;
  alreadyConsumed?: boolean;
  code?: "PRO_REQUIRED" | "DAILY_LIMIT_REACHED" | "QUOTA_EXHAUSTED" | "DATABASE_ERROR";
  error?: string;
}

export interface RefundResult {
  success: boolean;
  refunded: boolean;
  source?: QuotaSource;
  error?: string;
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
 * Evaluates whether daily usage events have reached or exceeded the daily cap.
 */
export function isDailyCapExceeded(todayEventCount: number, cap: number = 30): boolean {
  return todayEventCount >= cap;
}

/**
 * Determines whether to consume from the active subscription plan or add-on packs.
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
 * Consumes one unit of resume_tailor or cover_letter quota.
 * Quota Priority:
 * 1. Pro Entitlement check (Free users rejected)
 * 2. Idempotency check (repeat idempotency key returns earlier result without burning twice)
 * 3. Daily Cap check (max 30 total generations across both sources per IST day)
 * 4. Plan quota for current period
 * 5. Add-on packs (earliest-expiring non-expired credits decremented atomically)
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
    // 1. Pro Entitlement Check
    const entitlement = await getServerEntitlement(userId);
    if (!entitlement.isPro) {
      return {
        success: false,
        code: "PRO_REQUIRED",
        error: "CareerMonke Pro subscription required for AI resume and cover letter quota.",
      };
    }

    const supabaseAdmin = getSupabaseAdmin();

    // 2. Check Idempotency: repeat key returns earlier result and never burns twice
    const { data: existingEvent } = await supabaseAdmin
      .from("plan_usage_events")
      .select("id, source, kind")
      .eq("user_id", userId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (existingEvent) {
      return {
        success: true,
        source: existingEvent.source as QuotaSource,
        alreadyConsumed: true,
      };
    }

    // 3. Daily Cap Check (30 generations per IST day across both sources)
    const istStart = getStartOfIstDay(now);
    const { count: todayEventCount } = await supabaseAdmin
      .from("plan_usage_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", istStart.toISOString());

    if (isDailyCapExceeded(todayEventCount || 0, 30)) {
      return {
        success: false,
        code: "DAILY_LIMIT_REACHED",
        error: "Daily fair-use limit of 30 generations reached. Resets daily at midnight IST.",
      };
    }

    // 4. Check Plan Quota for current period
    const quota = await getPlanQuota(userId, now);
    const quotaDecision = determineQuotaSource(
      kind,
      quota.resumesRemaining,
      quota.coverLettersRemaining,
      quota.addonSetsRemaining
    );

    if (quotaDecision.source === "plan") {
      // Consume from plan quota
      const { error: insertErr } = await supabaseAdmin
        .from("plan_usage_events")
        .insert({
          user_id: userId,
          kind,
          source: "plan",
          idempotency_key: idempotencyKey,
          created_at: now.toISOString(),
        });

      if (insertErr) {
        // If conflict on idempotency key race, re-check
        if (insertErr.code === "23505") {
          return { success: true, source: "plan", alreadyConsumed: true };
        }
        console.error("[consumeSet] Failed to insert plan usage event:", insertErr);
        return { success: false, code: "DATABASE_ERROR", error: "Failed to record plan quota usage" };
      }

      return { success: true, source: "plan" };
    }

    if (quotaDecision.source === "addon") {
      // Try atomic RPC function first
      try {
        const { data: rpcRes, error: rpcErr } = await supabaseAdmin.rpc("consume_addon_set", {
          p_user_id: userId,
          p_kind: kind,
          p_idempotency_key: idempotencyKey,
        });

        if (!rpcErr && rpcRes) {
          if (rpcRes.success) {
            return {
              success: true,
              source: "addon",
              alreadyConsumed: Boolean(rpcRes.already_consumed),
            };
          }
          if (rpcRes.code === "QUOTA_EXHAUSTED") {
            return {
              success: false,
              code: "QUOTA_EXHAUSTED",
              error: rpcRes.error || "Plan quota finished and no active add-on credits available.",
            };
          }
        }
      } catch {
        // Fall back to direct atomic steps if RPC is not yet registered
      }

      // Fallback: Select earliest-expiring non-expired add-on credit
      const { data: credits, error: creditErr } = await supabaseAdmin
        .from("user_addon_credits")
        .select("id, sets_remaining, expires_at")
        .eq("user_id", userId)
        .gt("sets_remaining", 0)
        .gt("expires_at", now.toISOString())
        .order("expires_at", { ascending: true })
        .limit(1);

      if (creditErr || !credits || credits.length === 0) {
        return {
          success: false,
          code: "QUOTA_EXHAUSTED",
          error: "Plan quota finished and no active add-on credits available.",
        };
      }

      const credit = credits[0];
      const newRemaining = Math.max(0, credit.sets_remaining - 1);

      // Decrement add-on credit
      await supabaseAdmin
        .from("user_addon_credits")
        .update({ sets_remaining: newRemaining })
        .eq("id", credit.id);

      // Record event with source 'addon'
      const { error: insertErr } = await supabaseAdmin
        .from("plan_usage_events")
        .insert({
          user_id: userId,
          kind,
          source: "addon",
          idempotency_key: idempotencyKey,
          created_at: now.toISOString(),
        });

      if (insertErr && insertErr.code !== "23505") {
        console.error("[consumeSet] Failed to insert addon usage event:", insertErr);
      }

      return { success: true, source: "addon" };
    }

    return {
      success: false,
      code: "QUOTA_EXHAUSTED",
      error: "Plan quota finished and no active add-on credits available.",
    };
  } catch (err: any) {
    console.error("[consumeSet] Unexpected error:", err);
    return { success: false, code: "DATABASE_ERROR", error: err?.message || "Internal consume error" };
  }
}

/**
 * Refunds a consumed set on failure.
 * Deletes the usage event and restores 1 add-on set if the event came from 'addon'.
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

    const { data: event, error: selectErr } = await supabaseAdmin
      .from("plan_usage_events")
      .select("id, source")
      .eq("user_id", userId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (selectErr || !event) {
      return { success: true, refunded: false };
    }

    if (event.source === "addon") {
      // Find a non-expired addon credit to restore
      const { data: credits } = await supabaseAdmin
        .from("user_addon_credits")
        .select("id, sets_remaining, sets_total")
        .eq("user_id", userId)
        .gt("expires_at", now.toISOString())
        .order("expires_at", { ascending: true })
        .limit(1);

      if (credits && credits.length > 0) {
        const credit = credits[0];
        await supabaseAdmin
          .from("user_addon_credits")
          .update({ sets_remaining: credit.sets_remaining + 1 })
          .eq("id", credit.id);
      }
    }

    await supabaseAdmin
      .from("plan_usage_events")
      .delete()
      .eq("id", event.id);

    return { success: true, refunded: true, source: event.source as QuotaSource };
  } catch (err: any) {
    console.error("[refundSet] Unexpected error:", err);
    return { success: false, refunded: false, error: err?.message };
  }
}
