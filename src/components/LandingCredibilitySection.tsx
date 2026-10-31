"use client";

import React, { useState, useEffect } from "react";
import BrandIcon from "@/components/BrandIcon";
import { Briefcase, Building2, ShieldCheck } from "lucide-react";

interface StatsState {
  activeJobs: number;
  companies: number;
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
  const formattedActiveJobs = numberFormatter.format(stats.activeJobs);
  const formattedCompanies = numberFormatter.format(stats.companies);

  return (
    <section
      id="credibility"
      data-testid="landing-credibility-section"
      aria-label="Platform Credibility"
      className="py-12 sm:py-16 bg-white"
    >
      <div className="max-w-[1000px] mx-auto px-4 sm:px-6">
        <div className="bg-[#ECFDF3] border border-[#D1FADF] rounded-2xl sm:rounded-3xl p-6 sm:p-8 lg:p-10 shadow-xs">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center">
            {/* Left Column: Mascot + Bold Large Heading */}
            <div className="lg:col-span-5 flex flex-col items-start space-y-4">
              {/* CareerMonke monkey mascot logo top-left */}
              <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-white p-1.5 shadow-xs border border-emerald-100 flex items-center justify-center flex-shrink-0">
                <BrandIcon size={48} className="w-full h-full object-contain" />
              </div>

              <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-slate-900 tracking-tight leading-tight">
                Real numbers, not promises
              </h2>
            </div>

            {/* Right Column: Exactly 3 Stat Rows */}
            <div className="lg:col-span-7 flex flex-col space-y-3 sm:space-y-4 w-full">
              {/* Row 1: Active Jobs */}
              <div className="bg-white rounded-xl sm:rounded-2xl p-4 sm:p-5 border border-emerald-100/80 shadow-xs flex items-center justify-between gap-3">
                <div className="flex flex-col text-left">
                  <span className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight leading-none">
                    {formattedActiveJobs}
                  </span>
                  <span className="text-xs sm:text-sm text-slate-600 font-normal mt-1 leading-snug">
                    jobs straight from company career pages
                  </span>
                </div>

                <div
                  className="flex-1 border-b-2 border-dotted border-emerald-300/70 mx-3 sm:mx-4"
                  aria-hidden="true"
                />

                <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center flex-shrink-0">
                  <Briefcase className="w-4 h-4 sm:w-5 sm:h-5 text-[#2563EB] stroke-[1.75]" />
                </div>
              </div>

              {/* Row 2: Companies Tracked */}
              <div className="bg-white rounded-xl sm:rounded-2xl p-4 sm:p-5 border border-emerald-100/80 shadow-xs flex items-center justify-between gap-3">
                <div className="flex flex-col text-left">
                  <span className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight leading-none">
                    {formattedCompanies}
                  </span>
                  <span className="text-xs sm:text-sm text-slate-600 font-normal mt-1 leading-snug">
                    companies scanned
                  </span>
                </div>

                <div
                  className="flex-1 border-b-2 border-dotted border-emerald-300/70 mx-3 sm:mx-4"
                  aria-hidden="true"
                />

                <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center flex-shrink-0">
                  <Building2 className="w-4 h-4 sm:w-5 sm:h-5 text-[#2563EB] stroke-[1.75]" />
                </div>
              </div>

              {/* Row 3: Direct from Employer Sites (Text only) */}
              <div className="bg-white rounded-xl sm:rounded-2xl p-4 sm:p-5 border border-emerald-100/80 shadow-xs flex items-center justify-between gap-3">
                <div className="flex flex-col text-left">
                  <span className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight leading-tight">
                    Direct from employer sites
                  </span>
                  <span className="text-xs sm:text-sm text-slate-600 font-normal mt-1 leading-snug">
                    no reposted aggregator listings
                  </span>
                </div>

                <div
                  className="flex-1 border-b-2 border-dotted border-emerald-300/70 mx-3 sm:mx-4"
                  aria-hidden="true"
                />

                <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center flex-shrink-0">
                  <ShieldCheck className="w-4 h-4 sm:w-5 sm:h-5 text-[#2563EB] stroke-[1.75]" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
