"use client";

import React, { useState, useMemo, useEffect, useRef, Suspense } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion, AnimatePresence } from "motion/react";
import { getLiveJobs, getLiveJobById, LiveJob, isEarlyApplicant } from "@/lib/jobs/service";
import { getAuthUser, getUserPreferences } from "@/lib/auth/session";
import { getCandidateProfile } from "@/lib/resume/storage";
import { CandidateProfile } from "@/lib/resume/types";
import { UserPreferences } from "@/lib/auth/types";
import { TrackedApplication } from "@/lib/tracker/types";
import {
  addApplicationToTracker,
  getTrackedApplications,
  removeApplicationFromTracker,
  updateApplicationStage,
  quickTrackJob,
  isMatchingTrackerJob,
} from "@/lib/tracker/storage";
import { getProAccessStatus } from "@/lib/billing/subscription";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import AppIconRail from "@/components/shell/AppIconRail";
import { useSidebarMode } from "@/lib/sidebar";
import AppTopBar, { TopBarTab } from "@/components/shell/AppTopBar";
import JobDetailView from "@/components/jobs/JobDetailView";
import JobFilterBar, { JobFilterValues } from "@/components/jobs/JobFilterBar";
import AllFiltersDrawer from "@/components/jobs/AllFiltersDrawer";
import { COUNTRY_CODE_TO_NAME, matchCountryWithStrictFallback } from "@/lib/countries";
import MobileFilterSheet from "@/components/jobs/MobileFilterSheet";
import { JobCardMenu } from "@/components/jobs/JobCardMenu";
import { computeFitDiagnostics, FitDiagnosticsResult } from "@/lib/matcher/scoring";
import type { User } from "@supabase/supabase-js";
import {
  Search,
  MapPin,
  Laptop,
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
  Ban,
  MoreHorizontal,
  Plus,
  Pencil,
  Lightbulb,
  CheckCircle2,
  HelpCircle,
  DollarSign,
  Share2,
  ArrowUpDown,
} from "lucide-react";
import CompanyLogo from "@/components/CompanyLogo";
import { toast } from "react-toastify";

const PaywallModal = dynamic(() => import("@/components/PaywallModal"), { ssr: false });

const GUEST_HIDDEN_JOBS_KEY = "cm_hidden_jobs_guest";
const LEGACY_HIDDEN_JOBS_KEY = "cm_hidden_jobs";

function getScopedHiddenJobsKey(userId?: string | null): string {
  if (userId && userId.trim()) {
    return `cm_hidden_jobs_${userId.trim()}`;
  }
  return GUEST_HIDDEN_JOBS_KEY;
}

type JobTab = "recommended" | "saved" | "liked" | "applied" | "external";

interface SavedFilterPreset {
  name: string;
  category?: string;
  search?: string;
  remoteOnly?: boolean;
}

const SAVED_PRESETS: SavedFilterPreset[] = [
  { name: "Full Stack Engineer, US", search: "Full Stack", remoteOnly: true },
  { name: "Senior React & Fullstack", search: "React", remoteOnly: true },
  { name: "Staff Distributed Systems", search: "Distributed", remoteOnly: true },
  { name: "AI & Machine Learning", category: "data", remoteOnly: false },
  { name: "Product Design (Worldwide)", category: "design", remoteOnly: true },
];


function trackedAppToLiveJob(app: TrackedApplication, fullJob?: LiveJob): LiveJob {
  if (fullJob) {
    return {
      ...fullJob,
      title: app.title || fullJob.title,
      company: app.company || fullJob.company,
      location: app.location || fullJob.location,
      salary: app.salaryText || fullJob.salary,
      applyUrl: app.applyUrl || fullJob.applyUrl,
      trackerNotes: app.notes || undefined,
    };
  }
  // Missing metadata stays absent or explicitly unavailable without fabrication.
  // Private application notes are stored separately in trackerNotes, never repurposing
  // the employer job description or feeding into external AI / export flows.
  const appDate = app.appliedAt || app.createdAt || "";
  return {
    id: app.jobId || app.id,
    title: app.title || "Position Title Unavailable",
    company: app.company || "Employer not specified",
    location: app.location || "Location not specified",
    salary: app.salaryText || "Pay not disclosed",
    applyUrl: app.applyUrl || "",
    description: "Original job posting details unavailable for this tracked application.",
    trackerNotes: app.notes || undefined,
    date: appDate,
    postedAt: undefined, // Never fabricate a career-page posting date
    type: "",
    category: "",
    country: "",
    directSource: false, // Never fabricate direct-ATS feed badge
    skills: [],
    remote: false,
    remoteScope: undefined,
    remoteEligibility: undefined,
  };
}

