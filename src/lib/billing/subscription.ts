import { createClient } from "../supabase/client";
import {
  UserSubscription,
  ProAccessStatus,
  PLAN_DOMESTIC,
  PLAN_INTERNATIONAL,
} from "./types";

interface CachedProStatusEntry {
  userId: string;
  status: ProAccessStatus;
  timestamp: number;
}

let cachedProStatus: CachedProStatusEntry | null = null;
let activeProStatusPromise: Promise<ProAccessStatus> | null = null;
let activeProStatusUserId: string | null = null;
const CACHE_TTL_MS = 60 * 1000; // 60 seconds session cache

export function invalidateProAccessCache(): void {
  cachedProStatus = null;
  activeProStatusPromise = null;
  activeProStatusUserId = null;
}

if (typeof window !== "undefined") {
  window.addEventListener("careermonke_auth_updated", invalidateProAccessCache);
  window.addEventListener("careermonke_pro_updated", invalidateProAccessCache);
}

/**
 * Checks the user's active Pro access status, strictly server-verified from Supabase subscriptions table.
 * Default is FALSE (signed-in non-Pro) until server subscription is active.
 * Client-side overrides (localStorage/user_metadata) are strictly disabled.
 * Deduplicated and cached in-memory per session to prevent repeated network queries.
 */
export async function getProAccessStatus(userId?: string): Promise<ProAccessStatus> {
  const freeDefault: ProAccessStatus = {
    isPro: false,
    status: "none",
    planName: "Free Tier",
    inGracePeriod: false,
  };

  try {
    const supabase = createClient();
    let resolvedUserId = userId;

    if (!resolvedUserId) {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        resolvedUserId = session.user.id;
      } else {
        const { data: { user } } = await supabase.auth.getUser();
        resolvedUserId = user?.id;
      }
    }

    if (!resolvedUserId) {
      return freeDefault;
    }

    const now = Date.now();
    if (
      cachedProStatus &&
      cachedProStatus.userId === resolvedUserId &&
      now - cachedProStatus.timestamp < CACHE_TTL_MS
    ) {
      return cachedProStatus.status;
    }

    if (activeProStatusPromise && activeProStatusUserId === resolvedUserId) {
      return activeProStatusPromise;
    }

    activeProStatusUserId = resolvedUserId;
    activeProStatusPromise = (async () => {
      try {
        const subPromise = supabase
          .from("subscriptions")
          .select("*")
          .eq("user_id", resolvedUserId!)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
          setTimeout(() => resolve({ data: null, error: new Error("Subscription query timeout") }), 4000)
        );

        const { data: sub, error } = await Promise.race([subPromise, timeoutPromise]);

        let resultStatus: ProAccessStatus = {
          isPro: false,
          status: "none",
          planName: "Free Tier",
          inGracePeriod: false,
        };

        if (!error && sub) {
          const nowTime = new Date();
          const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
          const graceEnd = sub.grace_period_end ? new Date(sub.grace_period_end) : null;

          // Check if within 7-day grace period
          if (sub.status === "in_grace_period" && graceEnd) {
            const diffMs = graceEnd.getTime() - nowTime.getTime();
            const daysLeft = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

            if (diffMs > 0) {
              resultStatus = {
                isPro: true,
                status: "in_grace_period",
                planName: sub.plan_id === PLAN_INTERNATIONAL.id ? PLAN_INTERNATIONAL.name : PLAN_DOMESTIC.name,
                inGracePeriod: true,
                graceDaysLeft: daysLeft,
                expirationDate: graceEnd.toISOString(),
              };
            }
          } else if (sub.status === "active" || sub.status === "trialing") {
            resultStatus = {
              isPro: true,
              status: sub.status,
              planName: sub.plan_id === PLAN_INTERNATIONAL.id ? PLAN_INTERNATIONAL.name : PLAN_DOMESTIC.name,
              inGracePeriod: false,
              expirationDate: periodEnd ? periodEnd.toISOString() : undefined,
            };
          }
        }

        cachedProStatus = {
          userId: resolvedUserId!,
          status: resultStatus,
          timestamp: Date.now(),
        };

        return resultStatus;
      } finally {
        activeProStatusPromise = null;
        activeProStatusUserId = null;
      }
    })();

    return activeProStatusPromise;
  } catch (e) {
    console.warn("Could not check remote subscription status", e);
  }

  return {
    isPro: false,
    status: "canceled",
    inGracePeriod: false,
  };
}

/**
 * Sets Pro status locally and broadcasts update event.
 */
export function setLocalProActive(_active: boolean = false) {
  // Pro status is strictly managed on the server (Supabase subscriptions).
}

/**
 * Retrieves the full user subscription object if one exists
 */
export async function getUserSubscription(): Promise<UserSubscription | null> {

  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user || (await supabase.auth.getUser()).data.user;

    if (user) {
      const { data: sub, error } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!error && sub) {
        return {
          id: sub.id,
          userId: sub.user_id,
          provider: sub.provider || "manual",
          planId: sub.plan_id || PLAN_DOMESTIC.id,
          currency: sub.currency || "INR",
          amount: sub.amount || 199,
          status: sub.status || "active",
          currentPeriodStart: sub.current_period_start || new Date().toISOString(),
          currentPeriodEnd: sub.current_period_end || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          gracePeriodEnd: sub.grace_period_end,
          cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
          metadata: sub.metadata,
        };
      }
    }
  } catch (e) {
    console.warn("Could not fetch user subscription", e);
  }

  return null;
}

/**
 * Marks the subscription to cancel at the end of the current period
 */
export async function cancelSubscription(): Promise<UserSubscription | null> {
  setLocalProActive(false);

  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user || (await supabase.auth.getUser()).data.user;

    if (user) {
      await supabase
        .from("subscriptions")
        .update({ status: "canceled", cancel_at_period_end: true })
        .eq("user_id", user.id);
    }
  } catch (e) {
    console.warn("Could not cancel subscription remotely", e);
  }

  return null;
}
