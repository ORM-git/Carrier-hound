"use client";

import React, { useState } from "react";
import {
  X,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  FileText,
  FileCheck2,
  BookmarkPlus,
  ExternalLink,
  ChevronRight,
  ShieldCheck,
  Check,
  Info,
} from "lucide-react";
import { FitDiagnosticsResult } from "@/lib/matcher/scoring";
import { CandidateProfile } from "@/lib/resume/types";
import { addApplicationToTracker } from "@/lib/tracker/storage";
import { sanitizeExternalUrl } from "@/lib/security/xss";
import { toast } from "react-toastify";

interface FitDiagnosticsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  diagnostics: FitDiagnosticsResult;
  candidate: CandidateProfile;
  job: {
    id?: string;
    title: string;
    company: string;
    location?: string;
    salary_text?: string;
    apply_url?: string;
  };
  onOpenCoverLetter?: () => void;
  onExportResume?: () => void;
}

export default function FitDiagnosticsModal({
  open,
  onOpenChange,
  diagnostics,
  candidate,
  job,
  onOpenCoverLetter,
  onExportResume,
}: FitDiagnosticsModalProps) {
  const [isSavedToTracker, setIsSavedToTracker] = useState(false);

  if (!open) return null;

  const { score, scoreGrade, matchedSkills, missingSkills, whyYouFit, gaps } = diagnostics;

  const scoreBadgeColor =
    score >= 80
      ? "bg-gradient-to-br from-[#1E3A8A] to-[#2563EB] text-white border-white/10"
      : score >= 50
      ? "bg-gradient-to-br from-[#0F172A] to-[#1E3A8A] text-white border-white/10"


      : "bg-gradient-to-br from-[#0F172A] to-[#334155] text-white border-white/10";

  const handleTrackJob = async () => {
    await addApplicationToTracker({
      jobId: job.id,
      company: job.company,
      title: job.title,
      location: job.location,
      salaryText: job.salary_text,
      applyUrl: job.apply_url,
      stage: "saved",
      notes: `Matched ${score}% on CareerMonke Fit Diagnostics.`,
    });
    setIsSavedToTracker(true);
    toast.success(`Saved "${job.title}" at ${job.company} to your Application Tracker!`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-[#0F172A]/60 backdrop-blur-xs animate-fadeIn">
      <div
        className="relative w-full max-w-2xl bg-white rounded-[20px] shadow-popover border border-[#E2E8F0] overflow-hidden flex flex-col max-h-[92dvh] animate-scaleUp"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-5 sm:p-6 bg-slate-900 text-white flex items-start justify-between relative">
          <div className="pr-8 space-y-1">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-500/20 text-blue-300 border border-blue-500/30">
                <Sparkles className="w-3 h-3" /> Match Breakdown
              </span>
              <span className="text-xs text-slate-400 font-mono">Verified Match</span>
            </div>
            <h2 className="text-lg sm:text-xl font-bold text-white line-clamp-1">{job.title}</h2>
            <p className="text-xs sm:text-sm text-slate-300">
              {job.company} • {job.location || "Remote"}
            </p>
          </div>

          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors cursor-pointer min-h-[44px] min-w-[44px]"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="p-5 sm:p-6 space-y-6 overflow-y-auto flex-1">
          {/* Match Score Hero Card */}
          <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div
                className={`w-16 h-16 sm:w-20 sm:h-20 rounded-2xl flex flex-col items-center justify-center border font-black text-2xl sm:text-3xl shadow-xs shrink-0 ${scoreBadgeColor}`}
              >
                <span>{score}%</span>
                <span className="text-[10px] uppercase font-bold tracking-wider -mt-1">Match</span>
              </div>
              <div className="space-y-1">
                <div className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-blue-600" />
                  <span>
                    {score >= 80
                      ? "High Role Match"
                      : score >= 50
                      ? "Strong Role Alignment"
                
                      : "Moderate Fit — Address Missing Skills"}

                  </span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Calculated from your confirmed profile facts ({candidate.skills.length} skills, {candidate.experience.length} roles).
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleTrackJob}
              disabled={isSavedToTracker}
              className={`px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all min-h-[44px] shrink-0 ${
                isSavedToTracker
                  ? "bg-emerald-100 text-emerald-800 cursor-default"
                  : "bg-white hover:bg-slate-100 text-slate-800 border border-slate-300 shadow-xs cursor-pointer"
              }`}
            >
              {isSavedToTracker ? (
                <>
                  <Check className="w-4 h-4 text-emerald-600" />
                  <span>Tracked</span>
                </>
              ) : (
                <>
                  <BookmarkPlus className="w-4 h-4 text-blue-600" />
                  <span>Add to Tracker</span>
                </>
              )}
            </button>
          </div>

          {/* Score Calculation Basis */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-2">
            <div className="text-[11px] font-bold text-slate-700 uppercase tracking-wider flex items-center justify-between">
              <span>How This Score is Computed</span>
              <span className="font-mono text-slate-500 font-normal">Heuristic Weights</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="bg-white p-2 rounded-lg border border-slate-200">
                <span className="text-[10px] text-slate-500 block">Skills Evidenced</span>
                <span className="font-bold text-slate-900">{diagnostics.breakdown.skillScore} / 50</span>
              </div>
              <div className="bg-white p-2 rounded-lg border border-slate-200">
                <span className="text-[10px] text-slate-500 block">Title Alignment</span>
                <span className="font-bold text-slate-900">{diagnostics.breakdown.titleScore} / 25</span>
              </div>
              <div className="bg-white p-2 rounded-lg border border-slate-200">
                <span className="text-[10px] text-slate-500 block">Experience (~{diagnostics.breakdown.yearsOfExperience}y)</span>
                <span className="font-bold text-slate-900">{diagnostics.breakdown.experienceScore} / 15</span>
              </div>
              <div className="bg-white p-2 rounded-lg border border-slate-200">
                <span className="text-[10px] text-slate-500 block">Location Fit</span>
                <span className="font-bold text-slate-900">{diagnostics.breakdown.remoteScore} / 10</span>
              </div>
            </div>
          </div>

          {/* Section: Why You Fit */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>Why You Fit ({whyYouFit.length} Evidences)</span>
            </h3>
            <div className="bg-emerald-50/60 border border-emerald-100 rounded-xl p-4 space-y-2.5">
              {whyYouFit.map((item, idx) => (
                <div key={idx} className="flex items-start gap-2.5 text-xs text-slate-800 leading-relaxed">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 mt-1.5 shrink-0" />
                  <span>{item}</span>
                </div>
              ))}

              {matchedSkills.length > 0 && (
                <div className="pt-2 flex flex-wrap gap-1.5">
                  {matchedSkills.map((s, idx) => (
                    <span
                      key={idx}
                      className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-emerald-100/80 text-emerald-800 border border-emerald-200"
                    >
                      ✓ {s}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Section: Inferred Role Signals (Separated from explicit listing requirements) */}
          {diagnostics.inferredSignals && diagnostics.inferredSignals.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                <Info className="w-4 h-4 text-blue-600" />
                <span>Inferred Role Signals (From Title / Category — Not Required Skills)</span>
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {diagnostics.inferredSignals.map((signal, idx) => (
                  <span
                    key={idx}
                    className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200"
                  >
                    • {signal}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Section: Missing Skills / Gaps */}
          {missingSkills.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 text-amber-600" />
                <span>Skills Evidenced in Listing Description But Missing on Resume ({missingSkills.length})</span>
              </h3>
              <div className="bg-amber-50/60 border border-amber-100 rounded-xl p-4 space-y-2.5">
                <p className="text-xs text-slate-600 leading-relaxed">
                  Evidenced in the job description. Addressing these in your application or interview prep will strengthen your alignment:
                </p>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {missingSkills.map((s, idx) => (
                    <span
                      key={idx}
                      className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-amber-100/80 text-amber-900 border border-amber-200"
                    >
                      + {s}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Action Row: ATS Tailor Tools */}
          <div className="pt-2 border-t border-slate-100 space-y-2.5">
            <div className="text-xs font-bold text-slate-700 uppercase tracking-wider">
              Application Tailoring Tools
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  onOpenCoverLetter?.();
                }}
                className="w-full p-3.5 rounded-xl border border-blue-200 bg-blue-50/50 hover:bg-blue-100/60 text-blue-900 text-xs font-bold flex items-center justify-between transition-colors cursor-pointer min-h-[44px]"
              >
                <span className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-blue-600" />
                  <span>1-Click Cover Letter</span>
                </span>
                <ChevronRight className="w-4 h-4 text-blue-500" />
              </button>

              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  onExportResume?.();
                }}
                className="w-full p-3.5 rounded-xl border border-slate-200 bg-slate-50/70 hover:bg-slate-100 text-slate-800 text-xs font-bold flex items-center justify-between transition-colors cursor-pointer min-h-[44px]"
              >
                <span className="flex items-center gap-2">
                  <FileCheck2 className="w-4 h-4 text-slate-600" />
                  <span>Export ATS Resume</span>
                </span>
                <ChevronRight className="w-4 h-4 text-slate-400" />
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500">
            Source: <strong className="text-slate-800">{job.company} Direct ATS</strong>
          </span>
          {sanitizeExternalUrl(job.apply_url) && (
            <a
              href={sanitizeExternalUrl(job.apply_url)!}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-xs transition-colors min-h-[44px]"
            >
              <span>Apply on Company Portal</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
