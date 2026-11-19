"use client";

import React, { useState } from "react";
import {
  CheckCircle2,
  Heart,
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  Target,
} from "lucide-react";
import { LiveJob } from "@/lib/jobs/service";
import { CandidateProfile } from "@/lib/resume/types";
import { FitDiagnosticsResult } from "@/lib/matcher/scoring";
import type { User } from "@supabase/supabase-js";

// Match insights + tracker actions only. AI tool entry points (resume tailoring) are
// intentionally not offered outside the landing page.
export interface JobAiToolsPanelProps {
  job: LiveJob;
  candidate: CandidateProfile | null;
  user: User | null;
  isPro: boolean;
  diagnostics: FitDiagnosticsResult | null;
  isSaved: boolean;
  isApplied?: boolean;
  trackedStage?: "saved" | "applied" | "interview" | "offer" | "rejected" | null;
  isUpdatingApplied?: boolean;
  onSave: () => void;
  onToggleApplied?: () => void;
}

export default function JobAiToolsPanel({
  job,
  candidate,
  diagnostics,
  isSaved,
  isApplied = false,
  trackedStage = null,
  isUpdatingApplied = false,
  onSave,
  onToggleApplied,
}: JobAiToolsPanelProps) {
  const [isMobileExpanded, setIsMobileExpanded] = useState(false);

  const hasConfirmedResume = Boolean(candidate && candidate.confirmedAt);
  const matchScore = typeof job?.matchScore === "number" && !isNaN(job.matchScore)
    ? Math.max(10, Math.min(99, Math.round(job.matchScore)))
    : diagnostics
    ? Math.max(10, Math.min(99, Math.round(diagnostics.score)))
    : null;
  const matchLabel =
    matchScore !== null
      ? matchScore > 70
        ? "Great match"
        : matchScore >= 50
        ? "Good match"
        : "Fair match"
      : null;

  const topMatchedSkills = diagnostics?.matchedSkills ? diagnostics.matchedSkills.slice(0, 5) : [];
  const topMissingSkills = diagnostics?.missingSkills ? diagnostics.missingSkills.slice(0, 4) : [];

  return (
    <div
      data-testid="job-ai-tools-panel"
      className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-4 sm:p-5 shadow-xs transition-all duration-200"
    >
      {/* HEADER / MOBILE TOGGLE */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-200/80 flex items-center justify-center text-[#2563EB] shrink-0">
            <Target className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-[#0F172A] tracking-tight truncate">
                Match Insights
              </h2>
              {matchScore !== null && (
                <span
                  data-testid="ai-tools-match-badge"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-blue-50 text-[#1D4ED8] border border-blue-200/70 shrink-0"
                >
                  <Target className="w-3 h-3 text-[#2563EB]" />
                  {matchScore}% Match
                </span>
              )}
            </div>
            <p className="text-[11px] text-[#64748B] hidden sm:block truncate">
              Review your match breakdown and track your application
            </p>
          </div>
        </div>

        {/* Mobile toggle button */}
        <button
          type="button"
          onClick={() => setIsMobileExpanded(!isMobileExpanded)}
          aria-expanded={isMobileExpanded}
          aria-controls="ai-tools-panel-body"
          aria-label={isMobileExpanded ? "Collapse match insights panel" : "Expand match insights panel"}
          className="md:hidden inline-flex items-center justify-center w-8 h-8 rounded-lg text-[#64748B] hover:text-[#0F172A] hover:bg-slate-100 transition cursor-pointer shrink-0"
        >
          {isMobileExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {/* PANEL BODY (Always visible on desktop, toggleable on mobile) */}
      <div
        id="ai-tools-panel-body"
        className={`pt-3.5 mt-3.5 border-t border-[#F1F5F9] space-y-4 ${
          isMobileExpanded ? "block" : "hidden md:block"
        }`}
      >
        {/* ROW 1: ACTIONS (Quick Tracker) */}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {/* Tracker (Save & Applied) */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Save / Bookmark Button */}
            <button
              type="button"
              onClick={onSave}
              data-testid="ai-tools-save-button"
              aria-pressed={isSaved}
              aria-label={isSaved ? "Remove from saved jobs" : "Save job"}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition cursor-pointer min-h-[36px] ${
                isSaved
                  ? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                  : "border-[#E2E8F0] bg-white text-[#475569] hover:bg-slate-50 hover:text-[#0F172A]"
              }`}
            >
              <Heart
                className={`w-3.5 h-3.5 ${
                  isSaved ? "fill-rose-500 text-rose-500" : "text-[#64748B]"
                }`}
              />
              <span>{isSaved ? "Saved" : "Save"}</span>
            </button>

            {/* Applied / Track Button */}
            {onToggleApplied && (
              <button
                type="button"
                onClick={onToggleApplied}
                data-testid="ai-tools-applied-button"
                disabled={isUpdatingApplied}
                aria-pressed={Boolean(isApplied || (trackedStage && trackedStage !== "saved"))}
                aria-label={
                  isApplied ? "Mark position as unapplied" : "Mark position as applied"
                }
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition cursor-pointer min-h-[36px] ${
                  isUpdatingApplied
                    ? "opacity-60 cursor-not-allowed border-[#E2E8F0] bg-slate-50 text-[#64748B]"
                    : isApplied || (trackedStage && trackedStage !== "saved")
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                    : "border-[#E2E8F0] bg-white text-[#475569] hover:bg-slate-50 hover:text-[#0F172A]"
                }`}
              >
                {isUpdatingApplied ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[#64748B]" />
                ) : (
                  <CheckCircle2
                    className={`w-3.5 h-3.5 ${
                      isApplied || (trackedStage && trackedStage !== "saved")
                        ? "text-emerald-600 fill-emerald-100"
                        : "text-[#64748B]"
                    }`}
                  />
                )}
                <span>
                  {isUpdatingApplied
                    ? "Updating..."
                    : isApplied || (trackedStage && trackedStage !== "saved")
                    ? "Applied"
                    : "Mark Applied"}
                </span>
              </button>
            )}
          </div>
        </div>

        {/* ROW 2: MATCH BREAKDOWN (Shown ONLY when candidate has confirmed resume & diagnostics are computed) */}
        {hasConfirmedResume && diagnostics && matchScore !== null && (
          <div
            data-testid="ai-tools-match-breakdown"
            className="rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] p-3.5 space-y-3"
          >
            {/* Breakdown Header with Match Score */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-[#0F172A]">Match Breakdown</span>
                {matchLabel && (
                  <span className="text-[11px] font-semibold text-[#64748B]">
                    • {matchLabel}
                  </span>
                )}
              </div>
              <div className="text-xs font-bold text-[#1D4ED8] bg-blue-50 px-2 py-0.5 rounded-md border border-blue-200/60">
                {matchScore}% match score
              </div>
            </div>

            {/* Skills Comparison */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              {/* Top Matching Skills */}
              {topMatchedSkills.length > 0 && (
                <div data-testid="ai-tools-matched-skills" className="space-y-1.5">
                  <span className="text-[11px] font-bold text-emerald-800 uppercase tracking-wider block">
                    Top Matching Skills ({topMatchedSkills.length})
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {topMatchedSkills.map((skill) => (
                      <span
                        key={skill}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-emerald-50 text-emerald-800 border border-emerald-200/80"
                      >
                        <Check className="w-3 h-3 text-emerald-600 shrink-0" />
                        <span className="truncate max-w-[140px]">{skill}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Top Missing Skills */}
              {topMissingSkills.length > 0 && (
                <div data-testid="ai-tools-missing-skills" className="space-y-1.5">
                  <span className="text-[11px] font-bold text-[#475569] uppercase tracking-wider block">
                    Missing Skills ({topMissingSkills.length})
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {topMissingSkills.map((skill) => (
                      <span
                        key={skill}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-slate-100 text-[#475569] border border-slate-200"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0" />
                        <span className="truncate max-w-[140px]">{skill}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
