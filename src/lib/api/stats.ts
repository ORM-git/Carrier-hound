"use client";

import { useState, useEffect } from "react";
import { parseStatsResponse } from "./clientSchemas";
import { fetchWithRetry } from "./retryFetch";

/**
 * Client-side and shared utilities for fetching strictly real platform statistics.
 * Sourced directly from /api/stats (which queries active jobs and registered companies in Supabase).
 * ZERO fake numbers, zero hardcoded marketing figures, zero fabricated multipliers.
 */

export interface LiveStatsData {
  activeJobs: number | null;
  companies: number | null;
  jobsToday: number | null;
  totalJobs: number | null;
  companiesScanned: number | null;
  updatedAt?: string;
}

/** Determines whether an ISO timestamp string belongs to the current UTC calendar day. */
export function isTodayUtc(isoString?: string, referenceMs = Date.now()): boolean {
  if (!isoString) return false;
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return false;
  const ref = new Date(referenceMs);
  return (
    d.getUTCFullYear() === ref.getUTCFullYear() &&
    d.getUTCMonth() === ref.getUTCMonth() &&
    d.getUTCDate() === ref.getUTCDate()
  );
}

/**
 * Parses HTTP Retry-After header which may be either:
 * 1. Integer seconds (e.g. "120")
 * 2. An HTTP-date (RFC 9110 / RFC 7231, e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
 * Returns bounded seconds between 1 and 300, or undefined if absent/invalid.
 */
export function parseRetryAfterHeader(headerValue: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  const seconds = parseInt(trimmed, 10);
  if (!isNaN(seconds) && String(seconds) === trimmed && seconds > 0) {
    return Math.min(300, Math.max(1, seconds));
  }
  const dateMs = Date.parse(trimmed);
  if (!isNaN(dateMs)) {
    const diffSec = Math.ceil((dateMs - nowMs) / 1000);
    if (diffSec > 0) {
      return Math.min(300, Math.max(1, diffSec));
    }
  }
  return undefined;
}

export interface DailyJobsFetchResult {
  jobsToday: number | null;
  updatedAt?: string;
  status: number;
  retryAfterSeconds?: number;
  isStalePriorDay?: boolean;
}

/**
 * Fetches the public daily jobs count anonymously without attaching viewer tokens.
 * Honors cache/auth isolation and enforces UTC day freshness.
 */
export async function fetchAnonymousDailyStats(signal?: AbortSignal): Promise<DailyJobsFetchResult> {
  try {
    const res = await fetch("/api/stats", {
      method: "GET",
      // Strictly anonymous: no Authorization header, no credentials, no viewer token
      signal,
    });

    if (res.status === 429) {
      const retryHeader = res.headers.get("retry-after") || res.headers.get("Retry-After");
      const retryAfterSeconds = parseRetryAfterHeader(retryHeader);
      return { jobsToday: null, status: 429, retryAfterSeconds };
    }

    if (!res.ok) {
      return { jobsToday: null, status: res.status };
    }

    const data = await res.json();
    const parsed = parseStatsResponse(data);
    if (!parsed || parsed.jobsToday === null) {
      return { jobsToday: null, status: res.status };
    }

    // Guard: Ensure cached prior-day results cannot appear as today's count
    if (!isTodayUtc(parsed.updatedAt)) {
      return {
        jobsToday: null,
        updatedAt: parsed.updatedAt,
        status: res.status,
        isStalePriorDay: true,
      };
    }

    return {
      jobsToday: parsed.jobsToday,
      updatedAt: parsed.updatedAt,
      status: res.status,
    };
  } catch {
    return { jobsToday: null, status: 0 };
  }
}

/**
 * Hook to consume automatic daily jobs found count on the landing page hero.
 * - Anonymous fetch without viewer token.
 * - Refreshes every 5 minutes only while visible.
 * - Revalidates on tab return.
 * - Revalidates on UTC midnight, hiding yesterday's number until fresh data arrives.
 * - Bounded backoff honoring Retry-After.
 * - Full race and unmount cleanup.
 */
