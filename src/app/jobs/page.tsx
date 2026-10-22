"use client";

import React, { useState, useMemo, useEffect, useRef, Suspense } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion, AnimatePresence } from "motion/react";
import { getLiveJobs, getLiveJobById, LiveJob } from "@/lib/jobs/service";
import { getAuthUser, getUserPreferences } from "@/lib/auth/session";
import { getCandidateProfile } from "@/lib/resume/storage";
import { CandidateProfile } from "@/lib/resume/types";
import { UserPreferences } from "@/lib/auth/types";
import {
  addApplicationToTracker,
  getTrackedApplications,
  removeApplicationFromTracker,
} from "@/lib/tracker/storage";
import { getProAccessStatus } from "@/lib/billing/subscription";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import AppIconRail from "@/components/shell/AppIconRail";
import AppTopBar, { TopBarTab } from "@/components/shell/AppTopBar";
import JobDetailView from "@/components/jobs/JobDetailView";
import { computeFitDiagnostics, FitDiagnosticsResult, getDiagnosticsSummary } from "@/lib/matcher/scoring";
import type { User } from "@supabase/supabase-js";
import {
  Search,
  MapPin,
  Building,
  RotateCcw,
  Globe,
  SlidersHorizontal,
  X,
  Check,
  Heart,
  Sparkles,
  Briefcase,
  TrendingUp,
  Clock,
  Calendar,
  Award,
  ChevronDown,
  Lock,
  ArrowRight,
} from "lucide-react";
import CompanyLogo from "@/components/CompanyLogo";
import { toast } from "react-toastify";

const PaywallModal = dynamic(() => import("@/components/PaywallModal"), { ssr: false });

const STORAGE_KEY_HIDDEN_JOBS = "cm_hidden_jobs";

type JobTab = "recommended" | "liked" | "applied" | "external";

interface SavedFilterPreset {
  name: string;
  category?: string;
  search?: string;
  remoteOnly?: boolean;
}

const SAVED_PRESETS: SavedFilterPreset[] = [
  { name: "Senior React & Fullstack", search: "React", remoteOnly: true },
  { name: "Staff Distributed Systems", search: "Distributed", remoteOnly: true },
  { name: "AI & Machine Learning", category: "data", remoteOnly: false },
  { name: "Product Design (Worldwide)", category: "design", remoteOnly: true },
];

function inferJobLevel(title: string): string {
  const t = (title || "").toLowerCase();
  if (t.includes("staff") || t.includes("principal") || t.includes("lead")) return "Staff / Lead";
  if (t.includes("senior") || t.includes("sr.")) return "Senior Level";
  if (t.includes("junior") || t.includes("entry") || t.includes("associate")) return "Entry Level";
  return "Mid-Senior Level";
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

function isPostedUnder24Hours(dateStr?: string): boolean {
  if (!dateStr) return false;
  const s = dateStr.trim().toLowerCase();
  if (s === "today" || s === "just now" || s.includes("minute") || s.includes("hour")) {
    return true;
  }
  const timestamp = Date.parse(dateStr);
  if (isNaN(timestamp)) return false;
  const diffMs = Date.now() - timestamp;
  return diffMs >= 0 && diffMs < 24 * 60 * 60 * 1000;
}

function getJobMatchScore(job: LiveJob, candidate: CandidateProfile | null): number | null {
  if (candidate && candidate.confirmedAt) {
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
        return Math.max(10, Math.min(99, Math.round(res.score)));
      }
    } catch {}
  }
  return null;
}

function getJobDiagnostics(job: LiveJob, candidate: CandidateProfile | null): FitDiagnosticsResult | null {
  if (candidate && candidate.confirmedAt) {
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
  }
  return null;
}

