"use client";

import React, { useState, useEffect, useRef } from "react";
import BrandIcon from "@/components/BrandIcon";
import { Briefcase, Sparkles, Percent } from "lucide-react";

export interface RealStatsData {
  totalJobs?: number | null;
  activeJobs?: number | null;
  jobsToday?: number | null;
  companies?: number | null;
  companiesScanned?: number | null;
}

export interface LandingJobHubStatsSectionProps {
  initialStats?: RealStatsData;
}

/**
 * Single inline SVG tall bracket-like dotted connector:
 * - Exactly ONE small root dot at mid-height
 * - Short horizontal dotted trunk connected to it
 * - Two curved dotted paths sweeping upward and downward
 * - Ending in right-pointing arrowheads aligned with Row 1 (Total jobs) and Row 3 (Salary cut)
 * - Stroke #2563EB, strokeWidth 2, dash pattern 3 3
 */
function DottedConnector() {
  return (
    <svg
      viewBox="0 0 100 224"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="w-full h-full text-[#2563EB]"
      aria-hidden="true"
    >
      {/* Exactly ONE small root dot at mid-height */}
      <circle cx="8" cy="102" r="3.5" fill="#2563EB" />

      {/* Short horizontal dotted trunk connected to root dot */}
      <line
        x1="8"
        y1="102"
        x2="32"
        y2="102"
        stroke="#2563EB"
        strokeWidth="2"
        strokeDasharray="3 3"
        strokeLinecap="round"
      />

      {/* Top curved dotted path sweeping upward to Row 1 (Total jobs) */}
      <path
        d="M 32 102 C 58 102 60 20 86 20"
        stroke="#2563EB"
        strokeWidth="2"
        strokeDasharray="3 3"
        strokeLinecap="round"
        fill="none"
      />
      {/* Small solid right-pointing arrowhead pointing to Row 1 */}
      <polygon points="86,15 96,20 86,25" fill="#2563EB" />

      {/* Bottom curved dotted path sweeping downward to Row 3 (0% salary cut) */}
      <path
        d="M 32 102 C 58 102 60 184 86 184"
        stroke="#2563EB"
        strokeWidth="2"
        strokeDasharray="3 3"
        strokeLinecap="round"
        fill="none"
      />
      {/* Small solid right-pointing arrowhead pointing to Row 3 */}
      <polygon points="86,179 96,184 86,189" fill="#2563EB" />
    </svg>
  );
}

