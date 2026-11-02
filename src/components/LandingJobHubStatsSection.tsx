"use client";

import React, { useState, useEffect, useRef } from "react";
import BrandIcon from "@/components/BrandIcon";
import { Building2, Briefcase, Clock, Sparkles } from "lucide-react";

export interface RealStatsData {
  totalJobs?: number | null;
  jobsToday?: number | null;
  companies?: number | null;
  countries?: number | null;
}

export interface LandingJobHubStatsSectionProps {
  initialStats?: RealStatsData;
}

/**
 * Elegant Laurel Wreath award badge SVG wrapper.
 */
function LaurelWreath({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-1 sm:gap-1.5 select-none">
      {/* Left Laurel Branch */}
      <svg
        width="15"
        height="34"
        viewBox="0 0 20 44"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="text-[#2563EB] shrink-0"
        aria-hidden="true"
      >
        <path
          d="M16 3 C12 12 8 26 10 40"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <path d="M16 4 C13 3 11 6 13 8 C15 9 17 6 16 4 Z" fill="currentColor" />
        <path d="M14 10 C10 9 8 12 11 14 C13 15 15 12 14 10 Z" fill="currentColor" />
        <path d="M12 18 C8 17 6 20 9 22 C12 23 14 20 12 18 Z" fill="currentColor" />
        <path d="M10 26 C6 25 4 28 7 30 C10 31 12 28 10 26 Z" fill="currentColor" />
        <path d="M10 34 C6 33 4 36 7 38 C9 39 11 36 10 34 Z" fill="currentColor" />
        <path d="M15 8 C17 10 18 13 16 14 C15 15 13 12 15 8 Z" fill="currentColor" />
        <path d="M13 16 C15 18 16 21 14 22 C13 23 11 20 13 16 Z" fill="currentColor" />
        <path d="M11 24 C13 26 14 29 12 30 C11 31 9 28 11 24 Z" fill="currentColor" />
        <path d="M11 32 C13 34 14 37 12 38 C11 39 9 36 11 32 Z" fill="currentColor" />
      </svg>

      {/* Center text content */}
      <div className="flex flex-col items-center justify-center text-center">
        {children}
      </div>

      {/* Right Laurel Branch (Mirrored) */}
      <svg
        width="15"
        height="34"
        viewBox="0 0 20 44"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="text-[#2563EB] shrink-0 -scale-x-100"
        aria-hidden="true"
      >
        <path
          d="M16 3 C12 12 8 26 10 40"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <path d="M16 4 C13 3 11 6 13 8 C15 9 17 6 16 4 Z" fill="currentColor" />
        <path d="M14 10 C10 9 8 12 11 14 C13 15 15 12 14 10 Z" fill="currentColor" />
        <path d="M12 18 C8 17 6 20 9 22 C12 23 14 20 12 18 Z" fill="currentColor" />
        <path d="M10 26 C6 25 4 28 7 30 C10 31 12 28 10 26 Z" fill="currentColor" />
        <path d="M10 34 C6 33 4 36 7 38 C9 39 11 36 10 34 Z" fill="currentColor" />
        <path d="M15 8 C17 10 18 13 16 14 C15 15 13 12 15 8 Z" fill="currentColor" />
        <path d="M13 16 C15 18 16 21 14 22 C13 23 11 20 13 16 Z" fill="currentColor" />
        <path d="M11 24 C13 26 14 29 12 30 C11 31 9 28 11 24 Z" fill="currentColor" />
        <path d="M11 32 C13 34 14 37 12 38 C11 39 9 36 11 32 Z" fill="currentColor" />
      </svg>
    </div>
  );
}

/**
 * Dotted connector with bracket/curved split and arrowheads fanning out to stat rows.
 * Hidden on mobile.
 */