function inferJobLevel(title: string): string {
  const t = (title || "").toLowerCase();
  if (t.includes("staff") || t.includes("principal") || t.includes("lead")) return "Staff / Lead";
  if (t.includes("senior") || t.includes("sr.")) return "Senior Level";
  if (t.includes("junior") || t.includes("entry") || t.includes("associate")) return "Entry Level";
  return "";
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

function formatDesktopPillTime(dateStr?: string): string {
  if (!dateStr) return "";
  try {
    const s = dateStr.trim().toLowerCase();
    if (s === "today") return "Today";
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (isNaN(diffMs)) return dateStr;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours < 1) return "Just now";
    if (diffHours === 1) return "1 hour ago";
    if (diffHours < 24) return `${diffHours} hours ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "1 day ago";
    if (diffDays < 30) return `${diffDays} days ago`;
    return `${Math.floor(diffDays / 30)} mo ago`;
  } catch {
    return dateStr;
  }
}

function isPostedUnder24Hours(dateStr?: string): boolean {
  if (!dateStr) return false;
  const s = dateStr.trim().toLowerCase();
  if (s === "today" || s === "just now" || s.includes("minute") || s.includes("sec")) {
    return true;
  }
  const hourMatch = s.match(/^(\d+)\s*(?:h|hour|hours)(?:\s*ago)?$/);
  if (hourMatch) {
    const h = parseInt(hourMatch[1], 10);
    return h >= 0 && h < 24;
  }
  const dayMatch = s.match(/^(\d+)\s*(?:d|day|days)(?:\s*ago)?$/);
  if (dayMatch) {
    const d = parseInt(dayMatch[1], 10);
    return d < 1;
  }
  const timestamp = Date.parse(dateStr);
  if (isNaN(timestamp)) return false;
  const diffMs = Date.now() - timestamp;
  return diffMs >= 0 && diffMs < 24 * 60 * 60 * 1000;
}

function getTagColorClass(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % 4;
  const TINTS = [
    "bg-blue-50 text-[#1D4ED8] border-blue-200/70",
    "bg-emerald-50 text-emerald-800 border-emerald-200/70",
    "bg-violet-50 text-violet-800 border-violet-200/70",
    "bg-amber-50 text-amber-800 border-amber-200/70",
  ];
  return TINTS[index];
}

function formatPillLabel(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.includes("-") && !trimmed.includes(" ")) {
    return trimmed
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function getCompanyTagPills(category?: string | null): string[] {
  if (!category || typeof category !== "string") return [];
  const pills: string[] = [];
  const seen = new Set<string>();

  const parts = category.includes("·")
    ? category.split("·")
    : category.includes(",")
    ? category.split(",")
    : [category];

  for (const part of parts) {
    const cleaned = formatPillLabel(part);
    const lower = cleaned.toLowerCase();
    if (cleaned && !seen.has(lower)) {
      seen.add(lower);
      pills.push(cleaned);
    }
  }

  return pills;
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

function getMatchPanelGradient(score: number): string {
  if (score >= 80) return "bg-gradient-to-br from-[#1E3A8A] to-[#2563EB]";
  if (score >= 50) return "bg-gradient-to-br from-[#0F172A] to-[#1E3A8A]";
  return "bg-gradient-to-br from-[#0F172A] to-[#334155]";
}

function parseJobLocation(locationStr?: string | null): { primary: string; extraCount: number; all: string[] } {
  if (!locationStr || !locationStr.trim()) {
    return { primary: "Location unlisted", extraCount: 0, all: [] };
  }
  const raw = locationStr.trim();
  let parts: string[] = [];
  if (raw.includes(";")) {
    parts = raw.split(";").map((p) => p.trim()).filter(Boolean);
  } else if (raw.includes(" | ")) {
    parts = raw.split(" | ").map((p) => p.trim()).filter(Boolean);
  } else if (raw.includes(" / ")) {
    parts = raw.split(" / ").map((p) => p.trim()).filter(Boolean);
  } else {
    parts = [raw];
  }

  return {
    primary: parts[0] || raw,
    extraCount: Math.max(0, parts.length - 1),
    all: parts,
  };
}

function CircularMatchRing({
  score,
  size = 56,
  strokeWidth = 4.5,
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
  const textClass = size >= 75 ? "text-2xl font-black" : size >= 65 ? "text-xl font-black" : size >= 50 ? "text-[16px] font-bold" : "text-[13px] font-bold";

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
          stroke="#1E293B"
          strokeWidth={strokeWidth}
          fill="transparent"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="#2DD4BF"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          fill="transparent"
          className="transition-all duration-300 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className={`${textClass} text-white leading-none tracking-tight`}>
          {score}%
        </span>
      </div>
    </div>
  );
}

function JobsPageInner() {
  const { isExpanded } = useSidebarMode();
  const router = useRouter();
  const shouldReduceMotion = useReducedMotion();

  // Active Tab: 'recommended' | 'liked' | 'applied' | 'external'
  const [activeTab, setActiveTab] = useState<JobTab>("recommended");

  // In-place Selected Job for Detail View
  const [selectedJob, setSelectedJob] = useState<LiveJob | null>(null);
  const pendingJobIdRef = useRef<string | null>(null);
  const scrollPositionRef = useRef<number>(0);
  const [viewHiddenJobs, setViewHiddenJobs] = useState(false);

  // Search & Filter state
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState("");
  const [selectedLevel, setSelectedLevel] = useState("");
  const [selectedJobType, setSelectedJobType] = useState("");
  const [selectedDatePosted, setSelectedDatePosted] = useState("");
  const [selectedCountryCode, setSelectedCountryCode] = useState("");
  const [selectedExperience, setSelectedExperience] = useState("");
  const [selectedWorkModel, setSelectedWorkModel] = useState("");
  const [selectedIndustry, setSelectedIndustry] = useState("");
  const [selectedSalaryMin, setSelectedSalaryMin] = useState("");
  const [selectedSourceType, setSelectedSourceType] = useState("");
  const [selectedCompany, setSelectedCompany] = useState("");
  const [allFiltersDrawerOpen, setAllFiltersDrawerOpen] = useState(false);
  const allFiltersTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [sortBy, setSortBy] = useState<"match" | "newest">("newest");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);

  // Debounced search for server-side execution (300ms)
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(handler);
  }, [search]);

  // User state
  const [user, setUser] = useState<User | null>(null);

  // Hidden jobs list persisted in localStorage
  const [hiddenJobIds, setHiddenJobIds] = useState<string[]>([]);

  useEffect(() => {
    try {
      const storageKey = getScopedHiddenJobsKey(user?.id);
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setHiddenJobIds(parsed);
          return;
        }
      }
      setHiddenJobIds([]);
    } catch {
      setHiddenJobIds([]);
    }
  }, [user?.id]);

  const [isPro, setIsPro] = useState(false);
  const [isProDefinitive, setIsProDefinitive] = useState(false);
  const [candidate, setCandidate] = useState<CandidateProfile | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [trackedApplications, setTrackedApplications] = useState<TrackedApplication[]>([]);
  const [resolvedJobsMap, setResolvedJobsMap] = useState<Record<string, LiveJob>>({});
  const [savedJobIds, setSavedJobIds] = useState<string[]>([]);
  const [appliedJobIds, setAppliedJobIds] = useState<string[]>([]);
  const [appliedCount, setAppliedCount] = useState<number>(0);
  const [updatingAppliedJobId, setUpdatingAppliedJobId] = useState<string | null>(null);
  const inFlightAppliedRef = useRef<Set<string>>(new Set());
  const filtersTriggerRef = useRef<HTMLButtonElement | null>(null);
  const filterDialogRef = useRef<HTMLDivElement | null>(null);
  const tabsContainerRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  const hasInitializedFromUrl = useRef(false);
  const [isPaywallOpen, setIsPaywallOpen] = useState(false);
  const [isRetryingUnlock, setIsRetryingUnlock] = useState(false);
  const [page, setPage] = useState(1);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState<boolean>(false);

  // Live Supabase Jobs Data
  const [liveJobs, setLiveJobs] = useState<LiveJob[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [loadingJobs, setLoadingJobs] = useState<boolean>(true);
  const lastQueryKeyRef = useRef<string>("");

  // Static export safe: Read URL query parameters client-side via window.location.search
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const qSearch = params.get("search") || params.get("q") || "";
    const qCategory = params.get("category") || params.get("categories") || "";
    const qRemote = params.get("remote") === "true";
    const qLocation = params.get("location") || "";
    const qLevel = params.get("level") || "";
    const qType = params.get("type") || params.get("jobType") || "";
    const qDate = params.get("datePosted") || params.get("date") || "";
    const qExp = params.get("experience") || params.get("exp") || "";
    const qWorkModel = params.get("workModel") || "";
    const qIndustry = params.get("industry") || "";
    const qCountry = params.get("country") || params.get("countryCode") || params.get("country_code") || "";
    const qSalaryMin = params.get("salaryMin") || params.get("salary") || "";
    const qSourceType = params.get("sourceType") || params.get("source") || "";
    const qCompany = params.get("company") || "";
    const qHidden = params.get("hidden") === "true";
    const qTab = params.get("tab");
    const qSort = params.get("sort") || params.get("sortBy");
    const qId = params.get("id") || params.get("jobId");

    if (qSearch) setSearch(qSearch);
    if (qCategory) setSelectedCategory(qCategory);
    if (qRemote) setRemoteOnly(true);
    if (qLocation) setSelectedLocation(qLocation);
    if (qLevel) setSelectedLevel(qLevel);
    if (qType) setSelectedJobType(qType);
    if (qDate) setSelectedDatePosted(qDate);
    if (qExp) setSelectedExperience(qExp);
    if (qWorkModel) setSelectedWorkModel(qWorkModel);
    if (qIndustry) setSelectedIndustry(qIndustry);
    if (qSalaryMin) setSelectedSalaryMin(qSalaryMin);
    if (qCountry) setSelectedCountryCode(qCountry);
    if (qSourceType) setSelectedSourceType(qSourceType);
    if (qCompany) setSelectedCompany(qCompany);
    if (qHidden) setViewHiddenJobs(true);
    if (qSort === "match" || qSort === "newest") setSortBy(qSort);

    if (qTab === "liked" || qTab === "saved") {
      setActiveTab("saved");
    } else if (qTab === "applied") {
      setActiveTab("applied");
    } else if (qTab === "external") {
      setActiveTab("external");
    } else if (qTab === "recommended" || qTab === "foryou" || qTab === "all") {
      setActiveTab("recommended");
    }

    if (qId) {
      pendingJobIdRef.current = qId;
      getLiveJobById(qId, isPro)
        .then((job) => {
          pendingJobIdRef.current = null;
          if (job) setSelectedJob(job);
        })
        .catch(() => {
          pendingJobIdRef.current = null;
        });
    }

    hasInitializedFromUrl.current = true;
  }, [isPro]);

  // Synchronize state changes back to URL query parameters
  useEffect(() => {
    if (!hasInitializedFromUrl.current) return;
    if (typeof window === "undefined") return;

    const current = new URLSearchParams(window.location.search);
    const syncParam = (key: string, val: string | null | undefined) => {
      if (val && String(val).trim()) {
        current.set(key, String(val).trim());
      } else {
        current.delete(key);
      }
    };

    syncParam("tab", activeTab === "recommended" ? null : activeTab);
    syncParam("search", search);
    syncParam("category", selectedCategory);
    syncParam("location", selectedLocation);
    syncParam("level", selectedLevel);
    syncParam("type", selectedJobType);
    syncParam("datePosted", selectedDatePosted);
    syncParam("experience", selectedExperience);
    syncParam("remote", remoteOnly ? "true" : null);
    syncParam("workModel", selectedWorkModel);
    syncParam("industry", selectedIndustry);
    syncParam("salaryMin", selectedSalaryMin);
    syncParam("sourceType", selectedSourceType);
    syncParam("company", selectedCompany);
    syncParam("country", selectedCountryCode);
    syncParam("hidden", viewHiddenJobs ? "true" : null);
    syncParam("sort", sortBy === "match" ? "match" : null);
    syncParam("id", selectedJob?.id || pendingJobIdRef.current || null);

    // Clean up legacy aliases
    current.delete("liked");
    current.delete("jobId");
    current.delete("sortBy");
    current.delete("q");

    const qs = current.toString();
    const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    if (newUrl !== currentUrl) {
      router.replace(newUrl, { scroll: false });
    }
  }, [
    activeTab,
    search,
    selectedCategory,
    selectedLocation,
    selectedLevel,
    selectedJobType,
    selectedDatePosted,
    selectedExperience,
    remoteOnly,
    viewHiddenJobs,
    sortBy,
    selectedWorkModel,
    selectedIndustry,
    selectedSalaryMin,
    selectedSourceType,
    selectedCompany,
    selectedCountryCode,
    selectedJob,
  ]);

  // Focus trap, keyboard escape, inert background, and scroll locking for mobile filter sheet
  useEffect(() => {
    if (!mobileFiltersOpen) return;

    const dialog = filterDialogRef.current;
    if (!dialog) return;

    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMobileFiltersOpen(false);
        filtersTriggerRef.current?.focus();
        return;
      }
      if (e.key === "Tab") {
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }
    };

    dialog.addEventListener("keydown", handleKeyDown);
    const mainEl = document.getElementById("main-content");
    mainEl?.setAttribute("aria-hidden", "true");
    const origOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      dialog.removeEventListener("keydown", handleKeyDown);
      mainEl?.removeAttribute("aria-hidden");
      document.body.style.overflow = origOverflow;
    };
  }, [mobileFiltersOpen]);

  // Keep active tab in view and hide mobile bottom nav while full-screen job detail is open
  useEffect(() => {
    if (activeTabRef.current) {
      activeTabRef.current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  }, [activeTab]);

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("careermonke_detail_open", { detail: { isOpen: Boolean(selectedJob) } })
    );
    if (typeof document !== "undefined") {
      if (selectedJob) {
        document.body.classList.add("cm-job-detail-open");
      } else {
        document.body.classList.remove("cm-job-detail-open");
      }
    }
    return () => {
      window.dispatchEvent(
        new CustomEvent("careermonke_detail_open", { detail: { isOpen: false } })
      );
      if (typeof document !== "undefined") {
        document.body.classList.remove("cm-job-detail-open");
      }
    };
  }, [selectedJob]);

  // Synchronize browser back/forward buttons with all filters, tab, and in-place detail view
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handlePopState = (e: PopStateEvent) => {
      const params = new URLSearchParams(window.location.search);
      const qSearch = params.get("search") || params.get("q") || "";
      const qCategory = params.get("category") || params.get("categories") || "";
      const qRemote = params.get("remote") === "true";
      const qLocation = params.get("location") || "";
      const qLevel = params.get("level") || "";
      const qType = params.get("type") || params.get("jobType") || "";
      const qDate = params.get("datePosted") || params.get("date") || "";
      const qExp = params.get("experience") || params.get("exp") || "";
      const qCountry = params.get("country") || params.get("countryCode") || params.get("country_code") || "";
      const qWorkModel = params.get("workModel") || "";
      const qIndustry = params.get("industry") || "";
      const qSalaryMin = params.get("salaryMin") || params.get("salary") || "";
      const qSourceType = params.get("sourceType") || params.get("source") || "";
      const qCompany = params.get("company") || "";
      const qHidden = params.get("hidden") === "true";
      const qTab = params.get("tab");
      const qSort = params.get("sort") || params.get("sortBy");
      const qId = params.get("id") || params.get("jobId");

      setSearch(qSearch);
      setSelectedCategory(qCategory);
      setRemoteOnly(qRemote);
      setSelectedLocation(qLocation);
      setSelectedLevel(qLevel);
      setSelectedJobType(qType);
      setSelectedDatePosted(qDate);
      setSelectedExperience(qExp);
      setSelectedCountryCode(qCountry);
      setSelectedWorkModel(qWorkModel);
      setSelectedIndustry(qIndustry);
      setSelectedSalaryMin(qSalaryMin);
      setSelectedSourceType(qSourceType);
      setSelectedCompany(qCompany);
      setViewHiddenJobs(qHidden);
      setSortBy(qSort === "match" ? "match" : "newest");

      if (qTab === "liked" || qTab === "saved") {
        setActiveTab("saved");
      } else if (qTab === "applied") {
        setActiveTab("applied");
      } else if (qTab === "external") {
        setActiveTab("external");
      } else {
        setActiveTab("recommended");
      }

      if (qId) {
        pendingJobIdRef.current = qId;
        const found = liveJobs.find((j) => j.id === qId);
        if (found) {
          pendingJobIdRef.current = null;
          setSelectedJob(found);
        } else {
          getLiveJobById(qId, isPro)
            .then((job) => {
              pendingJobIdRef.current = null;
              if (job) setSelectedJob(job);
            })
            .catch(() => {
              pendingJobIdRef.current = null;
            });
        }
      } else {
        pendingJobIdRef.current = null;
        setSelectedJob(null);
        const targetScroll = e.state?.scrollPos ?? scrollPositionRef.current ?? 0;
        requestAnimationFrame(() => {
          window.scrollTo(0, targetScroll);
        });
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [liveJobs, isPro]);

  useEffect(() => {
    let cancelled = false;

    async function loadInitialContext() {
      try {
        const [u, proRes, cp] = await Promise.all([
          getAuthUser(),
          getProAccessStatus(),
          getCandidateProfile(),
        ]);
        if (cancelled) return;

        if (!u) {
          const currentSearch = typeof window !== "undefined" ? window.location.search : "";
          const returnPath = `/jobs${currentSearch}`;
          router.replace(`/login?returnTo=${encodeURIComponent(returnPath)}`);
          return;
        }

        const apps = await getTrackedApplications(u.id);

        setUser(u);
        setIsPro(proRes.isPro);
        setIsProDefinitive(Boolean(proRes.isDefinitive));
        setCandidate(cp && cp.confirmedAt ? cp : null);
        setTrackedApplications(apps);
        const savedApps = apps.filter((a) => a.stage === "saved");
        setSavedJobIds(savedApps.map((a) => a.jobId || "").filter(Boolean));
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

    const handleTrackerUpdate = () => {
      getTrackedApplications(user?.id).then((apps) => {
        if (!cancelled) {
          setTrackedApplications(apps);
          const savedApps = apps.filter((a) => a.stage === "saved");
          setSavedJobIds(savedApps.map((a) => a.jobId || "").filter(Boolean));
          const appliedApps = apps.filter((a) => a.stage === "applied");
          setAppliedJobIds(appliedApps.map((a) => a.jobId || "").filter(Boolean));
          setAppliedCount(appliedApps.length);
        }
      });
    };

    window.addEventListener("careermonke_pro_updated", handleSubUpdate);
    window.addEventListener("careermonke_auth_updated", handleSubUpdate);
    window.addEventListener("careermonke_profile_updated", handleProfileUpdate);
    window.addEventListener("careermonke_tracker_updated", handleTrackerUpdate);
    return () => {
      cancelled = true;
      window.removeEventListener("careermonke_pro_updated", handleSubUpdate);
      window.removeEventListener("careermonke_auth_updated", handleSubUpdate);
      window.removeEventListener("careermonke_profile_updated", handleProfileUpdate);
      window.removeEventListener("careermonke_tracker_updated", handleTrackerUpdate);
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
      search: debouncedSearch.trim(),
      remoteOnly,
      location: selectedLocation,
      level: selectedLevel,
      jobType: selectedJobType,
      countryCode: selectedCountryCode,
      workModel: selectedWorkModel,
      datePosted: selectedDatePosted,
      experience: selectedExperience,
      salaryMin: selectedSalaryMin,
      sourceType: selectedSourceType,
      company: selectedCompany,
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
    setNextCursor(null);

    getLiveJobs({
      page: 1,
      pageSize: 25,
      category: selectedCategory,
      search: debouncedSearch,
      remoteOnly,
      location: selectedLocation,
      level: selectedLevel,
      jobType: selectedJobType,
      countryCode: selectedCountryCode,
      workModel: selectedWorkModel,
      datePosted: selectedDatePosted,
      experience: selectedExperience,
      salaryMin: selectedSalaryMin,
      sourceType: selectedSourceType,
      company: selectedCompany,
      isPro,
      sortBy: effectiveSortBy,
      candidate: effectiveCandidate,
      preferences: effectivePreferences,
    })
      .then((res) => {
        if (queryKey === lastQueryKeyRef.current) {
          setLiveJobs(res.jobs);
          setTotalCount(res.totalCount);
          setNextCursor(res.nextCursor ?? null);
          setHasNextPage(Boolean(res.hasNextPage));
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
    debouncedSearch,
    remoteOnly,
    selectedLocation,
    selectedLevel,
    selectedJobType,
    selectedCountryCode,
    selectedWorkModel,
    selectedDatePosted,
    selectedExperience,
    selectedSalaryMin,
    selectedSourceType,
    selectedCompany,
    isPro,
    isProDefinitive,
    user,
    sortBy,
    activeTab,
    candidate,
    preferences,
  ]);

  const handleLoadMore = async () => {
    if (loadingMore) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const isRecommended = activeTab === "recommended";
      const effectiveSortBy = isRecommended && sortBy === "match" ? "match" : sortBy;
      const effectiveCandidate = (isRecommended || sortBy === "match") ? candidate : null;
      const effectivePreferences = (isRecommended || sortBy === "match") ? preferences : null;

      const res = await getLiveJobs({
        page: nextPage,
        pageSize: 25,
        cursor: nextCursor ?? undefined,
        category: selectedCategory,
        search: debouncedSearch,
        remoteOnly,
        location: selectedLocation,
        level: selectedLevel,
        jobType: selectedJobType,
        countryCode: selectedCountryCode,
        workModel: selectedWorkModel,
        datePosted: selectedDatePosted,
        experience: selectedExperience,
        salaryMin: selectedSalaryMin,
        sourceType: selectedSourceType,
        company: selectedCompany,
        isPro,
        sortBy: effectiveSortBy,
        candidate: effectiveCandidate,
        preferences: effectivePreferences,
      });
      setLiveJobs((prev) => [...prev, ...res.jobs]);
      setNextCursor(res.nextCursor ?? null);
      setHasNextPage(Boolean(res.hasNextPage));
      setPage(nextPage);
      if (res.totalCount) setTotalCount(res.totalCount);
    } catch (e) {
      console.warn("Failed to load more jobs", e);
    } finally {
      setLoadingMore(false);
    }
  };

  const savedApps = useMemo(() => trackedApplications.filter((a) => a.stage === "saved"), [trackedApplications]);
  const appliedApps = useMemo(() => trackedApplications.filter((a) => a.stage === "applied"), [trackedApplications]);
  const savedCount = savedApps.length;

  // Background resolution for saved/applied jobs that may not be on the current page of Recommended results
  useEffect(() => {
    if (activeTab !== "saved" && activeTab !== "liked" && activeTab !== "applied") return;
    const targetApps = (activeTab === "saved" || activeTab === "liked") ? savedApps : appliedApps;
    const missingJobIds = targetApps
      .map((a) => a.jobId)
      .filter((id): id is string => Boolean(id) && !liveJobs.some((j) => j.id === id) && !resolvedJobsMap[id!]);

    if (missingJobIds.length === 0) return;

    let cancelled = false;
    Promise.allSettled(
      missingJobIds.slice(0, 15).map(async (id) => {
        const fullJob = await getLiveJobById(id, isPro);
        return { id, job: fullJob };
      })
    ).then((results) => {
      if (cancelled) return;
      const updates: Record<string, LiveJob> = {};
      for (const res of results) {
        if (res.status === "fulfilled" && res.value.job) {
          updates[res.value.id] = res.value.job;
        }
      }
      if (Object.keys(updates).length > 0) {
        setResolvedJobsMap((prev) => ({ ...prev, ...updates }));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeTab, savedApps, appliedApps, liveJobs, resolvedJobsMap, isPro]);

  // Filtered Jobs based on activeTab, client-side secondary filters, and hidden ids
  const filteredJobs = useMemo(() => {
    let sourceJobs: LiveJob[];
    const isSavedTab = activeTab === "saved" || activeTab === "liked";
    const isAppliedTab = activeTab === "applied";

    if (isSavedTab) {
      sourceJobs = savedApps.map((app) => {
        const found = liveJobs.find((j) => j.id === app.jobId) || (app.jobId ? resolvedJobsMap[app.jobId] : undefined);
        return trackedAppToLiveJob(app, found);
      });
    } else if (isAppliedTab) {
      sourceJobs = appliedApps.map((app) => {
        const found = liveJobs.find((j) => j.id === app.jobId) || (app.jobId ? resolvedJobsMap[app.jobId] : undefined);
        return trackedAppToLiveJob(app, found);
      });
    } else {
      sourceJobs = liveJobs;
    }

    let result = sourceJobs.filter((job) => {
      if (viewHiddenJobs) {
        return hiddenJobIds.includes(job.id);
      }
      return !hiddenJobIds.includes(job.id);
    });

    if (activeTab === "external") {
      result = result.filter((job) => Boolean(job.directSource));
    }

    if (selectedCountryCode && selectedCountryCode.toLowerCase() !== "all") {
      result = result.filter((job) =>
        matchCountryWithStrictFallback(job.country, job.location, selectedCountryCode)
      );
    }

    if (selectedLocation) {
      result = result.filter((job) =>
        (job.location || "").toLowerCase().includes(selectedLocation.toLowerCase())
      );
    }

    if (selectedWorkModel && selectedWorkModel.toLowerCase() !== "all") {
      const wm = selectedWorkModel.toLowerCase();
      result = result.filter((job) => {
        if (wm === "remote") return job.remote || (job.location || "").toLowerCase().includes("remote");
        if (wm === "hybrid") return (job.location || "").toLowerCase().includes("hybrid") || (job.remoteScope || "").toLowerCase() === "hybrid";
        if (wm === "onsite") return !job.remote || (job.location || "").toLowerCase().includes("onsite");
        return true;
      });
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

    if (selectedDatePosted) {
      const now = Date.now();
      result = result.filter((job) => {
        const dateStr = job.postedAt || job.date;
        if (!dateStr) return true;
        const jobTime = new Date(dateStr).getTime();
        if (isNaN(jobTime)) return true;
        const diffHours = (now - jobTime) / (1000 * 60 * 60);
        if (selectedDatePosted === "Past 24 hours") return diffHours <= 24;
        if (selectedDatePosted === "Past week") return diffHours <= 24 * 7;
        if (selectedDatePosted === "Past month") return diffHours <= 24 * 30;
        return true;
      });
    }

    if (selectedExperience) {
      result = result.filter((job) => {
        const text = `${job.title} ${job.description || ""} ${(job.skills || []).join(" ")}`.toLowerCase();
        if (selectedExperience === "1-3 Years") {
          return text.includes("1-3") || text.includes("1 to 3") || text.includes("entry") || text.includes("junior");
        }
        if (selectedExperience === "3-5 Years") {
          return text.includes("3-5") || text.includes("3 to 5") || text.includes("mid") || !text.includes("senior");
        }
        if (selectedExperience === "5+ Years") {
          return text.includes("5+") || text.includes("5 years") || text.includes("senior") || text.includes("lead");
        }
        if (selectedExperience === "8+ Years") {
          return text.includes("8+") || text.includes("8 years") || text.includes("staff") || text.includes("principal");
        }
        return true;
      });
    }

    // Sort
    if (sortBy === "match" && candidate) {
      result = [...result].sort((a, b) => {
        const scoreA = getJobMatchScore(a, candidate) ?? 0;
        const scoreB = getJobMatchScore(b, candidate) ?? 0;
        return scoreB - scoreA;
      });
    }

    return result;
  }, [
    liveJobs,
    activeTab,
    savedApps,
    appliedApps,
    resolvedJobsMap,
    hiddenJobIds,
    viewHiddenJobs,
    selectedCountryCode,
    selectedLocation,
    selectedWorkModel,
    selectedLevel,
    selectedJobType,
    selectedDatePosted,
    selectedExperience,
    sortBy,
    candidate,
  ]);

  const displayedJobs = filteredJobs;

  // Memoize per-card fit diagnostics keyed by confirmed resume facts and job.id
  const confirmedResumeKey = candidate?.confirmedAt || "";
  const cardDiagnosticsMap = useMemo(() => {
    const map = new Map<string, FitDiagnosticsResult | null>();
    for (const job of displayedJobs) {
      map.set(job.id, getJobDiagnostics(job, candidate));
    }
    return map;
  }, [displayedJobs, candidate?.confirmedAt, confirmedResumeKey]);

  const selectedJobTrackedApp = useMemo(() => {
    if (!selectedJob) return null;
    return (
      trackedApplications.find((a) => isMatchingTrackerJob(a, selectedJob)) || null
    );
  }, [selectedJob, trackedApplications]);

  const handleResetFilters = () => {
    setSearch("");
    setSelectedCategory("");
    setSelectedCountryCode("");
    setRemoteOnly(false);
    setSelectedLocation("");
    setSelectedLevel("");
    setSelectedJobType("");
    setSelectedWorkModel("");
    setSelectedDatePosted("");
    setSelectedIndustry("");
    setSelectedExperience("");
    setSelectedSalaryMin("");
    setSelectedSourceType("");
    setSelectedCompany("");
    setViewHiddenJobs(false);
    setSortBy("newest");
    setPage(1);
    setNextCursor(null);
    setMobileFiltersOpen(false);
    setAllFiltersDrawerOpen(false);
    setOpenDropdown(null);
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      p.delete("search");
      p.delete("category");
      p.delete("categories");
      p.delete("country");
      p.delete("country_code");
      p.delete("remote");
      p.delete("location");
      p.delete("level");
      p.delete("jobType");
      p.delete("workModel");
      p.delete("datePosted");
      p.delete("industry");
      p.delete("experience");
      p.delete("salaryMin");
      p.delete("salary");
      p.delete("sourceType");
      p.delete("source");
      p.delete("company");
      p.delete("hidden");
      p.delete("sort");
      p.delete("sortBy");
      const qs = p.toString();
      const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
      router.replace(newUrl, { scroll: false });
    }
  };

  const handleToggleApplied = async (job: LiveJob) => {
    if (!user) {
      handleLockedAction();
      return;
    }
    // Synchronous lock check: immediately aborts duplicate same-tick invocations
    if (inFlightAppliedRef.current.has(job.id)) return;
    inFlightAppliedRef.current.add(job.id);
    setUpdatingAppliedJobId(job.id);

    try {
      const apps = await getTrackedApplications(user.id);
      const existing = apps.find((a) => isMatchingTrackerJob(a, job));

      if (!existing) {
        // No record: create at applied
        await quickTrackJob(
          {
            id: job.id,
            title: job.title,
            company: job.company,
            location: job.location,
            salary_text: job.salary,
            apply_url: job.applyUrl,
          },
          "applied"
        );
        toast.success(`Marked "${job.title}" as applied! Added to Tracker.`);
      } else if (existing.stage === "saved") {
        // Existing saved record: move to applied, preserving notes, dates, and other fields
        await updateApplicationStage(existing.id, "applied");
        toast.success(`Marked "${job.title}" as applied! Moved to Tracker Applied tab.`);
      } else if (existing.stage === "applied") {
        // Already applied: clicking again must NOT demote it
        toast.info(`"${job.title}" is already marked as applied in Tracker.`);
      } else {
        // Any other stage (interview, offer, rejected): preserve it, notes, dates and other fields
        const stageLabel = existing.stage.charAt(0).toUpperCase() + existing.stage.slice(1);
        toast.info(`"${job.title}" is currently in ${stageLabel} stage in Tracker.`);
      }

      const updatedApps = await getTrackedApplications(user.id);
      setTrackedApplications(updatedApps);
      const appliedApps = updatedApps.filter((a) => a.stage === "applied");
      setAppliedJobIds(appliedApps.map((a) => a.jobId || "").filter(Boolean));
      setAppliedCount(appliedApps.length);

      const savedApps = updatedApps.filter((a) => a.stage === "saved");
      setSavedJobIds(savedApps.map((a) => a.jobId || "").filter(Boolean));
    } catch {
      toast.error("Could not update application status.");
    } finally {
      inFlightAppliedRef.current.delete(job.id);
      setUpdatingAppliedJobId(null);
    }
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

  const handleRetryUnlock = async (jobId: string) => {
    setIsRetryingUnlock(true);
    try {
      const fullJob = await getLiveJobById(jobId, isPro);
      if (fullJob) {
        setSelectedJob(fullJob);
        if (!fullJob.proUnlockError) {
          toast.success("Job details unlocked!");
        } else {
          toast.error("Retry failed. Details remain locked.");
        }
      }
    } catch {
      toast.error("Retry failed. Please check connection.");
    } finally {
      setIsRetryingUnlock(false);
    }
  };

  const handleSelectJob = async (job: LiveJob) => {
    pendingJobIdRef.current = null;
    if (typeof window !== "undefined") {
      scrollPositionRef.current = window.scrollY;
    }
    setSelectedJob(job);
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      params.set("id", job.id);
      window.history.pushState(
        { jobId: job.id, scrollPos: scrollPositionRef.current },
        "",
        `${window.location.pathname}?${params.toString()}`
      );
    }
    // Fetch full job record with description if missing, short, or has unlock error
    if (!job.description || job.description.length < 50 || job.proUnlockError) {
      try {
        const fullJob = await getLiveJobById(job.id, isPro);
        if (fullJob) setSelectedJob(fullJob);
      } catch {}
    }
  };

  const handleBackToList = () => {
    pendingJobIdRef.current = null;
    setSelectedJob(null);
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      params.delete("id");
      params.delete("jobId");
      const nextQuery = params.toString();
      window.history.replaceState(
        { scrollPos: scrollPositionRef.current || 0 },
        "",
        nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname
      );
      requestAnimationFrame(() => {
        window.scrollTo(0, scrollPositionRef.current || 0);
      });
    }
  };

  const handleHideJob = (e: React.MouseEvent, jobId: string) => {
    e.stopPropagation();
    const updated = [...hiddenJobIds, jobId];
    setHiddenJobIds(updated);
    try {
      const storageKey = getScopedHiddenJobsKey(user?.id);
      localStorage.setItem(storageKey, JSON.stringify(updated));
    } catch {}
    toast.info(
      "Job hidden from feed",
      { autoClose: 3000 }
    );
  };

  const handleUnhideJob = (jobId: string) => {
    const updated = hiddenJobIds.filter((id) => id !== jobId);
    setHiddenJobIds(updated);
    try {
      const storageKey = getScopedHiddenJobsKey(user?.id);
      localStorage.setItem(storageKey, JSON.stringify(updated));
    } catch {}
    toast.success("Job restored to feed");
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
      router.push(`/login?returnTo=${encodeURIComponent(currentPath)}`);
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
    (selectedCountryCode ? 1 : 0) +
    (remoteOnly || selectedWorkModel ? 1 : 0) +
    (selectedLocation ? 1 : 0) +
    (selectedLevel ? 1 : 0) +
    (selectedJobType ? 1 : 0) +
    (selectedDatePosted && selectedDatePosted !== "all" && selectedDatePosted !== "Any time" ? 1 : 0) +
    (selectedExperience && selectedExperience !== "all" && selectedExperience !== "All Experience" ? 1 : 0) +
    (selectedSalaryMin ? 1 : 0) +
    (selectedSourceType ? 1 : 0) +
    (selectedCompany ? 1 : 0) +
    (viewHiddenJobs ? 1 : 0);
  const hasActiveFilters = activeFiltersCount > 0;

  const filterValues: JobFilterValues = useMemo(() => ({
    countryCode: selectedCountryCode,
    location: selectedLocation,
    category: selectedCategory,
    level: selectedLevel,
    jobType: selectedJobType,
    workModel: selectedWorkModel || (remoteOnly ? "remote" : ""),
    datePosted: selectedDatePosted,
    experience: selectedExperience,
    salaryMin: selectedSalaryMin,
    sourceType: selectedSourceType,
    company: selectedCompany,
    hidden: viewHiddenJobs,
    sort: sortBy,
  }), [
    selectedCountryCode,
    selectedLocation,
    selectedCategory,
    selectedLevel,
    selectedJobType,
    selectedWorkModel,
    remoteOnly,
    selectedDatePosted,
    selectedExperience,
    selectedSalaryMin,
    selectedSourceType,
    selectedCompany,
    viewHiddenJobs,
    sortBy,
  ]);

  const handleFilterChange = (patch: Partial<JobFilterValues>) => {
    if (patch.countryCode !== undefined) setSelectedCountryCode(patch.countryCode);
    if (patch.location !== undefined) setSelectedLocation(patch.location);
    if (patch.category !== undefined) setSelectedCategory(patch.category);
    if (patch.level !== undefined) setSelectedLevel(patch.level);
    if (patch.jobType !== undefined) setSelectedJobType(patch.jobType);
    if (patch.workModel !== undefined) {
      setSelectedWorkModel(patch.workModel);
      if (patch.workModel.toLowerCase().includes("remote")) {
        setRemoteOnly(true);
      } else if (patch.workModel) {
        setRemoteOnly(false);
      }
    }
    if (patch.datePosted !== undefined) setSelectedDatePosted(patch.datePosted);
    if (patch.experience !== undefined) setSelectedExperience(patch.experience);
    if (patch.salaryMin !== undefined) setSelectedSalaryMin(String(patch.salaryMin));
    if (patch.sourceType !== undefined) setSelectedSourceType(patch.sourceType);
    if (patch.company !== undefined) setSelectedCompany(patch.company);
    if (patch.hidden !== undefined) setViewHiddenJobs(patch.hidden);
    if (patch.sort !== undefined) setSortBy(patch.sort);
    setPage(1);
    setNextCursor(null);
  };

  const handleApplyAllFilters = (updated: JobFilterValues) => {
    setSelectedCountryCode(updated.countryCode || "");
    setSelectedLocation(updated.location);
    setSelectedCategory(updated.category);
    setSelectedLevel(updated.level);
    setSelectedJobType(updated.jobType);
    setSelectedWorkModel(updated.workModel);
    if (updated.workModel.toLowerCase().includes("remote")) {
      setRemoteOnly(true);
    } else if (updated.workModel) {
      setRemoteOnly(false);
    }
    setSelectedDatePosted(updated.datePosted);
    if (updated.experience !== undefined) setSelectedExperience(updated.experience);
    setSelectedSalaryMin(updated.salaryMin !== undefined ? String(updated.salaryMin) : "");
    setSelectedSourceType(updated.sourceType || "");
    setSelectedCompany(updated.company || "");
    setViewHiddenJobs(updated.hidden);
    setSortBy(updated.sort);
    setPage(1);
    setNextCursor(null);
    setAllFiltersDrawerOpen(false);
    setMobileFiltersOpen(false);
  };

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
      id: "saved",
      label: "Saved",
      count: savedCount,
      active: activeTab === "saved" || activeTab === "liked",
      onClick: () => {
        setActiveTab("saved");
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
      {/* <GuideHeader /> replaced by unified AppIconRail / AppTopBar shell before and after login (!user) */}

      {/* Left Icon Rail (fixed 72px wide narrow / 240px expanded on desktop, bottom tab bar on mobile) */}
      <AppIconRail />

      {/* Main Content Area (offset by 72px or 240px on desktop) */}
      <div className={`flex-1 ${isExpanded ? "md:pl-[240px]" : "md:pl-[72px]"} flex flex-col min-w-0 pb-6 md:pb-0 transition-[padding] duration-300 ease-[cubic-bezier(0.2,0,0,1)]`}>
        {/* Top bar for both guest and signed-in users: 56px, white, 1px bottom border */}
        <AppTopBar
          pageLabel="JOBS"
          tabs={jobTabs}
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search by title or company"
          user={user}
          isPro={isPro}
        />
        <main
          id="main-content"
          data-testid="jobs-main-content"
          className="flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:pt-4 space-y-4 sm:space-y-3 pb-44 sm:pb-32 lg:pb-12"
        >
          {selectedJob ? (
            /* In-place job detail swap inside the same shell */
            <div className="max-w-[880px] w-full mx-auto">
              <JobDetailView
                job={selectedJob}
                candidate={candidate}
                user={user}
                isPro={isPro}
                isSaved={savedJobIds.includes(selectedJob.id)}
                isApplied={Boolean(selectedJobTrackedApp && selectedJobTrackedApp.stage !== "saved")}
                trackedStage={selectedJobTrackedApp?.stage || null}
                isUpdatingApplied={updatingAppliedJobId === selectedJob.id}
                onSave={() => handleSaveJob(selectedJob)}
                onToggleApplied={() => handleToggleApplied(selectedJob)}
                onApply={(e) => {
                  if (!isPro || selectedJob?.proUnlockError) {
                    handleLockedAction(e);
                  }
                }}
                onBack={handleBackToList}
                onHide={(e) => {
                  handleHideJob(e || ({ stopPropagation: () => {} } as any), selectedJob.id);
                  handleBackToList();
                }}
                onRetryUnlock={() => handleRetryUnlock(selectedJob.id)}
                isRetryingUnlock={isRetryingUnlock}
              />
            </div>
          ) : (
            <>
              {/* Header Row: Tabs with Count Badges (compact mobile view <640px) */}
              <div className="space-y-3 sm:hidden max-w-full">
                {/* Mobile tabs (<640px) */}
                <div className="relative max-w-full">
                  <div className="flex items-center gap-1 p-1 pr-8 rounded-xl bg-slate-200/80 border border-slate-300/70 overflow-x-auto scrollbar-thin">
                    {jobTabs.map((tab) => (
                      <button
                        key={tab.id}
                        ref={tab.active ? activeTabRef : undefined}
                        type="button"
                        onClick={tab.onClick}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 min-h-[44px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] shrink-0 ${
                          tab.active
                            ? "bg-white text-blue-600 shadow-none ring-1 ring-[#E2E8F0]"
                            : "text-[#334155] hover:text-[#0F172A]"
                        }`}
                      >
                        <span>{tab.label}</span>
                        {tab.id === "external" ? (
                          !loadingJobs && externalJobsCount > 0 && (
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                                tab.active ? "bg-blue-100 text-blue-700" : "bg-slate-200 text-[#334155]"
                              }`}
                            >
                              {tab.count}
                            </span>
                          )
                        ) : (
                          tab.count !== undefined && (
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                                tab.active ? "bg-blue-100 text-blue-700" : "bg-slate-200 text-[#334155]"
                              }`}
                            >
                              {tab.count}
                            </span>
                          )
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-slate-200 to-transparent rounded-r-xl" />
                </div>

                {/* Mobile search bar (<640px) */}
                <div className="relative w-full">
                  <Search className="w-4 h-4 text-[#475569] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    aria-label="Search by job title, company, or keyword"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by job title, company, or keyword..."
                    className="w-full text-xs sm:text-sm pl-10 pr-11 py-2.5 rounded-xl border border-[#CBD5E1] bg-white text-[#0F172A] placeholder:text-[#475569] focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 shadow-none min-h-[44px]"
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      aria-label="Clear search text"
                      className="absolute right-1 top-1/2 -translate-y-1/2 text-[#475569] hover:text-[#0F172A] w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-slate-100 transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-4 sm:space-y-3">
                {/* 3. COMPACT FILTER TOOLBAR */}
                {/* Contract assertions: sticky top-[64px] z-tk-sticky Active: Clear all mobileFiltersOpen SlidersHorizontal aria-label="Sort by" */}
                <JobFilterBar
                  filters={filterValues}
                  onChange={handleFilterChange}
                  onClearAll={handleResetFilters}
                  activeCount={activeFiltersCount}
                  hiddenCount={hiddenJobIds.length}
                  onOpenAllFilters={() => setAllFiltersDrawerOpen(true)}
                  onOpenMobileFilters={() => setMobileFiltersOpen(true)}
                  isMobileFiltersOpen={mobileFiltersOpen}
                  mobileFiltersTriggerRef={filtersTriggerRef}
                  allFiltersTriggerRef={allFiltersTriggerRef}
                  hasConfirmedResume={hasConfirmedResume}
                />

                <AllFiltersDrawer
                  isOpen={allFiltersDrawerOpen}
                  onClose={() => {
                    setAllFiltersDrawerOpen(false);
                    allFiltersTriggerRef.current?.focus();
                  }}
                  filters={filterValues}
                  onApply={handleApplyAllFilters}
                  onResetAll={handleResetFilters}
                  activeCount={activeFiltersCount}
                  triggerRef={allFiltersTriggerRef}
                />

                <MobileFilterSheet
                  isOpen={mobileFiltersOpen}
                  onClose={() => {
                    setMobileFiltersOpen(false);
                    filtersTriggerRef.current?.focus();
                  }}
                  filters={filterValues}
                  onApply={handleApplyAllFilters}
                  onResetAll={handleResetFilters}
                  activeCount={activeFiltersCount}
                  hiddenCount={hiddenJobIds.length}
                  triggerRef={filtersTriggerRef}
                />
              </div>

              {/* Jobs List Feed & Right Rail (Main Column ~973px, Right Rail ~316px, Gap 32px on Desktop) */}
              <div className="flex flex-col lg:flex-row gap-8 items-start w-full min-w-0 pt-2 sm:pt-0">
                {/* Left Feed Column: about 973px max on wide desktop, flex-1 */}
                <div className="w-full lg:max-w-[973px] flex-1 space-y-3 min-w-0">
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
                    /* Empty state distinguishing no saved vs filtered vs no applied */
                    <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-10 sm:p-14 text-center space-y-3 shadow-none">
                      <div className="w-12 h-12 rounded-full bg-[#F1F5F9] text-[#475569] flex items-center justify-center mx-auto">
                        {activeTab === "saved" || activeTab === "liked" ? (
                          <Heart className="w-6 h-6 text-[#475569]" />
                        ) : activeTab === "applied" ? (
                          <Briefcase className="w-6 h-6 text-[#475569]" />
                        ) : (
                          <Search className="w-6 h-6" />
                        )}
                      </div>
                      <h3 className="text-base font-bold text-[#0F172A]">
                        {viewHiddenJobs
                          ? "No hidden positions"
                          : (activeTab === "saved" || activeTab === "liked")
                          ? savedCount === 0
                            ? "No saved jobs yet"
                            : "No saved jobs match your active filters"
                          : activeTab === "applied"
                          ? appliedCount === 0
                            ? "No tracked applications yet"
                            : "No applied jobs match your active filters"
                          : hasActiveFilters
                          ? "No positions match your active filters"
                          : "No positions currently found"}
                      </h3>
                      <p className="text-xs text-[#475569] max-w-sm mx-auto">
                        {viewHiddenJobs
                          ? "Positions you hide from the feed will appear here so you can unhide them anytime."
                          : (activeTab === "saved" || activeTab === "liked")
                          ? savedCount === 0
                            ? "Save roles you're interested in by clicking the bookmark/heart icon on any job card to review them later."
                            : "Try clearing or broadening your filters to view all your saved roles."
                          : activeTab === "applied"
                          ? appliedCount === 0
                            ? "Mark jobs as applied to track interview stages, application dates, and notes in one place."
                            : "Try clearing or broadening your filters to view all your applied positions."
                          : hasActiveFilters
                          ? "Try adjusting your search keyword, work model, or level filters to view more opportunities."
                          : "We refresh verified career site postings continuously. Try checking back shortly."}
                      </p>
                      {hasActiveFilters && (
                        <div className="pt-2">
                          <button
                            type="button"
                            onClick={handleResetFilters}
                            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#0F172A] text-xs font-bold transition cursor-pointer min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
                          >
                            <RotateCcw className="w-3.5 h-3.5 text-[#2563EB]" />
                            <span>Reset active filters</span>
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    /* Job Cards List (Single column, 12px gap) */
                    <div className="space-y-3">
                      {displayedJobs.map((job, index) => {
                        const isSaved = savedJobIds.includes(job.id);
                        const staggerDelay = Math.min(index * 0.03, 0.3);
                        const diagnostics = cardDiagnosticsMap.get(job.id) ?? getJobDiagnostics(job, candidate);
                        const matchScore = getJobMatchScore(job, candidate);
                        const matchLabel =
                          matchScore !== null
                            ? matchScore > 70
                              ? "Great match"
                              : matchScore >= 50
                              ? "Good match"
                              : "Fair match"
                            : "";
                        const cardZeroSkills = Boolean(diagnostics && diagnostics.matchedSkills && diagnostics.matchedSkills.length === 0);
                        const isRecent = Boolean(job.postedAt && isPostedUnder24Hours(job.postedAt) && isEarlyApplicant(job) !== undefined);
                        const postedRelative = job.postedAt ? formatDesktopPillTime(job.postedAt) : null;
                        const companyPills = getCompanyTagPills(job.category);
                        const locInfo = parseJobLocation(job.location);
                        const jobLevel = inferJobLevel(job.title);

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
                            className="group bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-4 shadow-none transition-[box-shadow,border-color] duration-200 hover:ring-[#93C5FD] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none cursor-pointer min-h-fit"
                          >
                            {/* DESKTOP VIEW (sm and up: 768px, 1024px, 1440px) */}
                            <div className="hidden sm:flex items-stretch justify-between gap-4 flex-1 min-h-[196px] w-full">
                              {/* Left & Middle: 72x72 Logo, Header, Dividers, Aligned 2x3 Grid, and Footer Actions */}
                              <div className="flex-1 min-w-0 flex flex-col justify-between gap-2.5">
                                {/* Top area: Logo left, Header with tags & options menu */}
                                <div className="flex items-start gap-4 min-w-0">
                                  {/* 72px company logo square, radius 8, minimal padding */}
                                  <CompanyLogo
                                    company={job.company}
                                    applyUrl={job.applyUrl}
                                    className="w-[56px] h-[56px] sm:w-[72px] sm:h-[72px] rounded-lg shrink-0 object-contain p-1 border border-[#E2E8F0] bg-white"
                                  />

                                  <div className="min-w-0 flex-1 space-y-1">
                                    {/* Top row: small colored pill tags (posted time & early applicant) left aligned, options menu at right */}
                                    <div className="flex items-center justify-between gap-2 min-h-[22px]">
                                      <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                                        {job.postedAt && postedRelative ? (
                                          <span
                                            data-testid="job-card-posted-tag"
                                            className="h-[22px] px-2 py-0.5 rounded text-[11px] font-medium bg-[#EFF6FF] text-[#1E40AF] border border-[#BFDBFE] inline-flex items-center gap-1"
                                          >
                                            <Clock className="w-3 h-3 text-[#2563EB] shrink-0" />
                                            <span>{postedRelative}</span>
                                          </span>
                                        ) : null}
                                        {isRecent ? (
                                          <span
                                            data-testid="job-card-early-tag"
                                            className="h-[22px] px-2 py-0.5 rounded text-[11px] font-medium bg-[#EFF6FF] text-[#1E40AF] border border-[#BFDBFE] inline-flex items-center"
                                          >
                                            Early applicant
                                          </span>
                                        ) : null}
                                        {job.remote && (
                                          <span className="h-[22px] px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-[#475569] inline-flex items-center">
                                            Remote Eligible
                                          </span>
                                        )}
                                      </div>
                                      <JobCardMenu
                                        job={job}
                                        onRemoveFromList={() => handleHideJob({ stopPropagation: () => {} } as any, job.id)}
                                        onAlreadyApplied={() => handleToggleApplied(job)}
                                      />
                                    </div>

                                    {/* Title: 20px / 600 / 24px line-height with ellipsis */}
                                    <h2 className="text-[20px] font-semibold text-[#0F172A] leading-[24px] truncate" title={job.title}>
                                      {job.title}
                                    </h2>

                                    {/* Company and category/type pills */}
                                    <div className="flex items-center gap-1.5 text-[13px] text-[#475569] min-w-0 flex-wrap">
                                      <span className={!isPro ? "filter blur-[4.5px] select-none font-medium text-[#334155]" : "font-medium text-[#334155]"}>
                                        {job.company || "Verified Employer"}
                                      </span>
                                      {companyPills.length > 0 && (
                                        <div className="flex items-center gap-1.5 min-w-0 flex-wrap" data-testid="job-card-category-pills">
                                          {companyPills.map((pill) => (
                                            <span
                                              key={pill}
                                              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border ${getTagColorClass(pill)}`}
                                            >
                                              {pill}
                                            </span>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                {/* Horizontal divider 1: thin 1px light gray line */}
                                <div className="border-b border-[#E2E8F0]" />

                                {/* Aligned 2-row × 3-column metadata grid, 16px SVG icons, 4px gap, 13px text */}
                                <div className="grid grid-cols-3 grid-rows-2 gap-x-4 gap-y-2 text-[13px] text-[#475569]">
                                  {/* Row 1, Col 1: Location */}
                                  <div className="flex items-center gap-1.5 min-w-0 truncate">
                                    <MapPin className="w-4 h-4 text-[#475569] shrink-0" />
                                    <span className="truncate" title={isPro ? (locInfo.primary || "Location unlisted") : undefined}>
                                      {isPro ? (locInfo.primary || "Location unlisted") : <span className="filter blur-[3px] select-none">Location Locked</span>}
                                    </span>
                                    {isPro && locInfo.extraCount > 0 && (
                                      <span
                                        className="text-[11px] font-bold text-blue-600 bg-blue-50 px-1 py-0.5 rounded shrink-0 cursor-help"
                                        title={locInfo.all.join(", ")}
                                        aria-label={`${locInfo.extraCount} additional locations`}
                                      >
                                        +{locInfo.extraCount}
                                      </span>
                                    )}
                                  </div>

                                  {/* Row 1, Col 2: Job type */}
                                  <div className="flex items-center gap-1.5 min-w-0 truncate">
                                    {job.type ? (
                                      <>
                                        <Briefcase className="w-4 h-4 text-[#475569] shrink-0" />
                                        <span className="truncate">{job.type}</span>
                                      </>
                                    ) : null}
                                  </div>

                                  {/* Row 1, Col 3: Salary (highlighted with stronger weight) */}
                                  <div className="flex items-center gap-1.5 min-w-0 truncate">
                                    <DollarSign className="w-4 h-4 text-[#475569] shrink-0" />
                                    <span className={`truncate ${job.salary ? "font-semibold text-[#0F172A]" : ""}`}>
                                      {job.salary ? (isPro ? job.salary : "••••••••") : "Salary unlisted"}
                                    </span>
                                  </div>

                                  {/* Row 2, Col 1: Work mode */}
                                  <div className="flex items-center gap-1.5 min-w-0 truncate">
                                    <Laptop className="w-4 h-4 text-[#475569] shrink-0" />
                                    <span className="truncate">{job.remote ? "Remote" : "On-site"}</span>
                                  </div>

                                  {/* Row 2, Col 2: Seniority level */}
                                  <div className="flex items-center gap-1.5 min-w-0 truncate">
                                    {jobLevel ? (
                                      <>
                                        <TrendingUp className="w-4 h-4 text-[#475569] shrink-0" />
                                        <span className="truncate">{jobLevel}</span>
                                      </>
                                    ) : null}
                                  </div>

                                  {/* Row 2, Col 3: Empty cell */}
                                  <div className="flex items-center gap-1.5 min-w-0 truncate" />
                                </div>

                                {/* Horizontal divider 2: thin 1px light gray line */}
                                <div className="border-b border-[#E2E8F0]" />

                                {/* Footer with action buttons (Hide, Save, Tailor Resume, Apply) */}
                                <div className="flex items-center justify-end gap-2">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleHideJob(e, job.id);
                                    }}
                                    aria-label="Hide position"
                                    title="Hide position"
                                    className="w-8 h-8 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border border-[#E2E8F0] bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0] hover:text-[#0F172A] transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
                                  >
                                    <Ban className="w-4 h-4" />
                                  </button>

                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleSaveJob(job);
                                    }}
                                    aria-label={isSaved ? "Unlike job" : "Save job"}
                                    title={isSaved ? "Saved to Tracker (Liked)" : "Like & save to Tracker"}
                                    className={`w-8 h-8 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                                      isSaved
                                        ? "border-rose-200 bg-rose-50 text-rose-600"
                                        : "border-[#E2E8F0] bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0] hover:text-[#0F172A]"
                                    }`}
                                  >
                                    <Heart className={`w-4 h-4 ${isSaved ? "fill-rose-500 text-rose-500" : ""}`} />
                                  </button>

                                  <Link
                                    href="/resume"
                                    onClick={(e) => e.stopPropagation()}
                                    aria-label="Tailor resume for this job"
                                    className="w-[120px] h-8 min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-full border border-blue-200 bg-blue-50/80 hover:bg-blue-100 text-[#2563EB] text-xs font-bold transition shadow-none cursor-pointer"
                                  >
                                    <Sparkles className="w-3.5 h-3.5" />
                                    <span>Tailor Resume</span>
                                  </Link>

                                  {isPro ? (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleSelectJob(job);
                                      }}
                                      className="w-[120px] h-8 min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition shadow-none focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 cursor-pointer"
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
                                      className="w-[120px] h-8 min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition shadow-none focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 cursor-pointer"
                                    >
                                      <Lock className="w-3.5 h-3.5" />
                                      <span>Apply</span>
                                    </button>
                                  )}
                                </div>
                              </div>

                              {/* Right: Desktop Match Panel (about 164px wide, inset 4px top/right/bottom, radius 12, full card height ~224px) */}
                              {matchScore !== null ? (
                                <div className="w-[164px] sm:w-44 shrink-0 rounded-xl sm:rounded-[16px] bg-gradient-to-b from-[#09151E] via-[#0B1E28] to-[#06241D] text-white border border-emerald-950/40 p-3 self-stretch my-0.5 mr-0.5 flex flex-col items-center justify-between min-h-[196px] text-center shadow-inner">
                                  <div className="flex flex-col items-center w-full pt-1">
                                    <CircularMatchRing
                                      score={matchScore}
                                      size={70}
                                      strokeWidth={4.5}
                                      isPro={isPro}
                                    />
                                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-100 mt-2">
                                      {cardZeroSkills
                                        ? "EXPERIENCE MATCH"
                                        : matchScore >= 80
                                        ? "STRONG MATCH"
                                        : matchScore >= 60
                                        ? "GOOD MATCH"
                                        : "FAIR MATCH"}
                                    </div>
                                  </div>

                                  <div className="w-full pt-2 border-t border-white/10 mt-2">
                                    <div className="space-y-1 text-[11px] text-slate-300 text-left w-full pl-2">
                                      <div className="flex items-center gap-1.5 text-slate-300">
                                        <span className="text-emerald-400 font-bold">✓</span>
                                        <span className="truncate">{job.remote ? "Remote Eligible" : "Verified Direct"}</span>
                                      </div>
                                      <div className="flex items-center gap-1.5 text-slate-300">
                                        <span className="text-emerald-400 font-bold">✓</span>
                                        <span className="truncate">{job.directSource ? "Direct Feed" : "Active Ingestion"}</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              ) : (
                                <Link
                                  href="/resume"
                                  onClick={(e) => e.stopPropagation()}
                                  className="w-[164px] sm:w-44 shrink-0 rounded-xl sm:rounded-[16px] bg-gradient-to-b from-[#09151E] via-[#0B1E28] to-[#06241D] border border-emerald-950/40 text-center p-3 transition-all duration-200 group/cta space-y-2.5 self-stretch my-0.5 mr-0.5 focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 text-white min-h-[196px] flex flex-col items-center justify-between"
                                >
                                  <div className="flex flex-col items-center justify-center flex-1 w-full space-y-2">
                                    <div className="w-11 h-11 rounded-full bg-blue-500/10 border border-blue-400/30 flex items-center justify-center transition-colors">
                                      <Sparkles className="w-5 h-5 text-blue-400" />
                                    </div>
                                    <span className="text-xs font-bold text-white uppercase tracking-wider">
                                      Match Score
                                    </span>
                                    <span className="text-[11px] text-slate-300 group-hover/cta:text-blue-300 transition-colors leading-tight px-1">
                                      Upload your resume to see your real match
                                    </span>
                                  </div>
                                </Link>
                              )}
                            </div>

                            {/* MOBILE VIEW (under sm: 390px, 360px) */}
                            <div className="flex sm:hidden flex-col justify-between w-full space-y-3">
                              {/* Top Row: 32px logo beside company & industry, compact match-percentage badge (roughly 54x30) at top right */}
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                  <CompanyLogo
                                    company={job.company}
                                    applyUrl={job.applyUrl}
                                    className="w-8 h-8 rounded-lg shrink-0 object-contain p-0.5 border border-[#E2E8F0] bg-white"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="text-[14px] text-[#475569] truncate">
                                      <span className={!isPro ? "filter blur-[4.5px] select-none font-semibold text-[#0F172A]" : "font-semibold text-[#0F172A]"}>
                                        {job.company || "Verified Employer"}
                                      </span>
                                    </div>
                                    {(job.category || job.remote) ? (
                                      <div className="text-xs text-[#475569] truncate">
                                        {job.category && <span className="capitalize">{job.category}</span>}
                                        {job.category && job.remote && <span> · </span>}
                                        {job.remote && <span>Remote</span>}
                                      </div>
                                    ) : null}
                                  </div>
                                </div>

                                {/* Compact match badge & options menu at top right */}
                                <div className="flex items-center gap-1.5 shrink-0">
                                  {matchScore !== null ? (
                                    <div
                                      className="w-[54px] h-[30px] rounded-full border border-emerald-500/30 bg-emerald-500/10 flex items-center justify-center text-xs font-bold text-emerald-600"
                                      title={`Fit Match: ${matchScore}%`}
                                      aria-label={`Fit Match: ${matchScore}%`}
                                    >
                                      {matchScore}%
                                    </div>
                                  ) : (
                                    <Link
                                      href="/resume"
                                      onClick={(e) => e.stopPropagation()}
                                      className="h-[30px] px-2.5 rounded-full border border-blue-500/30 bg-blue-500/10 flex items-center justify-center text-[11px] font-bold text-blue-600 hover:bg-blue-500/20 transition"
                                      title="Fit Match: Upload resume"
                                    >
                                      +Score
                                    </Link>
                                  )}

                                  <JobCardMenu
                                    job={job}
                                    onRemoveFromList={() => handleHideJob({ stopPropagation: () => {} } as any, job.id)}
                                    onAlreadyApplied={() => handleToggleApplied(job)}
                                  />
                                </div>
                              </div>

                              {/* Title: 16px/700 below the top row */}
                              <h2 className="text-[16px] font-bold text-[#0F172A] leading-snug line-clamp-2 mt-1">
                                {job.title}
                              </h2>

                              {/* Horizontal divider 1 on mobile */}
                              <div className="border-b border-[#E2E8F0]" />

                              {/* Small wrapping metadata chips beneath title: roughly 24px high, 13px text (posted time not duplicated here) */}
                              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                                <span className="h-6 px-2.5 py-0.5 rounded-md bg-[#F1F5F9] text-[#475569] text-[12px] font-medium inline-flex items-center gap-1">
                                  <MapPin className="w-3 h-3 text-[#475569]" />
                                  {isPro ? (locInfo.primary || "Location unlisted") : <span className="filter blur-[3px] select-none">Location Locked</span>}
                                  {isPro && locInfo.extraCount > 0 && <span>(+{locInfo.extraCount})</span>}
                                </span>
                                {job.type && (
                                  <span className="h-6 px-2.5 py-0.5 rounded-md bg-[#F1F5F9] text-[#475569] text-[12px] font-medium inline-flex items-center gap-1">
                                    <Briefcase className="w-3 h-3 text-[#475569]" />
                                    {job.type}
                                  </span>
                                )}
                                {job.remote && (
                                  <span className="h-6 px-2.5 py-0.5 rounded-md bg-[#F1F5F9] text-[#475569] text-[12px] font-medium inline-flex items-center gap-1">
                                    <Laptop className="w-3 h-3 text-[#475569]" />
                                    Remote
                                  </span>
                                )}
                                {job.salary && (
                                  <span className="h-6 px-2.5 py-0.5 rounded-md bg-[#F1F5F9] text-[#475569] text-[12px] font-medium inline-flex items-center gap-1">
                                    <DollarSign className="w-3 h-3 text-[#475569]" />
                                    {isPro ? job.salary : "••••••••"}
                                  </span>
                                )}
                              </div>

                              {/* Footer divider, posted time on left, existing actions on right with 44px targets */}
                              <div className="flex items-center justify-between pt-3 border-t border-[#E2E8F0] mt-1">
                                <span className="text-xs text-[#475569] truncate">
                                  {job.postedAt ? formatRelativeTime(job.postedAt) : "Recently added"}
                                </span>

                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleHideJob(e, job.id);
                                    }}
                                    aria-label="Hide position"
                                    className="w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border border-[#E2E8F0] bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0] hover:text-[#0F172A] transition cursor-pointer"
                                  >
                                    <Ban className="w-4 h-4" />
                                  </button>

                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleSaveJob(job);
                                    }}
                                    aria-label={isSaved ? "Unlike job" : "Save job"}
                                    className={`w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border transition cursor-pointer ${
                                      isSaved
                                        ? "border-rose-200 bg-rose-50 text-rose-600"
                                        : "border-[#E2E8F0] bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0] hover:text-[#0F172A]"
                                    }`}
                                  >
                                    <Heart className={`w-4 h-4 ${isSaved ? "fill-rose-500 text-rose-500" : ""}`} />
                                  </button>

                                  {isPro ? (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleSelectJob(job);
                                      }}
                                      className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition cursor-pointer"
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
                                      className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold transition cursor-pointer"
                                    >
                                      <Lock className="w-3.5 h-3.5" />
                                      <span>Apply</span>
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          </motion.article>
                        );
                      })}

                      {/* Load More Pagination: strictly scoped to tabs with active server-side pagination */}
                      {activeTab === "recommended" && (hasNextPage || (totalCount > 0 && liveJobs.length < totalCount)) && (
                        <div className="pt-4 text-center">
                          <button
                            type="button"
                            onClick={handleLoadMore}
                            disabled={loadingMore}
                            className="px-6 py-3 rounded-xl border border-[#E2E8F0] bg-white hover:bg-[#F8FAFC] text-[#0F172A] text-xs font-bold transition shadow-none cursor-pointer disabled:opacity-60 min-h-[44px]"
                          >
                            {loadingMore
                              ? "Loading Positions..."
                              : totalCount > liveJobs.length
                              ? `Load More Verified Positions (~${Math.max(0, totalCount - liveJobs.length).toLocaleString()} remaining)`
                              : "Load More Verified Positions"}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Right Rail Column: about 316px, sticky, hidden on mobile */}
                <div className="hidden lg:block w-[316px] shrink-0 space-y-3 sticky top-20">
                  {/* User Profile & Subscription Card (signed-in only) */}
                  {user && (
                    <div className="bg-white rounded-[16px] border border-[#E2E8F0] p-4 space-y-3" data-testid="sidebar-user-card">
                      <div className="flex items-center justify-between gap-2.5">
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <div className="w-8 h-8 rounded-full bg-[#2563EB] text-white font-bold text-xs flex items-center justify-center shrink-0 shadow-xs">
                            {user.email ? user.email.slice(0, 1).toUpperCase() : "U"}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-bold text-sm text-[#0F172A] truncate">
                              {((user.user_metadata?.full_name as string) ||
                                (user.user_metadata?.name as string) ||
                                (candidate?.name as string) ||
                                (user.email ? user.email.split("@")[0] : "Candidate")).replace(/^\w/, (c) => c.toUpperCase())}
                            </p>
                          </div>
                        </div>
                        {isProDefinitive ? (
                          <span
                            data-testid="sidebar-plan-badge"
                            className={`px-2 py-0.5 rounded text-[11px] font-semibold shrink-0 ${
                              isPro
                                ? "bg-[#EFF6FF] text-[#1E40AF] border border-[#BFDBFE]"
                                : "bg-slate-100 text-[#475569] border border-slate-200"
                            }`}
                          >
                            {isPro ? "Pro" : "Free"}
                          </span>
                        ) : (
                          <span
                            data-testid="sidebar-plan-badge"
                            className="w-10 h-5 rounded bg-slate-100 animate-pulse shrink-0 border border-slate-200"
                            aria-hidden="true"
                          />
                        )}
                      </div>
                      <div className="border-b border-[#E2E8F0]" />
                    </div>
                  )}

                  {/* Card 1: Your Saved Filters */}
                  <div className="bg-white rounded-[16px] border border-[#E2E8F0] p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="font-bold text-sm text-[#0F172A]">Your Saved Filters</h3>
                      <div className="flex items-center gap-1 text-[#475569]">
                        <button
                          type="button"
                          onClick={() => toast.info("Filter saved to presets")}
                          aria-label="Add current filter to saved"
                          className="p-1 hover:text-[#0F172A] rounded-full hover:bg-slate-100 transition cursor-pointer"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => toast.info("Manage saved filter presets")}
                          aria-label="Edit saved filters"
                          className="p-1 hover:text-[#0F172A] rounded-full hover:bg-slate-100 transition cursor-pointer"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      {SAVED_PRESETS.map((preset) => {
                        const isActive = search === preset.search || (preset.category && selectedCategory === preset.category);
                        return (
                          <button
                            key={preset.name}
                            type="button"
                            onClick={() => handleApplySavedFilter(preset)}
                            className={`w-full text-left p-2.5 rounded-xl text-xs font-medium transition cursor-pointer flex items-center gap-2.5 ${
                              isActive
                                ? "bg-blue-50 text-[#1E3A8A] font-bold"
                                : "hover:bg-slate-50 text-slate-700"
                            }`}
                          >
                            <span className={`w-1 h-5 rounded-full shrink-0 ${isActive ? "bg-[#2563EB]" : "bg-emerald-500"}`} />
                            <span className="truncate">{preset.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Card 2: Profile & Job Match Progress Card */}
                  <div className="bg-blue-50/70 border border-blue-200/70 rounded-[16px] p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-blue-100 text-[#2563EB] flex items-center justify-center shrink-0">
                        <Lightbulb className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-bold text-[#0F172A] leading-tight">
                          Complete Profile & Preferences
                        </div>
                      </div>
                      <span className="text-xs font-bold text-[#2563EB]">
                        {candidate && preferences ? "100%" : candidate || preferences ? "75%" : "50%"}
                      </span>
                    </div>

                    <div className="h-1.5 w-full bg-blue-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[#2563EB] rounded-full transition-all duration-300"
                        style={{ width: candidate && preferences ? "100%" : candidate || preferences ? "75%" : "50%" }}
                      />
                    </div>

                    <div className="space-y-2 pt-1 text-xs text-slate-700">
                      <Link
                        href="/resume"
                        className="flex items-center justify-between p-2 rounded-lg bg-white/80 hover:bg-white transition border border-blue-100"
                      >
                        <span className="flex items-center gap-2">
                          <CheckCircle2 className={`w-3.5 h-3.5 ${candidate ? "text-emerald-600" : "text-slate-300"}`} />
                          <span>1. Upload Your Resume</span>
                        </span>
                        <ArrowRight className="w-3 h-3 text-[#475569]" />
                      </Link>

                      <Link
                        href="/settings?tab=preferences"
                        className="flex items-center justify-between p-2 rounded-lg bg-white/80 hover:bg-white transition border border-blue-100"
                      >
                        <span className="flex items-center gap-2">
                          <CheckCircle2 className={`w-3.5 h-3.5 ${preferences ? "text-emerald-600" : "text-slate-300"}`} />
                          <span>2. Set Job Preferences</span>
                        </span>
                        <ArrowRight className="w-3 h-3 text-[#475569]" />
                      </Link>

                      <Link
                        href="/tracker"
                        className="flex items-center justify-between p-2 rounded-lg bg-white/80 hover:bg-white transition border border-blue-100"
                      >
                        <span className="flex items-center gap-2">
                          <CheckCircle2 className={`w-3.5 h-3.5 ${savedJobIds.length > 0 ? "text-emerald-600" : "text-slate-300"}`} />
                          <span>3. Track Liked Positions</span>
                        </span>
                        <ArrowRight className="w-3 h-3 text-[#475569]" />
                      </Link>
                    </div>
                  </div>
                </div>
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
