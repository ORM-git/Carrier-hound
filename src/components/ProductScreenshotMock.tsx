"use client";

import React, { useState, useEffect } from "react";
import { Clock, MapPin, Globe, Building } from "lucide-react";
import CompanyLogo from "@/components/CompanyLogo";
import { createClient } from "@/lib/supabase/client";

interface LandingPreviewJob {
  id: string;
  title: string;
  company: "Verified Employer";
  location: string | null;
  remote: boolean;
  remoteScope?: string;
  category?: string;
  jobType?: string;
  date: string | null;
}

function formatRealDate(dateStr?: string | null): string | null {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    const diffHours = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60));
    if (diffHours < 1) return "Just now";
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 30) return `${diffDays}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return null;
  }
}

export default function ProductScreenshotMock() {
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const [jobs, setJobs] = useState<LandingPreviewJob[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadNewestGuestJobs() {
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from("jobs_public")
          .select(
            "id, title, location, category, remote, remote_scope, remote_eligibility, country_code, job_type, verified, posted_at, last_seen_at, created_at"
          )
          .eq("is_active", true)
          .eq("status", "active")
          .order("posted_at", { ascending: false, nullsFirst: false })
          .limit(3);

        if (cancelled) return;

        if (error || !data || data.length === 0) {
          setJobs([]);
          setLoaded(true);
          return;
        }

        const mapped: LandingPreviewJob[] = data
          .filter((row: any) => Boolean(row && row.id && row.title))
          .slice(0, 3)
          .map((row: any) => ({
            id: String(row.id),
            title: String(row.title).trim(),
            company: "Verified Employer",
            location: row.location
              ? String(row.location).trim()
              : row.remote
              ? "Remote (Worldwide)"
              : null,
            remote: Boolean(row.remote),
            remoteScope: row.remote_scope || undefined,
            category: row.category || undefined,
            jobType: row.job_type === "internship" ? "Internship" : "Full-time",
            date: formatRealDate(row.posted_at || row.last_seen_at || row.created_at),
          }));

        setJobs(mapped);
        setLoaded(true);
      } catch {
        if (!cancelled) {
          setJobs([]);
          setLoaded(true);
        }
      }
    }

    loadNewestGuestJobs();

    return () => {
      cancelled = true;
    };
  }, []);

  const primaryJob = jobs[0] || null;
  const secondJob = jobs[1] || null;
  const thirdJob = jobs[2] || null;

  return (
    <div className="w-full bg-[#EDF0F4] rounded-t-[24px] sm:rounded-t-[36px] md:rounded-t-[40px] rounded-b-none border-t border-x border-gray-300/70 p-2 sm:p-5 md:p-8 shadow-[0_20px_50px_rgba(15,23,42,0.12)] overflow-hidden text-left">
      <div className="flex flex-row items-start gap-2 sm:gap-4 md:gap-5 min-h-[234px] sm:min-h-[290px]">
        {/* Left Side: Minimalist Filters Card */}
        <div className="w-[105px] xs:w-[110px] sm:w-[155px] md:w-[175px] shrink-0 bg-white border border-[#E5E7EB] rounded-xl sm:rounded-2xl p-2 sm:p-4 shadow-[0_2px_8px_rgba(0,0,0,0.04)]">
          <h2 className="text-xs sm:text-sm md:text-[15px] font-bold text-[#09090B] tracking-tight mb-2 sm:mb-3">
            Filters
          </h2>

          <div className="grid grid-cols-1 gap-1.5 sm:gap-2.5">
            {/* Filter 1: Role */}
            <div>
              <label className="block text-[10px] sm:text-[11px] font-semibold text-gray-700 mb-0.5 sm:mb-1">
                Role
              </label>
              <div className="w-full h-6 sm:h-7.5 px-1.5 sm:px-3 rounded-md sm:rounded-lg border border-gray-200 bg-white flex items-center text-[10px] sm:text-xs text-gray-500 select-none">
                Select...
              </div>
            </div>

            {/* Filter 2: Location */}
            <div>
              <label className="block text-[10px] sm:text-[11px] font-semibold text-gray-700 mb-0.5 sm:mb-1">
                Location
              </label>
              <div className="w-full h-6 sm:h-7.5 px-1.5 sm:px-3 rounded-md sm:rounded-lg border border-gray-200 bg-white flex items-center text-[10px] sm:text-xs text-gray-500 select-none">
                Select...
              </div>
            </div>

            {/* Filter 3: Tools */}
            <div>
              <label className="block text-[10px] sm:text-[11px] font-semibold text-gray-700 mb-0.5 sm:mb-1">
                Tools
              </label>
              <div className="w-full h-6 sm:h-7.5 px-1.5 sm:px-3 rounded-md sm:rounded-lg border border-gray-200 bg-white flex items-center text-[10px] sm:text-xs text-gray-500 select-none">
                Select...
              </div>
            </div>

            {/* Filter 4: Remote */}
            <div>
              <label className="block text-[10px] sm:text-[11px] font-semibold text-gray-700 mb-0.5 sm:mb-1">
                Remote
              </label>
              <div className="w-full h-6 sm:h-7.5 px-1.5 sm:px-3 rounded-md sm:rounded-lg border border-gray-200 bg-white flex items-center text-[10px] sm:text-xs text-gray-500 select-none">
                Select...
              </div>
            </div>
          </div>
        </div>

        {/* Right Side: 3-Layer Staggered Overlapping Real Guest Cards (reserved height prevents layout shift; hidden if fetch fails or returns empty) */}
        <div className="relative flex-1 min-w-0 pb-2 sm:pb-6 min-h-[234px] sm:min-h-[290px]">
          {loaded && primaryJob && (
            <>
              {/* Card 3 (Back Layer - Top Right) */}
              {thirdJob && (
                <div
                  className="absolute z-0 top-0 bottom-[70px] left-[16px] sm:left-[32px] md:left-[48px] right-0 bg-white border border-[#E5E7EB] rounded-xl sm:rounded-2xl p-2 sm:p-3.5 md:p-4 shadow-[0_2px_6px_rgba(0,0,0,0.03)] pointer-events-none select-none overflow-hidden"
                  aria-hidden="true"
                >
                  <div className="flex items-start gap-2 sm:gap-2.5">
                    <CompanyLogo
                      company="Verified Employer"
                      className="w-6 h-6 sm:w-8 sm:h-8 shrink-0 text-[10px] sm:text-xs"
                    />
                    <div className="space-y-0.5 min-w-0 flex-1">
                      <h4 className="font-bold text-[#09090B] text-[11px] sm:text-sm md:text-base tracking-tight truncate leading-tight">
                        {thirdJob.title}
                      </h4>
                      <p className="text-[9px] sm:text-xs text-gray-500 font-normal leading-tight truncate">
                        Verified Employer
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Card 2 (Middle Layer) */}
              {secondJob && (
                <div
                  className="absolute z-10 top-[34px] bottom-[34px] left-[8px] sm:left-[16px] md:left-[24px] right-[8px] sm:right-[16px] md:right-[24px] bg-white border border-[#E5E7EB] rounded-xl sm:rounded-2xl p-2 sm:p-3.5 md:p-4 shadow-[0_3px_10px_rgba(0,0,0,0.04)] pointer-events-none select-none overflow-hidden"
                  aria-hidden="true"
                >
                  <div className="flex items-start gap-2 sm:gap-2.5">
                    <CompanyLogo
                      company="Verified Employer"
                      className="w-6 h-6 sm:w-8 sm:h-8 shrink-0 text-[10px] sm:text-xs"
                    />
                    <div className="space-y-0.5 min-w-0 flex-1">
                      <h4 className="font-bold text-[#09090B] text-[11px] sm:text-sm md:text-base tracking-tight truncate leading-tight">
                        {secondJob.title}
                      </h4>
                      <p className="text-[9px] sm:text-xs text-gray-500 font-normal leading-tight truncate">
                        Verified Employer
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Card 1 (Front Layer - Main Focus) */}
              <div className="relative z-20 mt-[68px] mr-[16px] sm:mr-[32px] md:mr-[48px] bg-white border border-[#E5E7EB] rounded-xl sm:rounded-2xl p-2.5 sm:p-4 md:p-5 shadow-[0_8px_24px_rgba(0,0,0,0.06)]">
                <div className="space-y-1.5 sm:space-y-2">
                  {/* Logo, Job Title & Masked Company */}
                  <div className="flex items-start gap-2 sm:gap-3">
                    <CompanyLogo
                      company="Verified Employer"
                      className="w-8 h-8 sm:w-10 sm:h-10 shrink-0 text-xs sm:text-sm"
                    />
                    <div className="min-w-0 flex-1">
                      <h3 className="font-bold text-[#09090B] text-xs sm:text-base md:text-lg tracking-tight truncate leading-tight">
                        {primaryJob.title}
                      </h3>
                      <p className="text-[10px] sm:text-xs text-gray-500 font-normal mt-0.5 flex items-center gap-1">
                        <Building className="w-3 h-3 text-gray-400 shrink-0" />
                        <span className="truncate">Verified Employer</span>
                      </p>
                    </div>
                  </div>

                  {/* Guest-visible Location & Remote details from jobs_public */}
                  {(primaryJob.location || primaryJob.remote) && (
                    <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-[9px] sm:text-xs text-gray-600 leading-tight sm:leading-relaxed">
                      {primaryJob.location && (
                        <span className="inline-flex items-center gap-1 truncate">
                          <MapPin className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                          <span className="truncate">{primaryJob.location}</span>
                        </span>
                      )}
                      {primaryJob.remote && (
                        <span className="inline-flex items-center gap-1">
                          <Globe className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                          <span>
                            {primaryJob.remoteScope === "worldwide"
                              ? "Worldwide Remote"
                              : "Remote Eligible"}
                          </span>
                        </span>
                      )}
                    </div>
                  )}

                  {/* Real Posted/Updated Date from jobs_public */}
                  {primaryJob.date && (
                    <div className="flex items-center gap-1 sm:gap-1.5 text-[9px] sm:text-xs text-gray-500">
                      <Clock className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                      <span>{primaryJob.date}</span>
                    </div>
                  )}

                  {/* Action Buttons Row */}
                  <div className="flex items-center gap-1 sm:gap-1.5 pt-1 sm:pt-2 overflow-x-auto no-scrollbar flex-nowrap">
                    <a
                      href="/jobs"
                      className="shrink-0 whitespace-nowrap bg-[#18181B] hover:bg-black text-white text-[9px] sm:text-xs font-semibold px-2 sm:px-3.5 py-1 sm:py-1.5 rounded-md sm:rounded-lg transition-colors shadow-sm inline-flex items-center"
                    >
                      Apply Now
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        setLiked(!liked);
                        if (disliked) setDisliked(false);
                      }}
                      className={`shrink-0 whitespace-nowrap border text-[9px] sm:text-xs font-medium px-2 sm:px-3 py-1 sm:py-1.5 rounded-md sm:rounded-lg transition-colors ${
                        liked
                          ? "bg-blue-50 border-blue-400 text-blue-700"
                          : "bg-white hover:bg-gray-50 border-gray-300 text-gray-800"
                      }`}
                    >
                      Like
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDisliked(!disliked);
                        if (liked) setLiked(false);
                      }}
                      className={`shrink-0 whitespace-nowrap border text-[9px] sm:text-xs font-medium px-2 sm:px-3 py-1 sm:py-1.5 rounded-md sm:rounded-lg transition-colors ${
                        disliked
                          ? "bg-red-50 border-red-400 text-red-700"
                          : "bg-white hover:bg-gray-50 border-gray-300 text-gray-800"
                      }`}
                    >
                      Dislike
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