export function useDailyJobsCount(): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    let abortController: AbortController | null = null;
    let reqId = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let midnightTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;

    const clearTimers = () => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      if (midnightTimer) {
        clearTimeout(midnightTimer);
        midnightTimer = null;
      }
    };

    const scheduleMidnight = () => {
      if (midnightTimer) clearTimeout(midnightTimer);
      const now = new Date();
      const nextMidnightUtc = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        0,
        0,
        50
      );
      const delay = Math.max(100, nextMidnightUtc - now.getTime());
      midnightTimer = setTimeout(() => {
        if (!active) return;
        // UTC midnight crossed: hide yesterday's number immediately until fresh data arrives
        setCount(null);
        if (typeof document !== "undefined" && document.visibilityState === "visible") {
          performFetch();
        }
        scheduleMidnight();
      }, delay);
    };

    const scheduleRefresh = (delayMs: number) => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (!active) return;
        if (typeof document === "undefined" || document.visibilityState === "visible") {
          performFetch();
        } else {
          refreshTimer = null;
        }
      }, delayMs);
    };

    const performFetch = async () => {
      if (!active) return;
      if (abortController) abortController.abort();
      abortController = new AbortController();
      const currentReqId = ++reqId;

      const result = await fetchAnonymousDailyStats(abortController.signal);
      if (!active || currentReqId !== reqId) return;

      if (result.status === 200 && result.jobsToday !== null) {
        consecutiveFailures = 0;
        setCount(result.jobsToday);
        scheduleRefresh(300_000); // 5 minutes
      } else if (result.status === 429) {
        const delaySec = result.retryAfterSeconds ?? 30;
        scheduleRefresh(delaySec * 1000);
      } else {
        consecutiveFailures = Math.min(consecutiveFailures + 1, 4);
        const backoffMs = Math.min(60_000, 5_000 * Math.pow(2, consecutiveFailures));
        scheduleRefresh(backoffMs);
      }
    };

    const onVisibilityChange = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        performFetch();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    performFetch();
    scheduleMidnight();

    return () => {
      active = false;
      if (abortController) abortController.abort();
      clearTimers();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, []);

  return count;
}

let cachedStats: LiveStatsData | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60_000; // 60 seconds

export async function getLiveStats(): Promise<LiveStatsData | null> {
  const now = Date.now();
  if (cachedStats && now - lastFetchTime < CACHE_TTL_MS && isTodayUtc(cachedStats.updatedAt, now)) {
    return cachedStats;
  }

  try {
    let token: string | undefined;
    try {
      const { createClient } = await import("../supabase/client");
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      token = session?.access_token;
    } catch {}

    const headers: Record<string, string> = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const res = await fetchWithRetry(() => fetch("/api/stats", { headers }));
    if (!res.ok) return null;
    const parsed = parseStatsResponse(await res.json());
    if (!parsed) return null;
    cachedStats = parsed;
    lastFetchTime = now;
    return cachedStats;
  } catch {
    return null;
  }
}

/**
 * Hook to consume live stats client-side.
 * When data is unavailable or loading, returns null values so components can render
 * fallback copy without displaying fabricated figures.
 */
export function useLiveStats() {
  const [stats, setStats] = useState<LiveStatsData | null>(() => {
    if (cachedStats && isTodayUtc(cachedStats.updatedAt)) {
      return cachedStats;
    }
    return null;
  });
  const [loading, setLoading] = useState(!cachedStats || !isTodayUtc(cachedStats.updatedAt));

  useEffect(() => {
    let mounted = true;

    getLiveStats().then((data) => {
      if (mounted) {
        if (data) setStats(data);
        setLoading(false);
      }
    });

    const interval = setInterval(() => {
      getLiveStats().then((data) => {
        if (mounted && data) setStats(data);
      });
    }, CACHE_TTL_MS);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const isFresh = isTodayUtc(stats?.updatedAt);

  return {
    stats,
    loading,
    activeJobs: stats?.activeJobs ?? stats?.totalJobs ?? null,
    companies: stats?.companies ?? stats?.companiesScanned ?? null,
    totalJobs: stats?.totalJobs ?? stats?.activeJobs ?? null,
    companiesScanned: stats?.companiesScanned ?? stats?.companies ?? null,
    jobsToday: isFresh ? (stats?.jobsToday ?? null) : null,
  };
}
