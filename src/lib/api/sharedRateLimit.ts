import { createClient } from "@supabase/supabase-js";

/**
 * Shared rate limiting backed by Supabase (public.check_rate_limit RPC),
 * with in-memory fallback when the shared store is unavailable.
 * Schema: reports/rate_limit_table.sql - applied by the owner in Supabase.
 * On Edge/serverless, in-memory counters reset per isolate, so the shared
 * store is what makes the limit real across instances.
 */

let rlClient: any = null;

function getRateLimitClient() {
  if (process.env.NODE_ENV === "test" && (globalThis as any).__mockRateLimitClient !== undefined) {
    return (globalThis as any).__mockRateLimitClient;
  }
  if (rlClient) return rlClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  rlClient = createClient(url, key, { auth: { persistSession: false } });
  return rlClient;
}

export interface SharedLimitResult {
  allowed: boolean;
  retryAfter: number;
  currentCount: number;
  source: "shared" | "memory";
}

export async function checkSharedRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
  memoryFallback: () => { allowed: boolean; retryAfter: number; currentCount: number }
): Promise<SharedLimitResult> {
  const client = getRateLimitClient();
  if (client) {
    try {
      const { data, error } = await client.rpc("check_rate_limit", {
        p_key: key,
        p_max_requests: maxRequests,
        p_window_seconds: windowSeconds,
      });
      if (!error && data) {
        const row = Array.isArray(data) ? data[0] : data;
        if (row && typeof row.allowed === "boolean") {
          return {
            allowed: row.allowed,
            retryAfter: row.retry_after ?? 0,
            currentCount: row.current_count ?? 0,
            source: "shared",
          };
        }
      }
      // RPC missing or bad payload: fall through to memory.
    } catch {
      // fall through to memory
    }
  }
  return { ...memoryFallback(), source: "memory" };
}

export const SEARCH_RATE_LIMIT = {
  maxRequests: 60,
  windowSeconds: 60,
};

export const TRACK_RATE_LIMIT = {
  maxRequests: 30,
  windowSeconds: 60,
};

export const EARLY_ACCESS_RATE_LIMIT = {
  maxRequests: 5,
  windowSeconds: 60,
};

export const searchRateLimitStore = new Map<string, { count: number; resetAt: number }>();
export const trackRateLimitStore = new Map<string, { count: number; resetAt: number }>();
export const earlyAccessRateLimitStore = new Map<string, { count: number; resetAt: number }>();

export function _resetSearchRateLimitStore() {
  searchRateLimitStore.clear();
}

export function _resetTrackRateLimitStore() {
  trackRateLimitStore.clear();
}

export function _resetEarlyAccessRateLimitStore() {
  earlyAccessRateLimitStore.clear();
}

export const STATS_RATE_LIMIT = {
  maxRequests: 60,
  windowSeconds: 60,
};

export const statsRateLimitStore = new Map<string, { count: number; resetAt: number }>();

export function _resetStatsRateLimitStore() {
  statsRateLimitStore.clear();
}
