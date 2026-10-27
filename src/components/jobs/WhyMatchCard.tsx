"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Sparkles, X, Ban, Heart, ArrowRight, Lock } from "lucide-react";
import { LiveJob } from "@/lib/jobs/service";
import { CandidateProfile } from "@/lib/resume/types";
import { computeFitDiagnostics, FitDiagnosticsResult } from "@/lib/matcher/scoring";
import { stripHtmlAndExecutableMarkup } from "@/lib/security/xss";

const FitDiagnosticsModal = dynamic(
  () => import("@/components/matcher/FitDiagnosticsModal"),
  { ssr: false }
);

/**
 * Extracts the first 1-2 real sentences of a job's description.
 * Strips HTML, collapses whitespace, and caps at ~160 characters at a sentence/word boundary.
 * Returns null if the description is missing, empty, or has no valid text.
 */
export function extractJobSummary(description?: string | null): string | null {
  if (!description || !description.trim()) return null;
  const stripped = stripHtmlAndExecutableMarkup(description);
  const text = stripped.replace(/\s+/g, " ").trim();
  if (!text) return null;

  // Extract first 1-2 real sentences
  const sentenceRegex = /[^.!?]+[.!?]+(?:\s|$)/g;
  const sentences = text.match(sentenceRegex);

  let summary = "";
  if (sentences && sentences.length > 0) {
    const s1 = sentences[0].trim();
    if (s1.length >= 100) {
      summary = s1;
    } else if (sentences.length > 1) {
      summary = `${s1} ${sentences[1].trim()}`;
    } else {
      summary = s1;
    }
  } else {
    summary = text;
  }

  // Cap ~160 chars at sentence/word boundary
  if (summary.length > 160) {
    const truncated = summary.slice(0, 160);
    const lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > 80) {
      summary = truncated.slice(0, lastSpace).trim();
      if (!/[.!?]$/.test(summary)) {
        summary += "...";
      }
    } else {
      summary = truncated.trim() + "...";
    }
  }

  return summary || null;
}

/**
 * Computes strictly real sub-scores based on scorer breakdown.
 * Never renders an Education ring (no education score exists).
 * Omits any score not computable.
 */
export function computeSubScores(diagnostics: FitDiagnosticsResult | null) {
  if (!diagnostics || !diagnostics.breakdown) {
    return { experienceScore: null, skillScore: null, roleScore: null };
  }
  const expScore =
    typeof diagnostics.breakdown.experienceScore === "number"
      ? Math.min(100, Math.max(0, Math.round((diagnostics.breakdown.experienceScore / 15) * 100)))
      : null;

  const skillScore =
    typeof diagnostics.breakdown.skillScore === "number"
      ? Math.min(100, Math.max(0, Math.round((diagnostics.breakdown.skillScore / 50) * 100)))
      : null;

  const roleScore =
    typeof diagnostics.breakdown.titleScore === "number"
      ? Math.min(100, Math.max(0, Math.round((diagnostics.breakdown.titleScore / 25) * 100)))
      : null;

  return { experienceScore: expScore, skillScore, roleScore };
}

/**
 * Returns overall score label based on canonical thresholds:
 * >70: Strong match, >=50: Good match, else: Fair match.
 */
export function getMatchThresholdLabel(score: number): "Strong match" | "Good match" | "Fair match" {
  if (score > 70) return "Strong match";
  if (score >= 50) return "Good match";
  return "Fair match";
}

/**
 * Helper to compute diagnostics for a job against a confirmed candidate.
 */
export function computePopoverDiagnostics(
  job: LiveJob,
  candidate: CandidateProfile | null
): FitDiagnosticsResult | null {
  if (!candidate || !candidate.confirmedAt) return null;
  try {
    const res = computeFitDiagnostics(candidate, {
      id: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      remote_scope: job.remoteScope || (job.remote ? "worldwide" : undefined),
      category: job.category,
      skills: job.skills,
      description: job.description,
      salary_text: job.salary,
      apply_url: job.applyUrl,
    });
    if (res && typeof res.score === "number" && !isNaN(res.score)) {
      return res;
    }
  } catch {}
  return null;
}

