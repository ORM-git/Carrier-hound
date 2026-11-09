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

let cachedStats: LiveStatsData | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60_000; // 60 seconds

export async function getLiveStats(): Promise<LiveStatsData | null> {
  const now = Date.now();
  if (cachedStats && now - lastFetchTime < CACHE_TTL_MS) {
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
  const [stats, setStats] = useState<LiveStatsData | null>(cachedStats);
  const [loading, setLoading] = useState(!cachedStats);

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

  return {
    stats,
    loading,
    activeJobs: stats?.activeJobs ?? stats?.totalJobs ?? null,
    companies: stats?.companies ?? stats?.companiesScanned ?? null,
    totalJobs: stats?.totalJobs ?? stats?.activeJobs ?? null,
    companiesScanned: stats?.companiesScanned ?? stats?.companies ?? null,
    jobsToday: stats?.jobsToday ?? null,
  };
}
