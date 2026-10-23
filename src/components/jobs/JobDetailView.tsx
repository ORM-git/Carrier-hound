"use client";

import React, { useMemo, useState } from "react";
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
  Heart,
  ExternalLink,
  Lock,
  Sparkles,
  ArrowRight,
  Check,
  AlertCircle,
  Clock,
  Briefcase,
  DollarSign,
  MapPin,
  Share2,
  Flag,
  X,
} from "lucide-react";

interface JobDetailViewProps {
  job: LiveJob;
  candidate: CandidateProfile | null;
  user: User | null;
  isPro: boolean;
  isSaved: boolean;
  onSave: () => void;
  onApply: (e?: React.MouseEvent) => void;
  onBack: () => void;
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
  onSave,
  onApply,
  onBack,
}: JobDetailViewProps) {
  const hasConfirmedResume = Boolean(candidate && candidate.confirmedAt);
  const cookieNoticeHeight = useCookieNoticeHeight();

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

  const matchLabel =
    matchScore !== null
      ? matchScore > 70
        ? "Great match"
        : matchScore >= 50
        ? "Good match"
        : "Fair match"
      : "";

  return (
    <div className="max-w-[880px] w-full mx-auto space-y-4 pb-28 md:pb-12">
      {/* Top Left Back Button & Utility Actions */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to jobs list"
          className="inline-flex items-center gap-2 text-sm font-semibold text-[#475569] hover:text-[#0F172A] transition-colors py-2 px-1 min-h-[44px] cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back</span>
        </button>

        <div className="flex items-center gap-2">
          {/* Report Issue link in top utility bar */}
          <a
            href={getReportJobMailto(job)}
            data-testid="report-issue-link"
            aria-label="Report an issue with this job posting"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#64748B] hover:text-[#2563EB] transition-colors py-2 px-2.5 rounded-lg hover:bg-slate-100 min-h-[44px]"
          >
            <Flag className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Report issue</span>
          </a>
        </div>
      </div>

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

      {/* 1. Header Block Card */}
      <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 sm:p-6 shadow-none space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="flex items-start gap-4 min-w-0 flex-1">
            <CompanyLogo
              company={job.company}
              applyUrl={job.applyUrl}
              className="w-12 h-12 rounded-xl shrink-0 object-contain p-1 border border-[#E2E8F0] bg-white"
            />
            <div className="space-y-1.5 min-w-0 flex-1">
              <h1 className="text-[24px] font-bold text-[#0F172A] leading-tight break-words">
                {job.title}
              </h1>
              <div className="text-[14px] text-[#475569]">
                <span className={!isPro ? "filter blur-[4.5px] select-none" : ""}>
                  {job.company || "Verified Employer"}
                </span>
                {job.category && (
                  <span className="capitalize"> · {job.category}</span>
                )}
              </div>
            </div>
          </div>

          {/* Action buttons (Desktop header) */}
          <div className="hidden sm:flex items-center gap-2.5 shrink-0 self-start">
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

            {isPro && job.applyUrl ? (
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
                {!isPro && <Lock className="w-3.5 h-3.5" />}
                <span>Apply</span>
              </button>
            )}
          </div>
        </div>

        {/* Gray Chips Row */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#E2E8F0]">
          <span className="inline-flex items-center gap-1 text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
            <MapPin className="w-3 h-3 text-[#64748B]" />
            <span className="truncate">
              {isPro ? (job.location || "Remote") : <span className="filter blur-[3.5px] select-none">Location Locked</span>}
            </span>
          </span>

          <span className="inline-flex items-center gap-1 text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
            <Briefcase className="w-3 h-3 text-[#64748B]" />
            <span>{job.type || "Full-time"}</span>
          </span>

          {job.salary && (
            <span className="inline-flex items-center gap-1 text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
              <DollarSign className="w-3 h-3 text-[#166534]" />
              <span>{isPro ? job.salary : "••••••••"}</span>
            </span>
          )}

          <span className="inline-flex items-center gap-1 text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
            <Clock className="w-3 h-3 text-[#64748B]" />
            <span>{formatRelativeTime(job.postedAt || job.date)}</span>
          </span>
        </div>
      </div>

      {/* 2. Match Breakdown Card */}
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
                  isPro={isPro}
                />
                <div className="text-left">
                  <div className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-blue-300" />
                    <span>{matchLabel}</span>
                  </div>
                  <div className="text-xs text-slate-300 pt-0.5">
                    {(diagnostics?.whyYouFit && diagnostics.whyYouFit[0]) || "Calculated from your confirmed resume against verified job requirements."}
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
                    ) : (
                      <span className="text-xs text-[#166534] font-semibold">Zero critical skill gaps!</span>
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

      {/* 3. Job Description Card */}
      <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 sm:p-6 shadow-none space-y-3">
        <h2 className="text-[18px] font-bold text-[#0F172A]">Job description</h2>
        <div className="text-[15px] leading-[24px] text-[#0F172A] max-w-[720px] whitespace-pre-wrap break-words">
          {job.description ? (
            stripHtmlAndExecutableMarkup(job.description)
          ) : (
            <p className="text-[#475569]">
              Apply directly on the employer&apos;s site to view the complete posting and application instructions.
            </p>
          )}
        </div>

        {/* Footer info: Job ID & Report Issue */}
        <div className="pt-4 border-t border-[#E2E8F0] flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-[#64748B]">
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

      {/* 4. Requirements Section (only if data exists) */}
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

      {/* 5. Benefits Section (only if data exists) */}
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

      {/* Sticky Bottom Apply Bar on Mobile */}
      <div
        role="region"
        aria-label="Quick apply bar"
        style={{ bottom: user ? `calc(${cookieNoticeHeight}px + 4rem)` : `${cookieNoticeHeight}px` }}
        className="md:hidden fixed inset-x-0 z-30 bg-white/95 backdrop-blur-md border-t border-[#E2E8F0] p-4 flex items-center justify-between gap-3 shadow-lg transition-[bottom] duration-200"
      >
        <div className="flex items-center gap-2 min-w-0">
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
            className={`w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border transition cursor-pointer ${
              isSaved
                ? "border-rose-200 bg-rose-50 text-rose-600"
                : "border-[#E2E8F0] bg-[#F1F5F9] text-[#475569]"
            }`}
          >
            <Heart className={`w-4 h-4 ${isSaved ? "fill-rose-500 text-rose-500" : ""}`} />
          </button>
          <div className="min-w-0">
            <div className="text-xs font-bold text-[#0F172A] truncate">
              {job.title}
            </div>
            <div className="text-[11px] text-[#475569] truncate">
              {job.company}
            </div>
          </div>
        </div>

        {isPro && job.applyUrl ? (
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
            {!isPro && <Lock className="w-3.5 h-3.5" />}
            <span>Apply</span>
          </button>
        )}
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
    </div>
  );
}
