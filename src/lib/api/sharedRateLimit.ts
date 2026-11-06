import { createClient } from "@supabase/supabase-js";
import { rpcWithRetry } from "../db/rpcRetry";

/**
 * Shared rate limiting backed by Supabase (public.check_rate_limit RPC),
 * with strict fail-closed enforcement for costly AI operations and
 * in-memory fallback permitted ONLY for cheap public read endpoints.
 *
 * Schema: reports/rate_limit_table.sql - applied by the owner in Supabase.
 * On Edge/serverless, in-memory counters reset per isolate, so the shared
 * store is what makes the limit real across instances.
 */

let rlClient: any = null;

export function _resetRateLimitClient() {
  rlClient = null;
}

export function getRateLimitClient(clientOverride?: any, envOverrides?: Record<string, any>) {
  if (clientOverride) return clientOverride;
  if (process.env.NODE_ENV === "test" && (globalThis as any).__mockRateLimitClient !== undefined) {
    return (globalThis as any).__mockRateLimitClient;
  }
  if (rlClient) return rlClient;
  const url =
    (envOverrides && (envOverrides["NEXT_PUBLIC_SUPABASE_URL"] || envOverrides["SUPABASE_URL"])) ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL;
  const key =
    (envOverrides && (envOverrides["SUPABASE_SERVICE_ROLE_KEY"] || envOverrides["SUPABASE_SERVICE_KEY"])) ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  rlClient = createClient(url, key, { auth: { persistSession: false } });
  return rlClient;
}

export interface SharedLimitResult {
  allowed: boolean;
  retryAfter: number;
  currentCount: number;
  source: "shared" | "memory" | "unavailable";
}

export interface CheckSharedRateLimitOptions {
  failClosed?: boolean;
  client?: any;
  env?: Record<string, any>;
}

const ALERT_DEDUPE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const alertDedupeStore = new Map<string, number>();
const fallbackWarnDedupeStore = new Map<string, number>();

export function _resetRateLimitAlertStores() {
  alertDedupeStore.clear();
  fallbackWarnDedupeStore.clear();
}

export function _getAlertDedupeStore(): Map<string, number> {
  return alertDedupeStore;
}

export function _getFallbackWarnDedupeStore(): Map<string, number> {
  return fallbackWarnDedupeStore;
}

export function getKeyClass(key: string): string {
  if (key.startsWith("ai:ip")) return "ai:ip";
  if (key.startsWith("ai:user")) return "ai:user";
  if (key.startsWith("search")) return "search";
  if (key.startsWith("track")) return "track";
  if (key.startsWith("stats")) return "stats";
  if (key.startsWith("ticker")) return "ticker";
  if (key.startsWith("early_access") || key.startsWith("early-access")) return "early_access";

  const parts = key.split(":");
  if (parts.length >= 2 && !/^\d+\.\d+\.\d+\.\d+$/.test(parts[1]) && !parts[1].includes(".")) {
    return `${parts[0]}:${parts[1]}`;
  }
  return parts[0] || "general";
}

