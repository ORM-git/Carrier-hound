import { createClient } from "../supabase/client";
import {
  UserSubscription,
  ProAccessStatus,
  SubscriptionStatus,
} from "./types";
import { withJitter } from "../reliability/jitter";
import { normalizePlanCode, PLAN_DEFINITIONS, PlanCode } from "./quota";

import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "billing/subscription" } });

// Re-export central plan normalization from quota
export const normalizePlanId = normalizePlanCode;
export type SupportedPlanId = PlanCode;

function resolvePlanName(planId?: string | null): string {
  const norm = normalizePlanCode(planId);
  if (norm) return PLAN_DEFINITIONS[norm].name;
  if (!planId) return "Free Tier";
  return "Pro Member";
}

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
  window.addEventListener("careermonke_route_changed", invalidateProAccessCache);
  window.addEventListener("focus", invalidateProAccessCache);
  window.addEventListener("popstate", invalidateProAccessCache);
}

/**
 * Queries the user subscription from Supabase with exponential backoff retry.
 * Prevents false "Free" downgrades due to slow 3G or transient network timeouts.
 */
async function querySubscriptionWithRetry(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  maxRetries = 2
): Promise<{ data: any | null; error: any | null; isDefinitive: boolean }> {
  const timeoutMs = 10000; // 10s timeout accommodates Slow 3G round-trips and TLS handshakes
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      const fetchPromise = supabase
        .from("subscriptions")
        .select("status, plan_id, current_period_end, grace_period_end")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
        setTimeout(
          () => resolve({ data: null, error: new Error(`Subscription query timeout (${timeoutMs}ms)`) }),
          timeoutMs
        )
      );

      const res = await Promise.race([fetchPromise, timeoutPromise]);

      if (!res.error) {
        // Successful response: res.data is either the subscription row OR null (if user has no subscription).
        // In both cases, this is a DEFINITIVE response from the server!
        return { data: res.data, error: null, isDefinitive: true };
      }

      log.warn(`[Billing] Subscription check attempt ${attempt + 1}/${maxRetries + 1} failed:`, { detail: res.error.message });

      if (attempt < maxRetries) {
        // Exponential backoff: 500ms, 1000ms (±20% jitter via withJitter)
        await new Promise((resolve) => setTimeout(resolve, withJitter(500 * Math.pow(2, attempt))));
      }
    } catch (err: any) {
      log.warn(`[Billing] Subscription query exception on attempt ${attempt + 1}:`, { error: err });
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, withJitter(500 * Math.pow(2, attempt))));
      }
    }
    attempt++;
  }

  // All retries failed (timeout or network error) -> NOT definitive!
  return {
    data: null,
    error: new Error("Failed to reach billing verification server after retries"),
    isDefinitive: false,
  };
}

/**
 * Checks the user's active Pro access status, strictly server-verified from Supabase subscriptions table.
 * Default is FALSE (signed-in non-Pro) until server subscription is active.
 * Client-side overrides (localStorage/user_metadata) are strictly disabled.
 * Deduplicated and cached in-memory per session to prevent repeated network queries.
 */
