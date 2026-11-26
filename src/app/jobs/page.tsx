"use client";

import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, Suspense, startTransition } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { getLiveJobs, getLiveJobById, keepSameJobLogoIdentity, LatestJobSelectionGate, LiveJob, isEarlyApplicant, capJobsPerCompany, CURSOR_RESET_ERROR, type GetJobsResult } from "@/lib/jobs/service";
import { getAuthUser, getUserPreferences, saveUserPreferences } from "@/lib/auth/session";
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
import Footer from "@/components/Footer";
import AppIconRail from "@/components/shell/AppIconRail";
import { useSidebarMode } from "@/lib/sidebar";
import AppTopBar, { TopBarTab } from "@/components/shell/AppTopBar";
import "./mobile-reference.css";
import JobDetailView, { type ResumeState } from "@/components/jobs/JobDetailView";
import JobFilterBar, { JobFilterValues } from "@/components/jobs/JobFilterBar";
import { formatJobType } from "@/lib/jobs/formatJobType";
import AllFiltersDrawer from "@/components/jobs/AllFiltersDrawer";
import { matchCountryWithStrictFallback } from "@/lib/countries";
import MobileFilterSheet from "@/components/jobs/MobileFilterSheet";
import PreferencesSheet from "@/components/jobs/PreferencesSheet";
import { activeCount as activePreferenceCount, draftFromPreferences } from "@/lib/preferences/model";
import JobCardContent from "@/components/jobs/JobCardContent";
import { computeFitDiagnostics, FitDiagnosticsResult, compareByRecommendedRanking, shouldApplyRecommendedRanking, displayMatchScore, toFitInput } from "@/lib/matcher/scoring";
import { matchScoreSnapshot, recallMatchScore, reconcileFeedWithDetail, rememberMatchScores } from "@/lib/matcher/scoreCache";
import type { User } from "@supabase/supabase-js";
import {
  Search,
  RotateCcw,
  Heart,
  Briefcase,
  AlertCircle,
  ArrowLeft,
} from "lucide-react";
import { toast } from "react-toastify";
import { trackFunnelEvent } from "@/lib/analytics/funnel";
import {
  EXPERIENCE_LEVEL_LABELS,
  formatExperienceLevels,
  matchesExperienceLevelFilter,
  parseExperienceLevels,
  type CanonicalExperienceLevel,
} from "@/lib/jobs/experienceLevels";
import FirstJobsWelcome from "@/components/jobs/FirstJobsWelcome";
import { withFeedScore } from "@/lib/jobs/recommendations";
import { isRemoteOnlyWorkModel, matchesJobTypeFilter, matchesWorkModelFilter } from "@/lib/jobs/jobFilters";
import { appendPage, createNextPageLoader, FEED_PAGE_SIZE, isStalledCursor, PREFETCH_PAGES, refillTarget, type PageLoadOutcome } from "@/lib/jobs/pagination";
import { datePostedCutoff, savedFeedConstraintsEnforced } from "@/lib/preferences/feedConstraints";
import JobsProductTour from "@/components/jobs/JobsProductTour";
import {
  consumeFirstRunMarker,
  isTourDismissed,
  markTourDismissed,
  shouldShowFirstJobsWelcome,
} from "@/lib/onboarding/firstJobsExperience";

const PaywallModal = dynamic(() => import("@/components/PaywallModal"), { ssr: false });

const GUEST_HIDDEN_JOBS_KEY = "cm_hidden_jobs_guest";

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
  { name: "AI & Machine Learning", category: "ai", remoteOnly: false },
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

// Card score: the same displayMatchScore contract as the detail header and Match Insights.
function getJobMatchScore(job: LiveJob, candidate: CandidateProfile | null): number | null {
  if (typeof job.matchScore === "number" && !isNaN(job.matchScore)) return displayMatchScore(job, null);
  if (!candidate || !candidate.confirmedAt) return null;
  try {
    return displayMatchScore(job, computeFitDiagnostics(candidate, toFitInput(job)));
  } catch {
    return null;
  }
}

function getJobDiagnostics(job: LiveJob, candidate: CandidateProfile | null): FitDiagnosticsResult | null {
  if (candidate && candidate.confirmedAt) {
    try {
      const res = computeFitDiagnostics(candidate, toFitInput(job));
      if (res && typeof res.score === "number" && !isNaN(res.score)) {
        return res;
      }
    } catch {}
  }
  return null;
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


/** The first laid-out job card still on screen and its viewport offset, or null when none is. */
function readScrollAnchor(): { id: string; top: number } | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-job-id]"))) {
    const rect = el.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > 0) return { id: el.dataset.jobId as string, top: rect.top };
  }
  return null;
}

