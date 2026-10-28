"use client";

import React, { useMemo, useState, useEffect } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { LiveJob } from "@/lib/jobs/service";
import { CandidateProfile } from "@/lib/resume/types";
import { computeFitDiagnostics, FitDiagnosticsResult } from "@/lib/matcher/scoring";
import { stripHtmlAndExecutableMarkup, sanitizeExternalUrl } from "@/lib/security/xss";
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
  Ban,
  Laptop,
  TrendingUp,
  Calendar,
  Building2,
  Globe,
} from "lucide-react";

const TailorResumeModal = dynamic(() => import("@/components/resume/TailorResumeModal"), { ssr: false });

export const VERIFIED_SUPPORT_EMAIL = "support@careermonke.com";

export function getCanonicalJobUrl(jobId: string): string {
  const base =
    typeof window !== "undefined" && window.location.origin && window.location.origin !== "null"
      ? window.location.origin
      : getSiteUrl();
  return `${base}/jobs?id=${encodeURIComponent(jobId)}`;
}

export function getReportJobMailto(job: { id: string; title: string; company?: string }): string {
  const canonicalUrl = getCanonicalJobUrl(job.id);
  const subject = encodeURIComponent(`[Job Issue] ${job.title} (${job.id})`);
  const body = encodeURIComponent(
    `Job ID: ${job.id}\nJob Title: ${job.title}\nCompany: ${job.company || "N/A"}\nURL: ${canonicalUrl}\n\nPlease describe the issue with this job posting:`
  );
  return `mailto:${VERIFIED_SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
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

function inferJobLevel(title: string): string {
  const t = (title || "").toLowerCase();
  if (t.includes("staff") || t.includes("principal") || t.includes("lead")) return "Staff / Lead";
  if (t.includes("senior") || t.includes("sr.")) return "Senior Level";
  if (t.includes("junior") || t.includes("entry") || t.includes("associate")) return "Entry Level";
  if (t.includes("intern")) return "Internship";
  return "Mid-Senior Level";
}

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
  onHide?: (e?: React.MouseEvent) => void;
  onRetryUnlock?: () => void;
  isRetryingUnlock?: boolean;
  similarJobs?: LiveJob[];
  onSelectJob?: (job: LiveJob) => void;
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
  onHide,
  onRetryUnlock,
  isRetryingUnlock = false,
  similarJobs,
  onSelectJob,
}: JobDetailViewProps) {
  const isUnlocked = isPro && !job.proUnlockError;
  const hasConfirmedResume = Boolean(candidate && candidate.confirmedAt);
  const cookieNoticeHeight = useCookieNoticeHeight();

  const [activeTab, setActiveTab] = useState<"overview" | "company">("overview");
  const [isScrolled, setIsScrolled] = useState(false);
  const [isTailorOpen, setIsTailorOpen] = useState(false);
  const [shareStatus, setShareStatus] = useState<"idle" | "success" | "error">("idle");
  const [shareErrorMsg, setShareErrorMsg] = useState<string>("");

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 80);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

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

  const expSubScore = diagnostics
    ? Math.min(100, Math.max(0, Math.round((diagnostics.breakdown.experienceScore / 15) * 100)))
    : null;
  const skillSubScore = diagnostics
    ? Math.min(100, Math.max(0, Math.round((diagnostics.breakdown.skillScore / 50) * 100)))
    : null;
  const industrySubScore = diagnostics
    ? Math.min(
        100,
        Math.max(
          0,
          Math.round(
            (diagnostics.breakdown as any)?.industryScore ??
              ((diagnostics.breakdown.titleScore / 25) * 100)
          )
        )
      )
    : null;

  const matchLabel =
    matchScore !== null
      ? matchScore > 70
        ? "Great match"
        : matchScore >= 50
        ? "Good match"
        : "Fair match"
      : "";

  // Extract structured lists if present
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

  const preferredList: string[] = useMemo(() => {
    const raw = (job as any).preferred || (job as any).preferred_qualifications;
    if (Array.isArray(raw)) {
      return raw.map((r) => String(r).trim()).filter(Boolean);
    }
    if (typeof raw === "string" && raw.trim()) {
      return raw.split("\n").map((r) => r.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
    }
    return [];
  }, [job]);

  const responsibilitiesList: string[] = useMemo(() => {
    const raw = (job as any).responsibilities;
    if (Array.isArray(raw)) {
      return raw.map((r) => String(r).trim()).filter(Boolean);
    }
    if (typeof raw === "string" && raw.trim()) {
      return raw.split("\n").map((r) => r.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
    }
    return [];
  }, [job]);

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

  const jobLevel = inferJobLevel(job.title);
  const expMatch = job.description?.match(/(\d+\+?\s*(?:-\s*\d+\+?)?\s*years?(?:\s*of)?\s*(?:experience|exp)?)/i);
  const expText = (job as any).experience || (expMatch ? expMatch[0] : null);

  // Parse company details only where available
  const companyInfo = useMemo(() => {
    const raw = (job as any).companyInfo || (job as any).company_data || {};
    const rawWebsite = raw.website || (job as any).company_website || null;
    const sanitizedWebsite = sanitizeExternalUrl(rawWebsite);
    return {
      description: raw.description || (job as any).company_description || "",
      founded: raw.founded || (job as any).founded || null,
      hq: raw.hq || raw.headquarters || (job as any).hq || null,
      size: raw.size || raw.employees || (job as any).company_size || null,
      website: sanitizedWebsite,
    };
  }, [job]);

  return (
    <div
      style={{ paddingBottom: `calc(${cookieNoticeHeight}px + 7rem)` }}
      className="max-w-[880px] w-full mx-auto space-y-4 sm:space-y-3 md:pb-12"
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

      {/* (1) STICKY HEADER UNDER TOP BAR (NEVER SCROLLS AWAY) */}
      <div
        role="region"
        aria-label="Job header"
        className="sticky top-14 z-20 bg-white/95 backdrop-blur-md rounded-[16px] ring-1 ring-[#E2E8F0] px-3.5 sm:px-5 py-2.5 shadow-sm transition-all duration-200"
      >
        {/* DESKTOP SINGLE-ROW STRIP (md: and above) */}
        <div className="hidden md:flex items-center justify-between gap-3">
          {/* Left strip: Back/close, Scrolled Chip OR Tabs + Utility links */}
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to jobs list"
              className="w-9 h-9 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-slate-100 text-[#475569] hover:text-[#0F172A] transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>

            {/* When scrolled: compact logo + job title chip in strip */}
            {isScrolled ? (
              <div
                data-testid="scrolled-header-chip"
                className="flex items-center gap-2 min-w-0 max-w-[260px] sm:max-w-[400px] animate-fadeIn"
              >
                <CompanyLogo
                  company={job.company}
                  applyUrl={job.applyUrl}
                  className="w-6 h-6 rounded object-contain p-0.5 border border-[#E2E8F0] bg-white shrink-0"
                />
                <span className="text-xs sm:text-sm font-bold text-[#0F172A] truncate">
                  {job.title}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-4">
                {/* Overview and Company tabs */}
                <div className="flex items-center gap-1 border-r border-[#E2E8F0] pr-3">
                  <button
                    type="button"
                    onClick={() => setActiveTab("overview")}
                    className={`text-xs sm:text-sm font-semibold transition-colors py-1.5 px-2 rounded-md ${
                      activeTab === "overview"
                        ? "text-[#2563EB] bg-blue-50/70"
                        : "text-[#64748B] hover:text-[#0F172A]"
                    }`}
                  >
                    Overview
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab("company");
                      document.getElementById("company-section")?.scrollIntoView({ behavior: "smooth" });
                    }}
                    className={`text-xs sm:text-sm font-semibold transition-colors py-1.5 px-2 rounded-md ${
                      activeTab === "company"
                        ? "text-[#2563EB] bg-blue-50/70"
                        : "text-[#64748B] hover:text-[#0F172A]"
                    }`}
                  >
                    Company
                  </button>
                </div>

                {/* Utility actions (Desktop) */}
                <div className="flex items-center gap-2 text-xs text-[#64748B]">
                  <button
                    type="button"
                    onClick={handleShare}
                    data-testid="share-job-button"
                    className="inline-flex items-center gap-1 text-[#475569] hover:text-[#0F172A] transition-colors py-1.5 px-2 rounded hover:bg-slate-100 cursor-pointer min-h-[36px]"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    <span>{shareStatus === "success" ? "Link copied" : "Share"}</span>
                  </button>

                  <a
                    href={getReportJobMailto(job)}
                    data-testid="report-issue-link"
                    className="inline-flex items-center gap-1 text-[#475569] hover:text-[#2563EB] transition-colors py-1.5 px-2 rounded hover:bg-slate-100 min-h-[36px]"
                  >
                    <Flag className="w-3.5 h-3.5" />
                    <span>Report issue</span>
                  </a>

                  {isUnlocked && job.applyUrl && (
                    <a
                      href={job.applyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[#475569] hover:text-[#2563EB] transition-colors py-1.5 px-2 rounded hover:bg-slate-100 min-h-[36px]"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Original Job Post</span>
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Right strip: Hide, Heart, Apply */}
          <div className="flex items-center gap-2 shrink-0">
            {onHide && (
              <button
                type="button"
                onClick={onHide}
                aria-label="Hide position"
                title="Hide position"
                className="w-9 h-9 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border border-[#E2E8F0] bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0] hover:text-[#0F172A] transition cursor-pointer"
              >
                <Ban className="w-4 h-4" />
              </button>
            )}

            <button
              type="button"
              onClick={onSave}
              aria-label={isSaved ? "Unlike job" : "Save job"}
              className={`w-9 h-9 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border transition cursor-pointer ${
                isSaved
                  ? "border-rose-200 bg-rose-50 text-rose-600"
                  : "border-[#E2E8F0] bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0] hover:text-[#0F172A]"
              }`}
            >
              <Heart className={`w-4 h-4 ${isSaved ? "fill-rose-500 text-rose-500" : ""}`} />
            </button>

            {isUnlocked && job.applyUrl ? (
              <a
                href={job.applyUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onApply}
                className="inline-flex items-center gap-1.5 px-5 py-2 min-h-[44px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition shadow-none focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 cursor-pointer"
              >
                <span>Apply</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            ) : (
              <button
                type="button"
                onClick={onApply}
                className="inline-flex items-center gap-1.5 px-5 py-2 min-h-[44px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition shadow-none focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 cursor-pointer"
              >
                {!isUnlocked && <Lock className="w-3.5 h-3.5" />}
                <span>Apply</span>
              </button>
            )}
          </div>
        </div>

        {/* MOBILE TWO-ROW STRIP (md:hidden, stays sticky, zero overlap at 360px-414px) */}
        <div data-testid="mobile-sticky-header-strip" className="md:hidden flex flex-col gap-2">
          {/* Row 1: Back, Overview and Company tabs (full labels visible), Share icon */}
          <div className="flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={onBack}
                aria-label="Back to jobs list"
                className="w-8 h-8 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg hover:bg-slate-100 text-[#475569] hover:text-[#0F172A] transition-colors cursor-pointer shrink-0"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>

              <div className="flex items-center gap-1 bg-[#F1F5F9] p-0.5 rounded-lg shrink-0">
                <button
                  type="button"
                  onClick={() => setActiveTab("overview")}
                  className={`text-xs font-semibold py-1 px-2.5 rounded-md transition-colors ${
                    activeTab === "overview"
                      ? "text-[#2563EB] bg-white shadow-xs font-bold"
                      : "text-[#64748B] hover:text-[#0F172A]"
                  }`}
                >
                  Overview
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab("company");
                    document.getElementById("company-section")?.scrollIntoView({ behavior: "smooth" });
                  }}
                  className={`text-xs font-semibold py-1 px-2.5 rounded-md transition-colors ${
                    activeTab === "company"
                      ? "text-[#2563EB] bg-white shadow-xs font-bold"
                      : "text-[#64748B] hover:text-[#0F172A]"
                  }`}
                >
                  Company
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={handleShare}
              data-testid="mobile-header-share-button"
              aria-label="Share position"
              className="w-8 h-8 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-[#475569] hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
            >
              <Share2 className="w-4 h-4" />
            </button>
          </div>

          {/* Row 2: logo, Hide, Heart and Apply on the right */}
          <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-[#F1F5F9] min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <CompanyLogo
                company={job.company}
                applyUrl={job.applyUrl}
                className="w-7 h-7 rounded-lg object-contain p-0.5 border border-[#E2E8F0] bg-white shrink-0"
              />
              <span className={`text-xs font-bold text-[#0F172A] truncate max-w-[120px] ${!isUnlocked ? "filter blur-[3.5px] select-none" : ""}`}>
                {job.company || "Verified Employer"}
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {onHide && (
                <button
                  type="button"
                  onClick={onHide}
                  aria-label="Hide position"
                  title="Hide position"
                  className="w-8 h-8 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full border border-[#E2E8F0] bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0] transition cursor-pointer"
                >
                  <Ban className="w-3.5 h-3.5" />
                </button>
              )}

              <button
                type="button"
                onClick={onSave}
                aria-label={isSaved ? "Unlike job" : "Save job"}
                className={`w-8 h-8 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full border transition cursor-pointer ${
                  isSaved
                    ? "border-rose-200 bg-rose-50 text-rose-600"
                    : "border-[#E2E8F0] bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0]"
                }`}
              >
                <Heart className={`w-3.5 h-3.5 ${isSaved ? "fill-rose-500 text-rose-500" : ""}`} />
              </button>

              {isUnlocked && job.applyUrl ? (
                <a
                  href={job.applyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={onApply}
                  className="inline-flex items-center gap-1 px-3.5 py-1.5 min-h-[36px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition shadow-none cursor-pointer shrink-0"
                >
                  <span>Apply</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              ) : (
                <button
                  type="button"
                  onClick={onApply}
                  className="inline-flex items-center gap-1 px-3.5 py-1.5 min-h-[36px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition shadow-none cursor-pointer shrink-0"
                >
                  {!isUnlocked && <Lock className="w-3 h-3" />}
                  <span>Apply</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* (2) HEADER BODY CARD */}
      <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 sm:p-4 shadow-none space-y-4 sm:space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-5">
          {/* Left / Middle: Logo, Company, Title, 2x3 Metadata */}
          <div className="flex-1 min-w-0 space-y-3.5">
            <div className="flex items-center gap-3">
              <CompanyLogo
                company={job.company}
                applyUrl={job.applyUrl}
                className="w-12 h-12 rounded-xl shrink-0 object-contain p-1 border border-[#E2E8F0] bg-white"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[14px] text-[#475569] font-semibold ${!isUnlocked ? "filter blur-[4.5px] select-none" : ""}`}>
                    {job.company || "Verified Employer"}
                  </span>
                  <span className="text-xs text-[#64748B] flex items-center gap-1">
                    <Clock className="w-3 h-3 text-[#94A3B8]" />
                    <span>{formatRelativeTime(job.postedAt || job.date)}</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Title */}
            <h1 className="text-[24px] font-bold text-[#0F172A] leading-tight break-words">
              {job.title}
            </h1>

            {/* Metadata in 2 columns x 3 rows with small icons (only the ones that exist!) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t border-[#E2E8F0] text-[13px]">
              {/* Col 1: location, job type, work model */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 min-w-0 px-2.5 py-1.5 rounded-lg bg-[#F1F5F9] text-[#475569]">
                  <MapPin className="w-4 h-4 text-[#475569] shrink-0" />
                  <span className="truncate">
                    {isUnlocked ? (job.location || "Remote") : <span className="filter blur-[3.5px] select-none">Location Locked</span>}
                  </span>
                </div>

                {job.type && (
                  <div className="flex items-center gap-2 min-w-0 px-2.5 py-1.5 rounded-lg bg-[#F1F5F9] text-[#475569]">
                    <Briefcase className="w-4 h-4 text-[#475569] shrink-0" />
                    <span className="truncate">{job.type}</span>
                  </div>
                )}

                <div className="flex items-center gap-2 min-w-0 px-2.5 py-1.5 rounded-lg bg-[#F1F5F9] text-[#475569]">
                  <Laptop className="w-4 h-4 text-[#475569] shrink-0" />
                  <span className="truncate">{job.remote ? "Remote" : "On-site"}</span>
                </div>
              </div>

              {/* Col 2: level, salary, experience */}
              <div className="space-y-2">
                {jobLevel && (
                  <div className="flex items-center gap-2 min-w-0 px-2.5 py-1.5 rounded-lg bg-[#F1F5F9] text-[#475569]">
                    <TrendingUp className="w-4 h-4 text-[#475569] shrink-0" />
                    <span className="truncate">{jobLevel}</span>
                  </div>
                )}

                <div className="flex items-center gap-2 min-w-0 px-2.5 py-1.5 rounded-lg bg-[#F1F5F9] text-[#475569]">
                  <DollarSign className="w-4 h-4 text-[#166534] shrink-0" />
                  <span className="truncate font-medium text-[#0F172A]">
                    {job.salary ? (isUnlocked ? job.salary : "••••••••") : "Pay not disclosed"}
                  </span>
                </div>

                {expText && (
                  <div className="flex items-center gap-2 min-w-0 px-2.5 py-1.5 rounded-lg bg-[#F1F5F9] text-[#475569]">
                    <Calendar className="w-4 h-4 text-[#475569] shrink-0" />
                    <span className="truncate">{expText}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right: Match card on the right with total % and sub-scores (Desktop) */}
          <div className="hidden lg:block w-[280px] shrink-0">
            {hasConfirmedResume && matchScore !== null ? (
              <div className="p-4 rounded-[14px] bg-[#F8FAFC] border border-[#E2E8F0] space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold text-[#64748B] uppercase tracking-wider">
                    Match breakdown
                  </div>
                  <span
                    className={`text-[11px] font-bold px-2 py-0.5 rounded uppercase tracking-wide ${
                      matchScore > 70
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                        : matchScore >= 50
                        ? "bg-blue-50 text-blue-700 border border-blue-200"
                        : "bg-slate-100 text-slate-700 border border-slate-200"
                    }`}
                  >
                    {isUnlocked ? matchLabel : "Pro Match"}
                  </span>
                </div>

                <div className="text-2xl font-black text-[#0F172A] leading-none">
                  {isUnlocked ? (
                    `${matchScore}%`
                  ) : (
                    <span className="filter blur-[3px] select-none text-slate-400">85%</span>
                  )}
                </div>

                {/* Sub-scores */}
                <div className="space-y-1.5 pt-2 border-t border-[#E2E8F0] text-xs">
                  <div className="flex items-center justify-between text-[#475569]">
                    <span>Experience Level</span>
                    <span className="font-semibold text-[#0F172A]">
                      {isUnlocked ? (expSubScore !== null ? `${expSubScore}%` : "—") : "••%"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[#475569]">
                    <span>Skill</span>
                    <span className="font-semibold text-[#0F172A]">
                      {isUnlocked ? (skillSubScore !== null ? `${skillSubScore}%` : "—") : "••%"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[#475569]">
                    <span>Industry Exp.</span>
                    <span className="font-semibold text-[#0F172A]">
                      {isUnlocked ? (industrySubScore !== null ? `${industrySubScore}%` : "—") : "••%"}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <Link
                href="/resume"
                className="block p-4 rounded-[14px] bg-[#F8FAFC] hover:bg-[#EFF6FF] border border-[#E2E8F0] hover:border-[#93C5FD] transition-colors text-left space-y-2 group/cta"
              >
                <div className="flex items-center gap-2 text-xs font-bold text-[#1D4ED8]">
                  <Sparkles className="w-4 h-4 text-blue-600" />
                  <span>Upload your resume to see your real match</span>
                </div>
                <p className="text-[11px] text-[#475569] leading-snug">
                  Confirm your resume facts to unlock full match percentage and sub-score breakdown.
                </p>
              </Link>
            )}
          </div>
        </div>

        {/* Match score on Mobile: compact cards in ONE ROW */}
        {hasConfirmedResume && matchScore !== null && (
          <div className="lg:hidden pt-3 border-t border-[#E2E8F0] space-y-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#64748B]">
              Match Score
            </div>
            <div className="grid grid-cols-4 gap-2">
              <div className="p-2 sm:p-2.5 rounded-xl bg-emerald-50/70 border border-emerald-200 text-center space-y-0.5 min-w-0">
                <div className="text-base font-black text-[#0F172A]">
                  {isUnlocked ? `${matchScore}%` : "••%"}
                </div>
                <div className="text-[9px] sm:text-[10px] font-bold text-emerald-800 uppercase tracking-tight leading-tight break-words line-clamp-2">
                  {isUnlocked ? matchLabel : "Match"}
                </div>
              </div>
              <div className="p-2 sm:p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-center space-y-0.5 min-w-0">
                <div className="text-base font-bold text-[#0F172A]">
                  {isUnlocked ? (expSubScore !== null ? `${expSubScore}%` : "—") : "••%"}
                </div>
                <div className="text-[9px] sm:text-[10px] text-[#64748B] leading-tight break-words truncate">Experience</div>
              </div>
              <div className="p-2 sm:p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-center space-y-0.5 min-w-0">
                <div className="text-base font-bold text-[#0F172A]">
                  {isUnlocked ? (skillSubScore !== null ? `${skillSubScore}%` : "—") : "••%"}
                </div>
                <div className="text-[9px] sm:text-[10px] text-[#64748B] leading-tight break-words truncate">Skill</div>
              </div>
              <div className="p-2 sm:p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-center space-y-0.5 min-w-0">
                <div className="text-base font-bold text-[#0F172A]">
                  {isUnlocked ? (industrySubScore !== null ? `${industrySubScore}%` : "—") : "••%"}
                </div>
                <div className="text-[9px] sm:text-[10px] text-[#64748B] leading-tight break-words truncate">Industry</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* (3) CONTENT ORDER & (4) RIGHT RAIL */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left Column: Short summary + tags, Responsibilities, Qualification, Benefits, Company */}
        <div className="lg:col-span-7 space-y-4 min-w-0">
          {/* Pro Unlock Error Retry Banner */}
          {job.proUnlockError && (
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
          )}

          {/* 1. Short summary + tags Card */}
          <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 sm:p-6 shadow-none space-y-3.5">
            <h2 className="text-[18px] font-bold text-[#0F172A]">Job description</h2>
            {job.description ? (
              <div className="text-[15px] leading-[24px] text-[#0F172A] max-w-[720px] whitespace-pre-wrap break-words">
                {stripHtmlAndExecutableMarkup(job.description)}
              </div>
            ) : (
              <p className="text-[#475569] text-[15px] leading-[24px]">
                Apply directly on the employer&apos;s site to view the complete posting and application instructions.
              </p>
            )}

            {/* Tags row: category & skills */}
            {((job.skills && job.skills.length > 0) || job.category) && (
              <div className="flex flex-wrap items-center gap-1.5 pt-3 border-t border-[#E2E8F0]">
                {job.category && (
                  <span className="text-[12px] font-semibold px-2.5 py-1 rounded-full bg-slate-100 text-[#334155] capitalize">
                    {job.category}
                  </span>
                )}
                {job.skills &&
                  job.skills.map((skill) => (
                    <span
                      key={skill}
                      className="text-[12px] font-medium px-2.5 py-1 rounded-full bg-[#EFF6FF] text-[#1E40AF]"
                    >
                      {skill}
                    </span>
                  ))}
              </div>
            )}
          </div>

          {/* 2. Responsibilities (only if data exists) */}
          {responsibilitiesList.length > 0 && (
            <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 sm:p-4 shadow-none space-y-3">
              <h2 className="text-[18px] font-bold text-[#0F172A]">Responsibilities</h2>
              <ul className="space-y-2 max-w-[720px] text-[15px] leading-[24px] text-[#0F172A]">
                {responsibilitiesList.map((resp, idx) => (
                  <li key={idx} className="flex items-start gap-2.5">
                    <span className="text-[#2563EB] font-bold select-none">•</span>
                    <span className="flex-1 break-words">{resp}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 3. Qualification (Required, Preferred) (only if data exists) */}
          {(requirementsList.length > 0 || preferredList.length > 0) && (
            <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 sm:p-4 shadow-none space-y-4 sm:space-y-3">
              <h2 className="text-[18px] font-bold text-[#0F172A]">Requirements</h2>

              {requirementsList.length > 0 && (
                <div className="space-y-2">
                  {preferredList.length > 0 && (
                    <div className="text-xs font-bold text-[#475569] uppercase tracking-wider">
                      Required
                    </div>
                  )}
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

              {preferredList.length > 0 && (
                <div className="space-y-2 pt-2 border-t border-[#E2E8F0]">
                  <div className="text-xs font-bold text-[#475569] uppercase tracking-wider">
                    Preferred
                  </div>
                  <ul className="space-y-2 max-w-[720px] text-[15px] leading-[24px] text-[#0F172A]">
                    {preferredList.map((pref, idx) => (
                      <li key={idx} className="flex items-start gap-2.5">
                        <span className="text-[#64748B] font-bold select-none">•</span>
                        <span className="flex-1 break-words">{pref}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* 4. Benefits (only if data exists) */}
          {benefitsList.length > 0 && (
            <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 sm:p-4 shadow-none space-y-3">
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

          {/* 5. Company section as grouped cards (name/logo/description, plus founded/HQ/size/website only where data exists) */}
          <div
            id="company-section"
            className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 sm:p-4 shadow-none space-y-4 sm:space-y-3"
          >
            <h2 className="text-[18px] font-bold text-[#0F172A]">Company</h2>

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
                {job.location && (
                  <div className="text-xs text-[#475569] flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-[#64748B]" />
                    <span>{isUnlocked ? job.location : <span className="filter blur-[3.5px]">Location Locked</span>}</span>
                  </div>
                )}
              </div>
            </div>

            {companyInfo.description && (
              <p className="text-xs sm:text-[13px] text-[#475569] leading-relaxed">
                {companyInfo.description}
              </p>
            )}

            {/* Founded, HQ, size, website only where data exists */}
            {(companyInfo.founded || companyInfo.hq || companyInfo.size || companyInfo.website) && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-[#E2E8F0] text-xs">
                {companyInfo.founded && (
                  <div className="space-y-0.5">
                    <div className="text-[#94A3B8]">Founded</div>
                    <div className="font-semibold text-[#0F172A]">{companyInfo.founded}</div>
                  </div>
                )}
                {companyInfo.hq && (
                  <div className="space-y-0.5">
                    <div className="text-[#94A3B8]">Headquarters</div>
                    <div className="font-semibold text-[#0F172A]">{companyInfo.hq}</div>
                  </div>
                )}
                {companyInfo.size && (
                  <div className="space-y-0.5">
                    <div className="text-[#94A3B8]">Company Size</div>
                    <div className="font-semibold text-[#0F172A]">{companyInfo.size}</div>
                  </div>
                )}
                {companyInfo.website && (
                  <div className="space-y-0.5">
                    <div className="text-[#94A3B8]">Website</div>
                    <a
                      href={companyInfo.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-[#2563EB] hover:underline truncate block"
                    >
                      {companyInfo.website.replace(/^https?:\/\//, "")}
                    </a>
                  </div>
                )}
              </div>
            )}

            {/* Secondary report issue link */}
            <div className="pt-3 border-t border-[#E2E8F0] flex items-center justify-between text-xs text-[#64748B]">
              <span>Notice an issue with this job posting?</span>
              <a
                href={getReportJobMailto(job)}
                data-testid="report-issue-detail-link"
                className="font-semibold text-[#2563EB] hover:underline cursor-pointer"
              >
                Report issue
              </a>
            </div>
          </div>
        </div>

        {/* (4) RIGHT RAIL (DESKTOP ONLY: STACKED CARDS REUSING CURRENT LABELS) */}
        <div className="hidden lg:block lg:col-span-5 space-y-3 min-w-0">
          {/* Card 1: Tailor Resume Card */}
          {hasConfirmedResume && (
            <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-4 shadow-none space-y-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600 shrink-0">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-[#0F172A]">Tailor Resume</h3>
                  <p className="text-[11px] text-[#64748B]">
                    Customize your resume for this role
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  if (!isUnlocked) {
                    onApply();
                  } else {
                    setIsTailorOpen(true);
                  }
                }}
                className="w-full py-2 px-4 rounded-full text-xs font-bold transition border border-blue-200 bg-blue-50 hover:bg-blue-100 text-[#1D4ED8] flex items-center justify-center gap-1.5 cursor-pointer min-h-[38px]"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Tailor Resume</span>
              </button>
            </div>
          )}

          {/* Card: Interview Pack Card (gated behind feature flag, off in production by default) */}
          {(process.env.NEXT_PUBLIC_ENABLE_INTERVIEW_PACK === "true" || process.env.NODE_ENV !== "production") && (
            <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-4 shadow-none space-y-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full bg-blue-50 border border-blue-200 flex items-center justify-center text-[#2563EB] shrink-0">
                  <FileText className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-[#0F172A]">Interview Pack</h3>
                  <p className="text-[11px] text-[#64748B]">
                    Dossier, questions & tailored answers
                  </p>
                </div>
              </div>

              <Link
                href={`/jobs/${job.id}/interview-pack`}
                data-testid="interview-pack-entry-button"
                className="w-full py-2 px-4 rounded-full text-xs font-bold transition border border-[#BFDBFE] bg-[#EFF6FF] hover:bg-[#DBEAFE] text-[#1D4ED8] flex items-center justify-center gap-1.5 cursor-pointer min-h-[38px]"
              >
                <Sparkles className="w-3.5 h-3.5 text-[#2563EB]" />
                <span>Open Interview Pack</span>
              </Link>
            </div>
          )}

          {/* Card 2: Similar jobs Card (only when similar jobs exist) */}
          {similarJobs && similarJobs.length > 0 && (
            <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-4 shadow-none space-y-3">
              <h2 className="text-[16px] font-bold text-[#0F172A]">Similar jobs</h2>
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
            </div>
          )}

          {/* Card 3: Your Notes Card (only if private notes exist) */}
          {job.trackerNotes && (
            <div
              data-testid="tracker-notes-panel"
              className="bg-[#F8FAFC] rounded-[16px] ring-1 ring-[#E2E8F0] p-4 shadow-none space-y-2.5"
            >
              <div className="flex items-center gap-2 text-[#0F172A]">
                <FileText className="w-4 h-4 text-[#2563EB]" />
                <h3 className="text-sm font-bold">Your notes</h3>
              </div>
              <p className="text-[13px] leading-relaxed text-[#334155] whitespace-pre-wrap break-words">
                {job.trackerNotes}
              </p>
              <span className="inline-block text-[11px] text-[#64748B]">
                Private to your account — never shared with employers or external services.
              </span>
            </div>
          )}
        </div>
      </div>

      {candidate && isTailorOpen && (
        <TailorResumeModal
          isPro={isPro}
          open={isTailorOpen}
          onOpenChange={setIsTailorOpen}
          candidate={candidate}
          job={job}
          userId={user?.id || null}
        />
      )}

      {/* Mobile Sticky Bottom Apply Bar */}
      <div className="md:hidden fixed inset-x-0 bottom-0 z-30 bg-white/95 backdrop-blur-md border-t border-[#E2E8F0] p-3 flex items-center justify-between gap-3 shadow-lg">
        <button
          type="button"
          onClick={handleShare}
          data-testid="mobile-share-job-button"
          aria-label="Share job"
          className="w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border border-[#E2E8F0] bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0] hover:text-[#0F172A] transition cursor-pointer shrink-0"
        >
          <Share2 className="w-4 h-4" />
        </button>
        {isUnlocked && job.applyUrl ? (
          <a
            href={job.applyUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onApply}
            className="flex-1 py-2.5 min-h-[44px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-none cursor-pointer"
          >
            <span>Apply</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        ) : (
          <button
            type="button"
            onClick={onApply}
            className="flex-1 py-2.5 min-h-[44px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-none cursor-pointer"
          >
            {!isUnlocked && <Lock className="w-3.5 h-3.5" />}
            <span>Apply</span>
          </button>
        )}
      </div>
    </div>
  );
}
