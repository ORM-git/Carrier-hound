"use client";

import React, { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import {
  Sparkles,
  Building,
  MapPin,
  DollarSign,
  FileText,
  FileCheck2,
  ExternalLink,
  ChevronRight,
  RefreshCw,
  BookmarkPlus,
  ShieldCheck,
  CheckCircle2,
} from "lucide-react";
import dynamic from "next/dynamic";
import { CandidateProfile } from "@/lib/resume/types";
import { getLiveJobs, getTopRankedJobsForCandidate, LiveJob } from "@/lib/jobs/service";
import { computeFitDiagnostics, FitDiagnosticsResult } from "@/lib/matcher/scoring";

const TailorResumeModal = dynamic(() => import("@/components/resume/TailorResumeModal"), { ssr: false });
const CoverLetterModal = dynamic(() => import("@/components/resume/CoverLetterModal"), { ssr: false });
import { addApplicationToTracker, getTrackedApplications, removeApplicationFromTracker } from "@/lib/tracker/storage";
import CompanyLogo from "@/components/CompanyLogo";
import { toast } from "react-toastify";

interface TopTenCompatibleJobsProps {
  candidate: CandidateProfile;
  isPro: boolean;
}

interface RankedJobItem {
  job: LiveJob;
  diagnostics: FitDiagnosticsResult;
}

export default function TopTenCompatibleJobs({
  candidate,
  isPro,
}: TopTenCompatibleJobsProps) {
  const [loading, setLoading] = useState(true);
  const [rankedJobs, setRankedJobs] = useState<RankedJobItem[]>([]);
  const [savedJobIds, setSavedJobIds] = useState<string[]>([]);

  // Modals state
  const [activeTailorJob, setActiveTailorJob] = useState<LiveJob | null>(null);
  const [activeCoverLetterJob, setActiveCoverLetterJob] = useState<LiveJob | null>(null);

  const loadTopJobs = React.useCallback(async () => {
    setLoading(true);
    try {
      // Fetch and rank across the FULL live dataset (all 16,000+ jobs) with Pro unlocking
      const topJobs = await getTopRankedJobsForCandidate(candidate, 10, isPro);
      setRankedJobs(topJobs);
    } catch (err) {
      console.warn("Could not compute Top 10 jobs:", err);
    } finally {
      setLoading(false);
    }
  }, [candidate, isPro]);

  useEffect(() => {
    loadTopJobs();
    getTrackedApplications().then((apps) => {
      setSavedJobIds(apps.map((a) => a.jobId || ""));
    });
  }, [loadTopJobs]);

  const handleToggleSave = async (job: LiveJob) => {
    const isSaved = savedJobIds.includes(job.id);
    if (isSaved) {
      await removeApplicationFromTracker(job.id);
      setSavedJobIds((prev) => prev.filter((id) => id !== job.id));
      toast.info("Removed from tracker.");
    } else {
      await addApplicationToTracker({
        jobId: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        stage: "saved",
        salaryText: job.salary,
        applyUrl: job.applyUrl,
      });
      setSavedJobIds((prev) => [...prev, job.id]);
      toast.success("Saved to your pipeline tracker!");
    }
  };

  const getScoreBadgeColor = (score: number) => {
    if (score >= 75) return "bg-emerald-50 text-emerald-700 border-emerald-300";
    if (score >= 55) return "bg-blue-50 text-blue-700 border-blue-300";
    if (score >= 35) return "bg-amber-50 text-amber-700 border-amber-300";
    return "bg-slate-50 text-slate-700 border-slate-300";
  };

  return (
    <div className="space-y-5 animate-fadeIn">
      {/* Section Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-slate-200">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-800">
              <Sparkles className="w-3.5 h-3.5 text-blue-600" />
              Pro Feature
            </span>
            <span className="text-xs text-slate-500 font-medium">Scored against full live dataset</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-extrabold text-slate-900 tracking-tight mt-1">
            Your Top 10 Jobs
          </h2>
          <p className="text-xs sm:text-sm text-slate-600">
            Ranked by compatibility with your verified skills and work history.
          </p>
        </div>

        <button
          type="button"
          onClick={loadTopJobs}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 shadow-2xs transition cursor-pointer self-start sm:self-auto disabled:opacity-60"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-blue-600" : ""}`} />
          <span>Refresh Matches</span>
        </button>
      </div>

      {/* Loading Skeleton */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="p-5 bg-white rounded-2xl border border-slate-200 shadow-2xs animate-pulse space-y-3"
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-slate-200 rounded-xl shrink-0" />
                <div className="space-y-2 flex-1">
                  <div className="h-5 bg-slate-200 rounded w-1/3" />
                  <div className="h-4 bg-slate-100 rounded w-1/4" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : rankedJobs.length === 0 ? (
        <div className="p-10 bg-white rounded-2xl border border-slate-200 text-center space-y-3 shadow-2xs">
          <p className="text-sm font-bold text-slate-800">No compatible openings found yet.</p>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            Try adding additional skills or certifications to your resume profile.
          </p>
        </div>
      ) : (
        /* Top 10 Jobs List */
        <div className="space-y-3.5">
          {rankedJobs.map(({ job, diagnostics }, idx) => {
            const isSaved = savedJobIds.includes(job.id);
            const scoreColor = getScoreBadgeColor(diagnostics.score);

            return (
              <div
                key={job.id}
                className="p-5 sm:p-6 bg-white rounded-2xl border border-slate-200 shadow-2xs hover:shadow-md transition-all flex flex-col md:flex-row md:items-center justify-between gap-4 group"
              >
                {/* Left: Score Badge + Details */}
                <div className="flex items-start gap-4 flex-1 min-w-0">
                  {/* Large Clear Score Badge */}
                  <div
                    className={`flex flex-col items-center justify-center w-16 h-16 sm:w-18 sm:h-18 rounded-2xl border ${scoreColor} shrink-0 text-center shadow-xs`}
                  >
                    <span className="text-lg sm:text-xl font-black leading-none">
                      {diagnostics.score}%
                    </span>
                    <span className="text-[10px] uppercase font-bold tracking-wider mt-0.5">
                      Match
                    </span>
                    <span className="text-[9px] text-slate-400">#{idx + 1}</span>
                  </div>

                  {/* Main Role Info */}
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2.5">
                      <CompanyLogo company={job.company} applyUrl={job.applyUrl} className="w-8 h-8 shrink-0" />
                      <Link
                        href={`/jobs/detail?id=${encodeURIComponent(job.id)}`}
                        className="text-base sm:text-lg font-bold text-slate-900 hover:text-blue-600 transition-colors break-words line-clamp-1"
                      >
                        {job.title}
                      </Link>
                    </div>

                    {/* Company, Location, Salary */}
                    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600 font-medium">
                      <div className="flex items-center gap-1 font-bold text-slate-900">
                        <Building className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        <span>{job.company || "Verified Employer"}</span>
                      </div>

                      <span>•</span>

                      <div className="flex items-center gap-1">
                        <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        <span>{job.location || (job.remote ? "Remote (Worldwide)" : "Remote")}</span>
                      </div>

                      {job.salary && (
                        <>
                          <span>•</span>
                          <div className="flex items-center gap-1 text-emerald-700 font-bold">
                            <DollarSign className="w-3.5 h-3.5 shrink-0" />
                            <span>{job.salary}</span>
                          </div>
                        </>
                      )}
                    </div>

                    {/* Matched Skills Chips */}
                    {diagnostics.matchedSkills.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        <span className="text-[11px] text-slate-400 font-medium mr-0.5">
                          Matched:
                        </span>
                        {diagnostics.matchedSkills.slice(0, 4).map((s) => (
                          <span
                            key={s}
                            className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200"
                          >
                            ✓ {s}
                          </span>
                        ))}
                        {diagnostics.matchedSkills.length > 4 && (
                          <span className="text-[11px] text-slate-400">
                            +{diagnostics.matchedSkills.length - 4} more
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Right: Per-Job AI Actions */}
                <div className="flex flex-wrap items-center gap-2 self-start md:self-auto shrink-0 pt-2 md:pt-0 border-t md:border-t-0 border-slate-100 w-full md:w-auto justify-end">
                  {/* Action 1: Generate AI Resume for this role */}
                  <button
                    type="button"
                    onClick={() => setActiveTailorJob(job)}
                    title="Reorder and highlight verified skills matching this role"
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 text-xs font-bold transition cursor-pointer shadow-2xs"
                  >
                    <FileCheck2 className="w-3.5 h-3.5 text-emerald-600" />
                    <span>AI Resume</span>
                  </button>

                  {/* Action 2: Generate Cover Letter */}
                  <button
                    type="button"
                    onClick={() => setActiveCoverLetterJob(job)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-bold transition cursor-pointer shadow-2xs"
                    title="Generate tailored cover letter grounded strictly in verified facts"
                  >
                    <FileText className="w-3.5 h-3.5 text-blue-600" />
                    <span>Cover Letter</span>
                  </button>

                  {/* Action 3: Bookmark */}
                  <button
                    type="button"
                    onClick={() => handleToggleSave(job)}
                    className={`p-2 rounded-xl border text-xs font-bold transition cursor-pointer ${
                      isSaved
                        ? "bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100"
                        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                    }`}
                    title={isSaved ? "Saved in Tracker" : "Save to Tracker"}
                  >
                    <BookmarkPlus className="w-4 h-4" />
                  </button>

                  {/* Action 4: Inspect & Apply */}
                  <Link
                    href={`/jobs/detail?id=${encodeURIComponent(job.id)}`}
                    className="inline-flex items-center gap-1 px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition shadow-xs"
                  >
                    <span>Inspect</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modals */}
      {activeTailorJob && (
        <TailorResumeModal
          open={Boolean(activeTailorJob)}
          onOpenChange={(open) => !open && setActiveTailorJob(null)}
          candidate={candidate}
          job={{
            id: activeTailorJob.id,
            title: activeTailorJob.title,
            company: activeTailorJob.company,
            location: activeTailorJob.location,
            category: activeTailorJob.category,
            skills: activeTailorJob.skills,
            description: activeTailorJob.description,
          }}
          onOpenCoverLetter={() => {
            const j = activeTailorJob;
            setActiveTailorJob(null);
            setActiveCoverLetterJob(j);
          }}
        />
      )}

      {activeCoverLetterJob && (
        <CoverLetterModal
          open={Boolean(activeCoverLetterJob)}
          onOpenChange={(open) => !open && setActiveCoverLetterJob(null)}
          candidate={candidate}
          job={{
            id: activeCoverLetterJob.id,
            title: activeCoverLetterJob.title,
            company: activeCoverLetterJob.company,
            location: activeCoverLetterJob.location,
            description: activeCoverLetterJob.description,
          }}
        />
      )}
    </div>
  );
}
