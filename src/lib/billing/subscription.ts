import { createClient } from "../supabase/client";
import {
  UserSubscription,
  ProAccessStatus,
  SubscriptionStatus,
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
        .select("*")
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

      console.warn(`[Billing] Subscription check attempt ${attempt + 1}/${maxRetries + 1} failed:`, res.error.message);

      if (attempt < maxRetries) {
        // Exponential backoff: 500ms, 1000ms
        await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
      }
    } catch (err: any) {
      console.warn(`[Billing] Subscription query exception on attempt ${attempt + 1}:`, err);
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
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
    tier: "none",
    canAccessListings: false,
    canAccessScores: false,
    canAccessAi: false,
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
            tier: "none",
            canAccessListings: false,
            canAccessScores: false,
            canAccessAi: false,
            isPro: false,
            status: "unknown",
            inGracePeriod: false,
            isLoading: true,
            isDefinitive: false,
          };
        }

        // Definitive response from the server:
        let resultStatus: ProAccessStatus = {
          tier: "none",
          canAccessListings: false,
          canAccessScores: false,
          canAccessAi: false,
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
          const isListingsOnly = Boolean(sub.plan_id && sub.plan_id.includes("listings"));
          const tier = isListingsOnly ? "listings" : "ai";

          // 1. Check if within 7-day grace period
          if (sub.status === "in_grace_period" && graceEnd) {
            const diffMs = graceEnd.getTime() - nowMs;
            const daysLeft = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

            if (diffMs > 0) {
              resultStatus = {
                tier,
                canAccessListings: true,
                canAccessScores: tier === "ai",
                canAccessAi: tier === "ai",
                isPro: true,
                status: "in_grace_period",
                planName: sub.plan_id === PLAN_INTERNATIONAL.id ? PLAN_INTERNATIONAL.name : isListingsOnly ? "Listings Pass" : PLAN_DOMESTIC.name,
                inGracePeriod: true,
                graceDaysLeft: daysLeft,
                expirationDate: graceEnd.toISOString(),
                isLoading: false,
                isDefinitive: true,
              };
            } else {
              // Grace period expired
              resultStatus = {
                tier: "none",
                canAccessListings: false,
                canAccessScores: false,
                canAccessAi: false,
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
                tier,
                canAccessListings: true,
                canAccessScores: tier === "ai",
                canAccessAi: tier === "ai",
                isPro: true,
                status: sub.status,
                planName: sub.plan_id === PLAN_INTERNATIONAL.id ? PLAN_INTERNATIONAL.name : isListingsOnly ? "Listings Pass" : PLAN_DOMESTIC.name,
                inGracePeriod: false,
                expirationDate: periodEnd ? periodEnd.toISOString() : undefined,
                isLoading: false,
                isDefinitive: true,
              };
            } else {
              // Period has ended -> Expired!
              resultStatus = {
                tier: "none",
                canAccessListings: false,
                canAccessScores: false,
                canAccessAi: false,
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
              tier: "none",
              canAccessListings: false,
              canAccessScores: false,
              canAccessAi: false,
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

        // Check server-backed launch status if database has no active subscription
        if (!resultStatus.isPro && typeof window !== "undefined") {
          try {
            const { data: { session } } = await supabase.auth.getSession();
            const launchToken = sessionStorage.getItem("cm_launch_pass");
            if (session?.access_token) {
              const statusRes = await fetch("/api/billing/status", {
                headers: {
                  Authorization: `Bearer ${session.access_token}`,
                  ...(launchToken ? { "x-cm-launch-pass": launchToken } : {}),
                },
              });
              if (statusRes.ok) {
                const s = await statusRes.json();
                if (s.isPro && (s.tier === "listings" || s.tier === "ai")) {
                  resultStatus = {
                    tier: s.tier,
                    canAccessListings: Boolean(s.canAccessListings),
                    canAccessScores: Boolean(s.canAccessScores),
                    canAccessAi: Boolean(s.canAccessAi),
                    isPro: true,
                    status: s.status || "active",
                    planName: s.planName || (s.tier === "ai" ? "Launch AI Pass" : "Launch Listings Pass"),
                    inGracePeriod: false,
                    expirationDate: s.expirationDate,
                    isLoading: false,
                    isDefinitive: true,
                  };
                }
              }
            }
          } catch {}
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
    console.warn("Could not check remote subscription status", e);
  }

  // Fallback on unexpected unhandled error: stay unknown/loading, do not cache
  return {
    tier: "none",
    canAccessListings: false,
    canAccessScores: false,
    canAccessAi: false,
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
        const now = new Date();
        const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
        let resolvedStatus: SubscriptionStatus = sub.status || "active";

        // Expiry check: if active/trialing but past current_period_end, treat as expired
        if ((resolvedStatus === "active" || resolvedStatus === "trialing") && periodEnd && periodEnd <= now) {
          resolvedStatus = "canceled";
        }

        return {
          id: sub.id,
          userId: sub.user_id,
          provider: sub.provider || "manual",
          planId: sub.plan_id || PLAN_DOMESTIC.id,
          currency: sub.currency || "INR",
          amount: sub.amount || 199,
          status: resolvedStatus,
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

/**
 * Activates a server-backed launch tier (Listings or AI) when customer payments are paused.
 * Fails closed without valid user authentication.
 */
export async function activateLaunchTier(tier: "listings" | "ai"): Promise<ProAccessStatus> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error("Authentication required to activate launch tier");
  }

  const res = await fetch("/api/billing/activate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ tier }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || "Failed to activate launch tier");
  }

  const data = await res.json();
  invalidateProAccessCache();

  if (typeof window !== "undefined") {
    try {
      sessionStorage.setItem("cm_launch_pass", data.token);
    } catch {}
    window.dispatchEvent(new Event("careermonke_pro_updated"));
    window.dispatchEvent(new Event("careermonke_auth_updated"));
  }

  return {
    tier: data.tier,
    canAccessListings: Boolean(data.canAccessListings),
    canAccessScores: Boolean(data.canAccessScores),
    canAccessAi: Boolean(data.canAccessAi),
    isPro: true,
    status: "active",
    planName: data.planName,
    inGracePeriod: false,
    expirationDate: data.expiresAt,
    isLoading: false,
    isDefinitive: true,
  };
}


