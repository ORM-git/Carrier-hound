"use client";

import React, { useState, useEffect, useRef } from "react";
import BrandIcon from "@/components/BrandIcon";
import { Building2, Globe } from "lucide-react";

export interface RealStatsData {
  totalJobs?: number | null;
  jobsToday?: number | null;
  companies?: number | null;
  countries?: number | null;
}

export interface LandingJobHubStatsSectionProps {
  initialStats?: RealStatsData;
}

function RunningPersonIcon({ className = "w-6 h-6" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="16" cy="4" r="2" />
      <path d="m7 21 3-4 2-2 3 3 4-1" />
      <path d="M12 11V7l3 2 4-1" />
      <path d="m6 13 4-2" />
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

  // Count-up animation helper
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
    const targetCountries = data.countries ?? 0;

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
        countries:
          data.countries !== null && data.countries !== undefined
            ? Math.round(targetCountries * easeOut)
            : null,
      });

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        setDisplayValues({
          totalJobs: data.totalJobs ?? null,
          jobsToday: data.jobsToday ?? null,
          companies: data.companies ?? null,
          countries: data.countries ?? null,
        });
      }
    };

    requestAnimationFrame(animate);
  };

  // IntersectionObserver trigger
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

  // Block 1 rows config (hide row if value is missing or <= 0)
  const block1Rows = [
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
      key: "countries",
      val:
        displayValues.countries !== undefined
          ? displayValues.countries
          : stats.countries,
      raw: stats.countries,
      label: "Countries covered",
      icon: Globe,
    },
  ].filter((r) => typeof r.raw === "number" && r.raw > 0);

  // Block 2 rows config (hide row if value is missing or < 0)
  const block2Rows = [
    {
      key: "totalJobs",
      val:
        displayValues.totalJobs !== undefined
          ? displayValues.totalJobs
          : stats.totalJobs,
      raw: stats.totalJobs,
      label: "Total jobs",
    },
    {
      key: "jobsToday",
      val:
        displayValues.jobsToday !== undefined
          ? displayValues.jobsToday
          : stats.jobsToday,
      raw: stats.jobsToday,
      label: "New jobs today",
    },
  ].filter((r) => typeof r.raw === "number" && r.raw >= 0);

  // If all rows fail/missing, render nothing (no empty container)
  if (block1Rows.length === 0 && block2Rows.length === 0) {
    return null;
  }

  return (
    <section
      ref={containerRef}
      aria-label="Market Data & Job Hub Statistics"
      data-testid="landing-job-hub-stats-section"
      className="py-12 sm:py-16 bg-[#EFF6FF]/40 border-b border-blue-100/60 overflow-hidden"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        {/* Mascot Header Badge (Mascot appears once) */}
        <div className="flex items-center justify-center gap-2.5 mb-8 sm:mb-10 select-none">
          <div className="w-10 h-10 rounded-xl bg-white p-1 border border-blue-100 shadow-2xs flex items-center justify-center shrink-0">
            <BrandIcon size={34} className="w-full h-full object-contain" />
          </div>
          <span className="text-xs font-bold uppercase tracking-wider text-[#2563EB] bg-blue-50/80 px-3 py-1 rounded-full border border-blue-100">
            Live Market Data
          </span>
        </div>

        {/* Two-column layout on desktop, single column on mobile */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-8 w-full">
          {/* Block 1: Real numbers, no promises */}
          {block1Rows.length > 0 && (
            <div className="bg-[#EFF6FF] border border-[#BFDBFE] rounded-2xl sm:rounded-3xl p-6 sm:p-8 lg:p-10 shadow-xs flex flex-col justify-between">
              <h3 className="text-xl sm:text-2xl font-extrabold text-[#090E34] tracking-tight mb-6 sm:mb-8">
                Real numbers, no promises
              </h3>

              <div className="flex flex-col space-y-6 sm:space-y-7 w-full">
                {block1Rows.map((row) => {
                  const Icon = row.icon;
                  return (
                    <div
                      key={row.key}
                      className="flex items-center justify-between gap-3 sm:gap-4 w-full"
                    >
                      <div className="flex flex-col text-left min-w-0 pr-1">
                        <span className="text-[40px] sm:text-4xl lg:text-5xl font-extrabold text-[#090E34] tracking-tight leading-none">
                          {formatNumber(row.val)}
                        </span>
                        <span className="text-xs sm:text-sm text-slate-600 font-medium mt-1 leading-snug">
                          {row.label}
                        </span>
                      </div>

                      <div
                        className="flex-1 border-b-2 border-dashed border-[#2563EB]/25 mx-2 sm:mx-6 min-w-[20px]"
                        aria-hidden="true"
                      />

                      <div
                        className="flex-shrink-0 flex items-center justify-center text-[#2563EB]"
                        aria-hidden="true"
                      >
                        <Icon className="w-5 h-5 sm:w-6 sm:h-6 stroke-[1.5]" />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Block 2: Access a growing job hub */}
          {block2Rows.length > 0 && (
            <div className="bg-[#EFF6FF] border border-[#BFDBFE] rounded-2xl sm:rounded-3xl p-6 sm:p-8 lg:p-10 shadow-xs flex flex-col justify-between">
              <h3 className="text-xl sm:text-2xl font-extrabold text-[#090E34] tracking-tight mb-6 sm:mb-8">
                Access a growing job hub
              </h3>

              <div className="flex flex-col space-y-6 sm:space-y-7 w-full">
                {block2Rows.map((row) => (
                  <div
                    key={row.key}
                    className="flex items-center justify-between gap-3 sm:gap-4 w-full"
                  >
                    <div className="flex flex-col text-left min-w-0 pr-1">
                      <span className="text-[40px] sm:text-4xl lg:text-5xl font-extrabold text-[#090E34] tracking-tight leading-none">
                        {formatNumber(row.val)}
                      </span>
                      <span className="text-xs sm:text-sm text-slate-600 font-medium mt-1 leading-snug">
                        {row.label}
                      </span>
                    </div>

                    <div
                      className="flex-1 border-b-2 border-dashed border-[#2563EB]/25 mx-2 sm:mx-6 min-w-[20px]"
                      aria-hidden="true"
                    />

                    <div
                      className="flex-shrink-0 flex items-center justify-center text-[#2563EB]"
                      aria-hidden="true"
                    >
                      <RunningPersonIcon className="w-5 h-5 sm:w-6 sm:h-6 stroke-[1.5]" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
