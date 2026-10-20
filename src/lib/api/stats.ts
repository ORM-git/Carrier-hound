"use client";

import { useState, useEffect } from "react";

/**
 * Client-side and shared utilities for fetching strictly real platform statistics.
 * Sourced directly from /api/stats (which queries active jobs and registered companies in Supabase).
 * ZERO fake numbers, zero hardcoded marketing figures, zero fabricated multipliers.
 */

export interface LiveStatsData {
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
    const res = await fetch("/api/stats");
    if (!res.ok) return null;
    const data = await res.json();
    if (
      typeof data.totalJobs === "number" &&
      typeof data.companiesScanned === "number"
    ) {
      cachedStats = {
        jobsToday: typeof data.jobsToday === "number" ? data.jobsToday : 0,
        totalJobs: data.totalJobs,
        companiesScanned: data.companiesScanned,
        updatedAt: data.updatedAt,
      };
      lastFetchTime = now;
      return cachedStats;
    }
    return null;
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
    totalJobs: stats?.totalJobs ?? null,
    companiesScanned: stats?.companiesScanned ?? null,
    jobsToday: stats?.jobsToday ?? null,
  };
}
