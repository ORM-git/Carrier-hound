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

/** UTC calendar day (YYYY-MM-DD) of an ISO string or epoch ms, or null when it is not a valid time. */
export function utcDayKey(input: string | number | undefined | null): string | null {
  if (input === undefined || input === null || input === "") return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Determines whether an ISO timestamp string belongs to the current UTC calendar day. */
export function isTodayUtc(isoString?: string, referenceMs = Date.now()): boolean {
  const day = utcDayKey(isoString);
  return day !== null && day === utcDayKey(referenceMs);
}

/**
 * Parses HTTP Retry-After header which may be either:
 * 1. Integer seconds (e.g. "120")
 * 2. An HTTP-date (RFC 9110 / RFC 7231, e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
 * Returns the server's full wait in whole seconds (at least 1, never shortened), or undefined when
 * the header is absent, invalid or already in the past.
 */
export function parseRetryAfterHeader(headerValue: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 0 && Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (!isNaN(dateMs)) {
    const diffSec = Math.ceil((dateMs - nowMs) / 1000);
    if (diffSec > 0) return diffSec;
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
      const retryHeader = res.headers?.get("retry-after") || res.headers?.get("Retry-After");
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
    // Network failure, timeout abort or superseded request: never a count.
    return { jobsToday: null, status: 0 };
  }
}

export const DAILY_COUNT_REFRESH_MS = 300_000;
/** A request that has not answered by then is aborted and treated as a failure. */
export const DAILY_COUNT_TIMEOUT_MS = 10_000;
/** Waits after consecutive failures; after the last one, automatic retries stop until a tab return or the next UTC day. */
export const DAILY_COUNT_FAILURE_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 900_000] as const;
const MAX_TIMER_MS = 2_147_483_647; // setTimeout's ceiling; a longer server wait suspends instead

/**
 * Hook to consume automatic daily jobs found count on the landing page hero.
 * - Anonymous fetch without viewer token; a request is aborted after DAILY_COUNT_TIMEOUT_MS.
 * - Shows a number only while its own UTC day is today: the day is stored with the count and checked
 *   at every render, so a tab returning after midnight (timers throttled) hides yesterday's number
 *   before any response.
 * - Any failed refresh (error status, 429, malformed or prior-day data, network error, timeout) hides
 *   the number; it never stays on screen as if still current.
 * - Refreshes every 5 minutes while visible, on tab return and at UTC midnight. None of these run
 *   before a server Retry-After deadline (seconds or HTTP-date, honored in full).
 * - Failures back off (30s, 1m, 2m, 5m, 15m), then automatic retries stop until a tab return or the
 *   next UTC day: no endless retry loop.
 * - Race-safe (latest request wins) with full unmount cleanup.
 */
export function useDailyJobsCount(): number | null {
  const [shown, setShown] = useState<{ count: number; day: string } | null>(null);
  // Bumped on tab return and at midnight so the day check below re-runs without waiting for a response.
  const [, setClockTick] = useState(0);

  useEffect(() => {
    let active = true;
    let abortController: AbortController | null = null;
    let reqId = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let midnightTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;
    let notBeforeMs = 0; // server rate-limit deadline

    const isVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

    const schedule = (delayMs: number) => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = null;
      if (delayMs > MAX_TIMER_MS) return; // suspended: a tab return or the next UTC day tries again
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (active && isVisible()) performFetch();
      }, Math.max(0, delayMs));
    };

    const performFetch = async () => {
      if (!active) return;
      const now = Date.now();
      if (now < notBeforeMs) {
        schedule(notBeforeMs - now); // never bypass the server's Retry-After
        return;
      }
      if (abortController) abortController.abort();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const controller = new AbortController();
      abortController = controller;
      const currentReqId = ++reqId;
      timeoutTimer = setTimeout(() => controller.abort(), DAILY_COUNT_TIMEOUT_MS);

      const result = await fetchAnonymousDailyStats(controller.signal);
      if (!active || currentReqId !== reqId) return;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = null;

      const day = utcDayKey(result.updatedAt);
      if (result.status === 200 && result.jobsToday !== null && day !== null && day === utcDayKey(Date.now())) {
        consecutiveFailures = 0;
        setShown({ count: result.jobsToday, day });
        schedule(DAILY_COUNT_REFRESH_MS);
        return;
      }

      // Every unsuccessful refresh hides the previous number.
      setShown(null);
      if (result.status === 429 && result.retryAfterSeconds) {
        notBeforeMs = Date.now() + result.retryAfterSeconds * 1000;
        schedule(notBeforeMs - Date.now());
        return;
      }
      consecutiveFailures++;
      if (consecutiveFailures > DAILY_COUNT_FAILURE_BACKOFF_MS.length) {
        schedule(Infinity);
        return;
      }
      schedule(DAILY_COUNT_FAILURE_BACKOFF_MS[consecutiveFailures - 1]);
    };

    const scheduleMidnight = () => {
      if (midnightTimer) clearTimeout(midnightTimer);
      const now = new Date();
      const nextMidnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 50);
      const delay = Math.max(100, nextMidnightUtc - now.getTime());
      midnightTimer = setTimeout(() => {
        if (!active) return;
        setClockTick((t) => t + 1); // yesterday's number hides now
        if (isVisible()) performFetch();
        scheduleMidnight();
      }, delay);
    };

    const onVisibilityChange = () => {
      if (!isVisible()) return;
      setClockTick((t) => t + 1);
      performFetch();
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    performFetch();
    scheduleMidnight();

    return () => {
      active = false;
      if (abortController) abortController.abort();
      for (const t of [refreshTimer, midnightTimer, timeoutTimer]) if (t) clearTimeout(t);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, []);

  return shown && shown.day === utcDayKey(Date.now()) ? shown.count : null;
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