function SmallComponentRing({
  score,
  label,
  size = 36,
  strokeWidth = 3,
}: {
  score: number;
  label: string;
  size?: number;
  strokeWidth?: number;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  return (
    <div
      className="flex flex-col items-center gap-1 shrink-0"
      data-testid={`match-ring-${label.toLowerCase()}`}
      data-score={score}
    >
      <div
        className="relative inline-flex items-center justify-center shrink-0"
        style={{ width: size, height: size }}
      >
        <svg className="w-full h-full -rotate-90" viewBox={`0 0 ${size} ${size}`}>
          {/* #E2E8F0 track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke="#E2E8F0"
            strokeWidth={strokeWidth}
            fill="transparent"
          />
          {/* #2563EB ring */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke="#2563EB"
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            fill="transparent"
            className="transition-all duration-300 ease-out"
          />
        </svg>
        {/* value inside the ring */}
        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-[#0F172A]">
          {score}%
        </span>
      </div>
      {/* 12px label */}
      <span className="text-[12px] font-medium text-[#475569]">{label}</span>
    </div>
  );
}

function getMatchPanelGradient(score: number): string {
  if (score >= 80) return "bg-gradient-to-br from-[#1E3A8A] to-[#2563EB]";
  if (score >= 50) return "bg-gradient-to-br from-[#0F172A] to-[#1E3A8A]";
  return "bg-gradient-to-br from-[#0F172A] to-[#334155]";
}

function CircularMatchRing({
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

interface JobCardItemProps {
  job: LiveJob;
  index: number;
  isSaved: boolean;
  isPro: boolean;
  candidate: CandidateProfile | null;
  shouldReduceMotion: boolean | null;
  handleSelectJob: (job: LiveJob) => void;
  handleSaveJob: (job: LiveJob) => void;
  handleLockedAction: (e: React.MouseEvent) => void;
}

const JobCardItem = React.memo(function JobCardItem({
  job,
  index,
  isSaved,
  isPro,
  candidate,
  shouldReduceMotion,
  handleSelectJob,
  handleSaveJob,
  handleLockedAction,
}: JobCardItemProps) {
  const staggerDelay = Math.min(index * 0.03, 0.3);
  const confirmedResumeKey = candidate?.confirmedAt || "";
  const diagnostics = useMemo(
    () => getJobDiagnostics(job, candidate),
    [job.id, confirmedResumeKey]
  );
  const matchScore = useMemo(
    () => (diagnostics ? Math.max(10, Math.min(99, Math.round(diagnostics.score))) : null),
    [diagnostics]
  );
  const matchLabel =
    matchScore !== null
      ? matchScore > 70
        ? "Great match"
        : matchScore >= 50
        ? "Good match"
        : "Fair match"
      : "";

  return (
    <motion.article
      key={job.id}
      data-testid="job-card"
      initial={shouldReduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        shouldReduceMotion
          ? { duration: 0.01 }
          : { duration: 0.22, delay: staggerDelay, ease: [0.22, 1, 0.36, 1] }
      }
      onClick={() => handleSelectJob(job)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) {
          handleSelectJob(job);
        }
      }}
      className="group bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 shadow-none transition-[box-shadow,border-color] duration-200 hover:ring-[#93C5FD] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none space-y-4 cursor-pointer"
    >
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="flex items-start gap-3.5 min-w-0 flex-1">
          {/* 48px company logo square */}
          <CompanyLogo
            company={job.company}
            applyUrl={job.applyUrl}
            className="w-12 h-12 rounded-xl shrink-0 object-contain p-1 border border-[#E2E8F0] bg-white"
          />

          <div className="relative min-w-0 flex-1 grid grid-cols-1 grid-rows-1">
            {/* View A: Standard content (Title, Company, Chips) - crossfades out over 0.2s on desktop hover/focus */}
            <div className="col-start-1 row-start-1 w-full space-y-1 transition-opacity duration-200 motion-reduce:transition-none sm:group-hover:opacity-0 sm:group-focus-within:opacity-0 sm:group-focus:opacity-0 pointer-events-auto sm:group-hover:pointer-events-none sm:group-focus-within:pointer-events-none sm:group-focus:pointer-events-none">
              {/* Title bold 16px ink */}
              <h2 className="text-[16px] font-bold text-[#0F172A] leading-snug break-words">
                {job.title}
              </h2>

              {/* Company 14px #475569 */}
              <div className="text-[14px] text-[#475569]">
                <span className={!isPro ? "filter blur-[4.5px] select-none" : ""}>
                  {job.company || "Verified Employer"}
                </span>
                {job.category && <span className="capitalize"> · {job.category}</span>}
              </div>

              {/* Row of small gray chips: location, work type, salary only if present, posted time */}
              <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
                <span className="inline-flex items-center text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
                  {isPro ? (job.location || "Remote") : <span className="filter blur-[3px] select-none">Location Locked</span>}
                </span>
                <span className="inline-flex items-center text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
                  {job.type || "Full-time"}
                </span>
                {job.salary && (
                  <span className="inline-flex items-center text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
                    {isPro ? job.salary : "••••••••"}
                  </span>
                )}
                <span className="inline-flex items-center text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
                  {formatRelativeTime(job.postedAt || job.date)}
                </span>
              </div>

              {/* Mobile: Fit Match panel moves under the chips */}
              <div className="sm:hidden pt-2">
                {matchScore !== null ? (
                  <div className={`flex items-center justify-between p-3 rounded-[16px] ${getMatchPanelGradient(matchScore)} text-white`}>
                    <div className="flex items-center gap-3">
                      <CircularMatchRing
                        score={matchScore}
                        size={44}
                        strokeWidth={4}
                        isPro={isPro}
                      />
                      <div className="text-left">
                        <div className="text-xs font-bold text-white uppercase tracking-wider">
                          Fit Match
                        </div>
                        <div className="text-[11px] text-slate-300">
                          {isPro ? matchLabel : "Locked Preview"}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <Link
                    href="/resume"
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-2.5 p-3 rounded-[16px] bg-[#F8FAFC] hover:bg-[#EFF6FF] border border-[#E2E8F0] hover:border-[#93C5FD] text-left transition-all duration-200"
                  >
                    <div className="w-8 h-8 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center shrink-0">
                      <Sparkles className="w-4 h-4 text-[#2563EB]" />
                    </div>
                    <span className="text-xs font-semibold text-[#0F172A]">
                      Upload your resume to see your real match
                    </span>
                  </Link>
                )}
              </div>
            </div>

            {/* View B: Desktop Hover panel "Why this job is a match" (14px bold ink) - crossfades in over 0.2s */}
            <div
              data-testid="card-hover-match-panel"
              className="col-start-1 row-start-1 w-full hidden sm:flex flex-col justify-center space-y-1.5 opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 sm:group-focus:opacity-100 transition-opacity duration-200 motion-reduce:transition-none pointer-events-none sm:group-hover:pointer-events-auto sm:group-focus-within:pointer-events-auto sm:group-focus:pointer-events-auto"
            >
              <h3 className="text-[14px] font-bold text-[#0F172A] leading-snug">
                Why this job is a match
              </h3>

              {diagnostics ? (
                <>
                  <p className="text-[12px] text-[#475569] leading-snug line-clamp-2">
                    {getDiagnosticsSummary(diagnostics)}
                  </p>

                  <div className="flex items-center gap-4 pt-0.5" data-testid="match-component-rings">
                    <SmallComponentRing
                      label="Experience"
                      score={Math.min(100, Math.max(0, Math.round((diagnostics.breakdown.experienceScore / 15) * 100)))}
                    />
                    <SmallComponentRing
                      label="Skill"
                      score={Math.min(100, Math.max(0, Math.round((diagnostics.breakdown.skillScore / 50) * 100)))}
                    />
                    {typeof (diagnostics.breakdown as any)?.industryScore === "number" && (
                      <SmallComponentRing
                        label="Industry"
                        score={Math.min(100, Math.max(0, Math.round((diagnostics.breakdown as any).industryScore)))}
                      />
                    )}
                  </div>
                </>
              ) : (
                <div className="pt-0.5">
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
          </div>
        </div>

        {/* Right: Fit Match panel from PR #68, unchanged (hidden on mobile, sm:flex) */}
        {matchScore !== null ? (
          <div className={`hidden sm:flex flex-col items-center justify-between p-3.5 sm:p-4 rounded-[16px] ${getMatchPanelGradient(matchScore)} text-white w-44 shrink-0 text-center border border-white/10 shadow-none space-y-2`}>
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-300 uppercase tracking-wider">
              <Sparkles className="w-3 h-3 text-blue-400" />
              <span>Fit Match</span>
            </div>

            <CircularMatchRing
              score={matchScore}
              size={64}
              strokeWidth={5}
              isPro={isPro}
            />

            <div>
              <div className="text-xs font-bold text-slate-100">
                {isPro ? matchLabel : "Locked Preview"}
              </div>
              <div className="flex flex-wrap items-center justify-center gap-1.5 text-[10px] text-slate-400 pt-1">
                <span className="inline-flex items-center gap-0.5 text-emerald-400">
                  ✓ {job.remote ? "Remote" : "Verified"}
                </span>
                <span>•</span>
                <span className="inline-flex items-center gap-0.5 text-emerald-400">
                  ✓ Direct ATS
                </span>
              </div>
            </div>
          </div>
        ) : (
          <Link
            href="/resume"
            onClick={(e) => e.stopPropagation()}
            className="hidden sm:flex flex-col items-center justify-center p-3.5 sm:p-4 rounded-[16px] bg-[#F8FAFC] hover:bg-[#EFF6FF] border border-[#E2E8F0] hover:border-[#93C5FD] text-center w-44 shrink-0 transition-all duration-200 group/cta space-y-2.5 self-stretch focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1"
          >
            <div className="w-9 h-9 rounded-full bg-[#EFF6FF] group-hover/cta:bg-[#DBEAFE] border border-[#BFDBFE] flex items-center justify-center transition-colors">
              <Sparkles className="w-4 h-4 text-[#2563EB]" />
            </div>
            <span className="text-xs font-semibold text-[#0F172A] group-hover/cta:text-[#1D4ED8] transition-colors leading-snug">
              Upload your resume to see your real match
            </span>
          </Link>
        )}
      </div>

      {/* Bottom row of the card: Save icon button and primary blue pill Apply */}
      <div className="flex items-center justify-between pt-3 border-t border-[#E2E8F0]">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleSaveJob(job);
          }}
          aria-label={isSaved ? "Unlike job" : "Save job"}
          title={isSaved ? "Saved to Tracker (Liked)" : "Like & save to Tracker"}
          className={`w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border transition cursor-pointer ${
            isSaved
              ? "border-rose-200 bg-rose-50 text-rose-600"
              : "border-[#E2E8F0] bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0] hover:text-[#0F172A]"
          }`}
        >
          <Heart className={`w-4 h-4 ${isSaved ? "fill-rose-500 text-rose-500" : ""}`} />
        </button>

        <div className="flex items-center gap-2">
          {isPro ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleSelectJob(job);
              }}
              className="inline-flex items-center gap-1.5 px-5 py-2 min-h-[44px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition shadow-none focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 cursor-pointer"
            >
              <span>Apply</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleLockedAction(e);
              }}
              className="inline-flex items-center gap-1.5 px-5 py-2 min-h-[44px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition shadow-none focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 cursor-pointer"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Apply</span>
            </button>
          )}
        </div>
      </div>
    </motion.article>
  );
});

