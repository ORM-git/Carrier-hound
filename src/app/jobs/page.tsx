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
import { computeFitDiagnostics, FitDiagnosticsResult, getDiagnosticsSummary } from "@/lib/matcher/scoring";
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
  const textClass = size >= 75 ? "text-2xl font-black" : size >= 50 ? "text-[16px] font-bold" : "text-[13px] font-bold";

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
  const [selectedCategory, setSelectedCategory] = useState("");
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState("");
  const [selectedLevel, setSelectedLevel] = useState("");
  const [selectedJobType, setSelectedJobType] = useState("");
  const [selectedDatePosted, setSelectedDatePosted] = useState("");
  const [selectedExperience, setSelectedExperience] = useState("");
  const [sortBy, setSortBy] = useState<"match" | "newest">("newest");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);

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
    const qSearch = params.get("search") || params.get("q") || "";
    const qCategory = params.get("category") || params.get("categories") || "";
    const qRemote = params.get("remote") === "true";
    const qLocation = params.get("location") || "";
    const qLevel = params.get("level") || "";
    const qType = params.get("type") || params.get("jobType") || "";
    const qDate = params.get("datePosted") || params.get("date") || "";
    const qExp = params.get("experience") || params.get("exp") || "";
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
      window.history.replaceState({ scrollPos: window.scrollY }, "", newUrl);
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
        const apps = await getTrackedApplications(u?.id);

        if (cancelled) return;

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
      location: selectedLocation,
      level: selectedLevel,
      jobType: selectedJobType,
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
        location: selectedLocation,
        level: selectedLevel,
        jobType: selectedJobType,
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
    selectedLocation,
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
    setRemoteOnly(false);
    setSelectedLocation("");
    setSelectedLevel("");
    setSelectedJobType("");
    setSelectedDatePosted("");
    setSelectedExperience("");
    setViewHiddenJobs(false);
    setSortBy("newest");
    setPage(1);
    setMobileFiltersOpen(false);
    setOpenDropdown(null);
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      p.delete("search");
      p.delete("category");
      p.delete("categories");
      p.delete("remote");
      p.delete("location");
      p.delete("level");
      p.delete("jobType");
      p.delete("sort");
      p.delete("sortBy");
      const qs = p.toString();
      window.history.replaceState({}, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
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
    // Fetch full job record with description if missing or short
    if (!job.description || job.description.length < 50) {
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
    (selectedJobType ? 1 : 0) +
    (selectedDatePosted ? 1 : 0) +
    (selectedExperience ? 1 : 0) +
    (viewHiddenJobs ? 1 : 0);
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
      {!user && <GuideHeader />}

      {/* Left Icon Rail (fixed 72px wide, full height, white, #E2E8F0; bottom tab bar on mobile) */}
      {user && <AppIconRail />}

      {/* Main Content Area (offset by 72px on desktop when user is logged in) */}
      <div className={`flex-1 ${user ? (isExpanded ? "md:pl-[240px]" : "md:pl-[72px]") : ""} flex flex-col min-w-0 ${user ? "pb-6 md:pb-0" : ""} transition-[padding] duration-300 ease-[cubic-bezier(0.2,0,0,1)]`}>
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
          data-testid="jobs-main-content"
          className="flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-5 space-y-4 pb-44 sm:pb-32 lg:pb-12"
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
                  if (!isPro) {
                    handleLockedAction(e);
                  }
                }}
                onBack={handleBackToList}
              />
            </div>
          ) : (
            <>
              {/* Header Row: Title "JOBS" + Tabs with Count Badges + Search Box (signed-out view) */}
              <div className="space-y-4">
                {!user ? (
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
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 min-h-[44px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                            activeTab === "recommended"
                              ? "bg-white text-blue-600 shadow-none ring-1 ring-[#E2E8F0]"
                              : "text-[#334155] hover:text-[#0F172A]"
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
                            setActiveTab("saved");
                            setPage(1);
                          }}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 min-h-[44px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                            activeTab === "saved" || activeTab === "liked"
                              ? "bg-white text-blue-600 shadow-none ring-1 ring-[#E2E8F0]"
                              : "text-[#334155] hover:text-[#0F172A]"
                          }`}
                        >
                          <span>Saved</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-slate-200 text-[#334155]">
                            {savedCount}
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setActiveTab("applied");
                            setPage(1);
                          }}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 min-h-[44px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                            activeTab === "applied"
                              ? "bg-white text-blue-600 shadow-none ring-1 ring-[#E2E8F0]"
                              : "text-[#334155] hover:text-[#0F172A]"
                          }`}
                        >
                          <span>Applied</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-slate-200 text-[#334155]">
                            {appliedCount}
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setActiveTab("external");
                            setPage(1);
                          }}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 min-h-[44px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                            activeTab === "external"
                              ? "bg-white text-blue-600 shadow-none ring-1 ring-[#E2E8F0]"
                              : "text-[#334155] hover:text-[#0F172A]"
                          }`}
                        >
                          <span>External</span>
                          {!loadingJobs && externalJobsCount > 0 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-slate-200 text-[#334155]">
                              {externalJobsCount}
                            </span>
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Search Box on the Right */}
                    <div className="relative w-full sm:w-80">
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
                ) : (
                  /* Mobile tabs for logged-in user when AppTopBar tabs are hidden */
                  <div className="relative sm:hidden max-w-full">
                    <div className="flex items-center gap-1 p-1 pr-8 rounded-xl bg-slate-200/80 border border-slate-300/70 overflow-x-auto no-scrollbar">
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
                          {tab.count !== undefined && (
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                                tab.active ? "bg-blue-100 text-blue-700" : "bg-slate-200 text-[#334155]"
                              }`}
                            >
                              {tab.count}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                    <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-slate-200 to-transparent rounded-r-xl" />
                  </div>
                )}

                {/* 3. COMPACT FILTER TOOLBAR */}
                <div className={`${user ? "sticky top-[56px]" : "sticky top-[64px]"} z-tk-sticky bg-white/95 backdrop-blur-md rounded-[16px] border border-[#E2E8F0] shadow-none ring-1 ring-[#E2E8F0] p-2.5 sm:p-3 space-y-2`}>
                  {/* MOBILE VIEW (under md): Compact Filters Button + Sort Dropdown */}
                  <div className="flex md:hidden items-center justify-between w-full gap-2">
                    <button
                      ref={filtersTriggerRef}
                      type="button"
                      onClick={() => setMobileFiltersOpen(true)}
                      aria-expanded={mobileFiltersOpen}
                      aria-label="Open filter settings"
                      className="inline-flex items-center gap-2 px-3.5 py-2 min-h-[44px] rounded-full border border-[#E2E8F0] bg-[#F1F5F9] text-[#0F172A] text-xs font-bold transition hover:bg-[#E2E8F0] active:scale-95 cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#93C5FD]"
                    >
                      <SlidersHorizontal className="w-3.5 h-3.5 text-[#2563EB]" />
                      <span>Filters</span>
                      {activeFiltersCount > 0 && (
                        <span className="w-5 h-5 rounded-full bg-[#2563EB] text-white text-[11px] font-bold flex items-center justify-center">
                          {activeFiltersCount}
                        </span>
                      )}
                    </button>

                    {/* Mobile Sort Dropdown */}
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setOpenDropdown(openDropdown === "sort_mobile" ? null : "sort_mobile")}
                        aria-label={`Sort by: ${sortBy === "match" ? "Best Match" : "Newest"}`}
                        className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-full border border-[#E2E8F0] bg-[#F1F5F9] text-[#0F172A] text-xs font-semibold hover:bg-[#E2E8F0] transition cursor-pointer"
                      >
                        <ArrowUpDown className="w-3.5 h-3.5 text-[#475569]" />
                        <span>Sort: {sortBy === "match" ? "Match" : "Newest"}</span>
                        <ChevronDown className="w-3 h-3 text-[#475569]" />
                      </button>
                      {openDropdown === "sort_mobile" && (
                        <div className="absolute right-0 mt-1.5 w-36 bg-white border border-[#E2E8F0] rounded-[16px] shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                          <button
                            type="button"
                            onClick={() => {
                              setSortBy("newest");
                              setOpenDropdown(null);
                            }}
                            className={`w-full text-left px-3 py-2 min-h-[36px] rounded-lg font-medium transition cursor-pointer ${
                              sortBy === "newest" ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold" : "text-slate-700 hover:bg-slate-50"
                            }`}
                          >
                            Newest First
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setSortBy("match");
                              setOpenDropdown(null);
                            }}
                            className={`w-full text-left px-3 py-2 min-h-[36px] rounded-lg font-medium transition cursor-pointer ${
                              sortBy === "match" ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold" : "text-slate-700 hover:bg-slate-50"
                            }`}
                          >
                            Best Match
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* DESKTOP VIEW (md and up): Full Filter Pills Row + Sort Select */}
                  <div className="hidden md:flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 min-w-0">
                      {/* Location Pill */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setOpenDropdown(openDropdown === "loc" ? null : "loc")}
                          className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-full border text-[12px] font-medium transition cursor-pointer min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                            selectedLocation
                              ? "bg-[#DBEAFE] border-[#BFDBFE] text-[#1E3A8A] font-bold"
                              : "bg-[#F1F5F9] border-[#E2E8F0] text-[#0F172A] hover:border-[#CBD5E1]"
                          }`}
                        >
                          <MapPin className="w-3.5 h-3.5 text-[#475569]" />
                          <span>{selectedLocation || "Location"}</span>
                          <ChevronDown className="w-3 h-3 text-[#475569]" />
                        </button>
                        {openDropdown === "loc" && (
                          <div className="absolute left-0 mt-1.5 w-44 max-w-[calc(100vw-32px)] bg-white border border-[#E2E8F0] rounded-[16px] shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                            {["", "United States", "Europe", "India", "Remote"].map((loc) => (
                              <button
                                key={loc || "all"}
                                type="button"
                                onClick={() => {
                                  setSelectedLocation(loc);
                                  setOpenDropdown(null);
                                }}
                                className={`w-full text-left px-2.5 py-2 min-h-[36px] rounded-lg font-medium transition cursor-pointer ${
                                  selectedLocation === loc ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold" : "text-slate-700 hover:bg-slate-50"
                                }`}
                              >
                                {loc || "All Locations"}
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
                          className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-full border text-[12px] font-medium transition cursor-pointer min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                            selectedLevel
                              ? "bg-[#DBEAFE] border-[#BFDBFE] text-[#1E3A8A] font-bold"
                              : "bg-[#F1F5F9] border-[#E2E8F0] text-[#0F172A] hover:border-[#CBD5E1]"
                          }`}
                        >
                          <TrendingUp className="w-3.5 h-3.5 text-[#475569]" />
                          <span>{selectedLevel ? `${selectedLevel} Level` : "Level"}</span>
                          <ChevronDown className="w-3 h-3 text-[#475569]" />
                        </button>
                        {openDropdown === "level" && (
                          <div className="absolute left-0 mt-1.5 w-44 max-w-[calc(100vw-32px)] bg-white border border-[#E2E8F0] rounded-[16px] shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                            {["", "Senior", "Lead", "Mid", "Entry"].map((lvl) => (
                              <button
                                key={lvl || "all"}
                                type="button"
                                onClick={() => {
                                  setSelectedLevel(lvl);
                                  setOpenDropdown(null);
                                }}
                                className={`w-full text-left px-2.5 py-2 min-h-[36px] rounded-lg font-medium transition cursor-pointer ${
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
                          className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-full border text-[12px] font-medium transition cursor-pointer min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                            selectedJobType
                              ? "bg-[#DBEAFE] border-[#BFDBFE] text-[#1E3A8A] font-bold"
                              : "bg-[#F1F5F9] border-[#E2E8F0] text-[#0F172A] hover:border-[#CBD5E1]"
                          }`}
                        >
                          <Clock className="w-3.5 h-3.5 text-[#475569]" />
                          <span>{selectedJobType || "Job type"}</span>
                          <ChevronDown className="w-3 h-3 text-[#475569]" />
                        </button>
                        {openDropdown === "type" && (
                          <div className="absolute left-0 mt-1.5 w-44 max-w-[calc(100vw-32px)] bg-white border border-[#E2E8F0] rounded-[16px] shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                            {["", "Full-time", "Contract", "Part-time"].map((jt) => (
                              <button
                                key={jt || "all"}
                                type="button"
                                onClick={() => {
                                  setSelectedJobType(jt);
                                  setOpenDropdown(null);
                                }}
                                className={`w-full text-left px-2.5 py-2 min-h-[36px] rounded-lg font-medium transition cursor-pointer ${
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
                        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-full border text-xs transition cursor-pointer min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                          remoteOnly
                            ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8] font-bold"
                            : "bg-[#F1F5F9] border-[#E2E8F0] text-[#0F172A] hover:bg-[#E2E8F0]"
                        }`}
                      >
                        <Globe className="w-3.5 h-3.5 text-[#475569]" />
                        <span>Work model</span>
                        {remoteOnly ? <Check className="w-3 h-3 text-[#2563EB]" /> : <ChevronDown className="w-3 h-3 text-[#475569]" />}
                      </button>

                      {/* Industry Pill */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setOpenDropdown(openDropdown === "ind" ? null : "ind")}
                          className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-full border text-[12px] font-medium transition cursor-pointer min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                            selectedCategory
                              ? "bg-[#DBEAFE] border-[#BFDBFE] text-[#1E3A8A] font-bold"
                              : "bg-[#F1F5F9] border-[#E2E8F0] text-[#0F172A] hover:border-[#CBD5E1]"
                          }`}
                        >
                          <Building className="w-3.5 h-3.5 text-[#475569]" />
                          <span>{selectedCategory ? (selectedCategory.charAt(0).toUpperCase() + selectedCategory.slice(1)) : "Industry"}</span>
                          <ChevronDown className="w-3 h-3 text-[#475569]" />
                        </button>
                        {openDropdown === "ind" && (
                          <div className="absolute left-0 mt-1.5 w-48 max-w-[calc(100vw-32px)] bg-white border border-[#E2E8F0] rounded-[16px] shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                            {["", "tech", "data", "design", "marketing", "finance"].map((cat) => (
                              <button
                                key={cat || "all"}
                                type="button"
                                onClick={() => {
                                  setSelectedCategory(cat);
                                  setOpenDropdown(null);
                                }}
                                className={`w-full text-left px-2.5 py-2 min-h-[36px] rounded-lg font-medium capitalize transition cursor-pointer ${
                                  selectedCategory === cat ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold" : "text-slate-700 hover:bg-slate-50"
                                }`}
                              >
                                {cat ? cat : "All Industries"}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Date Posted Pill */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setOpenDropdown(openDropdown === "date" ? null : "date")}
                          className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-full border text-[12px] font-medium transition cursor-pointer min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                            selectedDatePosted
                              ? "bg-[#DBEAFE] border-[#BFDBFE] text-[#1E3A8A] font-bold"
                              : "bg-[#F1F5F9] border-[#E2E8F0] text-[#0F172A] hover:border-[#CBD5E1]"
                          }`}
                        >
                          <Calendar className="w-3.5 h-3.5 text-[#475569]" />
                          <span>{selectedDatePosted || "Date posted"}</span>
                          <ChevronDown className="w-3 h-3 text-[#475569]" />
                        </button>
                        {openDropdown === "date" && (
                          <div className="absolute left-0 mt-1.5 w-44 max-w-[calc(100vw-32px)] bg-white border border-[#E2E8F0] rounded-[16px] shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                            {["Any time", "Past 24 hours", "Past week", "Past month"].map((d) => (
                              <button
                                key={d}
                                type="button"
                                onClick={() => {
                                  setSelectedDatePosted(d === "Any time" ? "" : d);
                                  setOpenDropdown(null);
                                }}
                                className={`w-full text-left px-2.5 py-2 min-h-[36px] rounded-lg font-medium transition cursor-pointer ${
                                  (d === "Any time" && !selectedDatePosted) || selectedDatePosted === d
                                    ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold"
                                    : "text-slate-700 hover:bg-slate-50"
                                }`}
                              >
                                {d}
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
                          className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-full border text-[12px] font-medium transition cursor-pointer min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                            selectedExperience
                              ? "bg-[#DBEAFE] border-[#BFDBFE] text-[#1E3A8A] font-bold"
                              : "bg-[#F1F5F9] border-[#E2E8F0] text-[#0F172A] hover:border-[#CBD5E1]"
                          }`}
                        >
                          <Award className="w-3.5 h-3.5 text-[#475569]" />
                          <span>{selectedExperience || "Experience"}</span>
                          <ChevronDown className="w-3 h-3 text-[#475569]" />
                        </button>
                        {openDropdown === "exp" && (
                          <div className="absolute left-0 mt-1.5 w-44 max-w-[calc(100vw-32px)] bg-white border border-[#E2E8F0] rounded-[16px] shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                            {["All Experience", "1-3 Years", "3-5 Years", "5+ Years", "8+ Years"].map((e) => (
                              <button
                                key={e}
                                type="button"
                                onClick={() => {
                                  setSelectedExperience(e === "All Experience" ? "" : e);
                                  setOpenDropdown(null);
                                }}
                                className={`w-full text-left px-2.5 py-2 min-h-[36px] rounded-lg font-medium transition cursor-pointer ${
                                  (e === "All Experience" && !selectedExperience) || selectedExperience === e
                                    ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold"
                                    : "text-slate-700 hover:bg-slate-50"
                                }`}
                              >
                                {e}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Hidden Jobs Pill */}
                      <button
                        type="button"
                        onClick={() => setViewHiddenJobs((prev) => !prev)}
                        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-full border text-xs font-semibold transition cursor-pointer min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                          viewHiddenJobs
                            ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1E3A8A]"
                            : "bg-[#F1F5F9] border-[#E2E8F0] text-[#0F172A] hover:bg-[#E2E8F0]"
                        }`}
                      >
                        <Lock className="w-3.5 h-3.5 text-[#475569]" />
                        <span>Hidden Jobs</span>
                        {hiddenJobIds.length > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-slate-200 text-slate-700">
                            {hiddenJobIds.length}
                          </span>
                        )}
                      </button>

                      {/* Reset Filters Quick Action */}
                      {activeFiltersCount > 0 && (
                        <button
                          type="button"
                          onClick={handleResetFilters}
                          aria-label="Reset all applied filters"
                          className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-bold text-[#2563EB] hover:text-[#1D4ED8] hover:underline min-h-[44px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
                        >
                          <X className="w-3 h-3" />
                          <span>Reset</span>
                        </button>
                      )}
                    </div>

                    {/* Sort: Recommended on the Far Right (Desktop) */}
                    <div className="flex items-center gap-1.5 ml-auto shrink-0">
                      <div className="relative inline-flex items-center">
                        <HelpCircle className="w-3.5 h-3.5 text-[#475569] mr-1" />
                        <select
                          aria-label="Sort by"
                          value={sortBy}
                          onChange={(e) => {
                            const val = e.target.value as "newest" | "match";
                            setSortBy(val);
                          }}
                          className="text-xs bg-[#F1F5F9] border border-[#CBD5E1] rounded-full px-3 py-1.5 min-h-[40px] text-[#0F172A] font-semibold focus:outline-none focus:ring-2 focus:ring-[#93C5FD] cursor-pointer"
                        >
                          <option value="newest">Sort: Newest</option>
                          <option value="match">Sort: Best Match</option>
                        </select>
                      </div>
                    </div>
                  </div>


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
                      {selectedDatePosted && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E3A8A] text-xs font-medium">
                          <span>{selectedDatePosted}</span>
                          <button
                            type="button"
                            onClick={() => setSelectedDatePosted("")}
                            aria-label="Remove date posted filter"
                            className="hover:text-blue-950 p-0.5 rounded-full hover:bg-blue-100 transition"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      )}
                      {selectedExperience && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E3A8A] text-xs font-medium">
                          <span>{selectedExperience}</span>
                          <button
                            type="button"
                            onClick={() => setSelectedExperience("")}
                            aria-label="Remove experience filter"
                            className="hover:text-blue-950 p-0.5 rounded-full hover:bg-blue-100 transition"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      )}
                      {viewHiddenJobs && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E3A8A] text-xs font-medium">
                          <span>Hidden Jobs Active</span>
                          <button
                            type="button"
                            onClick={() => setViewHiddenJobs(false)}
                            aria-label="Exit hidden jobs view"
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

                {/* Real Accessible Mobile Bottom Sheet Modal */}
                {mobileFiltersOpen && (
                  <div
                    role="dialog"
                    aria-modal="true"
                    aria-label="Filter positions"
                    className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fadeIn"
                  >
                    <div
                      ref={filterDialogRef}
                      className="w-full max-w-lg bg-white rounded-t-[24px] sm:rounded-[20px] max-h-[85vh] flex flex-col shadow-2xl overflow-hidden"
                    >
                      {/* Drag handle */}
                      <div className="w-12 h-1 bg-slate-300 rounded-full mx-auto my-3 shrink-0" />

                      {/* Header */}
                      <div className="px-5 pb-3 border-b border-[#E2E8F0] flex items-center justify-between shrink-0">
                        <div className="flex items-center gap-2">
                          <h2 className="text-base font-bold text-[#0F172A]">Filters</h2>
                          {activeFiltersCount > 0 && (
                            <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-[#2563EB] text-white">
                              {activeFiltersCount} active
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setMobileFiltersOpen(false);
                            filtersTriggerRef.current?.focus();
                          }}
                          aria-label="Close filters"
                          className="w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-slate-100 text-[#475569] hover:text-[#0F172A] transition cursor-pointer"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>

                      {/* Scrollable Filters Content */}
                      <div className="flex-1 overflow-y-auto p-5 pb-8 space-y-5 text-xs sm:text-sm">
                        {/* 1. Location */}
                        <div className="space-y-2">
                          <label className="font-bold block text-xs uppercase tracking-wider text-slate-500">
                            Location
                          </label>
                          <div className="flex flex-wrap gap-1.5">
                            {["", "United States", "Europe", "India", "Remote"].map((loc) => (
                              <button
                                key={loc || "all"}
                                type="button"
                                onClick={() => setSelectedLocation(loc)}
                                className={`px-3 py-2 rounded-full border text-xs font-semibold min-h-[40px] transition cursor-pointer ${
                                  selectedLocation === loc
                                    ? "bg-[#2563EB] text-white border-[#2563EB]"
                                    : "bg-[#F1F5F9] text-[#0F172A] border-[#E2E8F0] hover:bg-[#E2E8F0]"
                                }`}
                              >
                                {loc || "All Locations"}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* 2. Experience */}
                        <div className="space-y-2">
                          <label className="font-bold block text-xs uppercase tracking-wider text-slate-500">
                            Experience
                          </label>
                          <div className="flex flex-wrap gap-1.5">
                            {["", "1-3 Years", "3-5 Years", "5+ Years", "8+ Years"].map((e) => (
                              <button
                                key={e || "all"}
                                type="button"
                                onClick={() => setSelectedExperience(e)}
                                className={`px-3 py-2 rounded-full border text-xs font-semibold min-h-[40px] transition cursor-pointer ${
                                  selectedExperience === e
                                    ? "bg-[#2563EB] text-white border-[#2563EB]"
                                    : "bg-[#F1F5F9] text-[#0F172A] border-[#E2E8F0] hover:bg-[#E2E8F0]"
                                }`}
                              >
                                {e || "All Experience"}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* 3. Level */}
                        <div className="space-y-2">
                          <label className="font-bold block text-xs uppercase tracking-wider text-slate-500">
                            Seniority Level
                          </label>
                          <div className="flex flex-wrap gap-1.5">
                            {["", "Entry", "Mid", "Senior", "Lead"].map((lvl) => (
                              <button
                                key={lvl || "all"}
                                type="button"
                                onClick={() => setSelectedLevel(lvl)}
                                className={`px-3 py-2 rounded-full border text-xs font-semibold min-h-[40px] transition cursor-pointer ${
                                  selectedLevel === lvl
                                    ? "bg-[#2563EB] text-white border-[#2563EB]"
                                    : "bg-[#F1F5F9] text-[#0F172A] border-[#E2E8F0] hover:bg-[#E2E8F0]"
                                }`}
                              >
                                {lvl ? `${lvl} Level` : "All Levels"}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* 4. Job Type */}
                        <div className="space-y-2">
                          <label className="font-bold block text-xs uppercase tracking-wider text-slate-500">
                            Job Type
                          </label>
                          <div className="flex flex-wrap gap-1.5">
                            {["", "Full-time", "Contract", "Part-time"].map((jt) => (
                              <button
                                key={jt || "all"}
                                type="button"
                                onClick={() => setSelectedJobType(jt)}
                                className={`px-3 py-2 rounded-full border text-xs font-semibold min-h-[40px] transition cursor-pointer ${
                                  selectedJobType === jt
                                    ? "bg-[#2563EB] text-white border-[#2563EB]"
                                    : "bg-[#F1F5F9] text-[#0F172A] border-[#E2E8F0] hover:bg-[#E2E8F0]"
                                }`}
                              >
                                {jt || "All Types"}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* 5. Date Posted */}
                        <div className="space-y-2">
                          <label className="font-bold block text-xs uppercase tracking-wider text-slate-500">
                            Date Posted
                          </label>
                          <div className="flex flex-wrap gap-1.5">
                            {["", "Past 24 hours", "Past week", "Past month"].map((d) => (
                              <button
                                key={d || "all"}
                                type="button"
                                onClick={() => setSelectedDatePosted(d)}
                                className={`px-3 py-2 rounded-full border text-xs font-semibold min-h-[40px] transition cursor-pointer ${
                                  selectedDatePosted === d
                                    ? "bg-[#2563EB] text-white border-[#2563EB]"
                                    : "bg-[#F1F5F9] text-[#0F172A] border-[#E2E8F0] hover:bg-[#E2E8F0]"
                                }`}
                              >
                                {d || "Any Time"}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* 6. Toggles: Remote & Hidden */}
                        <div className="pt-2 border-t border-[#E2E8F0] space-y-3">
                          <label className="flex items-center justify-between p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] cursor-pointer">
                            <span className="font-semibold text-xs text-[#0F172A]">Remote Only Positions</span>
                            <input
                              type="checkbox"
                              checked={remoteOnly}
                              onChange={(e) => setRemoteOnly(e.target.checked)}
                              className="w-5 h-5 rounded text-[#2563EB] focus:ring-[#93C5FD]"
                            />
                          </label>

                          <label className="flex items-center justify-between p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] cursor-pointer">
                            <span className="font-semibold text-xs text-[#0F172A]">View Hidden Positions ({hiddenJobIds.length})</span>
                            <input
                              type="checkbox"
                              checked={viewHiddenJobs}
                              onChange={(e) => setViewHiddenJobs(e.target.checked)}
                              className="w-5 h-5 rounded text-[#2563EB] focus:ring-[#93C5FD]"
                            />
                          </label>
                        </div>
                      </div>

                      {/* Sticky Action Footer */}
                      <div className="p-4 pb-[max(1rem,calc(env(safe-area-inset-bottom,0px)+0.75rem))] border-t border-[#E2E8F0] bg-white flex items-center justify-between gap-3 shrink-0">
                        <button
                          type="button"
                          onClick={handleResetFilters}
                          disabled={!hasActiveFilters}
                          className="px-4 py-2.5 text-xs font-bold text-slate-600 hover:text-[#0F172A] disabled:opacity-40 transition min-h-[44px] cursor-pointer"
                        >
                          Reset All
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMobileFiltersOpen(false);
                            filtersTriggerRef.current?.focus();
                          }}
                          className="px-6 py-2.5 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-bold shadow-none min-h-[44px] transition cursor-pointer"
                        >
                          Apply Filters ({filteredJobs.length})
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Jobs List Feed & Right Rail (2-Column Grid on Desktop) */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start pt-2">
                {/* Left Feed Column (8 cols on lg, 9 cols on xl) */}
                <div className="lg:col-span-8 xl:col-span-9 space-y-3.5 w-full min-w-0">
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
                        const isRecent = Boolean(job.postedAt && isPostedUnder24Hours(job.postedAt));
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
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-xs text-[#475569]">
                                          {job.postedAt ? formatRelativeTime(job.postedAt) : (job.date ? `Tracked ${formatRelativeTime(job.date)}` : "")}
                                        </span>
                                        {isRecent && (
                                          <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-md bg-[#EFF6FF] text-[#1E40AF] border border-[#BFDBFE]">
                                            Early applicant
                                          </span>
                                        )}
                                      </div>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleHideJob(e, job.id);
                                        }}
                                        aria-label="Hide position"
                                        title="Hide position"
                                        className="text-[#475569] hover:text-[#0F172A] min-w-[44px] min-h-[44px] flex items-center justify-center p-2 rounded-full hover:bg-slate-100 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
                                      >
                                        <MoreHorizontal className="w-4 h-4" />
                                      </button>
                                    </div>

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
                                      {job.remote && <span> · Remote Eligible</span>}
                                    </div>

                                    {/* Row of small gray chips: location, work type, salary only if present, posted time */}
                                    <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
                                      <span className="inline-flex items-center text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
                                        {isPro ? (job.location || "Location unlisted") : <span className="filter blur-[3px] select-none">Location Locked</span>}
                                      </span>
                                      {job.type && (
                                        <span className="inline-flex items-center text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
                                          {job.type}
                                        </span>
                                      )}
                                      {job.remote && (
                                        <span className="inline-flex items-center text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
                                          Remote
                                        </span>
                                      )}
                                      {inferJobLevel(job.title) && (
                                        <span className="inline-flex items-center text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
                                          {inferJobLevel(job.title)}
                                        </span>
                                      )}
                                      {job.salary && (
                                        <span className="inline-flex items-center text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
                                          {isPro ? job.salary : "••••••••"}
                                        </span>
                                      )}
                                      {job.postedAt && (
                                        <span className="inline-flex items-center text-[12px] font-medium px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">
                                          {formatRelativeTime(job.postedAt)}
                                        </span>
                                      )}
                                    </div>

                                    {/* Mobile: Fit Match panel moves under the chips */}
                                    <div className="sm:hidden pt-2">
                                      {matchScore !== null ? (
                                        <div className="flex items-center justify-between p-3 rounded-[16px] bg-[#0B1528] border border-[#1E293B] text-white">
                                          <div className="flex items-center gap-3">
                                            <CircularMatchRing
                                              score={matchScore}
                                              size={44}
                                              strokeWidth={4}
                                              isPro={isPro}
                                            />
                                            <div className="text-left">
                                              <div className="text-xs font-bold text-white uppercase tracking-wider">
                                                {cardZeroSkills ? "Fit Match · Experience only" : `Fit Match · ${matchScore >= 80 ? "Strong" : "Good"}`}
                                              </div>
                                              <div className="text-[11px] text-slate-300 flex items-center gap-2 pt-0.5">
                                                {job.directSource ? (
                                                  <span>✓ Direct Employer Feed</span>
                                                ) : job.postedAt ? (
                                                  <span>{formatRelativeTime(job.postedAt)}</span>
                                                ) : (
                                                  <span>Tracked Application</span>
                                                )}
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

                              {/* Right: Desktop Match Panel (roughly 180px wide, dark gradient, ~80px ring, full card height) */}
                              {matchScore !== null ? (
                                <div className="hidden sm:flex flex-col items-center justify-between p-4 rounded-[16px] bg-gradient-to-b from-[#09151E] via-[#0B1E28] to-[#06241D] text-white w-44 shrink-0 text-center border border-emerald-950/40 shadow-inner self-stretch min-h-[170px]">
                                  <div className="flex flex-col items-center w-full pt-1">
                                    <CircularMatchRing
                                      score={matchScore}
                                      size={80}
                                      strokeWidth={5}
                                      isPro={isPro}
                                    />
                                    <div className="text-[12px] font-bold uppercase tracking-wider text-slate-100 mt-2.5">
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
                                  className="hidden sm:flex flex-col items-center justify-between p-4 rounded-[16px] bg-gradient-to-b from-[#09151E] via-[#0B1E28] to-[#06241D] border border-emerald-950/40 text-center w-44 shrink-0 transition-all duration-200 group/cta space-y-2.5 self-stretch focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1 text-white min-h-[170px]"
                                >
                                  <div className="flex flex-col items-center justify-center flex-1 w-full space-y-2">
                                    <div className="w-12 h-12 rounded-full bg-blue-500/10 border border-blue-400/30 flex items-center justify-center transition-colors">
                                      <Sparkles className="w-6 h-6 text-blue-400" />
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

                            {/* Bottom row of the card: Save icon button and primary blue pill Apply */}
                            <div className="flex items-center justify-between pt-3 border-t border-[#E2E8F0]">
                              <div className="flex items-center gap-2" />

                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={(e) => handleHideJob(e, job.id)}
                                  aria-label="Hide position"
                                  title="Hide position"
                                  className="w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border border-[#E2E8F0] bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0] hover:text-[#0F172A] transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
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
                                  className={`w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full border transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
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
                                  className="hidden sm:inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full border border-blue-200 bg-blue-50/80 hover:bg-blue-100 text-[#2563EB] text-xs font-bold transition shadow-none cursor-pointer min-h-[44px]"
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
                      })}

                      {/* Load More Pagination: strictly scoped to tabs with active server-side pagination */}
                      {activeTab === "recommended" && liveJobs.length < totalCount && (
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

                {/* Right Rail Column (4 cols on lg, 3 cols on xl, hidden on mobile) */}
                <div className="hidden lg:block lg:col-span-4 xl:col-span-3 space-y-4 shrink-0 sticky top-20">
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