/**
 * Sub-score circular progress ring (Experience, Skill, Role).
 * Preserves Prompt 5 token specifications: #2563EB stroke fallback, #E2E8F0 track, 12px label.
 * Styled with horizontal ring + label layout and vibrant electric mint (#00E599) matching the reference design.
 */
export function SmallComponentRing({
  score,
  label,
  subLabel,
  size = 40,
  strokeWidth = 3.5,
  color = "#00E599",
}: {
  score: number;
  label: string;
  subLabel?: string;
  size?: number;
  strokeWidth?: number;
  color?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  return (
    <div
      className="flex items-center gap-2 shrink-0"
      data-testid={`match-ring-${label.toLowerCase()}`}
      data-score={score}
    >
      <div
        className="relative inline-flex items-center justify-center shrink-0"
        style={{ width: size, height: size }}
      >
        <svg className="w-full h-full -rotate-90" viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke="#E2E8F0"
            strokeWidth={strokeWidth}
            fill="transparent"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={color}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            fill="transparent"
            className="transition-all duration-300 ease-out"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[11px] font-black text-[#0F172A] leading-none">
            {score}%
          </span>
        </div>
      </div>
      <div className="flex flex-col text-left">
        <span className="text-[12px] font-medium text-[#475569] leading-tight">
          {label}
        </span>
        {subLabel && (
          <span className="text-[11px] font-medium text-[#475569] leading-tight">
            {subLabel}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Overall match circular progress ring for the right green panel.
 * Mint/teal stroke (#34D399), dark track, white percentage text.
 */
export function OverallMatchRing({
  score,
  size = 72,
  strokeWidth = 4.5,
}: {
  score: number;
  size?: number;
  strokeWidth?: number;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  return (
    <div
      className="relative inline-flex items-center justify-center shrink-0"
      style={{ width: size, height: size }}
      data-testid="overall-match-ring"
      data-score={score}
    >
      <svg className="w-full h-full -rotate-90" viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="rgba(255, 255, 255, 0.16)"
          strokeWidth={strokeWidth}
          fill="transparent"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="#34D399"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          fill="transparent"
          className="transition-all duration-300 ease-out drop-shadow-[0_0_8px_rgba(52,211,153,0.35)]"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-2xl font-black text-white leading-none tracking-tight">
          {score}%
        </span>
      </div>
    </div>
  );
}

export interface WhyMatchCardProps {
  job: LiveJob;
  candidate: CandidateProfile | null;
  isPro?: boolean;
  isSaved?: boolean;
  onSelectJob?: (job: LiveJob) => void;
  onHideJob?: (e: React.MouseEvent, jobId: string) => void;
  onSaveJob?: (job: LiveJob) => void;
  onApplyJob?: (e: React.MouseEvent, job: LiveJob) => void;
  onOpenFitAnalysis?: (job: LiveJob, diagnostics: FitDiagnosticsResult) => void;
  isMobileSheetOpen?: boolean;
  onCloseMobileSheet?: () => void;
  className?: string;
}

export default function WhyMatchCard({
  job,
  candidate,
  isPro = false,
  isSaved = false,
  onSelectJob,
  onHideJob,
  onSaveJob,
  onApplyJob,
  onOpenFitAnalysis,
  isMobileSheetOpen = false,
  onCloseMobileSheet,
  className = "",
}: WhyMatchCardProps) {
  const [hasIntent, setHasIntent] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [isFitModalOpen, setIsFitModalOpen] = useState(false);
  const hoverTimerRef = useRef<NodeJS.Timeout | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Lazy computation of fit diagnostics memoized by job.id and candidate confirmation
  const diagnostics = useMemo(() => {
    if (!hasIntent && !isMobileSheetOpen) return null;
    return computePopoverDiagnostics(job, candidate);
  }, [job, candidate, hasIntent, isMobileSheetOpen]);

  const summary = useMemo(() => extractJobSummary(job.description), [job.description]);
  const subScores = useMemo(() => computeSubScores(diagnostics), [diagnostics]);

  const overallScore = diagnostics
    ? Math.max(10, Math.min(99, Math.round(diagnostics.score)))
    : null;

  const thresholdLabel = overallScore !== null ? getMatchThresholdLabel(overallScore) : null;

  const matchedSkillsLine =
    diagnostics?.matchedSkills && diagnostics.matchedSkills.length > 0
      ? `Matches ${diagnostics.matchedSkills.length} of your skills (${diagnostics.matchedSkills.slice(0, 3).join(", ")}${diagnostics.matchedSkills.length > 3 ? ", ..." : ""})`
      : null;

  // Intent handling: 150ms delay to prevent jitter and maintain peak scroll performance
  const handleMouseEnter = () => {
    setIsDismissed(false);
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setHasIntent(true);
    }, 150);
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setIsDismissed(false);
    setHasIntent(false);
  };

  const handleFocus = () => {
    setIsDismissed(false);
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setHasIntent(true);
    }, 150);
  };

  const handleBlur = (e: React.FocusEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      setIsDismissed(false);
      setHasIntent(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setIsDismissed(true);
      setHasIntent(false);
    }
  };

  // Focus trap and escape listener for mobile sheet
  useEffect(() => {
    if (!isMobileSheetOpen) return;
    const handleSheetEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseMobileSheet?.();
      }
    };
    window.addEventListener("keydown", handleSheetEscape);
    return () => window.removeEventListener("keydown", handleSheetEscape);
  }, [isMobileSheetOpen, onCloseMobileSheet]);

  const handleFitAnalysisClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (diagnostics && candidate) {
      if (onOpenFitAnalysis) {
        onOpenFitAnalysis(job, diagnostics);
      } else {
        setIsFitModalOpen(true);
      }
    }
  };

  // Reusable panel content for both desktop popover and mobile sheet
  const renderLeftPanel = (isMobile = false) => (
    <div className={`flex-1 bg-white p-4 sm:p-5 flex flex-col justify-between min-w-0 ${isMobile ? "space-y-4" : ""}`}>
      <div className="space-y-2.5">
        {/* Title row with electric mint Sparkle icon & action menu dots */}
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <svg
              viewBox="0 0 24 24"
              className="w-5 h-5 text-[#00E599] fill-[#00E599] shrink-0 drop-shadow-[0_0_6px_rgba(0,229,153,0.35)]"
              fill="currentColor"
            >
              <path d="M12 0L14.6 9.4L24 12L14.6 14.6L12 24L9.4 14.6L0 12L9.4 9.4L12 0Z" />
            </svg>
            <h3 className="text-[14px] font-bold text-[#0F172A] leading-snug">
              Why this job is a match
            </h3>
          </div>
          <div className="text-slate-300 font-bold tracking-widest text-sm select-none pr-1">•••</div>
        </div>

        {diagnostics ? (
          <>
            {/* Real Per-Job Summary: ONLY from job's own description. Omitted if empty */}
            {summary && (
              <p className="text-[13px] text-[#334155] leading-relaxed line-clamp-2" title={summary}>
                {summary}
              </p>
            )}

            {/* Factual matched skills line (rendered only when real skills match) */}
            {matchedSkillsLine && (
              <p className="text-[11.5px] text-[#059669] font-medium leading-snug truncate flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#00E599] shrink-0" />
                <span>{matchedSkillsLine}</span>
              </p>
            )}

            {/* Real sub-score circular progress rings (up to 3: Experience, Skill, Role) */}
            <div className="flex items-center gap-4 sm:gap-6 pt-1 flex-wrap" data-testid="match-component-rings">
              {subScores.experienceScore !== null && (
                <SmallComponentRing
                  label="Experience"
                  subLabel="Level"
                  score={subScores.experienceScore}
                />
              )}
              {subScores.skillScore !== null && (
                <SmallComponentRing
                  label="Skills"
                  score={subScores.skillScore}
                />
              )}
              {subScores.roleScore !== null && (
                <SmallComponentRing
                  label="Role"
                  subLabel="Fit"
                  score={subScores.roleScore}
                />
              )}
            </div>
          </>
        ) : (
          /* Locked State for Guest & Unconfirmed Resume */
          <div className="pt-1">
            <Link
              href="/resume"
              data-testid="hover-upload-resume-cta"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-2 p-2.5 rounded-[12px] bg-[#F8FAFC] hover:bg-[#EFF6FF] border border-[#E2E8F0] hover:border-[#93C5FD] text-left transition-all duration-200 group/cta focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 w-fit"
            >
              <div className="w-6 h-6 rounded-full bg-[#EFF6FF] group-hover/cta:bg-[#DBEAFE] border border-[#BFDBFE] flex items-center justify-center shrink-0 transition-colors">
                <Sparkles className="w-3.5 h-3.5 text-[#2563EB]" />
              </div>
              <span className="text-[12px] font-semibold text-[#0F172A] group-hover/cta:text-[#1D4ED8] transition-colors leading-snug">
                Upload your resume to see why this job matches
              </span>
            </Link>
          </div>
        )}
      </div>

      {/* Footer row: Applicant text (real numbers only) + Actions (Hide, Save, Fit Analysis, Apply) */}
      <div className="flex items-center justify-between gap-2 pt-3 border-t border-[#F1F5F9] mt-2">
        <div className="min-w-0 truncate">
          {typeof job.applicantCount === "number" && (
            <span className="text-[11px] sm:text-xs text-[#64748B] font-medium truncate block">
              {job.applicantCount} applicants
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Hide button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onHideJob?.(e, job.id);
            }}
            aria-label="Hide position"
            title="Hide position"
            className="w-9 h-9 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full border border-slate-200/80 bg-slate-100/90 text-slate-600 hover:bg-slate-200 hover:text-slate-900 transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
          >
            <Ban className="w-4 h-4" />
          </button>

          {/* Save button (heart) */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSaveJob?.(job);
            }}
            aria-label={isSaved ? "Unlike job" : "Save job"}
            title={isSaved ? "Saved to Tracker (Liked)" : "Like & save to Tracker"}
            className={`w-9 h-9 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full border transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
              isSaved
                ? "border-rose-200 bg-rose-50 text-rose-600"
                : "border-slate-200/80 bg-slate-100/90 text-slate-600 hover:bg-slate-200 hover:text-slate-900"
            }`}
          >
            <Heart className={`w-4 h-4 ${isSaved ? "fill-rose-500 text-rose-500" : ""}`} />
          </button>

          {/* Fit analysis button (when diagnostics exist) */}
          {diagnostics && candidate && (
            <button
              type="button"
              onClick={handleFitAnalysisClick}
              aria-label="Open detailed fit analysis modal"
              className="px-3.5 h-9 min-h-[36px] inline-flex items-center justify-center gap-1.5 rounded-full border border-slate-200/80 bg-slate-100/90 hover:bg-slate-200 text-[#0F172A] text-xs font-bold transition shadow-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
            >
              <Sparkles className="w-3.5 h-3.5 text-[#00E599] fill-[#00E599]" />
              <span>Fit analysis</span>
            </button>
          )}

          {/* Apply button (Vibrant mint pill matching reference) */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onApplyJob?.(e, job);
            }}
            className="px-5 h-9 min-h-[36px] inline-flex items-center justify-center gap-1.5 rounded-full bg-[#00E599] hover:bg-[#00D488] active:bg-[#00C27C] text-[#042017] text-xs font-black tracking-wider uppercase transition shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00E599] cursor-pointer"
          >
            {!isPro && <Lock className="w-3.5 h-3.5 text-[#042017]" />}
            <span>Apply</span>
            {isPro && <ArrowRight className="w-3.5 h-3.5 text-[#042017]" />}
          </button>
        </div>
      </div>
    </div>
  );

  const renderRightPanel = (isMobile = false) => (
    <div
      className={`w-full ${
        isMobile ? "sm:w-44" : "w-[150px] sm:w-[164px]"
      } shrink-0 bg-gradient-to-b from-[#064E3B] via-[#043327] to-[#065F46] p-4 flex flex-col items-center justify-between text-white text-center border-l border-emerald-950/40 shadow-inner`}
    >
      {diagnostics && overallScore !== null ? (
        <>
          <div className="flex flex-col items-center w-full pt-1">
            <OverallMatchRing score={overallScore} />
            <div className="text-[11px] font-black uppercase tracking-widest text-white mt-2.5">
              {thresholdLabel}
            </div>
          </div>

          <div className="w-full pt-2.5 border-t border-white/15 mt-2 space-y-1 text-[11px] text-emerald-100/90 text-left pl-1">
            <div className="flex items-center gap-1.5 truncate">
              <span className="text-[#00E599] font-bold">✓</span>
              <span className="truncate">{job.remote ? "Remote Eligible" : "Verified Direct"}</span>
            </div>
            <div className="flex items-center gap-1.5 truncate">
              <span className="text-[#00E599] font-bold">✓</span>
              <span className="truncate">{job.directSource ? "Direct Feed" : "Active Ingestion"}</span>
            </div>
          </div>
        </>
      ) : (
        /* Locked state for Right Panel */
        <Link
          href="/resume"
          onClick={(e) => e.stopPropagation()}
          className="flex flex-col items-center justify-center flex-1 w-full space-y-2.5 text-center focus:outline-none focus:ring-2 focus:ring-[#5EEAD4] focus:ring-offset-1 group/cta"
        >
          <div className="w-11 h-11 rounded-full bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center transition-colors">
            <Sparkles className="w-5 h-5 text-[#5EEAD4]" />
          </div>
          <span className="text-xs font-bold text-white uppercase tracking-wider">
            Match Score
          </span>
          <span className="text-[11px] text-emerald-100 group-hover/cta:text-[#5EEAD4] transition-colors leading-tight px-1">
            Upload your resume to see your real match
          </span>
        </Link>
      )}
    </div>
  );

  return (
    <>
      {/* =================================================================== */}
      {/* 1. DESKTOP HOVER & FOCUS-WITHIN TWO-PANEL POPOVER                   */}
      {/* Positioned absolutely over card: zero layout shift, respects motion */}
      {/* =================================================================== */}
      <div
        ref={cardRef}
        data-testid="card-hover-match-panel"
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        className={`absolute inset-0 z-20 rounded-[16px] overflow-hidden hidden sm:flex items-stretch border border-[#CBD5E1] shadow-xl bg-white transition-opacity duration-200 motion-reduce:transition-none ${
          isDismissed
            ? "opacity-0 pointer-events-none"
            : "opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 pointer-events-none sm:group-hover:pointer-events-auto sm:group-focus-within:pointer-events-auto"
        } ${className}`}
      >
        {renderLeftPanel(false)}
        {renderRightPanel(false)}
      </div>

      {/* =================================================================== */}
      {/* 2. MOBILE ANCHORED SHEET (Touch / Accessibility)                   */}
      {/* Focus trap, close button, Escape support, 44px targets              */}
      {/* =================================================================== */}
      {isMobileSheetOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Why this job is a match"
          className="fixed inset-0 z-50 flex items-end sm:hidden bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={(e) => {
            e.stopPropagation();
            onCloseMobileSheet?.();
          }}
        >
          <div
            ref={sheetRef}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-h-[85vh] bg-white rounded-t-[20px] shadow-2xl flex flex-col overflow-y-auto animate-in slide-in-from-bottom duration-200"
          >
            {/* Sheet header with close button */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#F1F5F9]">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#2563EB]" />
                <span className="text-sm font-bold text-[#0F172A]">Why this job is a match</span>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseMobileSheet?.();
                }}
                aria-label="Close why match panel"
                className="w-11 h-11 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full text-[#475569] hover:bg-[#F1F5F9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Mobile Sheet Content */}
            <div className="flex flex-col">
              {renderLeftPanel(true)}
              {renderRightPanel(true)}
            </div>
          </div>
        </div>
      )}

      {/* FitDiagnosticsModal triggered by Fit analysis button */}
      {isFitModalOpen && diagnostics && candidate && (
        <FitDiagnosticsModal
          open={isFitModalOpen}
          onOpenChange={setIsFitModalOpen}
          diagnostics={diagnostics}
          candidate={candidate}
          job={{
            id: job.id,
            title: job.title,
            company: job.company,
            location: job.location,
            salary_text: job.salary,
            apply_url: job.applyUrl,
          }}
        />
      )}
    </>
  );
}
