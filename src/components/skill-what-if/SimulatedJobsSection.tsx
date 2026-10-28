import React from "react";
import { ArrowRight, Globe, Building2, DollarSign } from "lucide-react";
import type { SimulatedJob } from "@/data/skillWhatIfFixture";

interface SimulatedJobsSectionProps {
  jobs: SimulatedJob[];
  crossingCount: number;
  selectedCountry: string;
  onSelectCountry: (country: string) => void;
  availableCountries: string[];
}

export default function SimulatedJobsSection({
  jobs,
  crossingCount,
  selectedCountry,
  onSelectCountry,
  availableCountries,
}: SimulatedJobsSectionProps) {
  // Filter by country if specified
  const filteredJobs =
    selectedCountry === "all"
      ? jobs
      : jobs.filter(
          (j) => j.country.toLowerCase() === selectedCountry.toLowerCase()
        );

  // Take the top 3 jobs that move up
  const top3Jobs = filteredJobs.slice(0, 3);

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-white rounded-2xl ring-1 ring-[#E2E8F0] shadow-xs p-6 sm:p-8 space-y-6"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#F1F5F9]">
        <div>
          {/* Exact required wording: 'N additional jobs cross the match threshold' */}
          <h2
            data-testid="crossing-threshold-heading"
            className="text-xl font-bold text-[#0F172A] leading-tight"
          >
            {crossingCount} additional jobs cross the match threshold
          </h2>
          <p className="text-[15px] text-[#64748B] mt-1">
            Roles that become strong matches when acquiring the simulated skills
          </p>
        </div>

        {/* Country Selector Filter */}
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Globe className="w-4 h-4 text-[#64748B] shrink-0" />
          <label htmlFor="country-selector" className="sr-only">
            Filter by country
          </label>
          <select
            id="country-selector"
            value={selectedCountry}
            onChange={(e) => onSelectCountry(e.target.value)}
            aria-label="Filter jobs by country eligibility"
            className="rounded-xl border border-[#CBD5E1] bg-white px-3 py-2 text-[15px] font-semibold text-[#334155] focus:outline-none focus:ring-2 focus:ring-[#2563EB] cursor-pointer min-h-[44px]"
          >
            <option value="all">All Countries</option>
            {availableCountries.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Top 3 Result Cards */}
      {top3Jobs.length === 0 ? (
        <div className="text-center py-8 px-4 rounded-xl border border-dashed border-[#CBD5E1] bg-slate-50/50 space-y-2">
          <p className="text-[15px] font-bold text-[#334155]">
            No jobs found matching the selected country filter
          </p>
          <p className="text-[15px] text-[#64748B]">
            Try selecting &ldquo;All Countries&rdquo; or adding more skills to simulate.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {top3Jobs.map((job) => {
            const delta = job.newMatch - job.baseMatch;
            return (
              <div
                key={job.id}
                className="rounded-xl border border-[#E2E8F0] hover:border-[#93C5FD] p-5 bg-white transition shadow-2xs space-y-3"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="space-y-1">
                    <h3 className="text-base font-bold text-[#0F172A]">
                      {job.title}
                    </h3>
                    <div className="flex items-center gap-2 text-[15px] text-[#475569] flex-wrap">
                      <span className="inline-flex items-center gap-1 font-medium">
                        <Building2 className="w-4 h-4 text-[#64748B]" />
                        {job.company}
                      </span>
                      <span className="text-slate-300">•</span>
                      <span className="inline-flex items-center gap-1">
                        <Globe className="w-4 h-4 text-[#64748B]" />
                        {job.country} {job.workModel ? `(${job.workModel})` : ""}
                      </span>

                      {/* Salary Range: ONLY rendered when real data exists; otherwise hidden */}
                      {job.salaryRange && job.salaryRange.trim().length > 0 && (
                        <>
                          <span className="text-slate-300">•</span>
                          <span className="inline-flex items-center gap-1 font-bold text-[#0F172A]">
                            <DollarSign className="w-4 h-4 text-[#2563EB]" />
                            {job.salaryRange}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Match Score Old -> New Transition */}
                  <div className="flex items-center gap-2 shrink-0 self-start sm:self-auto pt-2 sm:pt-0">
                    <span className="text-[15px] font-semibold text-[#64748B]">
                      {job.baseMatch}%
                    </span>
                    <ArrowRight className="w-4 h-4 text-[#94A3B8]" />
                    <span className="text-base font-extrabold text-[#2563EB] bg-blue-50 px-2.5 py-1 rounded-lg border border-blue-200">
                      {job.newMatch}%
                    </span>
                    {delta > 0 && (
                      <span className="text-xs font-bold text-[#1D4ED8]">
                        (+{delta}%)
                      </span>
                    )}
                  </div>
                </div>

                {/* Associated Required Skills */}
                {job.requiredSkills && job.requiredSkills.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap pt-1 text-[15px] text-[#64748B]">
                    <span className="text-xs font-semibold text-[#64748B] uppercase tracking-wider">
                      Relevant skills:
                    </span>
                    {job.requiredSkills.map((s) => (
                      <span
                        key={s}
                        className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-slate-100 text-[#334155]"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
