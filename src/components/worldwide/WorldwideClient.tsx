"use client";

import React, { useState, useMemo } from "react";
import Link from "next/link";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import { WORLDWIDE_COMPANIES, WorldwideCompany } from "@/data/companies";
import { ArrowRight, Search, Globe2, Building } from "lucide-react";

export default function WorldwideClient({
  initialCompanies = WORLDWIDE_COMPANIES,
}: {
  initialCompanies?: WorldwideCompany[];
}) {
  const [query, setQuery] = useState("");
  const [isNavigating, setIsNavigating] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return initialCompanies;
    return initialCompanies.filter((c) => c.name.toLowerCase().includes(q));
  }, [initialCompanies, query]);

  if (isNavigating) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex flex-col justify-between">
        <GuideHeader />
        <main className="flex-1 flex flex-col items-center justify-center p-6 space-y-3">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs font-semibold text-slate-500">Loading verified jobs feed...</p>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#09090B] flex flex-col">
      <GuideHeader />

      <main className="flex-1 py-8 sm:py-12">
        {/* Compact Centered Header */}
        <div className="max-w-3xl mx-auto px-4 sm:px-6 text-center space-y-3 sm:space-y-4 mb-6 sm:mb-8">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
            <Globe2 className="w-3.5 h-3.5 text-emerald-600" />
            <span>Worldwide Remote</span>
          </div>

          <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-slate-900">
            Companies Hiring Worldwide
          </h1>

          <p className="text-slate-600 text-xs sm:text-sm max-w-xl mx-auto leading-relaxed">
            Verified organizations hiring across global timezones without regional restrictions.
          </p>

          <div className="pt-1 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/jobs?remote=true"
              onClick={() => setIsNavigating(true)}
              className="inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-bold px-6 py-2.5 min-h-[44px] rounded-xl text-xs sm:text-sm transition-colors shadow-xs cursor-pointer"
            >
              <span>View Worldwide Jobs</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>

          {/* Client Search / Filter Input */}
          <div className="pt-2 max-w-md mx-auto relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              aria-label="Filter companies"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter companies (e.g. GitLab, Automattic, Stripe)..."
              className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-300 text-xs sm:text-sm focus:outline-blue-500 bg-white shadow-2xs transition"
            />
          </div>

          <p className="text-[11px] uppercase tracking-wider font-bold text-slate-400 pt-1">
            Showing {filtered.length} of {initialCompanies.length} companies hiring worldwide
          </p>
        </div>

        {/* List ~770px wide: rows with py-3 and divider lines */}
        <div className="max-w-[770px] mx-auto px-4 sm:px-6">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xs divide-y divide-slate-100 overflow-hidden">
            {filtered.length === 0 ? (
              <div className="py-12 text-center space-y-2">
                <Building className="w-8 h-8 text-slate-400 mx-auto" />
                <p className="text-xs font-semibold text-slate-700">
                  No companies found matching &quot;{query}&quot;
                </p>
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="text-xs text-blue-600 font-bold hover:underline cursor-pointer"
                >
                  Clear search filter
                </button>
              </div>
            ) : (
              filtered.map((company) => (
                <div
                  key={company.id}
                  className="py-3 sm:py-3.5 px-4 sm:px-5 min-h-[48px] flex items-center justify-between hover:bg-slate-50 transition-colors group"
                >
                  <Link
                    href={`/jobs?search=${encodeURIComponent(company.name)}&remote=true`}
                    className="text-sm sm:text-base font-bold text-slate-900 group-hover:text-blue-600 transition-colors flex-1 py-1"
                  >
                    {company.name}
                  </Link>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 font-mono bg-slate-100 px-2 py-0.5 rounded-md">
                      {company.jobCount} open roles
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-300 opacity-0 group-hover:opacity-100 group-hover:text-blue-600 transition-all -translate-x-1 group-hover:translate-x-0" />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