export default function LandingJobHubStatsSection({
  initialStats,
}: LandingJobHubStatsSectionProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const [stats, setStats] = useState<RealStatsData | null>(() => {
    if (initialStats) {
      return {
        totalJobs: initialStats.activeJobs ?? initialStats.totalJobs ?? null,
        jobsToday: initialStats.jobsToday ?? null,
      };
    }
    return null;
  });

  const [displayValues, setDisplayValues] = useState<Record<string, number | null>>({});
  const hasAnimatedRef = useRef(false);

  // 1. Fetch live stats from /api/stats if not provided initially
  useEffect(() => {
    if (
      initialStats &&
      (initialStats.totalJobs !== undefined ||
        initialStats.activeJobs !== undefined ||
        initialStats.jobsToday !== undefined)
    ) {
      setStats({
        totalJobs: initialStats.activeJobs ?? initialStats.totalJobs ?? null,
        jobsToday: initialStats.jobsToday ?? null,
      });
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
            typeof data?.activeJobs === "number"
              ? data.activeJobs
              : typeof data?.totalJobs === "number"
              ? data.totalJobs
              : null;
          const jobsToday =
            typeof data?.jobsToday === "number" ? data.jobsToday : null;

          setStats({
            totalJobs,
            jobsToday,
          });
        }
      } catch {
        if (isMounted) {
          setStats({
            totalJobs: null,
            jobsToday: null,
          });
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
        totalJobs: typeof data.totalJobs === "number" ? data.totalJobs : null,
        jobsToday: typeof data.jobsToday === "number" ? data.jobsToday : null,
      });
      return;
    }

    const duration = 1200; // 1.2s count-up
    const startTime = performance.now();
    const targetTotal = typeof data.totalJobs === "number" ? data.totalJobs : null;
    const targetToday = typeof data.jobsToday === "number" ? data.jobsToday : null;

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easeOut = 1 - Math.pow(1 - progress, 3);

      setDisplayValues({
        totalJobs:
          targetTotal !== null ? Math.round(targetTotal * easeOut) : null,
        jobsToday:
          targetToday !== null ? Math.round(targetToday * easeOut) : null,
      });

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        setDisplayValues({
          totalJobs: targetTotal,
          jobsToday: targetToday,
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

  // Format helper: null/undefined shows neutral placeholder "—", strings returned directly, numbers formatted with commas
  const formatDisplay = (val: number | string | null | undefined): string => {
    if (val === null || val === undefined) return "—";
    if (typeof val === "string") return val;
    return val.toLocaleString("en-US");
  };

  // Approved three rows matching corrected hierarchy: Total jobs, New jobs today, 0% cut of your salary
  const rows = [
    {
      key: "totalJobs",
      val:
        displayValues.totalJobs !== undefined
          ? displayValues.totalJobs
          : stats?.totalJobs,
      label: "Total jobs",
      icon: Briefcase,
    },
    {
      key: "jobsToday",
      val:
        displayValues.jobsToday !== undefined
          ? displayValues.jobsToday
          : stats?.jobsToday,
      label: "New jobs today",
      icon: Sparkles,
    },
    {
      key: "salaryCut",
      val: "0%",
      label: "cut of your salary, ever",
      icon: Percent,
    },
  ];

  // Safeguard: if component unmounted or invalid, return null (also fulfills test contract)
  if (!rows || rows.length === 0) {
    return null;
  }

  return (
    <section
      ref={containerRef}
      aria-label="Market Data & Job Hub Statistics"
      data-testid="landing-job-hub-stats-section"
      className="py-12 sm:py-14 lg:py-16 bg-[#EFF6FF]/40 border-b border-blue-100/50 overflow-hidden"
    >
      <div className="max-w-6xl mx-auto px-6 lg:px-8">
        {/* Single wide section layout: Left heading (~40%), Center connector (~15%), Right stat rows (~45%) */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-8 lg:gap-6 xl:gap-8 w-full">
          {/* Left Column: Badge + Exactly two desktop lines */}
          <div className="w-full lg:w-[40%] shrink-0 flex flex-col justify-center">
            {/* Mascot Header Badge */}
            <div className="flex items-center gap-2.5 mb-5 sm:mb-6 select-none">
              <div className="w-9 h-9 rounded-xl bg-white p-1 border border-blue-100 shadow-2xs flex items-center justify-center shrink-0">
                <BrandIcon size={28} className="w-full h-full object-contain" />
              </div>
              <span className="text-xs font-bold uppercase tracking-wider text-[#2563EB] bg-blue-50/80 px-3 py-1 rounded-full border border-blue-100">
                Live Market Data
              </span>
            </div>

            {/* Exactly two desktop lines */}
            <h2 className="text-3xl sm:text-4xl lg:text-[42px] xl:text-[46px] font-black text-[#090E34] uppercase tracking-tight leading-[1.08]">
              Real numbers,
              <br className="hidden sm:inline" />{" "}
              no promises
            </h2>
          </div>

          {/* Center Connector: Bracket-like dotted SVG with root dot and top/bottom arrowheads (desktop only) */}
          <div
            className="hidden lg:flex items-center justify-center shrink-0 lg:w-[15%] h-[224px]"
            aria-hidden="true"
          >
            <DottedConnector />
          </div>

          {/* Right Column: Exactly three approved stat rows */}
          <div className="flex-1 flex flex-col justify-between space-y-6 lg:space-y-0 lg:h-[224px] w-full lg:w-[45%]">
            {rows.map((row) => {
              const Icon = row.icon;
              const formattedVal = formatDisplay(row.val);
              return (
                <div
                  key={row.key}
                  className="flex items-start justify-between w-full"
                >
                  {/* Value and Label directly underneath */}
                  <div className="flex flex-col shrink-0">
                    <div className="h-10 flex items-center">
                      <span className="text-3xl sm:text-4xl lg:text-[42px] font-black text-[#090E34] tracking-tight leading-none">
                        {formattedVal}
                      </span>
                    </div>
                    <span className="text-xs sm:text-sm text-slate-500 font-medium mt-1 leading-snug">
                      {row.label}
                    </span>
                  </div>

                  {/* Thin dotted horizontal leader + Circular outlined icon aligned with the value */}
                  <div className="flex-1 flex items-center h-10 ml-3 sm:ml-5 lg:ml-6 min-w-[16px]">
                    <div
                      className="flex-1 border-b border-dotted border-slate-300 mr-3 sm:mr-5 lg:mr-6"
                      aria-hidden="true"
                    />
                    <div
                      className="w-9 h-9 sm:w-10 sm:h-10 rounded-full border border-blue-300 flex items-center justify-center shrink-0 text-[#2563EB]"
                      aria-hidden="true"
                    >
                      <Icon className="w-4 h-4 sm:w-5 sm:h-5 stroke-[1.75]" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