function DottedConnector({ rowCount }: { rowCount: number }) {
  if (rowCount <= 0) return null;

  return (
    <svg
      viewBox="0 0 100 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="w-full h-full max-h-[260px] text-[#2563EB]"
      aria-hidden="true"
    >
      {/* Root dot */}
      <circle cx="6" cy="120" r="3.5" fill="#2563EB" />

      {/* Trunk line from root dot to split point */}
      <line
        x1="6"
        y1="120"
        x2="32"
        y2="120"
        stroke="#2563EB"
        strokeWidth="2"
        strokeDasharray="3 3"
        strokeLinecap="round"
      />

      {rowCount === 1 && (
        <>
          <line
            x1="32"
            y1="120"
            x2="84"
            y2="120"
            stroke="#2563EB"
            strokeWidth="2"
            strokeDasharray="3 3"
            strokeLinecap="round"
          />
          <polygon points="84,115 94,120 84,125" fill="#2563EB" />
        </>
      )}

      {rowCount === 2 && (
        <>
          {/* Top branch */}
          <path
            d="M 32 120 C 54 120 58 65 84 65"
            stroke="#2563EB"
            strokeWidth="2"
            strokeDasharray="3 3"
            strokeLinecap="round"
            fill="none"
          />
          <polygon points="84,60 94,65 84,70" fill="#2563EB" />

          {/* Bottom branch */}
          <path
            d="M 32 120 C 54 120 58 175 84 175"
            stroke="#2563EB"
            strokeWidth="2"
            strokeDasharray="3 3"
            strokeLinecap="round"
            fill="none"
          />
          <polygon points="84,170 94,175 84,180" fill="#2563EB" />
        </>
      )}

      {rowCount >= 3 && (
        <>
          {/* Top branch */}
          <path
            d="M 32 120 C 56 120 60 40 84 40"
            stroke="#2563EB"
            strokeWidth="2"
            strokeDasharray="3 3"
            strokeLinecap="round"
            fill="none"
          />
          <polygon points="84,35 94,40 84,45" fill="#2563EB" />

          {/* Middle straight branch */}
          <line
            x1="32"
            y1="120"
            x2="84"
            y2="120"
            stroke="#2563EB"
            strokeWidth="2"
            strokeDasharray="3 3"
            strokeLinecap="round"
          />
          <polygon points="84,115 94,120 84,125" fill="#2563EB" />

          {/* Bottom branch */}
          <path
            d="M 32 120 C 56 120 60 200 84 200"
            stroke="#2563EB"
            strokeWidth="2"
            strokeDasharray="3 3"
            strokeLinecap="round"
            fill="none"
          />
          <polygon points="84,195 94,200 84,205" fill="#2563EB" />
        </>
      )}
    </svg>
  );
}

export default function LandingJobHubStatsSection({
  initialStats,
}: LandingJobHubStatsSectionProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const [stats, setStats] = useState<RealStatsData | null>(initialStats || null);
  const [displayValues, setDisplayValues] = useState<Record<string, number | null>>({});
  const hasAnimatedRef = useRef(false);

  // 1. Fetch live stats if not provided initially
  useEffect(() => {
    if (
      initialStats &&
      (initialStats.totalJobs !== undefined ||
        initialStats.companies !== undefined ||
        initialStats.jobsToday !== undefined)
    ) {
      setStats(initialStats);
      return;
    }

    let isMounted = true;
    async function fetchStats() {
      try {
        const res = await fetch("/api/stats");
        if (!res.ok) throw new Error("Stats request failed");
        const data = await res.json();
        if (isMounted) {
          const totalJobs =
            typeof data?.totalJobs === "number"
              ? data.totalJobs
              : typeof data?.activeJobs === "number"
              ? data.activeJobs
              : null;
          const jobsToday =
            typeof data?.jobsToday === "number" ? data.jobsToday : null;
          const companies =
            typeof data?.companiesScanned === "number"
              ? data.companiesScanned
              : typeof data?.companies === "number"
              ? data.companies
              : null;
          const countries =
            typeof data?.countries === "number" ? data.countries : null;

          setStats({
            totalJobs,
            jobsToday,
            companies,
            countries,
          });
        }
      } catch {
        if (isMounted) {
          setStats(null);
        }
      }
    }

    fetchStats();
    return () => {
      isMounted = false;
    };
  }, [initialStats]);

  // 2. Count-up animation helper (IntersectionObserver triggered)
  const runAnimation = (data: RealStatsData) => {
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Under prefers-reduced-motion, set final numbers immediately
    if (prefersReducedMotion) {
      setDisplayValues({
        totalJobs: data.totalJobs ?? null,
        jobsToday: data.jobsToday ?? null,
        companies: data.companies ?? null,
        countries: data.countries ?? null,
      });
      return;
    }

    const duration = 1200; // 1.2s count-up
    const startTime = performance.now();
    const targetTotal = data.totalJobs ?? 0;
    const targetToday = data.jobsToday ?? 0;
    const targetCompanies = data.companies ?? 0;

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easeOut = 1 - Math.pow(1 - progress, 3);

      setDisplayValues({
        totalJobs:
          data.totalJobs !== null && data.totalJobs !== undefined
            ? Math.round(targetTotal * easeOut)
            : null,
        jobsToday:
          data.jobsToday !== null && data.jobsToday !== undefined
            ? Math.round(targetToday * easeOut)
            : null,
        companies:
          data.companies !== null && data.companies !== undefined
            ? Math.round(targetCompanies * easeOut)
            : null,
      });

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        setDisplayValues({
          totalJobs: data.totalJobs ?? null,
          jobsToday: data.jobsToday ?? null,
          companies: data.companies ?? null,
        });
      }
    };

    requestAnimationFrame(animate);
  };

  // 3. IntersectionObserver trigger
  useEffect(() => {
    if (!stats) return;

    if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
      runAnimation(stats);
      return;
    }

    const el = containerRef.current;
    if (!el) {
      runAnimation(stats);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry.isIntersecting && !hasAnimatedRef.current) {
          hasAnimatedRef.current = true;
          observer.disconnect();
          runAnimation(stats);
        }
      },
      { threshold: 0.15 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [stats]);

  if (!stats) return null;

  // Format helper (strictly exact real number formatted with commas)
  const formatNumber = (num: number | null | undefined): string | null => {
    if (num === null || num === undefined) return null;
    return num.toLocaleString("en-US");
  };

  // Rows config: Real data only from /api/stats (total jobs, companies scanned, new jobs today)
  const rows = [
    {
      key: "companies",
      val:
        displayValues.companies !== undefined
          ? displayValues.companies
          : stats.companies,
      raw: stats.companies,
      label: "Companies scanned",
      icon: Building2,
    },
    {
      key: "totalJobs",
      val:
        displayValues.totalJobs !== undefined
          ? displayValues.totalJobs
          : stats.totalJobs,
      raw: stats.totalJobs,
      label: "Total jobs",
      icon: Briefcase,
    },
    {
      key: "jobsToday",
      val:
        displayValues.jobsToday !== undefined
          ? displayValues.jobsToday
          : stats.jobsToday,
      raw: stats.jobsToday,
      label: "New jobs today",
      icon: Clock,
    },
  ];

  // HIDE any row whose value is missing or 0 (new jobs today must not show 0)
  const activeRows = rows.filter(
    (r) => typeof r.raw === "number" && r.raw > 0
  );

  // If all rows fail/missing, render nothing (no empty container)
  if (activeRows.length === 0) {
    return null;
  }

  return (
    <section
      ref={containerRef}
      aria-label="Market Data & Job Hub Statistics"
      data-testid="landing-job-hub-stats-section"
      className="py-12 sm:py-16 lg:py-20 bg-white overflow-hidden"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Soft tinted rounded speech-bubble card with bottom-left pointer */}
        <div className="relative bg-[#EFF6FF] border border-[#BFDBFE] rounded-3xl sm:rounded-[36px] p-6 sm:p-10 lg:p-12 shadow-xs">
          {/* Mascot Header Badge (Mascot appears once) */}
          <div className="flex items-center gap-2 mb-6 sm:mb-8 select-none">
            <div className="w-8 h-8 rounded-xl bg-white p-1 border border-blue-100 shadow-2xs flex items-center justify-center shrink-0">
              <BrandIcon size={24} className="w-full h-full object-contain" />
            </div>
            <span className="text-xs font-bold uppercase tracking-wider text-[#2563EB] bg-white/80 px-2.5 py-1 rounded-full border border-blue-100">
              Live Market Data
            </span>
          </div>

          {/* Single wide section layout: Left column with laurel awards & headline, Center connector, Right stat rows */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-8 lg:gap-12 w-full">
            {/* Left Column: Laurel wreath award badges + Big bold headline with dot */}
            <div className="flex flex-col justify-center shrink-0 lg:max-w-md">
              {/* 3 Laurel Wreath Badges matching reference layout */}
              <div className="flex flex-wrap items-center gap-4 sm:gap-6 mb-6">
                <LaurelWreath>
                  <span className="text-[10px] font-medium text-slate-500 leading-tight">Direct from source</span>
                  <span className="text-[11px] font-bold text-[#090E34] leading-tight">Company Portals</span>
                  <span className="text-[10px] font-extrabold text-[#2563EB] leading-tight uppercase">100% Direct</span>
                </LaurelWreath>

                <LaurelWreath>
                  <span className="text-[10px] font-medium text-slate-500 leading-tight">Continuous Radar</span>
                  <span className="text-[11px] font-bold text-[#090E34] leading-tight">Every 15 Mins</span>
                  <span className="text-[10px] font-extrabold text-[#2563EB] leading-tight uppercase">Live Sync</span>
                </LaurelWreath>

                <LaurelWreath>
                  <span className="text-[10px] font-bold text-amber-500 leading-none tracking-widest">★★★★★</span>
                  <span className="text-[10px] font-medium text-slate-500 leading-tight mt-0.5">Candidate First</span>
                  <span className="text-[11px] font-extrabold text-[#090E34] leading-tight">Zero Aggregators</span>
                </LaurelWreath>
              </div>

              {/* Headline with small dot on right edge */}
              <div className="flex items-center justify-between lg:justify-start gap-4">
                <h2 className="text-3xl sm:text-4xl lg:text-[42px] font-black text-[#090E34] uppercase tracking-tight leading-[1.08]">
                  Real numbers,
                  <br />
                  no promises
                </h2>
                {/* Small dot at right edge of headline */}
                <div
                  className="hidden lg:block w-3.5 h-3.5 rounded-full bg-[#2563EB] ring-4 ring-blue-100 shrink-0"
                  aria-hidden="true"
                />
              </div>
            </div>

            {/* Center Connector: Dotted bracket/curved split with arrowheads (desktop only) */}
            <div
              className="hidden lg:flex items-center justify-center shrink-0 w-24 xl:w-28 h-52 xl:h-60"
              aria-hidden="true"
            >
              <DottedConnector rowCount={activeRows.length} />
            </div>

            {/* Right Column: Vertical stack of stat rows */}
            <div className="flex-1 flex flex-col justify-center space-y-6 sm:space-y-8 w-full max-w-2xl">
              {activeRows.map((row) => {
                const Icon = row.icon;
                return (
                  <div
                    key={row.key}
                    className="flex items-center justify-between gap-3 sm:gap-6 w-full"
                  >
                    {/* Number + Label */}
                    <div className="flex flex-col text-left shrink-0 min-w-[120px] sm:min-w-[150px]">
                      <span className="text-[40px] sm:text-5xl lg:text-6xl font-black text-[#090E34] tracking-tight leading-none">
                        {formatNumber(row.val)}
                      </span>
                      <span className="text-xs sm:text-sm text-slate-500 font-medium mt-1.5 leading-snug">
                        {row.label}
                      </span>
                    </div>

                    {/* Long dotted horizontal leader line */}
                    <div
                      className="flex-1 border-b-2 border-dotted border-blue-200/80 mx-3 sm:mx-6 min-w-[24px]"
                      aria-hidden="true"
                    />

                    {/* Circular outline icon at far right */}
                    <div
                      className="shrink-0 flex items-center justify-center w-11 h-11 sm:w-12 sm:h-12 rounded-full border border-blue-200/90 bg-white/90 text-[#2563EB] shadow-2xs"
                      aria-hidden="true"
                    >
                      <Icon className="w-5 h-5 sm:w-6 sm:h-6 stroke-[1.8]" />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Speech-bubble tail pointing down-left */}
          <div
            className="absolute -bottom-3 sm:-bottom-3.5 left-10 sm:left-16 w-6 h-6 sm:w-7 sm:h-7 bg-[#EFF6FF] border-b border-r border-[#BFDBFE] rotate-45 transform pointer-events-none"
            aria-hidden="true"
          />
        </div>
      </div>
    </section>
  );
}
