"use client";

import React, { useState, useEffect } from "react";
import BrandIcon from "@/components/BrandIcon";
import { Briefcase, Building2, Globe } from "lucide-react";

interface StatsState {
  activeJobs: number;
  companies: number;
}

export interface StatRowConfig {
  value: keyof StatsState | string;
  caption: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const STAT_ROWS: StatRowConfig[] = [
  {
    value: "activeJobs",
    caption: "live jobs",
    icon: Briefcase,
  },
  {
    value: "companies",
    caption: "companies scanned",
    icon: Building2,
  },
  {
    value: "Worldwide roles",
    caption: "eligibility checked for your country",
    icon: Globe,
  },
];

function resolveRowValue(
  value: StatRowConfig["value"],
  stats: StatsState,
  formatter: Intl.NumberFormat
): string {
  if (value === "activeJobs") {
    return formatter.format(stats.activeJobs);
  }
  if (value === "companies") {
    return formatter.format(stats.companies);
  }
  if (typeof value === "string" && value in stats) {
    const raw = (stats as any)[value];
    return typeof raw === "number" ? formatter.format(raw) : String(raw);
  }
  return String(value);
}

export default function LandingCredibilitySection() {
  const [stats, setStats] = useState<StatsState | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetch("/api/stats")
      .then((res) => {
        if (!res.ok) throw new Error(`Stats fetch failed (${res.status})`);
        return res.json();
      })
      .then((data) => {
        if (!mounted) return;
        const activeJobs =
          typeof data?.activeJobs === "number"
            ? data.activeJobs
            : typeof data?.totalJobs === "number"
            ? data.totalJobs
            : null;
        const companies =
          typeof data?.companies === "number"
            ? data.companies
            : typeof data?.companiesScanned === "number"
            ? data.companiesScanned
            : null;

        // Strictly real positive counts: if missing or <= 0, hide section
        if (
          activeJobs !== null &&
          activeJobs > 0 &&
          companies !== null &&
          companies > 0
        ) {
          setStats({ activeJobs, companies });
        } else {
          setError(true);
        }
      })
      .catch(() => {
        if (mounted) setError(true);
      });

    return () => {
      mounted = false;
    };
  }, []);

  // If fetch failed, is loading, or numbers missing/zero: hide the entire section (no zeros, no placeholders)
  if (error || !stats) {
    return null;
  }

  const numberFormatter = new Intl.NumberFormat("en-US");

  return (
    <section
      id="credibility"
      data-testid="landing-credibility-section"
      aria-label="Platform Credibility"
      className="py-12 sm:py-16 bg-white overflow-hidden"
    >
      <div className="max-w-[1000px] mx-auto px-4 sm:px-6">
        {/* Soft tinted rounded card with bottom-left speech-bubble tail */}
        <div className="relative bg-[#ECFDF3] border border-[#D1FADF] rounded-2xl sm:rounded-3xl p-6 sm:p-10 lg:p-12 shadow-xs">
          {/* Centered Monkey Mascot + Bold Uppercase Condensed Heading */}
          <div className="flex flex-col items-center justify-center text-center mb-8 sm:mb-10">
            <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-white p-1.5 shadow-xs border border-emerald-100 flex items-center justify-center flex-shrink-0 mb-3 sm:mb-4">
              <BrandIcon size={48} className="w-full h-full object-contain" />
            </div>

            <h2 className="text-xl sm:text-2xl md:text-3xl lg:text-4xl font-extrabold uppercase tracking-tight text-slate-900 leading-tight">
              Real numbers, not promises
            </h2>
          </div>

          {/* Vertical List of Stat Rows rendered via a single map */}
          <div className="flex flex-col space-y-6 sm:space-y-8 w-full max-w-[800px] mx-auto">
            {STAT_ROWS.map((row, idx) => {
              const displayValue = resolveRowValue(row.value, stats, numberFormatter);
              const Icon = row.icon;
              return (
                <div
                  key={row.caption || idx}
                  className="flex items-center justify-between gap-3 sm:gap-4 w-full"
                >
                  <div className="flex flex-col text-left min-w-0 pr-1">
                    <span className="text-xl sm:text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight leading-tight">
                      {displayValue}
                    </span>
                    <span className="text-xs sm:text-sm text-slate-600 font-normal mt-1 leading-snug">
                      {row.caption}
                    </span>
                  </div>

                  <div
                    className="flex-1 border-b-2 border-dotted border-[#2563EB]/30 mx-2 sm:mx-6 min-w-[20px]"
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

          {/* Speech-bubble tail at bottom-left (CSS only) */}
          <div
            className="absolute -bottom-3 sm:-bottom-3.5 left-8 sm:left-12 w-6 h-6 sm:w-7 sm:h-7 bg-[#ECFDF3] border-b border-r border-[#D1FADF] rotate-45 transform pointer-events-none"
            aria-hidden="true"
          />
        </div>
      </div>
    </section>
  );
}
