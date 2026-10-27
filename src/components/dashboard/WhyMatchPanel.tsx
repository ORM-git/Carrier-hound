"use client";

import React, { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Sparkles, Ban, Heart, ArrowRight, Lock, RefreshCw, AlertCircle } from "lucide-react";
import { LiveJob } from "@/lib/jobs/service";
import { CandidateProfile } from "@/lib/resume/types";
import { computeFitDiagnostics, FitDiagnosticsResult } from "@/lib/matcher/scoring";
import { stripHtmlAndExecutableMarkup } from "@/lib/security/xss";
import { generateJobFitExplanation } from "@/lib/ai/groq";

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
 * Computes a deterministic hash of confirmed resume facts for localStorage caching.
 */
export function getCandidateResumeHash(candidate: CandidateProfile | null): string {
  if (!candidate) return "anon";
  const parts = [
    candidate.confirmedAt || "",
    candidate.headline || "",
    (candidate.skills || []).slice().sort().join(","),
    (candidate.experience || []).map((e) => `${e.company}:${e.role}`).join(","),
  ].join("::");

  let hash = 0;
  for (let i = 0; i < parts.length; i++) {
    hash = (hash << 5) - hash + parts.charCodeAt(i);
    hash |= 0;
  }
  return String(Math.abs(hash));
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
 * Preserves Prompt 5 token specifications: #2563EB stroke, #E2E8F0 track, 12px label.
 */
export function SmallComponentRing({
  score,
  label,
  subLabel,
  size = 40,
  strokeWidth = 3.5,
  color = "#2563EB",
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
 * Overall match circular progress ring for the right dark green panel.
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

export interface WhyMatchPanelProps {
  job: LiveJob;
  candidate: CandidateProfile | null;
  isPro?: boolean;
  userId?: string | null;
  isSaved?: boolean;
  onToggleSave?: (job: LiveJob) => void;
  onHideJob?: (jobId: string) => void;
  onOpenFitAnalysis?: (job: LiveJob, diagnostics: FitDiagnosticsResult) => void;
  className?: string;
}

export default function WhyMatchPanel({
  job,
  candidate,
  isPro = false,
  userId = null,
  isSaved = false,
  onToggleSave,
  onHideJob,
  onOpenFitAnalysis,
  className = "",
}: WhyMatchPanelProps) {
  const [isFitModalOpen, setIsFitModalOpen] = useState(false);

  // AI explanation state
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiGaps, setAiGaps] = useState<string[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);
  const [isAiGenerated, setIsAiGenerated] = useState(false);
  const [lastRegenTime, setLastRegenTime] = useState<number | null>(null);
  const [isRegenRateLimited, setIsRegenRateLimited] = useState(false);

  useEffect(() => {
    if (!lastRegenTime) return;
    setIsRegenRateLimited(true);
    const timer = setTimeout(() => {
      setIsRegenRateLimited(false);
    }, 5000);
    return () => clearTimeout(timer);
  }, [lastRegenTime]);

  // Lazy computation of fit diagnostics memoized by job and candidate
  const diagnostics = useMemo(
    () => computePopoverDiagnostics(job, candidate),
    [job, candidate]
  );

  const deterministicSummary = useMemo(
    () => extractJobSummary(job.description),
    [job.description]
  );

  const subScores = useMemo(() => computeSubScores(diagnostics), [diagnostics]);

  const overallScore = diagnostics
    ? Math.max(10, Math.min(99, Math.round(diagnostics.score)))
    : null;

  const thresholdLabel = overallScore !== null ? getMatchThresholdLabel(overallScore) : null;

  const matchedSkillsLine =
    diagnostics?.matchedSkills && diagnostics.matchedSkills.length > 0
      ? `Matches ${diagnostics.matchedSkills.length} of your skills (${diagnostics.matchedSkills.slice(0, 3).join(", ")}${diagnostics.matchedSkills.length > 3 ? ", ..." : ""})`
      : null;

  // Build storage cache key
  const resumeHash = useMemo(() => getCandidateResumeHash(candidate), [candidate]);
  const cacheKey = useMemo(() => {
    return `cm_job_fit_${userId || "anon"}_${job.id}_${resumeHash}`;
  }, [userId, job.id, resumeHash]);

  const handleExplainWithAi = async (bypassCache = false) => {
    if (!candidate || !candidate.confirmedAt || !isPro) return;

    // Rate-limit regenerate calls: 5-second cooldown
    const now = Date.now();
    if (bypassCache && lastRegenTime && now - lastRegenTime < 5000) {
      return;
    }

    setAiError(null);

    // Check localStorage cache first unless bypass requested
    if (!bypassCache && typeof window !== "undefined") {
      try {
        const cachedStr = localStorage.getItem(cacheKey);
        if (cachedStr) {
          const cached = JSON.parse(cachedStr);
          if (cached && typeof cached.summary === "string" && cached.summary.trim()) {
            setAiSummary(cached.summary.trim());
            setAiGaps(Array.isArray(cached.missingSkills) ? cached.missingSkills : []);
            setIsAiGenerated(true);
            return;
          }
        }
      } catch {}
    }

    setAiLoading(true);
    try {
      const res = await generateJobFitExplanation(candidate, {
        title: job.title,
        company: job.company,
        description: job.description,
      });

      if (res.success && res.summary) {
        setAiSummary(res.summary);
        setAiGaps(res.missingSkills || []);
        setIsAiGenerated(true);
        setLastRegenTime(Date.now());

        // Cache in localStorage
        if (typeof window !== "undefined") {
          try {
            localStorage.setItem(
              cacheKey,
              JSON.stringify({
                summary: res.summary,
                missingSkills: res.missingSkills || [],
                cachedAt: Date.now(),
              })
            );
          } catch {}
        }
      } else {
        setAiSummary(null);
        setAiGaps([]);
        setAiError(res.error || "AI match explanation temporarily unavailable.");
        setIsAiGenerated(false);
      }
    } catch (err: any) {
      setAiSummary(null);
      setAiGaps([]);
      setAiError(err?.message || "Failed to generate AI match explanation.");
      setIsAiGenerated(false);
    } finally {
      setAiLoading(false);
    }
  };

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

  return (
    <div
      data-testid={`why-match-panel-${job.id}`}
      className={`w-full rounded-2xl overflow-hidden border border-slate-200 shadow-sm bg-white flex flex-col md:flex-row items-stretch transition-all ${className}`}
    >
      {/* =================================================================== */}
      {/* LEFT PANEL: White Card with Title, Summary, Rings, and Action Row   */}
      {/* =================================================================== */}
      <div className="flex-1 bg-white p-4 sm:p-5 flex flex-col justify-between min-w-0 space-y-4">
        <div className="space-y-3">
          {/* Header Row: Sparkle Icon + Title + AI Action Button */}
          <div className="flex flex-wrap items-center justify-between gap-2 w-full">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center shrink-0">
                <Sparkles className="w-4 h-4 text-[#2563EB]" />
              </div>
              <h3 className="text-[14px] font-bold text-[#0F172A] leading-snug">
                Why this job is a match
              </h3>
            </div>

            {/* AI Action Button (Pro + Confirmed Resume ONLY) */}
            {isPro && candidate?.confirmedAt && (
              <div className="flex items-center gap-2">
                {isAiGenerated ? (
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-purple-50 text-purple-700 border border-purple-200">
                      <Sparkles className="w-3 h-3 text-purple-600" />
                      AI-generated
                    </span>
                    <button
                      type="button"
                      onClick={() => handleExplainWithAi(true)}
                      disabled={aiLoading || isRegenRateLimited}
                      data-testid="regenerate-ai-button"
                      title={isRegenRateLimited ? "Please wait a moment before regenerating" : "Regenerate AI explanation"}
                      className="inline-flex items-center gap-1 px-2.5 py-1 min-h-[36px] rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 border border-slate-200 transition disabled:opacity-50 cursor-pointer"
                    >
                      <RefreshCw className={`w-3 h-3 ${aiLoading ? "animate-spin text-purple-600" : ""}`} />
                      <span>Regenerate</span>
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleExplainWithAi(false)}
                    disabled={aiLoading}
                    data-testid="explain-with-ai-button"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded-xl text-xs font-bold text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 transition shadow-2xs disabled:opacity-60 cursor-pointer"
                  >
                    <Sparkles className={`w-3.5 h-3.5 text-purple-600 ${aiLoading ? "animate-spin" : ""}`} />
                    <span>{aiLoading ? "Analyzing match..." : "Explain with AI"}</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Error Message with Fallback Notice */}
          {aiError && (
            <div
              data-testid="ai-error-fallback-message"
              className="flex items-center gap-2 p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs font-medium"
            >
              <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>{aiError} Showing verified match summary below.</span>
            </div>
          )}

          {/* Summary Section: AI-generated OR Deterministic Fallback */}
          {diagnostics ? (
            <>
              {isAiGenerated && aiSummary ? (
                /* AI Match Explanation (Summary + Gaps only; NEVER shows AI score) */
                <div className="space-y-2">
                  <p
                    data-testid="ai-match-summary"
                    className="text-[13px] text-[#334155] leading-relaxed"
                  >
                    {aiSummary}
                  </p>

                  {/* Missing Skills / Gaps to Address */}
                  {Array.isArray(aiGaps) && aiGaps.length > 0 && (
                    <div
                      data-testid="ai-match-gaps"
                      className="flex flex-wrap items-center gap-1.5 pt-0.5"
                    >
                      <span className="text-[11.5px] font-semibold text-slate-500 mr-1">
                        Gaps to address:
                      </span>
                      {aiGaps.map((gap) => (
                        <span
                          key={gap}
                          className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-amber-50 text-amber-900 border border-amber-200"
                        >
                          {gap}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                /* Deterministic Per-Job Summary: ONLY from job's own description. Omitted if empty */
                summarySection(deterministicSummary)
              )}

              {/* Factual Matched Skills Line (rendered only when real skills match) */}
              {matchedSkillsLine && (
                <p
                  data-testid="matched-skills-line"
                  className="text-[11.5px] text-[#2563EB] font-medium leading-snug truncate flex items-center gap-1.5 pt-0.5"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-[#2563EB] shrink-0" />
                  <span>{matchedSkillsLine}</span>
                </p>
              )}

              {/* Real Sub-Score Circular Progress Rings (up to 3: Experience, Skill, Role) */}
              {/* NO Education ring! Rings omitted when not computable. */}
              <div
                className="flex items-center gap-4 sm:gap-6 pt-1 flex-wrap"
                data-testid="match-component-rings"
              >
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

        {/* Footer Row: Applicant text (real numbers only) + Actions (Hide, Save, Fit Analysis, Apply) */}
        <div className="flex items-center justify-between gap-2 pt-3 border-t border-[#F1F5F9]">
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
                onHideJob?.(job.id);
              }}
              aria-label="Hide position"
              title="Hide position"
              className="w-9 h-9 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
            >
              <Ban className="w-4 h-4" />
            </button>

            {/* Save button (heart) */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleSave?.(job);
              }}
              aria-label={isSaved ? "Unlike job" : "Save job"}
              title={isSaved ? "Saved to Tracker (Liked)" : "Like & save to Tracker"}
              className={`w-9 h-9 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full border transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                isSaved
                  ? "border-rose-200 bg-rose-50 text-rose-600"
                  : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
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
                className="px-3.5 h-9 min-h-[36px] inline-flex items-center justify-center gap-1.5 rounded-full border border-blue-200 bg-blue-50/90 hover:bg-blue-100 text-[#2563EB] text-xs font-bold transition shadow-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
              >
                <Sparkles className="w-3.5 h-3.5 text-[#2563EB] fill-[#2563EB]" />
                <span>Fit analysis</span>
              </button>
            )}

            {/* Apply button (CareerMonke signature blue brand pill) */}
            <Link
              href={job.applyUrl || `/job-detail?id=${encodeURIComponent(job.id)}`}
              target={job.applyUrl ? "_blank" : undefined}
              rel={job.applyUrl ? "noopener noreferrer" : undefined}
              onClick={(e) => e.stopPropagation()}
              className="px-5 h-9 min-h-[36px] inline-flex items-center justify-center gap-1.5 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold tracking-wide transition shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] cursor-pointer"
            >
              {!isPro && <Lock className="w-3.5 h-3.5 text-white" />}
              <span>Apply</span>
              {isPro && <ArrowRight className="w-3.5 h-3.5 text-white" />}
            </Link>
          </div>
        </div>
      </div>

      {/* =================================================================== */}
      {/* RIGHT PANEL: Scoped Dark Green Gradient with Big Overall Ring        */}
      {/* Gradient: #064E3B to #065F46, Mint ring: #34D399, Accent: #5EEAD4   */}
      {/* =================================================================== */}
      <div className="w-full md:w-[170px] lg:w-[185px] shrink-0 bg-gradient-to-b from-[#064E3B] via-[#043327] to-[#065F46] p-4 sm:p-5 flex flex-col items-center justify-between text-white text-center border-t md:border-t-0 md:border-l border-emerald-950/40 shadow-inner">
        {diagnostics && overallScore !== null ? (
          <>
            <div className="flex flex-col items-center w-full pt-1">
              <OverallMatchRing score={overallScore} />
              <div className="text-[11px] font-black uppercase tracking-widest text-white mt-2.5">
                {thresholdLabel}
              </div>
            </div>

            <div className="w-full pt-2.5 border-t border-white/15 mt-3 space-y-1 text-[11px] text-emerald-100/90 text-left pl-1">
              <div className="flex items-center gap-1.5 truncate">
                <span className="text-[#34D399] font-bold">✓</span>
                <span className="truncate">{job.remote ? "Remote Eligible" : "Verified Direct"}</span>
              </div>
              <div className="flex items-center gap-1.5 truncate">
                <span className="text-[#34D399] font-bold">✓</span>
                <span className="truncate">{job.directSource ? "Direct Feed" : "Active Ingestion"}</span>
              </div>
            </div>
          </>
        ) : (
          /* Locked state for Right Panel */
          <Link
            href="/resume"
            onClick={(e) => e.stopPropagation()}
            className="flex flex-col items-center justify-center flex-1 w-full space-y-2.5 text-center focus:outline-none focus:ring-2 focus:ring-[#5EEAD4] focus:ring-offset-1 group/cta py-4"
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
    </div>
  );
}

function summarySection(summaryText: string | null) {
  if (!summaryText) return null;
  return (
    <p
      data-testid="deterministic-job-summary"
      className="text-[13px] text-[#334155] leading-relaxed line-clamp-2"
      title={summaryText}
    >
      {summaryText}
    </p>
  );
}
