"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { Sparkles, Target, Zap } from "lucide-react";
import dynamic from "next/dynamic";
import { computeFitDiagnostics, FitDiagnosticsResult } from "@/lib/matcher/scoring";
import { CandidateProfile } from "@/lib/resume/types";
import { getCandidateProfile } from "@/lib/resume/storage";

const FitDiagnosticsModal = dynamic(() => import("./FitDiagnosticsModal"), { ssr: false });
const CoverLetterModal = dynamic(() => import("../resume/CoverLetterModal"), { ssr: false });

interface MatchScoreBadgeProps {
  job: {
    id?: string;
    title: string;
    company: string;
    description?: string;
    location?: string;
    remote_scope?: string;
    category?: string;
    salary_text?: string;
    apply_url?: string;
  };
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
  const [candidate, setCandidate] = useState<CandidateProfile | null>(() => {
    if (candidateProfile && candidateProfile.confirmedAt) {
      return candidateProfile;
    }
    return null;
  });
  const [diagnostics, setDiagnostics] = useState<FitDiagnosticsResult | null>(() => {
    if (candidateProfile && candidateProfile.confirmedAt) {
      return computeFitDiagnostics(candidateProfile, job);
    }
    return null;
  });
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [isCoverLetterOpen, setIsCoverLetterOpen] = useState(false);

  useEffect(() => {
    if (candidateProfile !== undefined) {
      if (candidateProfile && candidateProfile.confirmedAt) {
        setCandidate(candidateProfile);
        setDiagnostics(computeFitDiagnostics(candidateProfile, job));
      } else {
        setCandidate(null);
        setDiagnostics(null);
      }
      return;
    }

    // Load from storage (e.g. user's confirmed resume)
    getCandidateProfile().then((p) => {
      if (p && p.confirmedAt) {
        setCandidate(p);
        setDiagnostics(computeFitDiagnostics(p, job));
      } else {
        setCandidate(null);
        setDiagnostics(null);
      }
    });

    const handleProfileUpdate = () => {
      getCandidateProfile().then((p) => {
        if (p && p.confirmedAt) {
          setCandidate(p);
          setDiagnostics(computeFitDiagnostics(p, job));
        } else {
          setCandidate(null);
          setDiagnostics(null);
        }
      });
    };

    window.addEventListener("careermonke_profile_updated", handleProfileUpdate);
    return () => {
      window.removeEventListener("careermonke_profile_updated", handleProfileUpdate);
    };
  }, [candidateProfile, job]);

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
    colorClasses = "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100";
    ringClasses = "focus:ring-emerald-400";
    dotColor = "bg-emerald-500";
  } else if (score >= 65) {
    colorClasses = "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100";
    ringClasses = "focus:ring-blue-400";
    dotColor = "bg-blue-500";
  } else if (score >= 45) {
    colorClasses = "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100";
    ringClasses = "focus:ring-amber-400";
    dotColor = "bg-amber-500";
  } else {
    colorClasses = "bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200";
    ringClasses = "focus:ring-slate-400";
    dotColor = "bg-slate-400";
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
          job={job}
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
          job={job}
        />
      )}
    </>
  );
}