export async function getProAccessStatus(userId?: string): Promise<ProAccessStatus> {
  const unauthenticatedDefault: ProAccessStatus = {
    isPro: false,
    status: "none",
    planName: "Free Tier",
    inGracePeriod: false,
    isLoading: false,
    isDefinitive: true,
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
      return unauthenticatedDefault;
    }

    const now = Date.now();
    // Only return cached status if it exists, belongs to this user, was definitive, and is not expired
    if (
      cachedProStatus &&
      cachedProStatus.userId === resolvedUserId &&
      cachedProStatus.status.isDefinitive &&
      now - cachedProStatus.timestamp < CACHE_TTL_MS
    ) {
      return cachedProStatus.status;
    }

    // Deduplicate concurrent in-flight queries
    if (activeProStatusPromise && activeProStatusUserId === resolvedUserId) {
      return activeProStatusPromise;
    }

    activeProStatusUserId = resolvedUserId;
    activeProStatusPromise = (async () => {
      try {
        const { data: sub, error, isDefinitive } = await querySubscriptionWithRetry(supabase, resolvedUserId!);

        if (!isDefinitive || error) {
          // Timeout or network failure: NEVER resolve to Free!
          // NEVER cache a negative timeout/error result.
          // If the user was already verified as Pro in this session, retain Pro to prevent lockout
          if (cachedProStatus && cachedProStatus.userId === resolvedUserId && cachedProStatus.status.isPro) {
            return {
              ...cachedProStatus.status,
              isLoading: false,
              isDefinitive: false,
            };
          }

          // Otherwise, stay in loading/unknown state (never Free)
          return {
            isPro: false,
            status: "unknown",
            inGracePeriod: false,
            isLoading: true,
            isDefinitive: false,
          };
        }

        // Definitive response from the server:
        let resultStatus: ProAccessStatus = {
          isPro: false,
          status: "none",
          planName: "Free Tier",
          inGracePeriod: false,
          isLoading: false,
          isDefinitive: true,
        };

        if (sub) {
          const nowDate = new Date();
          const nowMs = nowDate.getTime();
          const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
          const graceEnd = sub.grace_period_end ? new Date(sub.grace_period_end) : null;

          // 1. Check if within 7-day grace period
          if (sub.status === "in_grace_period" && graceEnd) {
            const diffMs = graceEnd.getTime() - nowMs;
            const daysLeft = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

            if (diffMs > 0) {
              resultStatus = {
                isPro: true,
                status: "in_grace_period",
                planName: resolvePlanName(sub.plan_id),
                inGracePeriod: true,
                graceDaysLeft: daysLeft,
                expirationDate: graceEnd.toISOString(),
                isLoading: false,
                isDefinitive: true,
              };
            } else {
              // Grace period expired
              resultStatus = {
                isPro: false,
                status: "canceled",
                planName: "Free Tier",
                inGracePeriod: false,
                expirationDate: graceEnd.toISOString(),
                isLoading: false,
                isDefinitive: true,
              };
            }
          } else if (sub.status === "active" || sub.status === "trialing") {
            // Requirement 2: Client-side subscription period end expiry check
            const isPeriodExpired = Boolean(periodEnd && periodEnd.getTime() <= nowMs);

            if (!isPeriodExpired) {
              resultStatus = {
                isPro: true,
                status: sub.status,
                planName: resolvePlanName(sub.plan_id),
                inGracePeriod: false,
                expirationDate: periodEnd ? periodEnd.toISOString() : undefined,
                isLoading: false,
                isDefinitive: true,
              };
            } else {
              // Period has ended -> Expired!
              resultStatus = {
                isPro: false,
                status: "canceled",
                planName: "Free Tier",
                inGracePeriod: false,
                expirationDate: periodEnd?.toISOString(),
                isLoading: false,
                isDefinitive: true,
              };
            }
          } else {
            // Explicitly inactive subscription row: canceled, past_due, unpaid
            resultStatus = {
              isPro: false,
              status: sub.status || "none",
              planName: "Free Tier",
              inGracePeriod: false,
              expirationDate: periodEnd ? periodEnd.toISOString() : undefined,
              isLoading: false,
              isDefinitive: true,
            };
          }
        }

        // Requirement 3: ONLY cache definitive server answers
        if (resultStatus.isDefinitive) {
          cachedProStatus = {
            userId: resolvedUserId!,
            status: resultStatus,
            timestamp: Date.now(),
          };
        }

        return resultStatus;
      } finally {
        activeProStatusPromise = null;
        activeProStatusUserId = null;
      }
    })();

    return activeProStatusPromise;
  } catch (e) {
    log.warn("Could not check remote subscription status", { error: e });
  }

  // Fallback on unexpected unhandled error: stay unknown/loading, do not cache
  return {
    isPro: false,
    status: "unknown",
    inGracePeriod: false,
    isLoading: true,
    isDefinitive: false,
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
export async function getUserSubscription(
  userId?: string,
  client?: any
): Promise<UserSubscription | null> {
  try {
    const supabase = client || createClient();
    let resolvedUserId = userId;
    if (!resolvedUserId) {
      const { data: { session } } = await supabase.auth.getSession();
      const user = session?.user || (await supabase.auth.getUser()).data.user;
      resolvedUserId = user?.id;
    }

    if (resolvedUserId) {
      const { data: sub, error } = await supabase
        .from("subscriptions")
        .select("id, user_id, provider, plan_id, currency, amount, status, current_period_start, current_period_end, grace_period_end, cancel_at_period_end, metadata")
        .eq("user_id", resolvedUserId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!error && sub) {
        const now = new Date();
        const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
        let resolvedStatus: SubscriptionStatus = sub.status || "active";

        // Expiry check: if active/trialing but past current_period_end, treat as expired
        if ((resolvedStatus === "active" || resolvedStatus === "trialing") && periodEnd && periodEnd <= now) {
          resolvedStatus = "canceled";
        }

        const normalizedPlan = normalizePlanCode(sub.plan_id);

        // Convert subscriptions.amount explicitly from integer paise to standard units.
        // If amount is missing/null/undefined:
        // Do not combine the INR catalog price with a non-INR currency (USD quarterly must not show $3,999).
        // Either keep catalog amount and its INR currency together, or hide the price when currency is not INR.
        let resolvedAmount: number | undefined;
        const rawCurrency = sub.currency ? String(sub.currency).trim().toUpperCase() : "INR";
        const isINR = rawCurrency === "INR";

        if (typeof sub.amount === "number" && !Number.isNaN(sub.amount)) {
          resolvedAmount = Math.round(sub.amount / 100);
        } else if (normalizedPlan) {
          const catalogPlan = PLAN_DEFINITIONS[normalizedPlan];
          if (isINR) {
            resolvedAmount = Math.round(catalogPlan.price_paise / 100);
          } else {
            resolvedAmount = undefined;
          }
        } else {
          resolvedAmount = undefined;
        }

        return {
          id: sub.id,
          userId: sub.user_id,
          provider: sub.provider || "manual",
          planId: normalizedPlan || sub.plan_id || undefined,
          currency: rawCurrency,
          amount: resolvedAmount,
          status: resolvedStatus,
          currentPeriodStart: sub.current_period_start || new Date().toISOString(),
          currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end).toISOString() : undefined,
          gracePeriodEnd: sub.grace_period_end,
          cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
          metadata: sub.metadata,
        };
      }
    }
  } catch (e) {
    log.warn("Could not fetch user subscription", { error: e });
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
    log.warn("Could not cancel subscription remotely", { error: e });
  }

  return null;
}