function notifySentryIfInitialized(message: string, extra?: Record<string, any>) {
  try {
    const mock = (globalThis as any).__mockSentry;
    if (mock && typeof mock.captureMessage === "function") {
      mock.captureMessage(message, { level: "error", extra });
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require("@sentry/nextjs");
    if (typeof Sentry?.getClient === "function" && Sentry.getClient()) {
      Sentry.captureMessage(message, {
        level: "error",
        extra,
      });
    }
  } catch {
    // Sentry not initialized or not supported in this runtime; safe no-op
  }
}

function recordSharedStoreFailure(key: string, reason: string, details?: any) {
  const keyClass = getKeyClass(key);
  const now = Date.now();
  const lastAlert = alertDedupeStore.get(keyClass) || 0;

  if (now - lastAlert >= ALERT_DEDUPE_WINDOW_MS) {
    alertDedupeStore.set(keyClass, now);
    const msg = `[RATE-LIMIT-SHARED-STORE-DOWN] Shared rate limit store failure (${reason}) for key class '${keyClass}' (key: '${key}')`;
    console.error(msg, details !== undefined ? details : "");
    notifySentryIfInitialized(msg, { key, keyClass, reason, details: details ? String(details) : undefined });
  }
}

function warnMemoryFallback(key: string) {
  const route = getKeyClass(key);
  const now = Date.now();
  const lastWarn = fallbackWarnDedupeStore.get(route) || 0;

  if (now - lastWarn >= ALERT_DEDUPE_WINDOW_MS) {
    fallbackWarnDedupeStore.set(route, now);
    console.warn(
      `[RATE-LIMIT-MEMORY-FALLBACK] Shared store down; falling back to in-memory rate limiting for route '${route}'. Permitted only for cheap public read endpoints (search, track, stats, ticker, early-access).`
    );
  }
}

export async function checkSharedRateLimitStrict(
  key: string,
  maxRequests: number,
  windowSeconds: number,
  options?: Omit<CheckSharedRateLimitOptions, "failClosed">
): Promise<SharedLimitResult> {
  return checkSharedRateLimit(key, maxRequests, windowSeconds, undefined, {
    ...options,
    failClosed: true,
  });
}

export async function checkSharedRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
  memoryFallback?: () => { allowed: boolean; retryAfter: number; currentCount: number },
  options?: CheckSharedRateLimitOptions
): Promise<SharedLimitResult> {
  const isStrict = Boolean(options?.failClosed || !memoryFallback);
  const client = getRateLimitClient(options?.client, options?.env);

  if (!client) {
    recordSharedStoreFailure(key, "client_unconfigured", "Supabase client unconfigured or missing credentials");
    if (isStrict) {
      return {
        allowed: false,
        retryAfter: 30,
        currentCount: 0,
        source: "unavailable",
      };
    }
  } else {
    try {
      const { data, error } = await rpcWithRetry(() => client.rpc("check_rate_limit", {
        p_key: key,
        p_max_requests: maxRequests,
        p_window_seconds: windowSeconds,
      }));

      if (error) {
        recordSharedStoreFailure(key, "rpc_error", error);
      } else if (!data) {
        recordSharedStoreFailure(key, "empty_payload", "check_rate_limit RPC returned empty data");
      } else {
        const row = Array.isArray(data) ? data[0] : data;
        if (row && typeof row.allowed === "boolean") {
          return {
            allowed: row.allowed,
            retryAfter: row.retry_after ?? 0,
            currentCount: row.current_count ?? 0,
            source: "shared",
          };
        }
        recordSharedStoreFailure(key, "malformed_payload", data);
      }
    } catch (err) {
      recordSharedStoreFailure(key, "rpc_exception", err);
    }
  }

  // If we reach here, shared store is unavailable or failed
  if (isStrict) {
    return {
      allowed: false,
      retryAfter: 30,
      currentCount: 0,
      source: "unavailable",
    };
  }

  // PERMITTED FALLBACK USERS:
  // In-memory fallback is strictly reserved ONLY for cheap public read endpoints:
  // - /api/jobs/search (`search:ip:*`)
  // - /api/track (`track:ip:*`)
  // - /api/stats (`stats:ip:*`)
  // - /api/ticker (`ticker:ip:*`)
  // - /api/early-access (`early_access:ip:*`)
  // All costly/AI operations (e.g. /api/ai per-IP and per-user) MUST use checkSharedRateLimitStrict() / failClosed: true.
  if (!memoryFallback) {
    return {
      allowed: false,
      retryAfter: 30,
      currentCount: 0,
      source: "unavailable",
    };
  }

  warnMemoryFallback(key);
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

export const TICKER_RATE_LIMIT = {
  maxRequests: 60,
  windowSeconds: 60,
};

export const tickerRateLimitStore = new Map<string, { count: number; resetAt: number }>();

export function _resetTickerRateLimitStore() {
  tickerRateLimitStore.clear();
}