function JobsPageInner() {
  const router = useRouter();
  const shouldReduceMotion = useReducedMotion();

  // Active Tab: 'recommended' | 'liked' | 'applied' | 'external'
  const [activeTab, setActiveTab] = useState<JobTab>("recommended");

  // In-place Selected Job for Detail View
  const [selectedJob, setSelectedJob] = useState<LiveJob | null>(null);

  // Search & Filter state
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState("");
  const [selectedLevel, setSelectedLevel] = useState("");
  const [selectedJobType, setSelectedJobType] = useState("");
  const [sortBy, setSortBy] = useState<"match" | "newest">("newest");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);

  // Hidden jobs list persisted in localStorage
  const [hiddenJobIds, setHiddenJobIds] = useState<string[]>([]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_HIDDEN_JOBS);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setHiddenJobIds(parsed);
        }
      }
    } catch {
      // Ignore localStorage read errors
    }
  }, []);

  // User state
  const [user, setUser] = useState<User | null>(null);
  const [isPro, setIsPro] = useState(false);
  const [isProDefinitive, setIsProDefinitive] = useState(false);
  const [candidate, setCandidate] = useState<CandidateProfile | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [savedJobIds, setSavedJobIds] = useState<string[]>([]);
  const [appliedJobIds, setAppliedJobIds] = useState<string[]>([]);
  const [appliedCount, setAppliedCount] = useState<number>(0);
  const [isPaywallOpen, setIsPaywallOpen] = useState(false);
  const [page, setPage] = useState(1);

  // Live Supabase Jobs Data
  const [liveJobs, setLiveJobs] = useState<LiveJob[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [loadingJobs, setLoadingJobs] = useState<boolean>(true);
  const lastQueryKeyRef = useRef<string>("");

  // Static export safe: Read URL query parameters client-side via window.location.search
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const qSearch = params.get("search") || "";
    const qCategory = params.get("category") || params.get("categories") || "";
    const qRemote = params.get("remote") === "true";
    const qTab = params.get("tab");
    const qId = params.get("id") || params.get("jobId");

    if (qSearch) setSearch(qSearch);
    if (qCategory) setSelectedCategory(qCategory);
    if (qRemote) setRemoteOnly(true);
    if (qTab === "liked" || qTab === "saved") {
      setActiveTab("liked");
    } else if (qTab === "applied") {
      setActiveTab("applied");
    } else if (qTab === "external") {
      setActiveTab("external");
    } else if (qTab === "recommended" || qTab === "foryou" || qTab === "all") {
      setActiveTab("recommended");
    }

    if (qId) {
      getLiveJobById(qId, isPro).then((job) => {
        if (job) setSelectedJob(job);
      });
    }
  }, [isPro]);

  // Synchronize browser back/forward buttons with in-place detail view
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const qId = params.get("id") || params.get("jobId");
      if (qId) {
        const found = liveJobs.find((j) => j.id === qId);
        if (found) {
          setSelectedJob(found);
        } else {
          getLiveJobById(qId, isPro).then((job) => {
            if (job) setSelectedJob(job);
          });
        }
      } else {
        setSelectedJob(null);
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [liveJobs, isPro]);

  useEffect(() => {
    let cancelled = false;

    async function loadInitialContext() {
      try {
        const [u, proRes, cp, apps] = await Promise.all([
          getAuthUser(),
          getProAccessStatus(),
          getCandidateProfile(),
          getTrackedApplications(),
        ]);

        if (cancelled) return;

        setUser(u);
        setIsPro(proRes.isPro);
        setIsProDefinitive(Boolean(proRes.isDefinitive));
        setCandidate(cp && cp.confirmedAt ? cp : null);
        setSavedJobIds(apps.map((a) => a.jobId || ""));
        const appliedApps = apps.filter((a) => a.stage === "applied");
        const appliedIds = appliedApps.map((a) => a.jobId || "").filter(Boolean);
        setAppliedJobIds(appliedIds);
        setAppliedCount(appliedApps.length);

        if (u) {
          getUserPreferences(u.id).then((p) => {
            if (!cancelled) {
              setPreferences(p);
            }
          });
        }
      } catch (err) {
        console.warn("Failed to load initial context on jobs page:", err);
      }
    }

    loadInitialContext();

    const handleSubUpdate = () => {
      getProAccessStatus().then((res) => {
        setIsPro(res.isPro);
        setIsProDefinitive(Boolean(res.isDefinitive));
      });
    };

    const handleProfileUpdate = () => {
      getCandidateProfile().then((cp) => {
        if (cp && cp.confirmedAt) {
          setCandidate(cp);
        } else {
          setCandidate(null);
        }
      });
    };

    window.addEventListener("careermonke_pro_updated", handleSubUpdate);
    window.addEventListener("careermonke_auth_updated", handleSubUpdate);
    window.addEventListener("careermonke_profile_updated", handleProfileUpdate);
    return () => {
      cancelled = true;
      window.removeEventListener("careermonke_pro_updated", handleSubUpdate);
      window.removeEventListener("careermonke_auth_updated", handleSubUpdate);
      window.removeEventListener("careermonke_profile_updated", handleProfileUpdate);
    };
  }, []);

  const hasConfirmedResume = Boolean(candidate && candidate.confirmedAt);
  const [loadingMore, setLoadingMore] = useState(false);

  // Fetch live active jobs from Supabase whenever search, category, filters, sorting, or profile updates
  useEffect(() => {
    if (user && !isPro && !isProDefinitive) {
      setLoadingJobs(true);
      return;
    }

    const isRecommended = activeTab === "recommended";
    const effectiveSortBy = isRecommended && sortBy === "match" ? "match" : sortBy;
    const effectiveCandidate = (isRecommended || sortBy === "match") ? candidate : null;
    const effectivePreferences = (isRecommended || sortBy === "match") ? preferences : null;

    const queryKey = JSON.stringify({
      tab: activeTab,
      category: selectedCategory,
      search: search.trim(),
      remoteOnly,
      location: selectedLocation,
      level: selectedLevel,
      jobType: selectedJobType,
      isPro,
      sortBy: effectiveSortBy,
      candidateUpdated: effectiveCandidate?.updatedAt || null,
      preferencesUpdated: effectivePreferences?.updatedAt || null,
    });

    if (queryKey === lastQueryKeyRef.current) {
      return;
    }
    lastQueryKeyRef.current = queryKey;

    setLoadingJobs(true);
    setPage(1);

    getLiveJobs({
      page: 1,
      pageSize: 50,
      category: selectedCategory,
      search,
      remoteOnly,
      isPro,
      sortBy: effectiveSortBy,
      candidate: effectiveCandidate,
      preferences: effectivePreferences,
    })
      .then((res) => {
        if (queryKey === lastQueryKeyRef.current) {
          setLiveJobs(res.jobs);
          setTotalCount(res.totalCount);
          setLoadingJobs(false);
        }
      })
      .catch((err) => {
        console.warn("Failed to fetch live jobs:", err);
        if (queryKey === lastQueryKeyRef.current) {
          setLoadingJobs(false);
        }
      });
  }, [
    selectedCategory,
    search,
    remoteOnly,
    selectedLocation,
    selectedLevel,
    selectedJobType,
    isPro,
    isProDefinitive,
    user,
    sortBy,
    activeTab,
    candidate,
    preferences,
  ]);

  const handleLoadMore = async () => {
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const isRecommended = activeTab === "recommended";
      const effectiveSortBy = isRecommended && sortBy === "match" ? "match" : sortBy;
      const effectiveCandidate = (isRecommended || sortBy === "match") ? candidate : null;
      const effectivePreferences = (isRecommended || sortBy === "match") ? preferences : null;

      const res = await getLiveJobs({
        page: nextPage,
        pageSize: 50,
        category: selectedCategory,
        search,
        remoteOnly,
        isPro,
        sortBy: effectiveSortBy,
        candidate: effectiveCandidate,
        preferences: effectivePreferences,
      });
      setLiveJobs((prev) => [...prev, ...res.jobs]);
      setPage(nextPage);
      if (res.totalCount) setTotalCount(res.totalCount);
    } catch (e) {
      console.warn("Failed to load more jobs", e);
    } finally {
      setLoadingMore(false);
    }
  };

  // Filtered Jobs based on activeTab, client-side secondary filters, and hidden ids
  const filteredJobs = useMemo(() => {
    let result = liveJobs.filter((job) => !hiddenJobIds.includes(job.id));

    if (activeTab === "liked") {
      result = result.filter((job) => savedJobIds.includes(job.id));
    } else if (activeTab === "applied") {
      result = result.filter((job) => appliedJobIds.includes(job.id));
    } else if (activeTab === "external") {
      result = result.filter((job) => Boolean(job.directSource));
    }

    if (selectedLocation) {
      result = result.filter((job) =>
        (job.location || "").toLowerCase().includes(selectedLocation.toLowerCase())
      );
    }

    if (selectedLevel) {
      result = result.filter((job) =>
        inferJobLevel(job.title).toLowerCase().includes(selectedLevel.toLowerCase())
      );
    }

    if (selectedJobType) {
      result = result.filter((job) =>
        (job.type || "").toLowerCase().includes(selectedJobType.toLowerCase())
      );
    }

    return result;
  }, [
    liveJobs,
    activeTab,
    savedJobIds,
    appliedJobIds,
    hiddenJobIds,
    selectedLocation,
    selectedLevel,
    selectedJobType,
  ]);

  const displayedJobs = filteredJobs;

  const handleResetFilters = () => {
    setSearch("");
    setSelectedCategory("");
    setRemoteOnly(false);
    setSelectedLocation("");
    setSelectedLevel("");
    setSelectedJobType("");
    setSortBy("newest");
    setPage(1);
    setMobileFiltersOpen(false);
    setOpenDropdown(null);
  };

  const handleSaveJob = async (job: LiveJob) => {
    if (!user) {
      toast.info("Please create a free account or sign in to like and track jobs.");
      router.push(`/signup?next=${encodeURIComponent("/jobs")}`);
      return;
    }

    if (savedJobIds.includes(job.id)) {
      try {
        await removeApplicationFromTracker(job.id);
        setSavedJobIds((prev) => prev.filter((id) => id !== job.id));
        toast.info(`Removed "${job.title}" from Liked Jobs.`);
      } catch (e) {
        toast.error("Could not update saved job.");
      }
      return;
    }

    try {
      await addApplicationToTracker({
        jobId: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        salaryText: job.salary,
        applyUrl: job.applyUrl,
        stage: "saved",
      });
      setSavedJobIds((prev) => [...prev, job.id]);
      toast.success(`Liked "${job.title}"! Saved to your tracker.`);
    } catch (e) {
      toast.error("Could not save job.");
    }
  };

  const handleSelectJob = async (job: LiveJob) => {
    setSelectedJob(job);
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      params.set("id", job.id);
      window.history.pushState({ jobId: job.id }, "", `${window.location.pathname}?${params.toString()}`);
    }
    // Fetch full job record with description if missing or short
    if (!job.description || job.description.length < 50) {
      try {
        const fullJob = await getLiveJobById(job.id, isPro);
        if (fullJob) setSelectedJob(fullJob);
      } catch {}
    }
  };

  const handleBackToList = () => {
    setSelectedJob(null);
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      params.delete("id");
      params.delete("jobId");
      const nextQuery = params.toString();
      window.history.pushState({}, "", nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname);
    }
  };

  const handleLockedAction = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!user) {
      const currentPath =
        typeof window !== "undefined"
          ? window.location.pathname + window.location.search
          : "/jobs";
      router.push(`/login?next=${encodeURIComponent(currentPath)}`);
    } else {
      setIsPaywallOpen(true);
    }
  };

  const handleApplySavedFilter = (preset: SavedFilterPreset) => {
    if (preset.search) setSearch(preset.search);
    if (preset.category !== undefined) setSelectedCategory(preset.category);
    if (preset.remoteOnly !== undefined) setRemoteOnly(preset.remoteOnly);
    toast.info(`Applied filter: "${preset.name}"`);
  };

  const activeFiltersCount =
    (search.trim() ? 1 : 0) +
    (selectedCategory ? 1 : 0) +
    (remoteOnly ? 1 : 0) +
    (selectedLocation ? 1 : 0) +
    (selectedLevel ? 1 : 0) +
    (selectedJobType ? 1 : 0);
  const hasActiveFilters = activeFiltersCount > 0;

  const externalJobsCount = useMemo(() => {
    return liveJobs.filter((job) => Boolean(job.directSource)).length;
  }, [liveJobs]);

  const jobTabs: TopBarTab[] = [
    {
      id: "recommended",
      label: "Recommended",
      count: totalCount > 0 ? totalCount.toLocaleString() : liveJobs.length,
      active: activeTab === "recommended",
      onClick: () => {
        setActiveTab("recommended");
        setPage(1);
      },
    },
    {
      id: "liked",
      label: "Saved",
      count: savedJobIds.length,
      active: activeTab === "liked",
      onClick: () => {
        setActiveTab("liked");
        setPage(1);
      },
    },
    {
      id: "applied",
      label: "Applied",
      count: appliedCount,
      active: activeTab === "applied",
      onClick: () => {
        setActiveTab("applied");
        setPage(1);
      },
    },
    {
      id: "external",
      label: "External",
      count: !loadingJobs && externalJobsCount > 0 ? externalJobsCount : undefined,
      active: activeTab === "external",
      onClick: () => {
        setActiveTab("external");
        setPage(1);
      },
    },
  ];

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex flex-col font-sans">
      {!user && <GuideHeader />}

      {/* Left Icon Rail (fixed 72px wide, full height, white, #E2E8F0; bottom tab bar on mobile) */}
      {user && <AppIconRail />}

      {/* Main Content Area (offset by 72px on desktop when user is logged in) */}
      <div className={`flex-1 ${user ? "md:pl-[72px]" : ""} flex flex-col min-w-0 ${user ? "pb-16 md:pb-0" : ""}`}>
        {/* Top bar for logged-in user: 56px, white, 1px bottom border */}
        {user && (
          <AppTopBar
            pageLabel="JOBS"
            tabs={jobTabs}
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search by title or company"
            user={user}
            isPro={isPro}
          />
        )}
        <main
          id="main-content"
          className="flex-1 max-w-[880px] w-full mx-auto px-4 sm:px-6 py-5 sm:py-6 space-y-4 pb-24 lg:pb-12"
        >
          {selectedJob ? (
            /* In-place job detail swap inside the same shell */
            <JobDetailView
              job={selectedJob}
              candidate={candidate}
              user={user}
              isPro={isPro}
              isSaved={savedJobIds.includes(selectedJob.id)}
              onSave={() => handleSaveJob(selectedJob)}
              onApply={(e) => {
                if (!isPro) {
                  handleLockedAction(e);
                }
              }}
              onBack={handleBackToList}
            />
          ) : (
            <>
              {/* Header Row: Title "JOBS" + Tabs with Count Badges + Search Box (signed-out view) */}
              <div className="space-y-4">
                {!user && (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-4 sm:gap-6 min-w-0 max-w-full">
                      <h1 className="text-[18px] font-bold text-[#0F172A] tracking-wider uppercase">
                        JOBS
                      </h1>

                      {/* Tabs: Recommended, Liked, Applied, External */}
                      <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-200/80 border border-slate-300/70 overflow-x-auto max-w-full no-scrollbar">
                        <button
                          type="button"
                          onClick={() => {
                            setActiveTab("recommended");
                            setPage(1);
                          }}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 min-h-[44px] cursor-pointer ${
                            activeTab === "recommended"
                              ? "bg-white text-blue-600 shadow-none ring-1 ring-[#E2E8F0]"
                              : "text-slate-600 hover:text-slate-900"
                          }`}
                        >
                          <span>Recommended</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-blue-100 text-blue-700">
                            {totalCount > 0 ? totalCount.toLocaleString() : liveJobs.length}
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setActiveTab("liked");
                            setPage(1);
                          }}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 min-h-[44px] cursor-pointer ${
                            activeTab === "liked"
                              ? "bg-white text-blue-600 shadow-none ring-1 ring-[#E2E8F0]"
                              : "text-slate-600 hover:text-slate-900"
                          }`}
                        >
                          <span>Liked</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-slate-200 text-slate-700">
                            {savedJobIds.length}
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setActiveTab("applied");
                            setPage(1);
                          }}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 min-h-[44px] cursor-pointer ${
                            activeTab === "applied"
                              ? "bg-white text-blue-600 shadow-none ring-1 ring-[#E2E8F0]"
                              : "text-slate-600 hover:text-slate-900"
                          }`}
                        >
                          <span>Applied</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-slate-200 text-slate-700">
                            {appliedCount}
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setActiveTab("external");
                            setPage(1);
                          }}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 min-h-[44px] cursor-pointer ${
                            activeTab === "external"
                              ? "bg-white text-blue-600 shadow-none ring-1 ring-[#E2E8F0]"
                              : "text-slate-600 hover:text-slate-900"
                          }`}
                        >
                          <span>External</span>
                          {!loadingJobs && externalJobsCount > 0 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-slate-200 text-slate-700">
                              {externalJobsCount}
                            </span>
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Search Box on the Right */}
                    <div className="relative w-full sm:w-80">
                      <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        aria-label="Search by job title, company, or keyword"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search by job title, company, or keyword..."
                        className="w-full text-xs sm:text-sm pl-10 pr-9 py-2.5 rounded-xl border border-[#CBD5E1] bg-white text-[#0F172A] placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 shadow-none min-h-[44px]"
                      />
                      {search && (
                        <button
                          type="button"
                          onClick={() => setSearch("")}
                          aria-label="Clear search text"
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-1 rounded-full hover:bg-slate-100 transition cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* 3. FILTER BAR: ROUNDED PILL DROPDOWNS IN A WRAP ROW */}
                <div className={`${user ? "sticky top-[56px]" : "sticky top-[64px]"} z-tk-sticky bg-white/95 backdrop-blur-md rounded-[16px] border border-[#E2E8F0] shadow-none ring-1 ring-[#E2E8F0] p-3 space-y-2.5`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {/* Pill Dropdowns Row */}
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Location Pill */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setOpenDropdown(openDropdown === "loc" ? null : "loc")}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[12px] font-medium transition cursor-pointer min-h-[36px] ${
                            selectedLocation
                              ? "bg-[#DBEAFE] border-[#BFDBFE] text-[#1E3A8A]"
                              : "bg-[#F1F5F9] border-[#E2E8F0] text-[#0F172A] hover:border-[#CBD5E1]"
                          }`}
                        >
                          <MapPin className="w-3.5 h-3.5 text-slate-400" />
                          <span>{selectedLocation || "Location"}</span>
                          <ChevronDown className="w-3 h-3 text-slate-400" />
                        </button>
                        {openDropdown === "loc" && (
                          <div className="absolute left-0 mt-1.5 w-44 bg-white border border-[#E2E8F0] rounded-[16px] shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                            {["", "United States", "Europe", "India", "Remote"].map((loc) => (
                              <button
                                key={loc || "all"}
                                type="button"
                                onClick={() => {
                                  setSelectedLocation(loc);
                                  setOpenDropdown(null);
                                }}
                                className={`w-full text-left px-2.5 py-1.5 rounded-lg font-medium transition cursor-pointer ${
                                  selectedLocation === loc ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold" : "text-slate-700 hover:bg-slate-50"
                                }`}
                              >
                                {loc || "All Locations"}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Job Title Pill */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setOpenDropdown(openDropdown === "title" ? null : "title")}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[12px] font-medium transition cursor-pointer min-h-[36px] ${
                            search
                              ? "bg-[#DBEAFE] border-[#BFDBFE] text-[#1E3A8A]"
                              : "bg-[#F1F5F9] border-[#E2E8F0] text-[#0F172A] hover:border-[#CBD5E1]"
                          }`}
                        >
                          <Briefcase className="w-3.5 h-3.5 text-slate-400" />
                          <span>{search || "Job title"}</span>
                          <ChevronDown className="w-3 h-3 text-slate-400" />
                        </button>
                        {openDropdown === "title" && (
                          <div className="absolute left-0 mt-1.5 w-52 bg-white border border-[#E2E8F0] rounded-[16px] shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                            {["", "Engineer", "Fullstack", "Backend", "Frontend", "Product Manager", "Designer", "DevOps", "AI"].map((t) => (
                              <button
                                key={t || "all"}
                                type="button"
                                onClick={() => {
                                  setSearch(t);
                                  setOpenDropdown(null);
                                }}
                                className={`w-full text-left px-2.5 py-1.5 rounded-lg font-medium transition cursor-pointer ${
                                  search === t ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold" : "text-slate-700 hover:bg-slate-50"
                                }`}
                              >
                                {t || "All Roles"}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Level Pill */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setOpenDropdown(openDropdown === "level" ? null : "level")}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[12px] font-medium transition cursor-pointer min-h-[36px] ${
                            selectedLevel
                              ? "bg-[#DBEAFE] border-[#BFDBFE] text-[#1E3A8A]"
                              : "bg-[#F1F5F9] border-[#E2E8F0] text-[#0F172A] hover:border-[#CBD5E1]"
                          }`}
                        >
                          <TrendingUp className="w-3.5 h-3.5 text-slate-400" />
                          <span>{selectedLevel || "Level"}</span>
                          <ChevronDown className="w-3 h-3 text-slate-400" />
                        </button>
                        {openDropdown === "level" && (
                          <div className="absolute left-0 mt-1.5 w-44 bg-white border border-[#E2E8F0] rounded-[16px] shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                            {["", "Senior", "Lead", "Mid", "Entry"].map((lvl) => (
                              <button
                                key={lvl || "all"}
                                type="button"
                                onClick={() => {
                                  setSelectedLevel(lvl);
                                  setOpenDropdown(null);
                                }}
                                className={`w-full text-left px-2.5 py-1.5 rounded-lg font-medium transition cursor-pointer ${
                                  selectedLevel === lvl ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold" : "text-slate-700 hover:bg-slate-50"
                                }`}
                              >
                                {lvl ? `${lvl} Level` : "All Levels"}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Job Type Pill */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setOpenDropdown(openDropdown === "type" ? null : "type")}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[12px] font-medium transition cursor-pointer min-h-[36px] ${
                            selectedJobType
                              ? "bg-[#DBEAFE] border-[#BFDBFE] text-[#1E3A8A]"
                              : "bg-[#F1F5F9] border-[#E2E8F0] text-[#0F172A] hover:border-[#CBD5E1]"
                          }`}
                        >
                          <Clock className="w-3.5 h-3.5 text-slate-400" />
                          <span>{selectedJobType || "Job type"}</span>
                          <ChevronDown className="w-3 h-3 text-slate-400" />
                        </button>
                        {openDropdown === "type" && (
                          <div className="absolute left-0 mt-1.5 w-44 bg-white border border-[#E2E8F0] rounded-[16px] shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                            {["", "Full-time", "Contract", "Part-time"].map((jt) => (
                              <button
                                key={jt || "all"}
                                type="button"
                                onClick={() => {
                                  setSelectedJobType(jt);
                                  setOpenDropdown(null);
                                }}
                                className={`w-full text-left px-2.5 py-1.5 rounded-lg font-medium transition cursor-pointer ${
                                  selectedJobType === jt ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold" : "text-slate-700 hover:bg-slate-50"
                                }`}
                              >
                                {jt || "All Job Types"}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Work Model Pill */}
                      <button
                        type="button"
                        onClick={() => setRemoteOnly(!remoteOnly)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs transition cursor-pointer min-h-[36px] ${
                          remoteOnly
                            ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8] font-bold"
                            : "bg-[#F1F5F9] border-[#E2E8F0] text-[#0F172A] hover:bg-[#E2E8F0]"
                        }`}
                      >
                        <Globe className="w-3.5 h-3.5 text-slate-400" />
                        <span>Work model</span>
                        {remoteOnly ? <Check className="w-3 h-3 text-[#2563EB]" /> : <ChevronDown className="w-3 h-3 text-slate-400" />}
                      </button>

                      {/* Date Posted Pill */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setOpenDropdown(openDropdown === "date" ? null : "date")}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[#E2E8F0] bg-[#F1F5F9] text-[#0F172A] hover:bg-[#E2E8F0] text-xs transition cursor-pointer min-h-[36px]"
                        >
                          <Calendar className="w-3.5 h-3.5 text-slate-400" />
                          <span>Date posted</span>
                          <ChevronDown className="w-3 h-3 text-slate-400" />
                        </button>
                        {openDropdown === "date" && (
                          <div className="absolute left-0 mt-1.5 w-44 bg-white border border-[#E2E8F0] rounded-[16px] shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                            {["Any time", "Past 24 hours", "Past week", "Past month"].map((d) => (
                              <button
                                key={d}
                                type="button"
                                onClick={() => {
                                  toast.info(`Filtered: ${d}`);
                                  setOpenDropdown(null);
                                }}
                                className="w-full text-left px-2.5 py-1.5 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition cursor-pointer"
                              >
                                {d}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Industry Pill */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setOpenDropdown(openDropdown === "ind" ? null : "ind")}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[12px] font-medium transition cursor-pointer min-h-[36px] ${
                            selectedCategory
                              ? "bg-[#DBEAFE] border-[#BFDBFE] text-[#1E3A8A]"
                              : "bg-[#F1F5F9] border-[#E2E8F0] text-[#0F172A] hover:border-[#CBD5E1]"
                          }`}
                        >
                          <Building className="w-3.5 h-3.5 text-slate-400" />
                          <span>{selectedCategory || "Industry"}</span>
                          <ChevronDown className="w-3 h-3 text-slate-400" />
                        </button>
                        {openDropdown === "ind" && (
                          <div className="absolute left-0 mt-1.5 w-48 bg-white border border-[#E2E8F0] rounded-[16px] shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                            {["", "tech", "data", "design", "marketing", "finance"].map((cat) => (
                              <button
                                key={cat || "all"}
                                type="button"
                                onClick={() => {
                                  setSelectedCategory(cat);
                                  setOpenDropdown(null);
                                }}
                                className={`w-full text-left px-2.5 py-1.5 rounded-lg font-medium capitalize transition cursor-pointer ${
                                  selectedCategory === cat ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold" : "text-slate-700 hover:bg-slate-50"
                                }`}
                              >
                                {cat ? cat : "All Industries"}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Experience Pill */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setOpenDropdown(openDropdown === "exp" ? null : "exp")}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[#E2E8F0] bg-[#F1F5F9] text-[#0F172A] hover:bg-[#E2E8F0] text-xs transition cursor-pointer min-h-[36px]"
                        >
                          <Award className="w-3.5 h-3.5 text-slate-400" />
                          <span>Experience</span>
                          <ChevronDown className="w-3 h-3 text-slate-400" />
                        </button>
                        {openDropdown === "exp" && (
                          <div className="absolute left-0 mt-1.5 w-44 bg-white border border-[#E2E8F0] rounded-[16px] shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                            {["All Experience", "1-3 Years", "3-5 Years", "5+ Years", "8+ Years"].map((e) => (
                              <button
                                key={e}
                                type="button"
                                onClick={() => {
                                  toast.info(`Experience filter: ${e}`);
                                  setOpenDropdown(null);
                                }}
                                className="w-full text-left px-2.5 py-1.5 rounded-lg font-medium text-slate-700 hover:bg-slate-50 transition cursor-pointer"
                              >
                                {e}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* All Filters Button */}
                      <button
                        type="button"
                        onClick={() => setMobileFiltersOpen((prev) => !prev)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-[#E2E8F0] bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#0F172A] text-xs font-bold transition cursor-pointer min-h-[36px]"
                      >
                        <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" />
                        <span>All Filters</span>
                        {activeFiltersCount > 0 && (
                          <span className="w-4 h-4 rounded-full bg-[#2563EB] text-white text-[10px] font-bold flex items-center justify-center">
                            {activeFiltersCount}
                          </span>
                        )}
                      </button>
                    </div>

                    {/* Sort: Recommended on the Far Right */}
                    <div className="flex items-center gap-1.5 ml-auto">
                      <select
                        aria-label="Sort by"
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as any)}
                        className="text-xs font-bold py-1.5 px-3 rounded-full border border-[#E2E8F0] bg-white text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#93C5FD] cursor-pointer shadow-none min-h-[36px]"
                      >
                        <option value="newest">Sort: Recommended</option>
                        <option value="newest">Newest First</option>
                        {user && (
                          <option value="match" disabled={!hasConfirmedResume}>
                            {hasConfirmedResume ? "Highest Fit Match" : "Highest Match (Requires Resume)"}
                          </option>
                        )}
                      </select>
                    </div>
                  </div>

                  {/* Collapsible All-Filters Drawer */}
                  <AnimatePresence>
                    {mobileFiltersOpen && (
                      <motion.div
                        initial={shouldReduceMotion ? false : { height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={shouldReduceMotion ? undefined : { height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden border-t border-[#E2E8F0] pt-3 space-y-3"
                      >
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                          <div>
                            <label className="font-bold text-slate-700 block mb-1">Location scope</label>
                            <select
                              value={selectedLocation}
                              onChange={(e) => setSelectedLocation(e.target.value)}
                              className="w-full py-2 px-2.5 rounded-lg border border-[#E2E8F0] bg-white text-slate-800"
                            >
                              <option value="">All Locations</option>
                              <option value="United States">United States</option>
                              <option value="Europe">Europe</option>
                              <option value="India">India</option>
                              <option value="Remote">Remote</option>
                            </select>
                          </div>

                          <div>
                            <label className="font-bold text-slate-700 block mb-1">Seniority level</label>
                            <select
                              value={selectedLevel}
                              onChange={(e) => setSelectedLevel(e.target.value)}
                              className="w-full py-2 px-2.5 rounded-lg border border-[#E2E8F0] bg-white text-slate-800"
                            >
                              <option value="">All Levels</option>
                              <option value="Senior">Senior Level</option>
                              <option value="Lead">Lead / Staff</option>
                              <option value="Mid">Mid Level</option>
                              <option value="Entry">Entry Level</option>
                            </select>
                          </div>

                          <div>
                            <label className="font-bold text-slate-700 block mb-1">Employment type</label>
                            <select
                              value={selectedJobType}
                              onChange={(e) => setSelectedJobType(e.target.value)}
                              className="w-full py-2 px-2.5 rounded-lg border border-[#E2E8F0] bg-white text-slate-800"
                            >
                              <option value="">All Types</option>
                              <option value="Full-time">Full-time</option>
                              <option value="Contract">Contract</option>
                              <option value="Part-time">Part-time</option>
                            </select>
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-1">
                          <button
                            type="button"
                            onClick={handleResetFilters}
                            disabled={!hasActiveFilters}
                            className="text-xs font-semibold text-slate-500 hover:text-slate-800 disabled:opacity-40 transition py-2 min-h-[44px]"
                          >
                            Reset filters
                          </button>
                          <button
                            type="button"
                            onClick={() => setMobileFiltersOpen(false)}
                            className="px-4 py-2 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-bold shadow-none min-h-[44px]"
                          >
                            Done
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Active Filter Chips */}
                  {hasActiveFilters && (
                    <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-[#E2E8F0]">
                      <span className="text-xs font-semibold text-slate-500">Active:</span>
                      {search.trim() && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E3A8A] text-xs font-medium">
                          <span>“{search.trim()}”</span>
                          <button
                            type="button"
                            onClick={() => setSearch("")}
                            aria-label="Remove search filter"
                            className="hover:text-blue-950 p-0.5 rounded-full hover:bg-blue-100 transition"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      )}
                      {selectedCategory && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E3A8A] text-xs font-medium capitalize">
                          <span>{selectedCategory}</span>
                          <button
                            type="button"
                            onClick={() => setSelectedCategory("")}
                            aria-label="Remove category filter"
                            className="hover:text-blue-950 p-0.5 rounded-full hover:bg-blue-100 transition"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      )}
                      {remoteOnly && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E3A8A] text-xs font-medium">
                          <span>Remote only</span>
                          <button
                            type="button"
                            onClick={() => setRemoteOnly(false)}
                            aria-label="Remove remote only filter"
                            className="hover:text-blue-950 p-0.5 rounded-full hover:bg-blue-100 transition"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      )}
                      {selectedLocation && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E3A8A] text-xs font-medium">
                          <span>{selectedLocation}</span>
                          <button
                            type="button"
                            onClick={() => setSelectedLocation("")}
                            aria-label="Remove location filter"
                            className="hover:text-blue-950 p-0.5 rounded-full hover:bg-blue-100 transition"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      )}
                      {selectedLevel && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E3A8A] text-xs font-medium">
                          <span>{selectedLevel}</span>
                          <button
                            type="button"
                            onClick={() => setSelectedLevel("")}
                            aria-label="Remove level filter"
                            className="hover:text-blue-950 p-0.5 rounded-full hover:bg-blue-100 transition"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      )}
                      {selectedJobType && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E3A8A] text-xs font-medium">
                          <span>{selectedJobType}</span>
                          <button
                            type="button"
                            onClick={() => setSelectedJobType("")}
                            aria-label="Remove job type filter"
                            className="hover:text-blue-950 p-0.5 rounded-full hover:bg-blue-100 transition"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={handleResetFilters}
                        className="text-xs font-semibold text-slate-500 hover:text-[#2563EB] transition underline underline-offset-2 ml-1 cursor-pointer py-1 min-h-[32px] flex items-center"
                      >
                        Clear all
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Jobs List (Single column, max-width 880px centred, 12px gap) */}
              <div className="w-full space-y-3 pt-2">
                {loadingJobs ? (
                  /* Skeleton Loader matching layout exactly */
                  <div className="space-y-3" data-testid="jobs-skeleton-list">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <div
                        key={i}
                        className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-5 shadow-none space-y-4"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                          <div className="flex items-start gap-3.5 min-w-0 flex-1">
                            <div className="w-12 h-12 rounded-xl bg-slate-200/80 shrink-0 animate-pulse motion-reduce:animate-none" />
                            <div className="space-y-2 flex-1 min-w-0">
                              <div className="h-4 w-48 sm:w-64 bg-slate-200/80 rounded animate-pulse" />
                              <div className="h-3.5 w-32 bg-slate-100 rounded animate-pulse" />
                              <div className="flex flex-wrap gap-1.5 pt-1">
                                <div className="h-5 w-20 bg-slate-100 rounded-full" />
                                <div className="h-5 w-16 bg-slate-100 rounded-full" />
                                <div className="h-5 w-24 bg-slate-100 rounded-full" />
                              </div>
                            </div>
                          </div>
                          <div className="w-44 h-28 rounded-[16px] bg-slate-100 shrink-0 hidden sm:block animate-pulse" />
                        </div>
                        <div className="flex items-center justify-between pt-3 border-t border-[#E2E8F0]">
                          <div className="w-10 h-10 rounded-full bg-slate-100 animate-pulse" />
                          <div className="w-24 h-10 rounded-full bg-slate-200/80 animate-pulse" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : displayedJobs.length === 0 ? (
                  /* Empty state */
                  <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-10 sm:p-14 text-center space-y-4 shadow-none">
                    <div className="w-12 h-12 rounded-full bg-[#F1F5F9] text-[#475569] flex items-center justify-center mx-auto">
                      <Search className="w-6 h-6" />
                    </div>
                    <p className="text-sm font-semibold text-[#0F172A]">
                      {activeTab === "liked"
                        ? "You have not liked any jobs yet"
                        : activeTab === "applied"
                        ? "No tracked applications yet"
                        : Boolean(search || selectedCategory || remoteOnly)
                        ? "No jobs match your active filters"
                        : "No positions currently found"}
                    </p>
                    <div className="pt-1">
                      <button
                        type="button"
                        onClick={handleResetFilters}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#0F172A] text-xs font-semibold transition cursor-pointer min-h-[44px]"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Reset filters</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Job Cards List (Single column, 12px gap) */
                  <div className="space-y-3">
                    {displayedJobs.map((job, index) => (
                      <JobCardItem
                        key={job.id}
                        job={job}
                        index={index}
                        isSaved={savedJobIds.includes(job.id)}
                        isPro={isPro}
                        candidate={candidate}
                        shouldReduceMotion={shouldReduceMotion}
                        handleSelectJob={handleSelectJob}
                        handleSaveJob={handleSaveJob}
                        handleLockedAction={handleLockedAction}
                      />
                    ))}

                    {/* Load More Pagination */}
                    {liveJobs.length < totalCount && (
                      <div className="pt-4 text-center">
                        <button
                          type="button"
                          onClick={handleLoadMore}
                          disabled={loadingMore}
                          className="px-6 py-3 rounded-xl border border-[#E2E8F0] bg-white hover:bg-[#F8FAFC] text-[#0F172A] text-xs font-bold transition shadow-none cursor-pointer disabled:opacity-60 min-h-[44px]"
                        >
                          {loadingMore
                            ? "Loading Positions..."
                            : `Load More Verified Positions (${Math.max(0, totalCount - liveJobs.length).toLocaleString()} remaining)`}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>

      {!user && <Footer />}

      {/* Paywall Modal */}
      <PaywallModal
        open={isPaywallOpen}
        onOpenChange={setIsPaywallOpen}
        user={user}
        featureTitle="Unlock Verified Company Names & Direct ATS Apply"
      />
    </div>
  );
}

function JobsPageFallback() {
  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex flex-col font-sans">
      <div className="flex-1 max-w-[880px] w-full mx-auto px-4 sm:px-6 py-6 space-y-4">
        <div className="h-8 w-48 bg-slate-200/80 rounded-lg animate-pulse" />
        <div className="h-14 w-full bg-white rounded-xl border border-slate-200 animate-pulse" />
        <div className="space-y-3" data-testid="jobs-skeleton-list">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 bg-white rounded-[16px] border border-[#E2E8F0] animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function JobsPage() {
  return (
    <Suspense fallback={<JobsPageFallback />}>
      <JobsPageInner />
    </Suspense>
  );
}
