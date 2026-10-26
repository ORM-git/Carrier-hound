"use client";

import React, { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { LiveJob } from "@/lib/jobs/service";
import { CandidateProfile } from "@/lib/resume/types";
import { computeFitDiagnostics, FitDiagnosticsResult } from "@/lib/matcher/scoring";
import { stripHtmlAndExecutableMarkup } from "@/lib/security/xss";
import { getSiteUrl } from "@/lib/siteUrl";
import CompanyLogo from "@/components/CompanyLogo";
import { useCookieNoticeHeight } from "@/components/CookieNotice";
import type { User } from "@supabase/supabase-js";
import {
  ArrowLeft,
  FileText,
  Heart,
  ExternalLink,
  Lock,
  Sparkles,
  ArrowRight,
  Check,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  Briefcase,
  DollarSign,
  MapPin,
  Share2,
  Flag,
  X,
  RotateCw,
} from "lucide-react";

const TailorResumeModal = dynamic(() => import("@/components/resume/TailorResumeModal"), { ssr: false });

interface JobDetailViewProps {
  job: LiveJob;
  candidate: CandidateProfile | null;
  user: User | null;
  isPro: boolean;
  isSaved: boolean;
  isApplied?: boolean;
  trackedStage?: "saved" | "applied" | "interview" | "offer" | "rejected" | null;
  isUpdatingApplied?: boolean;
  onSave: () => void;
  onApply: (e?: React.MouseEvent) => void;
  onToggleApplied?: () => void;
  onBack: () => void;
  onRetryUnlock?: () => void;
  isRetryingUnlock?: boolean;
  similarJobs?: LiveJob[];
  onSelectJob?: (job: LiveJob) => void;
}

function formatRelativeTime(dateStr?: string): string {
  if (!dateStr) return "Recently posted";
  try {
    const s = dateStr.trim().toLowerCase();
    if (s === "today") return "Today";
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (isNaN(diffMs)) return dateStr;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours < 1) return "Just now";
    if (diffHours < 24) return `${diffHours} hours ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "1 day ago";
    if (diffDays < 30) return `${diffDays} days ago`;
    return "Recently posted";
  } catch {
    return "Recently posted";
  }
}

function getMatchPanelGradient(score: number): string {
  if (score >= 80) return "bg-gradient-to-br from-[#1E3A8A] to-[#2563EB]";
  if (score >= 50) return "bg-gradient-to-br from-[#0F172A] to-[#1E3A8A]";
  return "bg-gradient-to-br from-[#0F172A] to-[#334155]";
}

function CircularDetailMatchRing({
  score,
  size = 64,
  strokeWidth = 5,
  isPro = true,
}: {
  score: number;
  size?: number;
  strokeWidth?: number;
  isPro?: boolean;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  return (
    <div
      className="relative inline-flex items-center justify-center shrink-0"
      style={{ width: size, height: size }}
    >
      <svg className="w-full h-full -rotate-90" viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="rgba(255, 255, 255, 0.12)"
          strokeWidth={strokeWidth}
          fill="transparent"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="#FFFFFF"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={isPro ? offset : circumference * 0.25}
          strokeLinecap="round"
          fill="transparent"
          className="transition-all duration-300 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {isPro ? (
          <span className="text-base font-black text-white leading-none">
            {score}%
          </span>
        ) : (
          <div className="flex flex-col items-center">
            <Lock className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-[10px] font-bold text-slate-400 select-none filter blur-[3px]">
              85%
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export const VERIFIED_SUPPORT_EMAIL = "support@careermonke.com";

/**
 * Pure helper to construct the canonical job URL without private/session parameters.
 */
export function getCanonicalJobUrl(jobId: string): string {
  const base =
    typeof window !== "undefined" && window.location.origin && window.location.origin !== "null"
      ? window.location.origin
      : getSiteUrl();
  return `${base}/jobs?id=${encodeURIComponent(jobId)}`;
}

/**
 * Reuses verified support destination with job context and zero candidate data.
 */
export function getReportJobMailto(job: { id: string; title: string; company?: string }): string {
  const canonicalUrl = getCanonicalJobUrl(job.id);
  const subject = encodeURIComponent(`[Job Issue] ${job.title} (${job.id})`);
  const body = encodeURIComponent(
    `Job ID: ${job.id}\nJob Title: ${job.title}\nCompany: ${job.company || "N/A"}\nURL: ${canonicalUrl}\n\nPlease describe the issue with this job posting:`
  );
  return `mailto:${VERIFIED_SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
}

export default function JobDetailView({
  job,
  candidate,
  user,
  isPro,
  isSaved,
  isApplied = false,
  trackedStage = null,
  isUpdatingApplied = false,
  onSave,
  onApply,
  onToggleApplied,
  onBack,
  onRetryUnlock,
  isRetryingUnlock = false,
  similarJobs,
  onSelectJob,
}: JobDetailViewProps) {
  const isUnlocked = isPro && !job.proUnlockError;
  const hasConfirmedResume = Boolean(candidate && candidate.confirmedAt);
  const cookieNoticeHeight = useCookieNoticeHeight();

  const [isTailorOpen, setIsTailorOpen] = useState(false);
  const [shareStatus, setShareStatus] = useState<"idle" | "success" | "error">("idle");
  const [shareErrorMsg, setShareErrorMsg] = useState<string>("");

  const handleShare = async () => {
    const canonicalUrl = getCanonicalJobUrl(job.id);
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
        throw new Error("Clipboard API unavailable in this browser context");
      }
      await navigator.clipboard.writeText(canonicalUrl);
      setShareStatus("success");
      setShareErrorMsg("");
      setTimeout(() => {
        setShareStatus((cur) => (cur === "success" ? "idle" : cur));
      }, 2500);
    } catch (err: any) {
      setShareStatus("error");
      setShareErrorMsg(err?.message || "Failed to copy link to clipboard");
    }
  };

  const diagnostics: FitDiagnosticsResult | null = useMemo(() => {
    if (!hasConfirmedResume || !candidate) return null;
    try {
      return computeFitDiagnostics(candidate, {
        id: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        remote: job.remote,
        remote_scope: job.remoteScope || (job.remote ? "worldwide" : undefined),
        category: job.category,
        skills: job.skills,
        description: job.description,
        salary_text: job.salary,
        apply_url: job.applyUrl,
      });
    } catch {
      return null;
    }
  }, [hasConfirmedResume, candidate, job]);

  const matchScore = diagnostics ? Math.max(10, Math.min(99, Math.round(diagnostics.score))) : null;

  // Extract requirements if present in data
  const requirementsList: string[] = useMemo(() => {
    const raw = (job as any).requirements;
    if (Array.isArray(raw)) {
      return raw.map((r) => String(r).trim()).filter(Boolean);
    }
    if (typeof raw === "string" && raw.trim()) {
      return raw.split("\n").map((r) => r.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
    }
    return [];
  }, [job]);

  // Extract benefits if present in data
  const benefitsList: string[] = useMemo(() => {
    const raw = (job as any).benefits;
    if (Array.isArray(raw)) {
      return raw.map((b) => String(b).trim()).filter(Boolean);
    }
    if (typeof raw === "string" && raw.trim()) {
      return raw.split("\n").map((b) => b.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
    }
    return [];
  }, [job]);

  const hasZeroSkillMatches = Boolean(diagnostics && diagnostics.matchedSkills.length === 0);
  const hasJobSkills = Boolean(diagnostics && diagnostics.jobRequiredSkills && diagnostics.jobRequiredSkills.length > 0);

  const matchLabel =
    matchScore !== null
      ? hasZeroSkillMatches
        ? hasJobSkills
          ? "Experience match (0 skill matches)"
          : "Preliminary Match (Skills unlisted)"
        : matchScore > 70
        ? "Great match"
        : matchScore >= 50
        ? "Good match"
        : "Fair match"
      : "";

  const matchExplanation =
    diagnostics
      ? hasZeroSkillMatches
        ? hasJobSkills
          ? "Score reflects candidate title and experience overlap; no required skills matched."
          : "Score estimated from title and experience alignment; posting does not list required skills."
        : (diagnostics.whyYouFit && diagnostics.whyYouFit[0]) || "Calculated from your confirmed resume against verified job requirements."
      : "";

  return (
    <div
      style={{ paddingBottom: `calc(${cookieNoticeHeight}px + 7rem)` }}
      className="max-w-[880px] w-full mx-auto space-y-4 md:pb-12"
    >
      {/* Clipboard Fallback Alert when copy fails */}
      {shareStatus === "error" && (
        <div
          data-testid="share-fallback-container"
          role="alert"
          className="bg-[#FEF2F2] border border-[#FECACA] rounded-[12px] p-3.5 text-xs text-[#991B1B] space-y-2 animate-fadeIn"
        >
          <div className="flex items-center justify-between">
            <span className="font-semibold flex items-center gap-1.5 text-[#B91C1C]">
              <AlertCircle className="w-4 h-4" />
              Unable to copy link automatically
            </span>
            <button
              type="button"
              onClick={() => setShareStatus("idle")}
              aria-label="Dismiss error"
              className="text-[#991B1B] hover:text-[#7F1D1D] p-1 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="text-[11px] text-[#B91C1C]">
            Select and copy this link manually:
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              data-testid="share-fallback-input"
              value={getCanonicalJobUrl(job.id)}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 bg-white border border-[#FCA5A5] rounded-lg px-2.5 py-1.5 text-xs text-[#0F172A] select-all focus:outline-none focus:ring-1 focus:ring-[#EF4444]"
            />
          </div>
        </div>
      )}

      {/* 1. Sticky Header Block Card */}
      <div
        role="region"
        aria-label="Job header"
        className="sticky top-14 z-20 bg-white/95 backdrop-blur-md rounded-[16px] ring-1 ring-[#E2E8F0] p-4 sm:p-5 shadow-sm space-y-3.5"
      >
        {/* Top utility row: Back button & actions */}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to jobs list"
            className="inline-flex items-center gap-2 text-sm font-semibold text-[#475569] hover:text-[#0F172A] transition-colors py-1.5 px-2.5 min-h-[44px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] rounded-lg bg-slate-50 border border-slate-200 hover:bg-slate-100"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back</span>
          </button>

          <div className="flex items-center gap-2">
            <a
              href={getReportJobMailto(job)}
              data-testid="report-issue-link"
              aria-label="Report an issue with this job posting"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[#475569] hover:text-[#2563EB] transition-colors py-2 px-2.5 rounded-lg hover:bg-slate-100 min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
            >
              <Flag className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Report issue</span>
            </a>

            <button
              type="button"
              onClick={handleShare}
              data-testid="share-job-button"
              aria-label={shareStatus === "success" ? "Link copied" : "Share job"}
              className={`min-h-[44px] px-3.5 flex items-center gap-1.5 rounded-full border transition cursor-pointer text-xs font-semibold ${
                shareStatus === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-[#E2E8F0] bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0] hover:text-[#0F172A]"
              }`}
            >
              {shareStatus === "success" ? (
                <>
                  <Check className="w-4 h-4 text-emerald-600" />
                  <span data-testid="link-copied-text">Link copied</span>
                </>
              ) : (
                <>
                  <Share2 className="w-4 h-4 text-[#475569]" />
                  <span>Share</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={onSave}
              aria-label={isSaved ? "Unlike job" : "Save job"}
              className={`w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border transition cursor-pointer ${
                isSaved
                  ? "border-rose-200 bg-rose-50 text-rose-600"
                  : "border-[#E2E8F0] bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0] hover:text-[#0F172A]"
              }`}
            >
              <Heart className={`w-4 h-4 ${isSaved ? "fill-rose-500 text-rose-500" : ""}`} />
            </button>
          </div>
        </div>

        {/* Title, Company and Primary Actions */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-1">
          <div className="flex items-start gap-3.5 min-w-0 flex-1">
            <CompanyLogo
              company={job.company}
              applyUrl={job.applyUrl}
              className="w-12 h-12 rounded-xl shrink-0 object-contain p-1 border border-[#E2E8F0] bg-white"
            />
            <div className="space-y-1 min-w-0 flex-1">
              <h1 className="text-[24px] font-bold text-[#0F172A] leading-tight break-words">
                {job.title}
              </h1>
              <div className="text-[14px] text-[#475569] flex items-center flex-wrap gap-1.5">
                <span className={!isUnlocked ? "filter blur-[4.5px] select-none" : ""}>
                  {job.company || "Verified Employer"}
                </span>
                {job.category && (
                  <span className="capitalize"> · {job.category}</span>
                )}
              </div>
            </div>
          </div>

          {/* Action buttons (Desktop header) */}
          <div className="hidden sm:flex items-center gap-2.5 shrink-0">
            {isUnlocked && onToggleApplied && (
              <button
                type="button"
                onClick={onToggleApplied}
                disabled={isUpdatingApplied}
                aria-label={
                  trackedStage === "interview"
                    ? "In interview stage"
                    : trackedStage === "offer"
                    ? "In offer stage"
                    : trackedStage === "rejected"
                    ? "In rejected stage"
                    : trackedStage === "applied" || isApplied
                    ? "Marked as applied"
                    : "Mark as applied"
                }
                className={`inline-flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-full text-xs font-bold transition cursor-pointer border focus:outline-none focus:ring-2 focus:ring-[#93C5FD] ${
                  isUpdatingApplied
                    ? "opacity-60 cursor-not-allowed bg-slate-100 text-slate-400 border-slate-200"
                    : trackedStage === "interview" || trackedStage === "offer"
                    ? "bg-purple-50 text-purple-700 border-purple-300"
                    : trackedStage === "rejected"
                    ? "bg-rose-50 text-rose-700 border-rose-300"
                    : trackedStage === "applied" || isApplied
                    ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                    : "bg-white text-[#475569] hover:text-[#0F172A] hover:bg-slate-50 border-[#E2E8F0]"
                }`}
              >
                {trackedStage === "interview" || trackedStage === "offer" ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-purple-600" />
                ) : trackedStage === "rejected" ? (
                  <XCircle className="w-3.5 h-3.5 text-rose-600" />
                ) : trackedStage === "applied" || isApplied ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                ) : (
                  <Clock className="w-3.5 h-3.5 text-[#475569]" />
                )}
                <span>
                  {trackedStage === "interview"
                    ? "Interview"
                    : trackedStage === "offer"
                    ? "Offer"
                    : trackedStage === "rejected"
                    ? "Rejected"
                    : trackedStage === "applied" || isApplied
                    ? "Applied ✓"
                    : "Mark Applied"}
                </span>
              </button>
            )}

            {hasConfirmedResume && (
              <button
                type="button"
                onClick={() => {
                  if (!isUnlocked) {
                    onApply();
                  } else {
                    setIsTailorOpen(true);
                  }
                }}
                aria-label="Tailor resume with AI"
                className="inline-flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-full text-xs font-bold transition cursor-pointer border border-blue-200 bg-blue-50 hover:bg-blue-100 text-[#1D4ED8] focus:outline-none focus:ring-2 focus:ring-[#93C5FD]"
              >
                <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                <span>Tailor Resume</span>
              </button>
            )}

            {isUnlocked && job.applyUrl ? (
              <a
                href={job.applyUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onApply}
                className="inline-flex items-center gap-1.5 px-6 py-2.5 min-h-[44px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition shadow-none focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 cursor-pointer"
              >
                <span>Apply</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            ) : (
              <button
                type="button"
                onClick={onApply}
                className="inline-flex items-center gap-1.5 px-6 py-2.5 min-h-[44px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition shadow-none focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 cursor-pointer"
              >
                {!isUnlocked && <Lock className="w-3.5 h-3.5" />}
                <span>Apply</span>
              </button>
            )}
          </div>
        </div>

        {/* Gray Chips Row */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#E2E8F0] max-w-full min-w-0">
          <span className="inline-flex items-start gap-1.5 text-[12px] font-medium px-2.5 py-1 rounded-2xl bg-[#F1F5F9] text-[#475569] max-w-full">
            <MapPin className="w-3.5 h-3.5 text-[#475569] shrink-0 mt-0.5" />
            <span className="break-words whitespace-normal leading-relaxed">
              {isUnlocked ? (job.location || "Remote") : <span className="filter blur-[3.5px] select-none">Location Locked</span>}
            </span>
          </span>

          <span className="inline-flex items-center gap-1 text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
            <Briefcase className="w-3 h-3 text-[#475569]" />
            <span>{job.type || "Full-time"}</span>
          </span>

          {job.salary ? (
            <span className="inline-flex items-center gap-1 text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
              <DollarSign className="w-3 h-3 text-[#166534]" />
              <span>{isUnlocked ? job.salary : "••••••••"}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#64748B]">
              <DollarSign className="w-3 h-3 text-[#94A3B8]" />
              <span>Pay not disclosed</span>
            </span>
          )}

          <span className="inline-flex items-center gap-1 text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
            <Clock className="w-3 h-3 text-[#475569]" />
            <span>{formatRelativeTime(job.postedAt || job.date)}</span>
          </span>
        </div>
      </div>

      {/* 2. Main Two-Column Layout on Desktop, Single Column on Mobile */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left Column: Description, Requirements, Benefits, Notes */}
        <div className="lg:col-span-7 space-y-4 min-w-0">
          {/* Match Breakdown Card */}
          <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 sm:p-6 shadow-none space-y-4">
            <h2 className="text-[18px] font-bold text-[#0F172A]">Match breakdown</h2>

            {hasConfirmedResume && matchScore !== null ? (
              <div className="space-y-4">
                <div className={`flex flex-col sm:flex-row items-center justify-between p-4 rounded-[16px] ${getMatchPanelGradient(matchScore)} text-white gap-4 border border-white/10 shadow-none`}>
                  <div className="flex items-center gap-4">
                    <CircularDetailMatchRing
                      score={matchScore}
                      size={64}
                      strokeWidth={5}
                      isPro={isUnlocked}
                    />
                    <div className="text-left">
                      <div className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-blue-300" />
                        <span>{matchLabel}</span>
                      </div>
                      <div className="text-xs text-slate-300 pt-0.5">
                        {matchExplanation}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Matched & Missing Skills */}
                {diagnostics && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                    <div className="p-3.5 rounded-[12px] bg-[#EFF6FF] border border-[#BFDBFE] space-y-2">
                      <div className="text-xs font-bold text-[#1E3A8A] flex items-center gap-1.5">
                        <Check className="w-3.5 h-3.5 text-[#166534]" />
                        <span>Matched Skills ({diagnostics.matchedSkills.length})</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {diagnostics.matchedSkills.length > 0 ? (
                          diagnostics.matchedSkills.map((s) => (
                            <span
                              key={s}
                              className="text-[12px] font-medium px-2 py-0.5 rounded-full bg-[#DBEAFE] text-[#1E3A8A]"
                            >
                              {s}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-[#475569]">No direct skill matches detected.</span>
                        )}
                      </div>
                    </div>

                    <div className="p-3.5 rounded-[12px] bg-[#FEF3C7] border border-[#FDE68A] space-y-2">
                      <div className="text-xs font-bold text-[#92400E] flex items-center gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 text-[#92400E]" />
                        <span>Skills to Highlight ({diagnostics.missingSkills.length})</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {diagnostics.missingSkills.length > 0 ? (
                          diagnostics.missingSkills.map((s) => (
                            <span
                              key={s}
                              className="text-[12px] font-medium px-2 py-0.5 rounded-full bg-white text-[#92400E] border border-[#FDE68A]"
                            >
                              {s}
                            </span>
                          ))
                        ) : hasJobSkills && diagnostics.missingSkills.length === 0 && diagnostics.matchedSkills.length > 0 ? (
                          <span className="text-xs text-[#166534] font-semibold">Zero critical skill gaps (all required skills matched)!</span>
                        ) : (
                          <span className="text-xs text-[#92400E] font-medium">Skill requirements not explicitly detailed in job posting.</span>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <Link
                href="/resume"
                className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 rounded-[16px] bg-[#F8FAFC] hover:bg-[#EFF6FF] border border-[#E2E8F0] hover:border-[#93C5FD] transition-all duration-200 group/cta focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-[#EFF6FF] group-hover/cta:bg-[#DBEAFE] border border-[#BFDBFE] flex items-center justify-center shrink-0 transition-colors">
                    <Sparkles className="w-5 h-5 text-[#2563EB]" />
                  </div>
                  <div className="space-y-0.5 text-left">
                    <div className="text-sm font-semibold text-[#0F172A] group-hover/cta:text-[#1D4ED8] transition-colors">
                      Upload your resume to see your real match
                    </div>
                    <div className="text-xs text-[#475569]">
                      Confirm your resume facts to unlock full skill breakdown and match analysis.
                    </div>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-full bg-[#2563EB] text-white text-xs font-bold shrink-0 shadow-none">
                  <span>Upload Resume</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </span>
              </Link>
            )}
          </div>

          {/* Job Description Card */}
          <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 sm:p-6 shadow-none space-y-3">
            <h2 className="text-[18px] font-bold text-[#0F172A]">Job description</h2>
            {job.proUnlockError ? (
              <div
                data-testid="pro-unlock-error-banner"
                className="p-4 rounded-[14px] border border-[#E2E8F0] bg-[#F8FAFC] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-left"
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-[#EFF6FF] border border-[#BFDBFE] text-[#2563EB]">
                    <Lock className="w-4 h-4" />
                  </div>
                  <div className="text-sm font-semibold text-[#0F172A]">
                    Details are locked. Retry
                  </div>
                </div>

                {onRetryUnlock && (
                  <button
                    type="button"
                    data-testid="pro-unlock-retry-btn"
                    onClick={onRetryUnlock}
                    disabled={isRetryingUnlock}
                    className="px-3.5 py-1.5 min-h-[36px] rounded-full text-xs font-semibold border border-[#CBD5E1] bg-white hover:bg-[#F1F5F9] text-[#0F172A] transition cursor-pointer flex items-center gap-1.5 shrink-0 self-end sm:self-center"
                  >
                    <RotateCw className={`w-3.5 h-3.5 ${isRetryingUnlock ? "animate-spin" : ""}`} />
                    <span>{isRetryingUnlock ? "Retrying..." : "Retry"}</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="text-[15px] leading-[24px] text-[#0F172A] max-w-[720px] whitespace-pre-wrap break-words">
                {job.description ? (
                  stripHtmlAndExecutableMarkup(job.description)
                ) : (
                  <p className="text-[#475569]">
                    Apply directly on the employer&apos;s site to view the complete posting and application instructions.
                  </p>
                )}
              </div>
            )}

            {/* Footer info: Job ID & Report Issue */}
            <div className="pt-4 border-t border-[#E2E8F0] flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-[#475569]">
              <span>Job ID: <code className="font-mono text-[#0F172A]">{job.id}</code></span>
              <a
                href={getReportJobMailto(job)}
                data-testid="report-issue-detail-link"
                className="inline-flex items-center gap-1.5 text-[#475569] hover:text-[#2563EB] transition-colors min-h-[44px] py-1 cursor-pointer"
              >
                <Flag className="w-3.5 h-3.5" />
                <span>Report issue with this listing</span>
              </a>
            </div>
          </div>

          {/* Requirements Section (only if data exists) */}
          {requirementsList.length > 0 && (
            <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 sm:p-6 shadow-none space-y-3">
              <h2 className="text-[18px] font-bold text-[#0F172A]">Requirements</h2>
              <ul className="space-y-2 max-w-[720px] text-[15px] leading-[24px] text-[#0F172A]">
                {requirementsList.map((req, idx) => (
                  <li key={idx} className="flex items-start gap-2.5">
                    <span className="text-[#2563EB] font-bold select-none">•</span>
                    <span className="flex-1 break-words">{req}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Benefits Section (only if data exists) */}
          {benefitsList.length > 0 && (
            <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 sm:p-6 shadow-none space-y-3">
              <h2 className="text-[18px] font-bold text-[#0F172A]">Benefits</h2>
              <ul className="space-y-2 max-w-[720px] text-[15px] leading-[24px] text-[#0F172A]">
                {benefitsList.map((ben, idx) => (
                  <li key={idx} className="flex items-start gap-2.5">
                    <span className="text-[#166534] font-bold select-none">✓</span>
                    <span className="flex-1 break-words">{ben}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Private Tracker Notes (if tracked application) */}
          {job.trackerNotes && (
            <div
              data-testid="tracker-notes-panel"
              className="bg-[#F8FAFC] rounded-[16px] ring-1 ring-[#E2E8F0] p-5 sm:p-6 shadow-none space-y-2.5"
            >
              <div className="flex items-center gap-2 text-[#0F172A]">
                <FileText className="w-4 h-4 text-[#2563EB]" />
                <h3 className="text-base font-bold">Your notes</h3>
              </div>
              <p className="text-[14px] leading-relaxed text-[#334155] whitespace-pre-wrap break-words">
                {job.trackerNotes}
              </p>
              <span className="inline-block text-[11px] text-[#64748B]">
                Private to your account — never shared with employers or external services.
              </span>
            </div>
          )}
        </div>

        {/* Right Column: Company overview, Salary/Pro info, Similar jobs */}
        <div className="lg:col-span-5 space-y-4 min-w-0">
          {/* Company Card */}
          <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 shadow-none space-y-3.5">
            <div className="flex items-start gap-3.5">
              <CompanyLogo
                company={job.company}
                applyUrl={job.applyUrl}
                className="w-12 h-12 rounded-xl shrink-0 object-contain p-1 border border-[#E2E8F0] bg-white"
              />
              <div className="space-y-1 min-w-0 flex-1">
                <div className="font-bold text-[16px] text-[#0F172A] truncate">
                  <span className={!isUnlocked ? "filter blur-[4.5px] select-none" : ""}>
                    {job.company || "Verified Employer"}
                  </span>
                </div>
                <div className="text-xs text-[#475569]">
                  {job.category && <span className="capitalize">{job.category} · </span>}
                  <span>{job.type || "Full-time"}</span>
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-[#E2E8F0] space-y-2 text-xs text-[#475569]">
              <div className="flex items-start gap-2">
                <MapPin className="w-3.5 h-3.5 text-[#475569] shrink-0 mt-0.5" />
                <span className="break-words">
                  {isUnlocked ? (job.location || "Remote") : <span className="filter blur-[3.5px] select-none">Location Locked</span>}
                </span>
              </div>
            </div>
          </div>

          {/* Salary / Pro Info Card */}
          <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 shadow-none space-y-3">
            <div className="flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-[#166534] shrink-0" />
              <div className="text-sm font-bold text-[#0F172A]">
                {job.salary ? (isUnlocked ? job.salary : "••••••••") : "Pay not disclosed"}
              </div>
            </div>

            {/* Retry button for Pro unlock errors only */}
            {job.proUnlockError && onRetryUnlock && (
              <button
                type="button"
                onClick={onRetryUnlock}
                disabled={isRetryingUnlock}
                className="inline-flex items-center justify-center gap-1.5 w-full px-4 py-2 rounded-full border border-[#CBD5E1] bg-white hover:bg-[#F1F5F9] text-[#0F172A] text-xs font-semibold transition cursor-pointer min-h-[38px]"
              >
                <RotateCw className={`w-3.5 h-3.5 ${isRetryingUnlock ? "animate-spin" : ""}`} />
                <span>{isRetryingUnlock ? "Retrying..." : "Retry"}</span>
              </button>
            )}

            {/* Paywall trigger for free users */}
            {!isPro && (
              <button
                type="button"
                onClick={onApply}
                className="inline-flex items-center justify-center gap-1.5 w-full px-4 py-2 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-bold transition shadow-none cursor-pointer min-h-[38px]"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Apply</span>
              </button>
            )}
          </div>

          {/* Similar Jobs Card */}
          <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 shadow-none space-y-3">
            <h2 className="text-[18px] font-bold text-[#0F172A]">Similar jobs</h2>
            {similarJobs && similarJobs.length > 0 ? (
              <div className="space-y-2.5">
                {similarJobs.slice(0, 3).map((simJob) => (
                  <button
                    key={simJob.id}
                    type="button"
                    onClick={() => onSelectJob && onSelectJob(simJob)}
                    className="w-full text-left p-3 rounded-xl border border-[#E2E8F0] hover:border-[#93C5FD] hover:bg-[#EFF6FF] transition flex items-start gap-3 cursor-pointer group"
                  >
                    <CompanyLogo
                      company={simJob.company}
                      applyUrl={simJob.applyUrl}
                      className="w-9 h-9 rounded-lg shrink-0 object-contain p-1 border border-[#E2E8F0] bg-white"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-[#0F172A] group-hover:text-[#1D4ED8] truncate">
                        {simJob.title}
                      </div>
                      <div className="text-[11px] text-[#475569] truncate">
                        {simJob.company || "Verified Employer"}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center justify-center gap-1.5 w-full px-4 py-2 rounded-full bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#0F172A] text-xs font-bold transition cursor-pointer min-h-[44px]"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to jobs</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Sticky Bottom Apply Bar on Mobile */}
      <div
        role="region"
        aria-label="Quick apply bar"
        style={{ bottom: `${cookieNoticeHeight}px` }}
        className="md:hidden fixed inset-x-0 z-30 bg-white/95 backdrop-blur-md border-t border-[#E2E8F0] px-3 sm:px-4 py-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] flex items-center justify-between gap-2 shadow-lg transition-[bottom] duration-200"
      >
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleShare}
            data-testid="mobile-share-job-button"
            aria-label={shareStatus === "success" ? "Link copied" : "Share job"}
            className={`w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border transition cursor-pointer shrink-0 ${
              shareStatus === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-[#E2E8F0] bg-[#F1F5F9] text-[#475569]"
            }`}
          >
            {shareStatus === "success" ? (
              <Check className="w-4 h-4 text-emerald-600" />
            ) : (
              <Share2 className="w-4 h-4" />
            )}
          </button>
          <button
            type="button"
            onClick={onSave}
            aria-label={isSaved ? "Unlike job" : "Save job"}
            className={`w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border transition cursor-pointer shrink-0 ${
              isSaved
                ? "border-rose-200 bg-rose-50 text-rose-600"
                : "border-[#E2E8F0] bg-[#F1F5F9] text-[#475569]"
            }`}
          >
            <Heart className={`w-4 h-4 ${isSaved ? "fill-rose-500 text-rose-500" : ""}`} />
          </button>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isUnlocked && onToggleApplied && (
            <button
              type="button"
              onClick={onToggleApplied}
              disabled={isUpdatingApplied}
              aria-label={
                trackedStage === "interview"
                  ? "In interview stage"
                  : trackedStage === "offer"
                  ? "In offer stage"
                  : trackedStage === "rejected"
                  ? "In rejected stage"
                  : trackedStage === "applied" || isApplied
                  ? "Marked as applied"
                  : "Mark as applied"
              }
              className={`inline-flex items-center justify-center gap-1 px-3 py-2.5 min-h-[44px] rounded-full text-xs font-bold transition border cursor-pointer ${
                isUpdatingApplied
                  ? "opacity-60 cursor-not-allowed bg-slate-100 text-slate-400 border-slate-200"
                  : trackedStage === "interview" || trackedStage === "offer"
                  ? "bg-purple-50 text-purple-700 border-purple-300"
                  : trackedStage === "rejected"
                  ? "bg-rose-50 text-rose-700 border-rose-300"
                  : trackedStage === "applied" || isApplied
                  ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                  : "bg-white text-[#475569] border-[#E2E8F0]"
              }`}
            >
              {trackedStage === "interview" || trackedStage === "offer" ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-purple-600" />
              ) : trackedStage === "rejected" ? (
                <XCircle className="w-3.5 h-3.5 text-rose-600" />
              ) : trackedStage === "applied" || isApplied ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              ) : (
                <Clock className="w-3.5 h-3.5 text-[#475569]" />
              )}
              <span>
                {trackedStage === "interview"
                  ? "Interview"
                  : trackedStage === "offer"
                  ? "Offer"
                  : trackedStage === "rejected"
                  ? "Rejected"
                  : trackedStage === "applied" || isApplied
                  ? "Applied ✓"
                  : "Mark Applied"}
              </span>
            </button>
          )}

          {isUnlocked && job.applyUrl ? (
            <a
              href={job.applyUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onApply}
              className="inline-flex items-center gap-1.5 px-6 py-2.5 min-h-[44px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition shadow-none shrink-0"
            >
              <span>Apply</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          ) : (
            <button
              type="button"
              onClick={onApply}
              className="inline-flex items-center gap-1.5 px-6 py-2.5 min-h-[44px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition shadow-none shrink-0"
            >
              {!isUnlocked && <Lock className="w-3.5 h-3.5" />}
              <span>Apply</span>
            </button>
          )}
        </div>
      </div>

      {/* Mobile Copied Notification Toast */}
      {shareStatus === "success" && (
        <div
          data-testid="share-success-banner"
          role="status"
          className="sm:hidden fixed bottom-28 left-1/2 -translate-x-1/2 z-40 bg-[#0F172A] text-white text-xs font-medium px-4 py-2 rounded-full shadow-lg flex items-center gap-1.5 animate-fadeIn"
        >
          <Check className="w-3.5 h-3.5 text-emerald-400" />
          <span>Link copied</span>
        </div>
      )}

      {candidate && isTailorOpen && (
        <TailorResumeModal
          open={isTailorOpen}
          onOpenChange={setIsTailorOpen}
          candidate={candidate}
          job={job}
          userId={user?.id || null}
        />
      )}
    </div>
  );
}
