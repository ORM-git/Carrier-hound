"use client";

import React, { useEffect, useRef, useState } from "react";

const FALLBACK_JOBS_TODAY = 0;
const FALLBACK_TOTAL_JOBS = 16423;
const FALLBACK_COMPANIES_SCANNED = 500;

interface StatsData {
  jobsToday: number;
  totalJobs: number;
  companiesScanned: number;
  updatedAt?: string;
}

export default function GlobeLiveStats() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Target values from API or fallback
  const [stats, setStats] = useState<StatsData>({
    jobsToday: FALLBACK_JOBS_TODAY,
    totalJobs: FALLBACK_TOTAL_JOBS,
    companiesScanned: FALLBACK_COMPANIES_SCANNED,
  });

  // Display animated count-up values
  const [displayJobsToday, setDisplayJobsToday] = useState(0);
  const [displayTotalJobs, setDisplayTotalJobs] = useState(0);
  const [displayCompanies, setDisplayCompanies] = useState(0);

  // Track if count-up has already executed
  const hasAnimatedRef = useRef(false);
  const [lastUpdatedTime, setLastUpdatedTime] = useState<number>(Date.now());
  const [updatedText, setUpdatedText] = useState("updated just now");

  // 1. Fetch live stats from /api/stats on mount and every 60 seconds
  useEffect(() => {
    let isMounted = true;

    async function fetchStats() {
      try {
        const res = await fetch("/api/stats");
        if (!res.ok) throw new Error("Failed to fetch stats");
        const data: StatsData = await res.json();
        if (isMounted) {
          setStats({
            jobsToday: data.jobsToday ?? 0,
            totalJobs: data.totalJobs || FALLBACK_TOTAL_JOBS,
            companiesScanned: data.companiesScanned || FALLBACK_COMPANIES_SCANNED,
          });
          setLastUpdatedTime(Date.now());
          setUpdatedText("updated just now");
        }
      } catch {
        // Keep fallback constants on network or parse failure
      }
    }

    fetchStats();
    const intervalId = setInterval(fetchStats, 60000);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, []);

  // 2. Count-up animation helper (ease-out over 1.5s)
  const runCountUp = (target: StatsData) => {
    const duration = 1500; // 1.5 seconds
    const startTime = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Cubic ease-out
      const easeOut = 1 - Math.pow(1 - progress, 3);

      setDisplayJobsToday(Math.round(target.jobsToday * easeOut));
      setDisplayTotalJobs(Math.round(target.totalJobs * easeOut));
      setDisplayCompanies(Math.round(target.companiesScanned * easeOut));

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        setDisplayJobsToday(target.jobsToday);
        setDisplayTotalJobs(target.totalJobs);
        setDisplayCompanies(target.companiesScanned);
      }
    };

    requestAnimationFrame(animate);
  };

  // 3. IntersectionObserver: Trigger count-up once when scrolled into view
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry.isIntersecting && !hasAnimatedRef.current) {
          hasAnimatedRef.current = true;
          observer.disconnect();
          runCountUp(stats);
        }
      },
      { threshold: 0.15 }
    );

    observer.observe(el);

    return () => {
      observer.disconnect();
    };
  }, [stats]);

  // If stats update after initial animation (e.g. from 60s refetch), smoothly reflect changes
  useEffect(() => {
    if (hasAnimatedRef.current) {
      setDisplayJobsToday(stats.jobsToday);
      setDisplayTotalJobs(stats.totalJobs);
      setDisplayCompanies(stats.companiesScanned);
    }
  }, [stats]);

  // 4. Update the "updated just now" line to real time every 30 seconds
  useEffect(() => {
    const updateRelativeTime = () => {
      const seconds = Math.floor((Date.now() - lastUpdatedTime) / 1000);
      if (seconds < 30) {
        setUpdatedText("updated just now");
      } else if (seconds < 60) {
        setUpdatedText("updated 30 seconds ago");
      } else {
        const mins = Math.floor(seconds / 60);
        setUpdatedText(`updated ${mins}m ago`);
      }
    };

    updateRelativeTime();
    const timer = setInterval(updateRelativeTime, 30000);

    return () => clearInterval(timer);
  }, [lastUpdatedTime]);

  return (
    <div
      ref={containerRef}
      className="w-full pt-6 border-t border-gray-100 dark:border-zinc-800 space-y-3.5"
    >
      {/* Top: Pulsing Green Dot + LIVE label */}
      <div className="flex items-center justify-center lg:justify-start gap-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
        </span>
        <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400 tracking-wider uppercase">
          LIVE
        </span>
      </div>

      {/* Stats Row: 3 in a row, responsive wrap to 2+1 centered on narrow mobile */}
      <div className="grid grid-cols-3 max-[480px]:flex max-[480px]:flex-wrap max-[480px]:justify-center gap-4 sm:gap-6 md:gap-8 items-start">
        {/* Stat 1: jobs found today */}
        <div className="text-center lg:text-left min-w-[90px] max-[480px]:w-[calc(50%-0.6rem)]">
          <div className="text-2xl sm:text-3xl font-extrabold text-[#09090B] dark:text-white tracking-tight">
            {displayJobsToday.toLocaleString("en-US")}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 font-medium mt-0.5">
            jobs found today (est.)
          </div>
        </div>

        {/* Stat 2: total hidden jobs */}
        <div className="text-center lg:text-left min-w-[90px] max-[480px]:w-[calc(50%-0.6rem)]">
          <div className="text-2xl sm:text-3xl font-extrabold text-[#09090B] dark:text-white tracking-tight">
            {displayTotalJobs.toLocaleString("en-US")}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 font-medium mt-0.5">
            total hidden jobs
          </div>
        </div>

        {/* Stat 3: companies scanned */}
        <div className="text-center lg:text-left min-w-[90px] max-[480px]:w-full max-[480px]:text-center">
          <div className="text-2xl sm:text-3xl font-extrabold text-[#09090B] dark:text-white tracking-tight">
            {displayCompanies.toLocaleString("en-US")}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 font-medium mt-0.5">
            companies scanned
          </div>
        </div>
      </div>

      {/* Bottom: Muted "updated just now" line */}
      <p className="text-xs text-gray-500 dark:text-zinc-500 font-normal text-center lg:text-left">
        {updatedText}
      </p>
    </div>
  );
}
