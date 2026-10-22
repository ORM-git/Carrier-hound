"use client";

import React, { useState, useMemo } from "react";
import Link from "next/link";
import { Sparkles, Target, Zap } from "lucide-react";
import dynamic from "next/dynamic";
import { computeFitDiagnostics, FitDiagnosticsResult, StandardJobScoringInput } from "@/lib/matcher/scoring";
import { CandidateProfile } from "@/lib/resume/types";
import { useSharedCandidateProfile } from "@/lib/resume/useCandidateProfile";

const FitDiagnosticsModal = dynamic(() => import("./FitDiagnosticsModal"), { ssr: false });
const CoverLetterModal = dynamic(() => import("../resume/CoverLetterModal"), { ssr: false });

interface MatchScoreBadgeProps {
  job: StandardJobScoringInput;
  candidateProfile?: CandidateProfile | null;
  size?: "xs" | "sm" | "md";
  showLabel?: boolean;
}

export default function MatchScoreBadge({
  job,
  candidateProfile,
  size = "sm",
  showLabel = true,
}: MatchScoreBadgeProps) {
  // Read from shared memoized store or parent-passed candidateProfile
  const candidate = useSharedCandidateProfile(candidateProfile);

  // Synchronous, stable memoized diagnostics based on primitive job attributes
  const diagnostics = useMemo<FitDiagnosticsResult | null>(() => {
    if (!candidate || !candidate.confirmedAt) return null;
    return computeFitDiagnostics(candidate, job);
  }, [
    candidate,
    job?.id,
    job?.title,
    job?.company,
    job?.location,
    job?.remote_scope,
    job?.category,
    job?.skills?.length,
    job?.description?.length,
  ]);

  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [isCoverLetterOpen, setIsCoverLetterOpen] = useState(false);

  if (!candidate || !candidate.confirmedAt || !diagnostics) {
    return (
      <Link
        href="/resume"
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 font-semibold rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition text-[10px] px-2 py-0.5 shadow-2xs"
        title="Add and confirm your resume facts to see your personalized match score"
      >
        <Sparkles className="w-3 h-3 text-slate-400" />
        <span>Add resume to see match</span>
      </Link>
    );
  }

  const { score, scoreGrade } = diagnostics;

  let colorClasses = "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100";
  let ringClasses = "focus:ring-blue-400";
  let dotColor = "bg-blue-500";

  if (score >= 80) {
    colorClasses = "bg-[#DBEAFE] text-[#1E3A8A] border-[#BFDBFE] hover:bg-blue-100";
    ringClasses = "focus:ring-[#93C5FD]";
    dotColor = "bg-[#2563EB]";
  } else if (score >= 50) {
    colorClasses = "bg-[#EFF6FF] text-[#1D4ED8] border-[#BFDBFE] hover:bg-[#DBEAFE]";
    ringClasses = "focus:ring-[#93C5FD]";
    dotColor = "bg-[#1D4ED8]";
  } else {
    colorClasses = "bg-[#F1F5F9] text-[#475569] border-[#E2E8F0] hover:bg-[#E2E8F0]";
    ringClasses = "focus:ring-slate-300";
    dotColor = "bg-[#94A3B8]";
  }

  const sizeClasses =
    size === "xs"
      ? "text-[10px] px-1.5 py-0.5 gap-1"
      : size === "md"
      ? "text-xs px-3 py-1.5 gap-1.5"
      : "text-xs px-2.5 py-1 gap-1.5"; // sm

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setIsDiagnosticsOpen(true);
        }}
        className={`inline-flex items-center font-bold rounded-lg border transition-all cursor-pointer shadow-2xs focus:outline-hidden focus:ring-2 ${colorClasses} ${ringClasses} ${sizeClasses}`}
        title={`Fit Score: ${score}% match. Click to view honest skill & requirement breakdown.`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor} shrink-0`} />
        <span>{score}%</span>
        {showLabel && <span className="font-medium text-[11px] opacity-90">Match</span>}
      </button>

      {/* Diagnostics Modal */}
      {isDiagnosticsOpen && (
        <FitDiagnosticsModal
          open={isDiagnosticsOpen}
          onOpenChange={setIsDiagnosticsOpen}
          diagnostics={diagnostics}
          candidate={candidate}
          job={{
            ...job,
            company: job.company || "Verified Employer",
          }}
          onOpenCoverLetter={() => {
            setIsDiagnosticsOpen(false);
            setIsCoverLetterOpen(true);
          }}
        />
      )}

      {/* Cover Letter Modal */}
      {isCoverLetterOpen && (
        <CoverLetterModal
          open={isCoverLetterOpen}
          onOpenChange={setIsCoverLetterOpen}
          candidate={candidate}
          job={{
            ...job,
            company: job.company || "Verified Employer",
          }}
        />
      )}
    </>
  );
}
