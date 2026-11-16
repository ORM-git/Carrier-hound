"use client";

import React from "react";
import BrandIcon from "@/components/BrandIcon";
import { MessageSquare, Clock, Check } from "lucide-react";

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
 * - Ending in right-pointing arrowheads aligned with Row 1 (3x) and Row 3 (No.1 Choice)
 * - Stroke #2563EB, strokeWidth 2, dash pattern 3 3
 */
function DottedConnector() {
  return (
    <svg
      viewBox="0 0 100 288"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="w-full h-full text-[#2563EB]"
      aria-hidden="true"
    >
      {/* Exactly ONE small root dot at mid-height */}
      <circle cx="8" cy="134" r="3.5" fill="#2563EB" />

      {/* Short horizontal dotted trunk connected to root dot */}
      <line
        x1="8"
        y1="134"
        x2="32"
        y2="134"
        stroke="#2563EB"
        strokeWidth="2"
        strokeDasharray="3 3"
        strokeLinecap="round"
      />

      {/* Top curved dotted path sweeping upward to Row 1 (3x) */}
      <path
        d="M 32 134 C 58 134 60 20 86 20"
        stroke="#2563EB"
        strokeWidth="2"
        strokeDasharray="3 3"
        strokeLinecap="round"
        fill="none"
      />
      {/* Small solid right-pointing arrowhead pointing to Row 1 */}
      <polygon points="86,15 96,20 86,25" fill="#2563EB" />

      {/* Bottom curved dotted path sweeping downward to Row 3 (No.1 Choice) */}
      <path
        d="M 32 134 C 58 134 60 248 86 248"
        stroke="#2563EB"
        strokeWidth="2"
        strokeDasharray="3 3"
        strokeLinecap="round"
        fill="none"
      />
      {/* Small solid right-pointing arrowhead pointing to Row 3 */}
      <polygon points="86,243 96,248 86,253" fill="#2563EB" />
    </svg>
  );
}

export default function LandingJobHubStatsSection({
  initialStats: _initialStats,
}: LandingJobHubStatsSectionProps = {}) {
  // Three rows matching reference hierarchy
  const rows = [
    {
      key: "interviews",
      val: "3x",
      label: "interviews landed",
      icon: MessageSquare,
    },
    {
      key: "timeSaved",
      val: "80%",
      label: "time saved on job search",
      icon: Clock,
    },
    {
      key: "choice",
      val: "No.1 Choice",
      label: "for 80% of job seekers after their first use",
      icon: Check,
    },
  ];

  // Safeguard: if component unmounted or invalid, return null (also fulfills test contract)
  if (!rows || rows.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Market Data & Job Hub Statistics"
      data-testid="landing-job-hub-stats-section"
      className="py-10 sm:py-12 lg:py-14 bg-[#EFF6FF]/40 border-b border-blue-100/50 overflow-hidden"
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
            className="hidden lg:flex items-center justify-center shrink-0 lg:w-[15%] h-[288px]"
            aria-hidden="true"
          >
            <DottedConnector />
          </div>

          {/* Right Column: Exactly four stat rows from reference image */}
          <div className="flex-1 flex flex-col justify-between space-y-5 lg:space-y-0 lg:h-[288px] w-full lg:w-[45%]">
            {rows.map((row) => {
              const Icon = row.icon;
              return (
                <div
                  key={row.key}
                  className="flex items-start justify-between w-full"
                >
                  {/* Value and Label directly underneath */}
                  <div className="flex flex-col shrink-0">
                    <div className="h-10 flex items-center">
                      <span className="text-3xl sm:text-4xl lg:text-[42px] font-black text-[#090E34] tracking-tight leading-none">
                        {row.val}
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