function JobsPageInner() {
  const { isExpanded } = useSidebarMode();
  const router = useRouter();
  const shouldReduceMotion = useReducedMotion();

  // Active Tab: 'recommended' | 'liked' | 'applied' | 'external'
  const [activeTab, setActiveTab] = useState<JobTab>("recommended");

  // In-place Selected Job for Detail View
  const [selectedJob, setSelectedJob] = useState<LiveJob | null>(null);
  const jobSelectionGateRef = useRef<LatestJobSelectionGate | null>(null);
  if (!jobSelectionGateRef.current) jobSelectionGateRef.current = new LatestJobSelectionGate();
  const pendingJobIdRef = useRef<string | null>(null);
  const scrollPositionRef = useRef<number>(0);
  const [viewHiddenJobs, setViewHiddenJobs] = useState(false);
  const [isPhone, setIsPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setIsPhone(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  const effectiveViewHiddenJobs = viewHiddenJobs && !isPhone;

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
  const [sortBy, setSortBy] = useState<"match" | "newest">("match");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const preferencesTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [_openDropdown, setOpenDropdown] = useState<string | null>(null);

  // Debounced search for server-side execution (300ms)
  useEffect(() => {
    const handler = setTimeout(() => {
      // Mark the filter/render pass as non-urgent so typing stays responsive
      // while the job list re-renders (concurrent feature).
      startTransition(() => {
        setDebouncedSearch(search);
      });
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
  // Where the viewer's resume stands, so the detail shows an honest state instead of a score (candidate stays null unless confirmed).
  const [resumeState, setResumeState] = useState<ResumeState>("loading");
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [trackedApplications, setTrackedApplications] = useState<TrackedApplication[]>([]);
  const [resolvedJobsMap, setResolvedJobsMap] = useState<Record<string, LiveJob>>({});
  const [savedJobIds, setSavedJobIds] = useState<string[]>([]);
  const [_appliedJobIds, setAppliedJobIds] = useState<string[]>([]);
  const [appliedCount, setAppliedCount] = useState<number>(0);
  const [updatingAppliedJobId, setUpdatingAppliedJobId] = useState<string | null>(null);
  const inFlightAppliedRef = useRef<Set<string>>(new Set());
  const inFlightSaveRef = useRef<Set<string>>(new Set());
  const filtersTriggerRef = useRef<HTMLButtonElement | null>(null);
  const filterDialogRef = useRef<HTMLDivElement | null>(null);
  const hasInitializedFromUrl = useRef(false);
  const [isPaywallOpen, setIsPaywallOpen] = useState(false);
  const [isRetryingUnlock, setIsRetryingUnlock] = useState(false);
  const [page, setPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState<boolean>(false);

  // Live Supabase Jobs Data
  const [liveJobs, setLiveJobs] = useState<LiveJob[]>([]);
  // Authoritative rows for growth checks. The look-ahead chain runs several requests from the
  // closure of the render that started it, so reading the liveJobs state there would compare a new
  // page against stale rows and report growth for an all-duplicate page. This ref is updated
  // synchronously wherever a page is applied.
  const liveJobsRef = useRef<LiveJob[]>([]);
  useEffect(() => {
    liveJobsRef.current = liveJobs;
  }, [liveJobs]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [appliedEligibility, setAppliedEligibility] = useState<{ countries: string[]; filteredOut: number } | null>(null);
  const [loadingJobs, setLoadingJobs] = useState<boolean>(true);
  const [isDegraded, setIsDegraded] = useState<boolean>(false);
  const [retryNonce, setRetryNonce] = useState<number>(0);

  // First-run welcome + guided tour: desktop (>=1024px) only; mobile/tablet Jobs is unchanged.
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [tourActive, setTourActive] = useState(false);
  const welcomeTriggeredRef = useRef(false);

  useEffect(() => {
    // Once per mount; only after the verified user's recommended feed has loaded (not degraded).
    if (welcomeTriggeredRef.current || !isDesktop || loadingJobs || isDegraded || !user?.id) return;
    if (
      shouldShowFirstJobsWelcome({
        userId: user.id,
        isVerifiedUser: true,
        isRecommendedTab: activeTab === "recommended",
      })
    ) {
      welcomeTriggeredRef.current = true;
      setWelcomeOpen(true);
    }
  }, [isDesktop, loadingJobs, isDegraded, user, activeTab]);

  const finishWelcome = (levels: CanonicalExperienceLevel[] | null) => {
    if (user?.id) consumeFirstRunMarker(user.id);
    // Confirm applies the OR Level filter to the current feed/URL only (not an account preference).
    if (levels) {
      setSelectedLevel(formatExperienceLevels(levels));
      setPage(1);
    }
    setWelcomeOpen(false);
    if (user?.id && !isTourDismissed(user.id)) setTourActive(true);
  };

  const endTour = () => {
    if (user?.id) markTourDismissed(user.id);
    setTourActive(false);
  };
  const [apiSimilarJobs, setApiSimilarJobs] = useState<LiveJob[]>([]);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [detailStatus, setDetailStatus] = useState<"not-found" | "expired" | null>(null);
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
    // A stale remote=true next to Remote + Hybrid/Onsite (written by the old handlers) is not a Remote-only link.
    if (qRemote && (!qWorkModel || isRemoteOnlyWorkModel(qWorkModel))) setRemoteOnly(true);
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
      setDetailLoading(true);
      setDetailStatus(null);
      getLiveJobById(qId, isPro)
        .then((job) => {
          pendingJobIdRef.current = null;
          setDetailLoading(false);
          if (job) {
            if (job.isExpired || job.status === "expired" || job.status === "closed") {
              setDetailStatus("expired");
            }
            setSelectedJob(job);
          } else {
            setDetailStatus("not-found");
          }
        })
        .catch(() => {
          pendingJobIdRef.current = null;
          setDetailLoading(false);
          setDetailStatus("not-found");
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
    syncParam("search", debouncedSearch);
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
    syncParam("sort", sortBy === "newest" ? "newest" : null);
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
    debouncedSearch,
    selectedCategory,
    selectedLocation,
    selectedLevel,
    selectedJobType,
    selectedDatePosted,
    selectedExperience,
    remoteOnly,
    viewHiddenJobs,
    effectiveViewHiddenJobs,
    sortBy,
    selectedWorkModel,
    selectedIndustry,
    selectedSalaryMin,
    selectedSourceType,
    selectedCompany,
    selectedCountryCode,
    selectedJob,
    router,
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
      setRemoteOnly(qRemote && (!qWorkModel || isRemoteOnlyWorkModel(qWorkModel)));
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
      setSortBy(qSort === "newest" ? "newest" : "match");

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
          setDetailLoading(false);
          setDetailStatus(found.isExpired ? "expired" : null);
          setSelectedJob(found);
        } else {
          setDetailLoading(true);
          setDetailStatus(null);
          getLiveJobById(qId, isPro)
            .then((job) => {
              pendingJobIdRef.current = null;
              setDetailLoading(false);
              if (job) {
                if (job.isExpired || job.status === "expired" || job.status === "closed") {
                  setDetailStatus("expired");
                }
                setSelectedJob(job);
              } else {
                setDetailStatus("not-found");
              }
            })
            .catch(() => {
              pendingJobIdRef.current = null;
              setDetailLoading(false);
              setDetailStatus("not-found");
            });
        }
      } else {
        pendingJobIdRef.current = null;
        setSelectedJob(null);
        setDetailLoading(false);
        setDetailStatus(null);
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

        // Preferences load beside the tracker and land in the same render as the account, so the feed
        // query key changes once (one page-1 request) instead of again when preferences arrive later.
        const [apps, prefs]: [TrackedApplication[], UserPreferences | null] = u
          ? await Promise.all([getTrackedApplications(u.id), getUserPreferences(u.id).catch(() => null)])
          : [[], null];
        if (cancelled) return;

        setUser(u);
        setIsPro(Boolean(proRes?.isPro));
        setIsProDefinitive(Boolean(proRes?.isDefinitive));
        setCandidate(cp && cp.confirmedAt ? cp : null);
        setResumeState(cp?.confirmedAt ? "confirmed" : cp ? "unconfirmed" : "none");
        setTrackedApplications(apps);
        const savedApps = apps.filter((a) => a.stage === "saved");
        setSavedJobIds(savedApps.map((a) => a.jobId || "").filter(Boolean));
        const appliedApps = apps.filter((a) => a.stage === "applied");
        const appliedIds = appliedApps.map((a) => a.jobId || "").filter(Boolean);
        setAppliedJobIds(appliedIds);
        setAppliedCount(appliedApps.length);
        if (u) setPreferences(prefs);
      } catch (err) {
        console.warn("Failed to load initial context on jobs page:", err);
        if (!cancelled) setResumeState("none");
      }
    }

    loadInitialContext();

    const handleSubUpdate = () => {
      getProAccessStatus().then((res) => {
        setIsPro(res.isPro);
        setIsProDefinitive(Boolean(res.isDefinitive));
      });
    };

    const handlePreferencesUpdate = () => {
      getAuthUser().then(async (currentUser) => {
        if (!currentUser) return;
        const nextPreferences = await getUserPreferences(currentUser.id);
        if (!cancelled) setPreferences(nextPreferences);
      }).catch((error) => console.warn("Failed to refresh job preferences:", error));
    };

    const handleProfileUpdate = () => {
      handlePreferencesUpdate();
      getCandidateProfile().then((cp) => {
        if (cp && cp.confirmedAt) {
          setCandidate(cp);
        } else {
          setCandidate(null);
        }
        setResumeState(cp?.confirmedAt ? "confirmed" : cp ? "unconfirmed" : "none");
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
    window.addEventListener("careermonke_preferences_updated", handlePreferencesUpdate);
    window.addEventListener("careermonke_tracker_updated", handleTrackerUpdate);
    return () => {
      cancelled = true;
      window.removeEventListener("careermonke_pro_updated", handleSubUpdate);
      window.removeEventListener("careermonke_auth_updated", handleSubUpdate);
      window.removeEventListener("careermonke_profile_updated", handleProfileUpdate);
      window.removeEventListener("careermonke_preferences_updated", handlePreferencesUpdate);
      window.removeEventListener("careermonke_tracker_updated", handleTrackerUpdate);
    };
    // Mount-once bootstrap + event subscriptions. user?.id is read inside the
    // tracker handler via closure; re-running on its change would duplicate
    // the initial load. Intentional empty deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasConfirmedResume = Boolean(candidate && candidate.confirmedAt);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [autoLoadPaused, setAutoLoadPaused] = useState(false);
  // One next-page request at a time; reset (abort + stale) when the list query (filters/tab/search/sort) changes.
  const pageLoaderRef = useRef(createNextPageLoader<GetJobsResult>());
  const loadedPageRef = useRef(1);
  const cursorRef = useRef<string | null>(null);
  // Automatic restarts after a refused continuation since the last applied page (bounded to one).
  const cursorResetsRef = useRef(0);
  const hasNextPageRef = useRef(false);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const autoLoadArmedRef = useRef(true);
  // Bounded look-ahead (see refillTarget): the rendered page the reader has read into, the
  // last page the current request chain aims for, and ONE coalesced refill asked for while that
  // chain runs. chainGenRef ends a chain between requests on query reset or unmount.
  const reachedPageRef = useRef(1);
  const refillTargetRef = useRef(1);
  const pendingRefillRef = useRef(false);
  const chainGenRef = useRef(0);
  // Cursors this query has consumed, to detect a server that repeats one instead of advancing.
  const seenCursorsRef = useRef<Set<string>>(new Set());
  // Reader progress: distinct cards that have actually been on screen for this query. Client re-ranking
  // can insert later pages above earlier cards, so page boundaries in the displayed list are not progress.
  const seenJobIdsRef = useRef<Set<string>>(new Set());
  // The card the reader is looking at when a background page is applied, held in place after render.
  const scrollAnchorRef = useRef<{ id: string; top: number } | null>(null);
  // True once the reader has moved the page themselves (wheel, touch, keys, scrollbar drag, jump) since the
  // last background append. Our own anchor correction is excluded, so re-ranked appends never count as reading.
  const readerScrolledRef = useRef(false);
  const programmaticScrollRef = useRef(false);
  const programmaticRafOuterRef = useRef(0);
  const programmaticRafInnerRef = useRef(0);
  useEffect(() => () => {
    cancelAnimationFrame(programmaticRafOuterRef.current);
    cancelAnimationFrame(programmaticRafInnerRef.current);
  }, []);
  // Page 1 of the current query; aborted when the query changes or the page unmounts.
  const firstPageAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    chainGenRef.current++;
    pendingRefillRef.current = false;
    firstPageAbortRef.current?.abort();
    pageLoaderRef.current.reset();
    // A remount (React StrictMode in dev) must request page 1 again rather than keep the aborted one.
    lastQueryKeyRef.current = "";
  }, []);

  // Fetch live active jobs from Supabase whenever search, category, filters, sorting, or profile updates
  useEffect(() => {
    if (user && !isPro && !isProDefinitive) {
      setLoadingJobs(true);
      return;
    }

    const isRecommended = activeTab === "recommended";
    const effectiveSortBy = sortBy;
    const effectiveCandidate = (isRecommended || sortBy === "match") ? candidate : null;
    const effectivePreferences = (isRecommended || sortBy === "match") ? preferences : null;

    const queryKey = JSON.stringify({
      retryNonce,
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

    pageLoaderRef.current.reset();
    firstPageAbortRef.current?.abort();
    const firstPage = new AbortController();
    firstPageAbortRef.current = firstPage;
    chainGenRef.current++;
    // The warm-up supplies the first pages; the tail sentinel waits for a real downward gesture.
    autoLoadArmedRef.current = false;
    pendingRefillRef.current = false;
    reachedPageRef.current = 1;
    refillTargetRef.current = 1;
    seenCursorsRef.current = new Set();
    seenJobIdsRef.current = new Set();
    scrollAnchorRef.current = null;
    setLoadingMore(false);
    setLoadMoreError(false);
    setAutoLoadPaused(false);
    setLoadingJobs(true);
    setPage(1);
    loadedPageRef.current = 1;
    cursorRef.current = null;
    hasNextPageRef.current = false;

    getLiveJobs({
      page: 1,
      pageSize: FEED_PAGE_SIZE,
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
      signal: firstPage.signal,
    })
      .then((res) => {
        if (queryKey === lastQueryKeyRef.current && !firstPage.signal.aborted) {
          liveJobsRef.current = res.jobs;
          setLiveJobs(res.jobs);
          setTotalCount(res.totalCount);
          setHasNextPage(Boolean(res.hasNextPage));
          cursorRef.current = res.nextCursor ?? null;
          if (res.nextCursor) seenCursorsRef.current.add(res.nextCursor);
          hasNextPageRef.current = Boolean(res.hasNextPage);
          setIsDegraded(Boolean(res.isDegraded || res.error === "degraded"));
          setAppliedEligibility(res.appliedEligibility || null);
          setLoadingJobs(false);
          // Page 1 is on screen; warm pages 2-3 in the background, one request after another.
          if (isRecommended && res.hasNextPage && !res.isDegraded && !res.error) {
            refillTargetRef.current = PREFETCH_PAGES;
            void loadAhead();
          }
        }
      })
      .catch((err) => {
        console.warn("Failed to fetch live jobs:", err);
        if (queryKey === lastQueryKeyRef.current && !firstPage.signal.aborted) {
          setIsDegraded(true);
          setLoadingJobs(false);
        }
      });
    // loadAhead is this render's closure over the same query; queryKey above owns re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    retryNonce,
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

  // One ordered request chain toward refillTargetRef, following real continuations one at a time.
  // Short, empty or duplicate-only pages do not stop it while the server reports more; it pauses on a
  // stalled cursor, on a whole chain that added nothing, and on errors (never advancing past the
  // failed continuation). A query reset or unmount ends it between requests.
  const loadAhead = async () => {
    const loader = pageLoaderRef.current;
    if (loader.busy) {
      pendingRefillRef.current = true;
      return;
    }
    const gen = chainGenRef.current;
    const isRecommended = activeTab === "recommended";
    const effectiveSortBy = sortBy;
    const effectiveCandidate = (isRecommended || sortBy === "match") ? candidate : null;
    const effectivePreferences = (isRecommended || sortBy === "match") ? preferences : null;
    setLoadingMore(true);
    setLoadMoreError(false);
    let outcome: PageLoadOutcome = "applied";
    let requested = 0;
    let grew = false;
    let stalled = false;
    let resetRequested = false;

    while (!stalled && gen === chainGenRef.current && hasNextPageRef.current && loadedPageRef.current < refillTargetRef.current) {
      const nextPage = loadedPageRef.current + 1;
      const sentCursor = cursorRef.current;
      requested++;
      outcome = await loader.load(
        (signal) =>
          getLiveJobs({
            page: nextPage,
            pageSize: FEED_PAGE_SIZE,
            cursor: sentCursor ?? undefined,
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
            signal,
          }),
        (res) => {
          // The service refused this continuation: apply nothing, restart the query from page 1 below.
          if (res.error === CURSOR_RESET_ERROR) {
            resetRequested = true;
            return;
          }
          // Degraded/forbidden pages are failures: nothing is applied and the cursor stays put.
          if (res.isDegraded || res.error) throw new Error(res.error || "degraded");
          // Server order kept; ids already shown or repeated within this page are skipped.
          const prevRows = liveJobsRef.current;
          const nextRows = appendPage(prevRows, res.jobs);
          const added = nextRows.slice(prevRows.length);
          if (added.length) {
            grew = true;
            // Re-ranking may place new cards above the reader; remember their card to hold it in place.
            scrollAnchorRef.current ??= readScrollAnchor();
          }
          cursorResetsRef.current = 0;
          stalled = isStalledCursor(sentCursor, res, seenCursorsRef.current);
          if (res.nextCursor) seenCursorsRef.current.add(res.nextCursor);
          liveJobsRef.current = nextRows;
          setLiveJobs(nextRows);
          setHasNextPage(Boolean(res.hasNextPage));
          setPage(nextPage);
          loadedPageRef.current = nextPage;
          cursorRef.current = res.nextCursor ?? null;
          hasNextPageRef.current = Boolean(res.hasNextPage);
          if (res.totalCount) setTotalCount(res.totalCount);
        }
      );
      if (outcome !== "applied" || resetRequested) break;
    }
    // A stale chain belongs to an old query or an unmounted page; its reset already cleared state.
    if (outcome === "stale" || gen !== chainGenRef.current) return;
    if (resetRequested && cursorResetsRef.current++ < 1) {
      setRetryNonce((n) => n + 1); // the query effect resets the whole chain and loads page 1 cleanly
      return;
    }
    if (resetRequested) outcome = "error"; // a second refusal in a row: show Retry instead of looping
    setLoadingMore(false);
    if (outcome === "error") {
      // Recovery is the Retry button at this same continuation, never a queued refill.
      pendingRefillRef.current = false;
      setLoadMoreError(true);
      return;
    }
    const paused = stalled || (requested > 0 && !grew && hasNextPageRef.current);
    setAutoLoadPaused(paused);
    if (paused) {
      pendingRefillRef.current = false;
    } else if (pendingRefillRef.current) {
      pendingRefillRef.current = false;
      reachPage(reachedPageRef.current);
    }
  };

  // The reader reached rendered page `page` (a page's worth of cards seen, or the tail with a gesture).
  // Repeated reports coalesce: the deepest page wins and a running chain re-checks once it settles.
  const reachPage = (page: number) => {
    reachedPageRef.current = Math.max(reachedPageRef.current, page);
    if (pageLoaderRef.current.busy) {
      pendingRefillRef.current = true;
      return;
    }
    const target = hasNextPageRef.current ? refillTarget(loadedPageRef.current, reachedPageRef.current) : null;
    if (target === null) return;
    refillTargetRef.current = target;
    void loadAhead();
  };

  // Load More / Retry: the user's own intent. Retry resumes the unfinished chain at the failed
  // continuation; otherwise one more bounded refill.
  const handleLoadMore = () => {
    autoLoadArmedRef.current = false;
    if (refillTargetRef.current <= loadedPageRef.current) refillTargetRef.current = loadedPageRef.current + PREFETCH_PAGES;
    void loadAhead();
  };

  // getLiveJobs always reports hasNextPage; a totalCount fallback would show a phantom button once
  // duplicates are dropped (shown < total while the server has no next page).
  const canLoadMore = activeTab === "recommended" && hasNextPage;

  // Keep the feed supplied while scrolling on every screen size. Cards the reader has seen drive the
  // bounded refill; the tail sentinel is the fallback when the reader outruns the network, and it still
  // needs a fresh downward gesture (anchoring after an append is not input).
  useEffect(() => {
    const el = loadMoreSentinelRef.current;
    if (!el || !canLoadMore || loadMoreError || autoLoadPaused || loadingJobs || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (autoLoadArmedRef.current && entries.some((e) => e.isIntersecting)) {
          autoLoadArmedRef.current = false;
          reachPage(loadedPageRef.current);
        }
      },
      { rootMargin: "400px 0px" }
    );
    observer.observe(el);
    // Only cards that are actually on screen count. Initial callbacks of a recreated observer report the
    // same visible cards again, and appended/re-ranked cards land off screen (see the scroll anchor), so
    // neither adds progress; reading past a page's worth of cards does.
    const cardObserver = new IntersectionObserver((entries) => {
      const cardsBefore = Array.from(document.querySelectorAll<HTMLElement>("[data-job-id]"));
      let furthestSeenBefore = -1;
      cardsBefore.forEach((c, i) => {
        if (seenJobIdsRef.current.has(c.dataset.jobId ?? "")) furthestSeenBefore = i;
      });
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.jobId;
        if (e.isIntersecting && id) seenJobIdsRef.current.add(id);
      }
      // Depth is the count of distinct cards seen. A reader-driven jump (scrollbar drag, End) lands on cards far
      // below the furthest one seen, skipping the ones between; after reader scrolling those skipped cards count
      // as passed. Measured against the furthest SEEN card in the current order, so re-ranked appends (which move
      // seen cards down) never create a gap, and nothing counts without reader scrolling.
      let depth = seenJobIdsRef.current.size;
      if (readerScrolledRef.current) {
        let furthestVisible = -1;
        for (const e of entries) {
          if (e.isIntersecting) furthestVisible = Math.max(furthestVisible, cardsBefore.indexOf(e.target as HTMLElement));
        }
        // Cards strictly between the previous furthest seen card and the visible ones were skipped, not read.
        const skipped = furthestVisible > furthestSeenBefore ? furthestVisible - furthestSeenBefore - 1 : 0;
        depth += skipped;
      }
      const page = Math.floor((depth - 1) / FEED_PAGE_SIZE) + 1;
      if (page > reachedPageRef.current) reachPage(page);
    });
    document.querySelectorAll("[data-job-id]").forEach((card) => cardObserver.observe(card));
    let frame = 0;
    let touchY: number | null = null;
    // A gesture near the tail during a running chain is not lost: reachPage keeps ONE pending refill.
    const armFromInput = () => {
      autoLoadArmedRef.current = true;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        if (autoLoadArmedRef.current && rect.top <= window.innerHeight + 400 && rect.bottom >= -400) {
          autoLoadArmedRef.current = false;
          reachPage(loadedPageRef.current);
        }
      });
    };
    const onWheel = (event: WheelEvent) => { if (event.deltaY > 0) armFromInput(); };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.repeat || target?.closest("input,textarea,select,[contenteditable=true]")) return;
      if (["End", "PageDown", "ArrowDown", " "].includes(event.key)) armFromInput();
    };
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? null; };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null;
      if (touchY !== null && nextY !== null && nextY < touchY) armFromInput();
      touchY = nextY;
    };
    // Only real reader input arms the jump credit (never a bare scroll event: Chrome's own scroll anchoring and
    // our anchor hold also fire scroll events). Scrollbar drags arrive as a mouse/pointer press on the page.
    const onReaderInput = () => {
      readerScrolledRef.current = true;
      window.clearTimeout(readerInputTimer);
      readerInputTimer = window.setTimeout(() => { readerScrolledRef.current = false; }, 2500);
    };
    let readerInputTimer = 0;
    // A scroll we did not cause (scrollbar drag, programmatic jump, End key) also counts; our own anchor
    // correction is instant (never smooth) and flagged, so it cannot arm this.
    const onScroll = () => { if (!programmaticScrollRef.current) onReaderInput(); };
    window.addEventListener("scroll", onScroll, { passive: true });
    const inputEvents = ["wheel", "touchmove", "pointerdown", "mousedown", "keydown"] as const;
    inputEvents.forEach((n) => window.addEventListener(n, onReaderInput, { passive: true, capture: true }));
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      observer.disconnect();
      cardObserver.disconnect();
      cancelAnimationFrame(frame);
      inputEvents.forEach((n) => window.removeEventListener(n, onReaderInput, { capture: true }));
      window.removeEventListener("scroll", onScroll);
      window.clearTimeout(readerInputTimer);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
    };
    // Refresh closures when the list changes, but preserve the consumed intent across observers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLoadMore, loadMoreError, autoLoadPaused, loadingJobs, loadingMore, liveJobs.length]);

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
      if (effectiveViewHiddenJobs) {
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

    if (selectedWorkModel) {
      result = result.filter((job) => matchesWorkModelFilter(job, selectedWorkModel));
    }

    if (selectedLevel) {
      result = result.filter((job) =>
        matchesExperienceLevelFilter(job, selectedLevel)
      );
    }

    if (selectedJobType) {
      result = result.filter((job) => matchesJobTypeFilter(job.type, selectedJobType));
    }

    // Same window as the server (datePostedCutoff); an unknown posting date never counts as recent.
    const postedCutoff = datePostedCutoff(selectedDatePosted);
    if (postedCutoff) {
      const cutoffMs = new Date(postedCutoff).getTime();
      result = result.filter((job) => {
        const jobTime = job.postedAt ? new Date(job.postedAt).getTime() : NaN;
        return !isNaN(jobTime) && jobTime >= cutoffMs;
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

    // Top matched uses the shared ranking. Most recent preserves server chronological order.
    if (shouldApplyRecommendedRanking(activeTab, sortBy)) {
      const now = Date.now(); // one snapshot for the whole sort pass, not per-comparison
      result = [...result].sort((a, b) =>
        compareByRecommendedRanking(
          a,
          b,
          candidate,
          preferences ? { preferredCountryCode: preferences.countryCode, remotePreference: preferences.remotePreference } : null,
          now
        )
      );
    }

    if (activeTab === "recommended") {
      result = capJobsPerCompany(result, 3, 30);
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
    effectiveViewHiddenJobs,
    selectedCountryCode,
    selectedLocation,
    selectedWorkModel,
    selectedLevel,
    selectedJobType,
    selectedDatePosted,
    selectedExperience,
    sortBy,
    candidate,
    preferences,
  ]);

  const displayedJobs = filteredJobs;
  // A background page re-ranked into the list must not move the card the reader is looking at: after the
  // DOM updates and before paint, scroll by however far that card moved (a no-op when nothing moved or
  // the browser's own scroll anchoring already held it).
  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    if (!anchor) return;
    scrollAnchorRef.current = null;
    const card = Array.from(document.querySelectorAll<HTMLElement>("[data-job-id]")).find((el) => el.dataset.jobId === anchor.id);
    const moved = card ? card.getBoundingClientRect().top - anchor.top : 0;
    if (Math.abs(moved) >= 1) {
      programmaticScrollRef.current = true;
      window.scrollBy({ top: moved, left: 0, behavior: "instant" as ScrollBehavior });
      cancelAnimationFrame(programmaticRafOuterRef.current);
      cancelAnimationFrame(programmaticRafInnerRef.current);
      programmaticRafOuterRef.current = requestAnimationFrame(() => {
        programmaticRafInnerRef.current = requestAnimationFrame(() => { programmaticScrollRef.current = false; });
      });
    }
    readerScrolledRef.current = false;
  }, [displayedJobs]);

  // Similar jobs: same category first, country only as fallback; API-fetched if direct link
  const similarJobs = useMemo(() => {
    if (!selectedJob) return [];
    const pool = liveJobs.length > 1 ? liveJobs : (apiSimilarJobs.length > 0 ? apiSimilarJobs : liveJobs);
    const sameCategory = pool.filter((j) => j.id !== selectedJob.id && selectedJob.category && j.category && j.category.toLowerCase() === selectedJob.category.toLowerCase());
    const sameCountryFallback = pool.filter((j) => j.id !== selectedJob.id && (!selectedJob.category || !j.category || j.category.toLowerCase() !== selectedJob.category.toLowerCase()) && selectedJob.country && j.country && j.country.toUpperCase() === selectedJob.country.toUpperCase());
    return [...sameCategory, ...sameCountryFallback].slice(0, 5);
  }, [selectedJob, liveJobs, apiSimilarJobs]);

  // When opened by direct link (liveJobs is empty/minimal), fetch similar jobs from API
  useEffect(() => {
    if (!selectedJob || !selectedJob.id) return;
    if (liveJobs.length <= 1) {
      getLiveJobs({
        category: selectedJob.category || undefined,
        pageSize: 6,
      })
        .then((res) => {
          if (Array.isArray(res.jobs)) {
            setApiSimilarJobs(res.jobs.filter((j) => j.id !== selectedJob.id));
          }
        })
        .catch(() => {});
    }
  // Deps are the primitives that actually drive the refetch; depending on the
  // whole selectedJob object would re-fetch on unrelated field changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJob?.id, selectedJob?.category, liveJobs.length]);

  // Memoize per-card fit diagnostics keyed by confirmed resume facts and job.id
  const confirmedResumeKey = candidate?.confirmedAt || "";
  const cardDiagnosticsMap = useMemo(() => {
    const map = new Map<string, FitDiagnosticsResult | null>();
    for (const job of displayedJobs) {
      map.set(job.id, getJobDiagnostics(job, candidate));
    }
    return map;
  // Keyed on confirmedAt/confirmedResumeKey: the candidate object identity
  // changes every render, so depending on it would defeat the memo.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setSortBy("match");
    setPage(1);
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
        trackFunnelEvent("apply_completed", { path: "/jobs" });
        toast.success(`Marked "${job.title}" as applied! Added to Tracker.`);
      } else if (existing.stage === "saved") {
        // Existing saved record: move to applied, preserving notes, dates, and other fields
        await updateApplicationStage(existing.id, "applied");
        trackFunnelEvent("apply_completed", { path: "/jobs" });
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

    // Synchronous lock check (same pattern as handleUpdateApplied):
    // immediately aborts duplicate same-tick invocations (double-click race).
    if (inFlightSaveRef.current.has(job.id)) return;
    inFlightSaveRef.current.add(job.id);

    try {
      if (savedJobIds.includes(job.id)) {
        try {
          await removeApplicationFromTracker(job.id);
          setSavedJobIds((prev) => prev.filter((id) => id !== job.id));
          toast.info(`Removed "${job.title}" from Liked Jobs.`);
        } catch {
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
      } catch {
        toast.error("Could not save job.");
      }
    } finally {
      inFlightSaveRef.current.delete(job.id);
    }
  };

  const handleRetryUnlock = async (jobId: string) => {
    const selectionToken = jobSelectionGateRef.current!.begin();
    setIsRetryingUnlock(true);
    try {
      const fullJob = await getLiveJobById(jobId, isPro);
      if (fullJob && jobSelectionGateRef.current!.isCurrent(selectionToken)) {
        setSelectedJob((current) => keepSameJobLogoIdentity(fullJob, current));
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

  const handleLoadCompanyProfile = async () => {
    if (!isPro || !selectedJob || selectedJob.companyProfile?.jobs.status === "ready" || selectedJob.companyProfile?.jobs.status === "error") return;
    const jobId = selectedJob.id;
    try {
      const fullJob = await getLiveJobById(jobId, true);
      if (fullJob && selectedJob?.id === jobId) setSelectedJob((current) => current?.id === jobId ? keepSameJobLogoIdentity({ ...current, ...fullJob }, current) : current);
    } catch (error) {
      console.warn("Failed to load company profile", error);
    }
  };

  const handleSelectJob = async (job: LiveJob) => {
    const selectionToken = jobSelectionGateRef.current!.begin();
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
        if (fullJob && jobSelectionGateRef.current!.isCurrent(selectionToken)) {
          if (typeof job.matchScore === "number" && fullJob.scoreRevision && fullJob.scoreRevision === job.scoreRevision) {
            fullJob.matchScore = job.matchScore;
          }
          setSelectedJob(keepSameJobLogoIdentity(fullJob, job));
        }
      } catch {}
    }
  };

  const handleBackToList = () => {
    jobSelectionGateRef.current!.cancel();
    pendingJobIdRef.current = null;
    setSelectedJob(null);
    setDetailLoading(false);
    setDetailStatus(null);
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

  // Right-panel summary rows, derived only from the live filter state.
  const currentFilterRows: Array<[string, string]> = [
    ["Search", search.trim()],
    ["Country", selectedCountryCode],
    ["Location", selectedLocation],
    ["Category", selectedCategory],
    ["Level", parseExperienceLevels(selectedLevel).map((l) => EXPERIENCE_LEVEL_LABELS[l]).join(", ")],
    ["Job type", selectedJobType],
    ["Work model", selectedWorkModel || (remoteOnly ? "remote" : "")],
    ["Posted", selectedDatePosted],
    ["Company", selectedCompany],
  ].filter((row): row is [string, string] => Boolean(row[1]));

  // One score per job + candidate snapshot + scoring version: remember what each card showed, and give the
  // detail the feed score, else that remembered score (reload / job not on this page), else its computed fallback.
  const scoreSnap = matchScoreSnapshot(candidate, preferences?.updatedAt);
  // A saved-input revision also refreshes an already-open detail. Never replace a different selection.
  useEffect(() => {
    const id = selectedJob?.id;
    if (!id) return;
    let cancelled = false;
    getLiveJobById(id, isPro).then((fresh) => {
      if (cancelled || !fresh) return;
      setSelectedJob((current) => current?.id === id ? keepSameJobLogoIdentity({ ...current, ...fresh }, current) : current);
    }).catch((error) => console.warn("Failed to refresh selected job score:", error));
    return () => { cancelled = true; };
    // selectedJob identity, rather than the full object, avoids a refresh loop after the result is set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreSnap, selectedJob?.id, isPro]);
  useEffect(() => {
    rememberMatchScores(scoreSnap, liveJobs);
  }, [scoreSnap, liveJobs]);
  // A detail fetch with a newer score-input revision makes that card's feed score stale: invalidate it there too.
  useEffect(() => {
    if (selectedJob) setLiveJobs((prev) => reconcileFeedWithDetail(prev, selectedJob));
  }, [selectedJob]);
  const detailJob = useMemo(() => {
    if (!selectedJob) return null;
    const job = withFeedScore(selectedJob, liveJobs);
    if (typeof job.matchScore === "number") return job;
    const remembered = recallMatchScore(scoreSnap, job);
    return remembered === null ? job : { ...job, matchScore: remembered };
  }, [selectedJob, liveJobs, scoreSnap]);

  // The listing view (not detail/loading) uses the desktop two-column grid with the right panel.
  const isListView = !detailLoading && !(detailStatus === "not-found" && !selectedJob) && !selectedJob;

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
    (effectiveViewHiddenJobs ? 1 : 0);
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
    hidden: effectiveViewHiddenJobs,
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
    effectiveViewHiddenJobs,
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
      setRemoteOnly(isRemoteOnlyWorkModel(patch.workModel));
    }
    if (patch.datePosted !== undefined) setSelectedDatePosted(patch.datePosted);
    if (patch.experience !== undefined) setSelectedExperience(patch.experience);
    if (patch.salaryMin !== undefined) setSelectedSalaryMin(String(patch.salaryMin));
    if (patch.sourceType !== undefined) setSelectedSourceType(patch.sourceType);
    if (patch.company !== undefined) setSelectedCompany(patch.company);
    if (patch.hidden !== undefined) setViewHiddenJobs(patch.hidden);
    if (patch.sort !== undefined) setSortBy(patch.sort);
    setPage(1);
  };

  const handleApplyAllFilters = (updated: JobFilterValues) => {
    setSelectedCountryCode(updated.countryCode || "");
    setSelectedLocation(updated.location);
    setSelectedCategory(updated.category);
    setSelectedLevel(updated.level);
    setSelectedJobType(updated.jobType);
    setSelectedWorkModel(updated.workModel);
    setRemoteOnly(isRemoteOnlyWorkModel(updated.workModel));
    setSelectedDatePosted(updated.datePosted);
    if (updated.experience !== undefined) setSelectedExperience(updated.experience);
    setSelectedSalaryMin(updated.salaryMin !== undefined ? String(updated.salaryMin) : "");
    setSelectedSourceType(updated.sourceType || "");
    setSelectedCompany(updated.company || "");
    setViewHiddenJobs(updated.hidden);
    setSortBy(updated.sort);
    setPage(1);
    setAllFiltersDrawerOpen(false);
    setMobileFiltersOpen(false);
  };

  const externalJobsCount = useMemo(() => {
    return liveJobs.filter((job) => Boolean(job.directSource)).length;
  }, [liveJobs]);

  const jobTabs: TopBarTab[] = [
    {
      id: "recommended",
      label: "For You",
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
    <div className={`cm-jobs-reference ${isListView ? "cm-mobile-list" : "cm-mobile-detail"} min-h-screen bg-[#F8FAFC] text-[#0F172A] flex flex-col font-sans`}>
      {/* <GuideHeader /> replaced by unified AppIconRail / AppTopBar shell before and after login (!user) */}

      {/* Left Icon Rail (fixed 72px wide narrow / 240px expanded on desktop, bottom tab bar on mobile) */}
      <AppIconRail />

      {/* Main Content Area (offset by 72px or 240px on desktop) */}
      <div className={`flex-1 ${isExpanded ? "md:pl-[240px]" : "md:pl-[72px]"} flex flex-col min-w-0 pb-6 md:pb-0 lg:bg-slate-100 transition-[padding] duration-300 ease-[cubic-bezier(0.2,0,0,1)]`}>
        {/* Top bar for both guest and signed-in users: 56px, white, 1px bottom border */}
        <AppTopBar
          pageLabel="JOBS"
          tabs={jobTabs}
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search by title or company"
          user={user}
          isPro={isPro}
          hidePlanPill
          // Mobile feed: Recommended / Saved / Applied only (External and search stay on sm+).
          mobileTabs={isListView ? jobTabs.filter((tab) => tab.id !== "external") : undefined}
        />
        <main
          id="main-content"
          data-testid="jobs-main-content"
          className={`flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 pt-3 sm:pt-4 space-y-3 pb-4 md:pb-32 lg:pb-12 ${isListView ? "lg:grid lg:grid-cols-[minmax(0,1fr)_316px] lg:gap-x-8 lg:items-start lg:max-w-none" : ""}`}
        >
          {detailLoading ? (
            <div data-testid="job-detail-skeleton" className="max-w-[880px] w-full mx-auto space-y-4 animate-pulse">
              <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-slate-200" />
                  <div className="space-y-2 flex-1">
                    <div className="w-32 h-4 bg-slate-200 rounded" />
                    <div className="w-20 h-3 bg-slate-100 rounded" />
                  </div>
                </div>
                <div className="w-3/4 h-7 bg-slate-200 rounded" />
                <div className="flex gap-2 pt-2 border-t border-[#E2E8F0]">
                  <div className="w-24 h-7 bg-slate-100 rounded-full" />
                  <div className="w-28 h-7 bg-slate-100 rounded-full" />
                  <div className="w-24 h-7 bg-slate-100 rounded-full" />
                </div>
              </div>
              <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-6 space-y-3">
                <div className="w-36 h-5 bg-slate-200 rounded" />
                <div className="w-full h-4 bg-slate-100 rounded" />
                <div className="w-5/6 h-4 bg-slate-100 rounded" />
                <div className="w-4/6 h-4 bg-slate-100 rounded" />
              </div>
            </div>
          ) : detailStatus === "not-found" && !selectedJob ? (
            <div data-testid="job-not-found-state" className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-10 sm:p-14 text-center space-y-3 shadow-none max-w-[880px] mx-auto">
              <div className="w-12 h-12 rounded-full bg-slate-100 text-[#475569] flex items-center justify-center mx-auto">
                <AlertCircle className="w-6 h-6" />
              </div>
              <h3 className="text-base font-bold text-[#0F172A]">Job not found</h3>
              <p className="text-xs text-[#475569] max-w-sm mx-auto">
                This job posting might have been removed or the link is invalid.
              </p>
              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleBackToList}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-bold transition cursor-pointer min-h-[44px]"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back to all jobs</span>
                </button>
              </div>
            </div>
          ) : selectedJob ? (
            /* In-place job detail swap inside the same shell */
            <div className="max-w-[880px] w-full mx-auto">
              <JobDetailView
                job={detailJob ?? selectedJob}
                candidate={candidate}
                resumeState={resumeState}
                user={user}
                isPro={isPro}
                isSaved={savedJobIds.includes(selectedJob.id)}
                isApplied={Boolean(selectedJobTrackedApp && selectedJobTrackedApp.stage !== "saved")}
                trackedStage={selectedJobTrackedApp?.stage || null}
                isUpdatingApplied={updatingAppliedJobId === selectedJob.id}
                onSave={() => handleSaveJob(selectedJob)}
                onToggleApplied={() => handleToggleApplied(selectedJob)}
                onApply={(e) => {
                  trackFunnelEvent("apply_started", { path: "/jobs" });
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
                similarJobs={similarJobs}
                onSelectJob={(job) => {
                  void handleSelectJob(job);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                isExpired={detailStatus === "expired" || selectedJob.isExpired}
                onLoadCompanyProfile={handleLoadCompanyProfile}
              />
            </div>
          ) : (
            <>
              <div className="space-y-2 sm:space-y-3 lg:col-start-1">
                {/* Saved preferences (Recommended feed). Only for a signed-in user whose own row is loaded. */}
                {user && preferences && activeTab === "recommended" && (
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-[#E2E8F0] bg-white px-3 py-1.5">
                    <p className="min-w-0 truncate text-[13px] text-[#475569]">
                      Recommended uses your saved preferences
                    </p>
                    <button
                      ref={preferencesTriggerRef}
                      type="button"
                      onClick={() => setPreferencesOpen(true)}
                      aria-haspopup="dialog"
                      className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-bold text-[#2563EB] hover:bg-[#EFF6FF] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#2563EB]"
                    >
                      Preferences
                      {activePreferenceCount(draftFromPreferences(preferences), preferences.feedConstraintsAvailable !== false && savedFeedConstraintsEnforced()) > 0 && (
                        <span className="rounded-full bg-[#2563EB] px-1.5 text-[11px] text-white">
                          {activePreferenceCount(draftFromPreferences(preferences), preferences.feedConstraintsAvailable !== false && savedFeedConstraintsEnforced())}
                        </span>
                      )}
                    </button>
                  </div>
                )}
                {user && preferences && (
                  <PreferencesSheet
                    key={user.id}
                    ownerId={user.id}
                    isOpen={preferencesOpen}
                    onClose={() => setPreferencesOpen(false)}
                    committed={preferences}
                    triggerRef={preferencesTriggerRef}
                    onSave={async (next) => {
                      // Persist once; the saved-event re-reads the row, which changes the feed query key
                      // and resets pagination through the existing loader. A failure rejects to the sheet.
                      await saveUserPreferences(next, user.id);
                      toast.success("Preferences updated. Refreshing your recommendations.");
                    }}
                  />
                )}

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
                  isOpen={allFiltersDrawerOpen && !isPhone}
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
                  hideHiddenJobs={isPhone}
                  triggerRef={filtersTriggerRef}
                />
              </div>

              {/* Jobs List Feed & Right Rail (Main Column ~973px, Right Rail ~316px, Gap 32px on Desktop) */}
              <div className="flex flex-col lg:flex-row gap-8 items-start w-full min-w-0 lg:col-start-1">
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
                  ) : isDegraded ? (
                    /* Degraded / HTTP 503 error state */
                    <div data-testid="search-degraded-state" className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-6 sm:p-14 text-center space-y-3 shadow-none">
                      <div className="w-12 h-12 rounded-full bg-amber-50 text-amber-600 flex items-center justify-center mx-auto">
                        <AlertCircle className="w-6 h-6" />
                      </div>
                      <h3 className="text-base font-bold text-[#0F172A]">Couldn&apos;t load jobs</h3>
                      <p className="text-xs text-[#475569] max-w-sm mx-auto">
                        We encountered a temporary issue querying the jobs directory. Please try again.
                      </p>
                      <div className="pt-2">
                        <button
                          type="button"
                          onClick={() => {
                            setIsDegraded(false);
                            setLoadingJobs(true);
                            setRetryNonce((n) => n + 1);
                          }}
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-bold transition cursor-pointer min-h-[44px]"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>Retry</span>
                        </button>
                      </div>
                    </div>
                  ) : displayedJobs.length === 0 && !(canLoadMore && (loadingMore || loadMoreError || autoLoadPaused)) ? (
                    /* With zero cards but a running, failed or paused continuation, the list branch below renders
                       its tail (loading, Retry or Load More) instead of an empty state that would hide recovery. */
                    /* Empty state distinguishing no saved vs filtered vs no applied */
                    <div className="bg-white rounded-[16px] ring-1 ring-[#E2E8F0] p-6 sm:p-14 text-center space-y-3 shadow-none">
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
                        {effectiveViewHiddenJobs
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
                        {effectiveViewHiddenJobs
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
                          : "We refresh verified career site postings regularly. Try checking back shortly."}
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
                      {appliedEligibility && appliedEligibility.countries && appliedEligibility.countries.length > 0 && (
                        <div className="text-xs text-[#64748B] px-1 py-0.5" data-testid="eligibility-banner">
                          Showing jobs eligible in {appliedEligibility.countries.join(", ")} (+ worldwide remote) - {appliedEligibility.filteredOut} hidden
                        </div>
                      )}
                      {displayedJobs.map((job, index) => {
                        const isSaved = savedJobIds.includes(job.id);
                        const staggerDelay = Math.min(index * 0.03, 0.3);
                        const diagnostics = cardDiagnosticsMap.get(job.id) ?? getJobDiagnostics(job, candidate);
                        const matchScore = getJobMatchScore(job, candidate);
                        const cardZeroSkills = Boolean(diagnostics && diagnostics.matchedSkills && diagnostics.matchedSkills.length === 0);
                        const isRecent = Boolean(job.postedAt && isPostedUnder24Hours(job.postedAt) && isEarlyApplicant(job) !== undefined);
                        const postedRelative = job.postedAt ? formatDesktopPillTime(job.postedAt) : null;
                        const companyPills = getCompanyTagPills(job.category);
                        const locInfo = parseJobLocation(job.location);
                        const jobLevel = inferJobLevel(job.title);
                        const formattedJobType = formatJobType(job.type);

                        return (
                          <motion.article
                            key={job.id}
                            data-testid="job-card"
                            data-job-id={job.id}
                            data-tour={index === 0 ? "tour-job-details" : undefined}
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
                            <JobCardContent
                              job={job}
                              index={index}
                              isPro={isPro}
                              isSaved={isSaved}
                              matchScore={matchScore}
                              cardZeroSkills={cardZeroSkills}
                              isRecent={isRecent}
                              postedRelative={postedRelative}
                              companyPills={companyPills}
                              locInfo={locInfo}
                              jobLevel={jobLevel}
                              formattedJobType={formattedJobType}
                              getTagColorClass={getTagColorClass}
                              formatRelativeTime={formatRelativeTime}
                              handleHideJob={handleHideJob}
                              handleToggleApplied={handleToggleApplied}
                              handleSaveJob={handleSaveJob}
                              handleSelectJob={handleSelectJob}
                              handleLockedAction={handleLockedAction}
                            />
                          </motion.article>
                        );
                      })}

                      {/* Load More Pagination: strictly scoped to tabs with active server-side pagination.
                          Scrolling auto-loads via the sentinel; a button appears only for error or paused recovery. */}
                      {canLoadMore && (
                        // overflow-anchor:none: otherwise scroll anchoring keeps this block in view as cards are
                        // inserted above it, the sentinel stays visible and pages chain-load.
                        <div className="pt-4 text-center [overflow-anchor:none]" aria-live="polite">
                          <div ref={loadMoreSentinelRef} data-testid="jobs-load-more-sentinel" aria-hidden="true" />
                          {loadMoreError && (
                            <p className="text-xs text-[#B91C1C] pb-2" role="alert">Couldn&apos;t load more jobs.</p>
                          )}
                          {loadingMore && <p className="text-xs text-[#475569] py-3" role="status">Loading Positions...</p>}
                          {(isPhone ? !loadingMore : (loadMoreError || autoLoadPaused)) && (
                            <button
                              type="button"
                              onClick={handleLoadMore}
                              disabled={loadingMore}
                              className="px-6 py-3 rounded-xl border border-[#E2E8F0] bg-white hover:bg-[#F8FAFC] text-[#0F172A] text-xs font-bold transition shadow-none cursor-pointer disabled:opacity-60 min-h-[44px]"
                            >
                              {loadMoreError ? "Retry" : "Load More Verified Positions"}
                            </button>
                          )}
                        </div>
                      )}
                      {activeTab === "recommended" && !canLoadMore && (isPhone ? (!loadingJobs && !isDegraded && displayedJobs.length > 0) : page > 1) && (
                        <p data-testid="jobs-list-end" className="pt-4 text-center text-xs text-[#475569]">
                          {isPhone ? "You've reached the end of this recommended list for your current search and filters." : "You've reached the end of this list."}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Right Rail Column: about 316px, sticky, hidden on mobile */}
              </div>
              {/* Right panel (desktop >=1024px only): continuous white surface, listing-only content.
                  Hidden below lg, so moving it out of the list row cannot change mobile/tablet. */}
              <aside
                aria-label="Listing summary"
                data-testid="jobs-right-panel"
                className="hidden lg:block lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:self-stretch bg-white border-l border-[#E2E8F0] lg:-mr-8 lg:!-mt-4 lg:-mb-12 lg:min-h-[calc(100vh-56px)]"
              >
                <div className="sticky top-14 p-4 space-y-3 max-h-[calc(100vh-56px)] overflow-y-auto">
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

                  {/* Current filter summary, derived from the live filter state */}
                  <section className="space-y-2" data-testid="current-filter-summary" aria-labelledby="current-filters-title">
                    <div className="flex items-center justify-between">
                      <h3 id="current-filters-title" className="font-bold text-sm text-[#0F172A]">Current filters</h3>
                      {currentFilterRows.length > 0 && (
                        <button
                          type="button"
                          onClick={handleResetFilters}
                          className="text-xs font-semibold text-[#2563EB] hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] rounded"
                        >
                          Clear all
                        </button>
                      )}
                    </div>
                    {currentFilterRows.length === 0 ? (
                      <p className="text-xs text-[#475569]">No filters applied. Showing all listings in this tab.</p>
                    ) : (
                      <dl className="space-y-1.5 text-xs">
                        {currentFilterRows.map(([label, value]) => (
                          <div key={label} className="flex items-start justify-between gap-3">
                            <dt className="text-[#475569] shrink-0">{label}</dt>
                            <dd className="font-semibold text-[#0F172A] text-right truncate" title={value}>{value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </section>

                  <div className="border-b border-[#E2E8F0]" />

                  {/* Static example searches (not personal saved filters): each applies its real filter */}
                  <section className="space-y-2" aria-labelledby="suggested-searches-title">
                    <h3 id="suggested-searches-title" className="font-bold text-sm text-[#0F172A]">Suggested Searches</h3>
                    <div className="space-y-1.5">
                      {SAVED_PRESETS.map((preset) => {
                        const isActive = search === preset.search || (preset.category && selectedCategory === preset.category);
                        return (
                          <button
                            key={preset.name}
                            type="button"
                            onClick={() => handleApplySavedFilter(preset)}
                            className={`w-full text-left p-2.5 rounded-xl text-xs font-medium transition cursor-pointer flex items-center gap-2.5 ${
                              isActive ? "bg-blue-50 text-[#1E3A8A] font-bold" : "hover:bg-slate-50 text-slate-700"
                            }`}
                          >
                            <span className={`w-1 h-5 rounded-full shrink-0 ${isActive ? "bg-[#2563EB]" : "bg-emerald-500"}`} />
                            <span className="truncate">{preset.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  <div className="border-b border-[#E2E8F0]" />

                  <section className="space-y-1.5 text-xs text-[#475569]" aria-labelledby="listing-help-title">
                    <h3 id="listing-help-title" className="font-bold text-sm text-[#0F172A]">Using this list</h3>
                    <p>Use All Filters to narrow by location, job type and work model.</p>
                    <p>Open a job to read its listed requirements before you apply.</p>
                  </section>
                </div>
              </aside>
            </>
          )}
        </main>
      </div>

      {/* © 2026 Olive Ridley Media Private Limited. All rights reserved. */}
      <Footer />

      {/* Paywall Modal */}
      <PaywallModal
        open={isPaywallOpen}
        onOpenChange={setIsPaywallOpen}
        user={user}
        featureTitle="Unlock Verified Company Names & Direct Employer Apply"
      />

      {isDesktop && (
        <>
          <FirstJobsWelcome
            isOpen={welcomeOpen}
            onClose={() => finishWelcome(null)}
            onConfirm={(levels) => finishWelcome(levels)}
            recommendedCount={isDegraded ? null : Math.min(totalCount || liveJobs.length, 30)}
            initialLevels={selectedLevel}
            savedExperienceLevel={preferences?.experienceLevel}
          />
          <JobsProductTour isActive={tourActive && !welcomeOpen} onComplete={endTour} onExit={endTour} />
        </>
      )}
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
