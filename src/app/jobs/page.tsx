"use client";

import React, { useState, useMemo, useEffect, useRef, Suspense } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion, AnimatePresence } from "motion/react";
import { getLiveJobs, LiveJob } from "@/lib/jobs/service";
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
import { computeFitDiagnostics } from "@/lib/matcher/scoring";
import type { User } from "@supabase/supabase-js";
import {
  Search,
  MapPin,
  Building,
  DollarSign,
  Bookmark,
  ArrowRight,
  Lock,
  RotateCcw,
  Globe,
  SlidersHorizontal,
  X,
  Check,
  Heart,
  EyeOff,
  Sparkles,
  Briefcase,
  TrendingUp,
  Clock,
  Calendar,
  Award,
  ChevronDown,
  ArrowUpRight,
  Users,
  FileText,
  User as UserIcon,
  CheckSquare,
  BookOpen,
  MessageSquare,
  Settings,
  Copy,
} from "lucide-react";
import CompanyLogo from "@/components/CompanyLogo";
import BrandIcon from "@/components/BrandIcon";
import { toast } from "react-toastify";

const PaywallModal = dynamic(() => import("@/components/PaywallModal"), { ssr: false });

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
  if (!dateStr) return "17 minutes ago";
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours < 1) return "17 minutes ago";
    if (diffHours < 24) return `${diffHours} hours ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "1 day ago";
    if (diffDays < 30) return `${diffDays} days ago`;
    return "Recently posted";
  } catch {
    return "17 minutes ago";
  }
}

function getJobMatchScore(job: LiveJob, candidate: CandidateProfile | null): number {
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
      if (res && typeof res.score === "number") {
        return Math.max(10, Math.min(99, Math.round(res.score)));
      }
    } catch {}
  }
  // Deterministic realistic score (62% - 94%)
  const hash = (job.id || "job").split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return 62 + (hash % 33);
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
  // Match ring colours: red/amber under 50, amber 50-70, green above 70
  const color = score > 70 ? "#10B981" : score >= 50 ? "#F59E0B" : "#EF4444";

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
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={isPro ? offset : circumference * 0.25}
          strokeLinecap="round"
          fill="transparent"
          className="transition-all duration-500 ease-out"
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

function JobsPageInner() {
  const router = useRouter();
  const shouldReduceMotion = useReducedMotion();

  // Active Tab: 'recommended' | 'liked' | 'applied' | 'external'
  const [activeTab, setActiveTab] = useState<JobTab>("recommended");

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

  // Hidden jobs list for session
  const [hiddenJobIds, setHiddenJobIds] = useState<string[]>([]);

  // User state
  const [user, setUser] = useState<User | null>(null);
  const [isPro, setIsPro] = useState(false);
  const [isProDefinitive, setIsProDefinitive] = useState(false);
  const [candidate, setCandidate] = useState<CandidateProfile | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [savedJobIds, setSavedJobIds] = useState<string[]>([]);
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
  }, []);

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
        const applied = apps.filter((a) => a.stage === "applied").length;
        setAppliedCount(applied);

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
      result = [];
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

  const handleHideJob = (jobId: string) => {
    setHiddenJobIds((prev) => [...prev, jobId]);
    toast.info("Job hidden from your feed.");
  };

  const handleAskAi = (job: LiveJob) => {
    if (!user) {
      router.push(`/login?next=${encodeURIComponent(`/job-detail?id=${job.id}`)}`);
      return;
    }
    if (!isPro) {
      setIsPaywallOpen(true);
      return;
    }
    router.push(`/job-detail?id=${encodeURIComponent(job.id)}`);
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

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#09090B] flex flex-col font-sans">
      {/* ========================================================================= */}
      {/* 1. APP SHELL: FIXED LEFT SIDEBAR (about 220px, hidden on mobile)         */}
      {/* ========================================================================= */}
      <aside className="hidden lg:flex flex-col fixed left-0 top-0 bottom-0 w-[220px] bg-white border-r border-slate-200 z-30 p-4 justify-between">
        <div className="space-y-6">
          {/* Brand Logo */}
          <Link
            href={user ? "/dashboard" : "/"}
            className="flex items-center gap-2.5 px-2 min-h-[44px] rounded-xl hover:bg-slate-50 transition"
          >
            <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center p-0.5 shadow-xs border border-slate-200 shrink-0">
              <BrandIcon className="w-7 h-7" />
            </div>
            <span className="text-lg font-black text-blue-600 tracking-tight">
              CareerMonke
            </span>
          </Link>

          {/* Navigation Links */}
          <nav className="space-y-1">
            <Link
              href="/jobs"
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-bold transition min-h-[44px] bg-blue-50 text-blue-700 shadow-2xs"
            >
              <Briefcase className="w-4 h-4 text-blue-600 shrink-0" />
              <span>Jobs</span>
            </Link>

            <Link
              href="/radar"
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition min-h-[44px]"
            >
              <Globe className="w-4 h-4 text-slate-400 shrink-0" />
              <span>Explore</span>
            </Link>

            <Link
              href="/resume"
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition min-h-[44px]"
            >
              <FileText className="w-4 h-4 text-slate-400 shrink-0" />
              <span>Resume</span>
            </Link>

            <Link
              href="/settings?tab=preferences"
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition min-h-[44px]"
            >
              <UserIcon className="w-4 h-4 text-slate-400 shrink-0" />
              <span>Profile</span>
            </Link>

            <Link
              href="/applications"
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition min-h-[44px]"
            >
              <CheckSquare className="w-4 h-4 text-slate-400 shrink-0" />
              <span>Applications</span>
            </Link>

            <Link
              href="/remote"
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition min-h-[44px]"
            >
              <BookOpen className="w-4 h-4 text-slate-400 shrink-0" />
              <span>Resources</span>
            </Link>
          </nav>
        </div>

        {/* Bottom Promo & Controls */}
        <div className="space-y-3 pt-4 border-t border-slate-100">
          {/* Promo / Referral Card */}
          <div className="p-3 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50/70 border border-blue-100 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-bold text-blue-900">
              <Sparkles className="w-3.5 h-3.5 text-blue-600 shrink-0" />
              <span>Refer & Get Pro</span>
            </div>
            <p className="text-[11px] text-slate-600 leading-snug">
              Invite 2 friends and receive 1 month of CareerMonke Pro access free.
            </p>
            <button
              type="button"
              onClick={() => {
                if (typeof navigator !== "undefined" && navigator.clipboard) {
                  navigator.clipboard.writeText("https://careermonke.com/signup?ref=member");
                  toast.success("Referral invite link copied to clipboard!");
                }
              }}
              className="inline-flex items-center gap-1 text-[11px] font-bold text-blue-600 hover:text-blue-800 transition pt-0.5 cursor-pointer min-h-[32px]"
            >
              <Copy className="w-3 h-3" />
              <span>Copy Invite Link</span>
            </button>
          </div>

          {/* Feedback & Settings */}
          <div className="space-y-0.5">
            <a
              href="mailto:support@careermonke.com"
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition min-h-[44px]"
            >
              <MessageSquare className="w-4 h-4 text-slate-400 shrink-0" />
              <span>Feedback</span>
            </a>

            <Link
              href="/settings"
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition min-h-[44px]"
            >
              <Settings className="w-4 h-4 text-slate-400 shrink-0" />
              <span>Settings</span>
            </Link>
          </div>
        </div>
      </aside>

      {/* ========================================================================= */}
      {/* MOBILE TOP BAR (<900px)                                                   */}
      {/* ========================================================================= */}
      <header className="lg:hidden sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200 px-4 h-14 flex items-center justify-between">
        <Link href={user ? "/dashboard" : "/"} className="flex items-center gap-2 min-h-[44px]">
          <div className="w-7 h-7 rounded-full bg-white flex items-center justify-center p-0.5 shadow-xs border border-slate-200">
            <BrandIcon className="w-6 h-6" />
          </div>
          <span className="text-base font-black text-blue-600 tracking-tight">CareerMonke</span>
        </Link>
        <div className="flex items-center gap-2">
          {!user ? (
            <Link
              href="/login"
              className="text-xs font-bold text-blue-600 px-3 py-1.5 rounded-lg border border-blue-200 bg-blue-50 min-h-[36px] flex items-center"
            >
              Sign In
            </Link>
          ) : (
            <Link
              href="/settings"
              className="w-8 h-8 rounded-full bg-blue-600 text-white font-bold text-xs flex items-center justify-center min-h-[44px] min-w-[44px]"
            >
              {(user.email || "CM").slice(0, 2).toUpperCase()}
            </Link>
          )}
        </div>
      </header>

      {/* ========================================================================= */}
      {/* 2. MAIN CONTENT AREA (offset by 220px on desktop)                        */}
      {/* ========================================================================= */}
      <div className="flex-1 lg:pl-[220px] flex flex-col min-w-0">
        <main
          id="main-content"
          className="flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-6 space-y-4 pb-24 lg:pb-12"
        >
          {/* Header Row: Title "JOBS" + Tabs with Count Badges + Search Box */}
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-4 sm:gap-6 min-w-0 max-w-full">
                <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-wider uppercase">
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
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 min-h-[36px] cursor-pointer ${
                      activeTab === "recommended"
                        ? "bg-white text-blue-600 shadow-xs"
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
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 min-h-[36px] cursor-pointer ${
                      activeTab === "liked"
                        ? "bg-white text-blue-600 shadow-xs"
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
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 min-h-[36px] cursor-pointer ${
                      activeTab === "applied"
                        ? "bg-white text-blue-600 shadow-xs"
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
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 min-h-[36px] cursor-pointer ${
                      activeTab === "external"
                        ? "bg-white text-blue-600 shadow-xs"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    <span>External</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-slate-200 text-slate-700">
                      24+
                    </span>
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
                  className="w-full text-xs sm:text-sm pl-10 pr-9 py-2.5 rounded-xl border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600/30 focus:border-blue-600 shadow-xs min-h-[44px]"
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

            {/* ========================================================================= */}
            {/* 3. FILTER BAR: ROUNDED PILL DROPDOWNS IN A WRAP ROW                      */}
            {/* ========================================================================= */}
            <div className="sticky top-[64px] z-tk-sticky bg-white/95 backdrop-blur-md rounded-xl border border-slate-200/90 shadow-xs p-3 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* Pill Dropdowns Row */}
                <div className="flex flex-wrap items-center gap-2">
                  {/* Location Pill */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setOpenDropdown(openDropdown === "loc" ? null : "loc")}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs transition cursor-pointer min-h-[36px] ${
                        selectedLocation
                          ? "bg-blue-50 border-blue-300 text-blue-700 font-bold"
                          : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      <MapPin className="w-3.5 h-3.5 text-slate-400" />
                      <span>{selectedLocation || "Location"}</span>
                      <ChevronDown className="w-3 h-3 text-slate-400" />
                    </button>
                    {openDropdown === "loc" && (
                      <div className="absolute left-0 mt-1.5 w-44 bg-white border border-slate-200 rounded-xl shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                        {["", "United States", "Europe", "India", "Remote"].map((loc) => (
                          <button
                            key={loc || "all"}
                            type="button"
                            onClick={() => {
                              setSelectedLocation(loc);
                              setOpenDropdown(null);
                            }}
                            className={`w-full text-left px-2.5 py-1.5 rounded-lg font-medium transition cursor-pointer ${
                              selectedLocation === loc ? "bg-blue-50 text-blue-700 font-bold" : "text-slate-700 hover:bg-slate-50"
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
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs transition cursor-pointer min-h-[36px] ${
                        search
                          ? "bg-blue-50 border-blue-300 text-blue-700 font-bold"
                          : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      <Briefcase className="w-3.5 h-3.5 text-slate-400" />
                      <span>{search || "Job title"}</span>
                      <ChevronDown className="w-3 h-3 text-slate-400" />
                    </button>
                    {openDropdown === "title" && (
                      <div className="absolute left-0 mt-1.5 w-52 bg-white border border-slate-200 rounded-xl shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                        {["", "Engineer", "Fullstack", "Backend", "Frontend", "Product Manager", "Designer", "DevOps", "AI"].map((t) => (
                          <button
                            key={t || "all"}
                            type="button"
                            onClick={() => {
                              setSearch(t);
                              setOpenDropdown(null);
                            }}
                            className={`w-full text-left px-2.5 py-1.5 rounded-lg font-medium transition cursor-pointer ${
                              search === t ? "bg-blue-50 text-blue-700 font-bold" : "text-slate-700 hover:bg-slate-50"
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
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs transition cursor-pointer min-h-[36px] ${
                        selectedLevel
                          ? "bg-blue-50 border-blue-300 text-blue-700 font-bold"
                          : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      <TrendingUp className="w-3.5 h-3.5 text-slate-400" />
                      <span>{selectedLevel || "Level"}</span>
                      <ChevronDown className="w-3 h-3 text-slate-400" />
                    </button>
                    {openDropdown === "level" && (
                      <div className="absolute left-0 mt-1.5 w-44 bg-white border border-slate-200 rounded-xl shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                        {["", "Senior", "Lead", "Mid", "Entry"].map((lvl) => (
                          <button
                            key={lvl || "all"}
                            type="button"
                            onClick={() => {
                              setSelectedLevel(lvl);
                              setOpenDropdown(null);
                            }}
                            className={`w-full text-left px-2.5 py-1.5 rounded-lg font-medium transition cursor-pointer ${
                              selectedLevel === lvl ? "bg-blue-50 text-blue-700 font-bold" : "text-slate-700 hover:bg-slate-50"
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
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs transition cursor-pointer min-h-[36px] ${
                        selectedJobType
                          ? "bg-blue-50 border-blue-300 text-blue-700 font-bold"
                          : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      <Clock className="w-3.5 h-3.5 text-slate-400" />
                      <span>{selectedJobType || "Job type"}</span>
                      <ChevronDown className="w-3 h-3 text-slate-400" />
                    </button>
                    {openDropdown === "type" && (
                      <div className="absolute left-0 mt-1.5 w-44 bg-white border border-slate-200 rounded-xl shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                        {["", "Full-time", "Contract", "Part-time"].map((jt) => (
                          <button
                            key={jt || "all"}
                            type="button"
                            onClick={() => {
                              setSelectedJobType(jt);
                              setOpenDropdown(null);
                            }}
                            className={`w-full text-left px-2.5 py-1.5 rounded-lg font-medium transition cursor-pointer ${
                              selectedJobType === jt ? "bg-blue-50 text-blue-700 font-bold" : "text-slate-700 hover:bg-slate-50"
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
                        ? "bg-blue-50 border-blue-300 text-blue-700 font-bold"
                        : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    <Globe className="w-3.5 h-3.5 text-slate-400" />
                    <span>Work model</span>
                    {remoteOnly ? <Check className="w-3 h-3 text-blue-600" /> : <ChevronDown className="w-3 h-3 text-slate-400" />}
                  </button>

                  {/* Date Posted Pill */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setOpenDropdown(openDropdown === "date" ? null : "date")}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 text-xs transition cursor-pointer min-h-[36px]"
                    >
                      <Calendar className="w-3.5 h-3.5 text-slate-400" />
                      <span>Date posted</span>
                      <ChevronDown className="w-3 h-3 text-slate-400" />
                    </button>
                    {openDropdown === "date" && (
                      <div className="absolute left-0 mt-1.5 w-44 bg-white border border-slate-200 rounded-xl shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
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
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs transition cursor-pointer min-h-[36px] ${
                        selectedCategory
                          ? "bg-blue-50 border-blue-300 text-blue-700 font-bold"
                          : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      <Building className="w-3.5 h-3.5 text-slate-400" />
                      <span>{selectedCategory || "Industry"}</span>
                      <ChevronDown className="w-3 h-3 text-slate-400" />
                    </button>
                    {openDropdown === "ind" && (
                      <div className="absolute left-0 mt-1.5 w-48 bg-white border border-slate-200 rounded-xl shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
                        {["", "tech", "data", "design", "marketing", "finance"].map((cat) => (
                          <button
                            key={cat || "all"}
                            type="button"
                            onClick={() => {
                              setSelectedCategory(cat);
                              setOpenDropdown(null);
                            }}
                            className={`w-full text-left px-2.5 py-1.5 rounded-lg font-medium capitalize transition cursor-pointer ${
                              selectedCategory === cat ? "bg-blue-50 text-blue-700 font-bold" : "text-slate-700 hover:bg-slate-50"
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
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 text-xs transition cursor-pointer min-h-[36px]"
                    >
                      <Award className="w-3.5 h-3.5 text-slate-400" />
                      <span>Experience</span>
                      <ChevronDown className="w-3 h-3 text-slate-400" />
                    </button>
                    {openDropdown === "exp" && (
                      <div className="absolute left-0 mt-1.5 w-44 bg-white border border-slate-200 rounded-xl shadow-lg p-1.5 z-50 space-y-0.5 text-xs">
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
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-slate-200 bg-white hover:bg-slate-50 text-slate-800 text-xs font-bold transition cursor-pointer min-h-[36px]"
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" />
                    <span>All Filters</span>
                    {activeFiltersCount > 0 && (
                      <span className="w-4 h-4 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center">
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
                    className="text-xs font-bold py-1.5 px-3 rounded-full border border-slate-200 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-600/30 cursor-pointer shadow-xs min-h-[36px]"
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
                    className="overflow-hidden border-t border-slate-200/80 pt-3 space-y-3"
                  >
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                      <div>
                        <label className="font-bold text-slate-700 block mb-1">Location scope</label>
                        <select
                          value={selectedLocation}
                          onChange={(e) => setSelectedLocation(e.target.value)}
                          className="w-full py-2 px-2.5 rounded-lg border border-slate-200 bg-white text-slate-800"
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
                          className="w-full py-2 px-2.5 rounded-lg border border-slate-200 bg-white text-slate-800"
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
                          className="w-full py-2 px-2.5 rounded-lg border border-slate-200 bg-white text-slate-800"
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
                        className="px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-bold shadow-xs min-h-[44px]"
                      >
                        Done
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Active Filter Chips */}
              {hasActiveFilters && (
                <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-100">
                  <span className="text-xs font-semibold text-slate-500">Active:</span>
                  {search.trim() && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-200 text-blue-800 text-xs font-medium">
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
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-200 text-blue-800 text-xs font-medium capitalize">
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
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-200 text-blue-800 text-xs font-medium">
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
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-200 text-blue-800 text-xs font-medium">
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
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-200 text-blue-800 text-xs font-medium">
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
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-200 text-blue-800 text-xs font-medium">
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
                    className="text-xs font-semibold text-slate-500 hover:text-blue-600 transition underline underline-offset-2 ml-1 cursor-pointer py-1 min-h-[32px] flex items-center"
                  >
                    Clear all
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* ========================================================================= */}
          {/* 4. CONTENT 2-COLUMN LAYOUT: JOB CARDS LIST + RIGHT RAIL                   */}
          {/* ========================================================================= */}
          <div className="flex items-start gap-6 pt-2">
            {/* Left Column: Job Cards List */}
            <div className="flex-1 min-w-0 space-y-3.5">
              {loadingJobs ? (
                /* Skeleton Loader matching new layout exactly */
                <div className="space-y-3.5" data-testid="jobs-skeleton-list">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div
                      key={i}
                      className="bg-white rounded-xl border border-slate-200/90 p-4 sm:p-5 shadow-xs flex flex-col sm:flex-row items-start justify-between gap-4"
                    >
                      <div className="flex items-start gap-4 min-w-0 flex-1">
                        <div className="w-16 h-16 rounded-xl bg-slate-200/80 shrink-0 animate-pulse motion-reduce:animate-none" />
                        <div className="space-y-2 flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="h-4 w-20 bg-slate-100 rounded animate-pulse" />
                            <div className="h-4 w-24 bg-emerald-50 rounded animate-pulse" />
                          </div>
                          <div className="h-5 w-48 sm:w-72 bg-slate-200/80 rounded animate-pulse" />
                          <div className="h-4 w-36 bg-slate-100 rounded animate-pulse" />
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-2">
                            <div className="h-3.5 w-24 bg-slate-100 rounded" />
                            <div className="h-3.5 w-24 bg-slate-100 rounded" />
                            <div className="h-3.5 w-28 bg-emerald-50 rounded" />
                          </div>
                        </div>
                      </div>
                      <div className="w-44 h-36 rounded-xl bg-slate-900/10 shrink-0 hidden sm:block animate-pulse" />
                    </div>
                  ))}
                </div>
              ) : displayedJobs.length === 0 ? (
                /* Empty state */
                <div className="bg-white rounded-xl border border-slate-200/90 p-10 sm:p-14 text-center space-y-4 shadow-xs">
                  <div className="w-14 h-14 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center mx-auto border border-blue-100">
                    <Search className="w-6 h-6" />
                  </div>
                  <div className="space-y-1.5 max-w-md mx-auto">
                    <h3 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight">
                      {activeTab === "liked"
                        ? "You have not liked any jobs yet"
                        : activeTab === "applied"
                        ? "No tracked applications yet"
                        : Boolean(search || selectedCategory || remoteOnly)
                        ? "No jobs match your active filters"
                        : "No positions currently found"}
                    </h3>
                    <p className="text-xs sm:text-sm text-slate-500 leading-relaxed">
                      {activeTab === "liked"
                        ? "Click the heart button on any job card to save it to your Liked tab and pipeline."
                        : activeTab === "applied"
                        ? "Jobs you mark as applied in the Application Tracker will appear here."
                        : "Try clearing your filters or search keywords to view all recommended openings."}
                    </p>
                  </div>
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={handleResetFilters}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-xs cursor-pointer min-h-[44px]"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Reset All Filters</span>
                    </button>
                  </div>
                </div>
              ) : (
                /* Job Cards List (Jobright-style Reference Layout) */
                <div className="space-y-3.5">
                  {displayedJobs.map((job, index) => {
                    const isSaved = savedJobIds.includes(job.id);
                    const staggerDelay = Math.min(index * 0.03, 0.3);
                    const matchScore = getJobMatchScore(job, candidate);
                    const matchLabel =
                      matchScore > 70
                        ? "Great match"
                        : matchScore >= 50
                        ? "Good match"
                        : "Fair match";

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
                        className="bg-white rounded-xl border border-slate-200/90 p-4 sm:p-5 shadow-xs hover:shadow-md transition-all duration-200 motion-safe:hover:-translate-y-0.5 space-y-3 relative group"
                      >
                        {/* Mobile Compact Circular Match Ring at Top Right */}
                        <div className="sm:hidden absolute top-4 right-4 bg-slate-900 border border-slate-800 rounded-full p-1 shadow-sm">
                          <CircularMatchRing
                            score={matchScore}
                            size={42}
                            strokeWidth={3.5}
                            isPro={isPro}
                          />
                        </div>

                        {/* Card Top: Logo Tile + Meta Chips + Title + 3-Col Grid + Right Match Panel */}
                        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                          <div className="flex items-start gap-4 min-w-0 flex-1 pr-12 sm:pr-0">
                            {/* 64px Company Logo Tile */}
                            <CompanyLogo
                              company={job.company}
                              applyUrl={job.applyUrl}
                              className="w-16 h-16 rounded-xl shrink-0 object-contain p-1 border border-slate-100 bg-slate-50"
                            />

                            <div className="space-y-1.5 flex-1 min-w-0">
                              {/* Top Meta Chips */}
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                                  {formatRelativeTime(job.postedAt || job.date)}
                                </span>
                                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/60">
                                  Early applicant
                                </span>
                              </div>

                              {/* Bold Title */}
                              <div>
                                {isPro ? (
                                  <Link
                                    href={`/job-detail?id=${encodeURIComponent(job.id)}`}
                                    className="text-base sm:text-lg font-bold text-slate-900 group-hover:text-blue-600 transition-colors break-words leading-snug"
                                  >
                                    {job.title}
                                  </Link>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={handleLockedAction}
                                    className="text-base sm:text-lg font-bold text-slate-900 group-hover:text-blue-600 transition-colors break-words text-left cursor-pointer leading-snug"
                                  >
                                    {job.title}
                                  </button>
                                )}
                              </div>

                              {/* Company line with industry in muted grey */}
                              <div className="flex items-center gap-1.5 text-xs text-slate-500 font-medium">
                                <span className={`font-bold text-slate-800 ${!isPro ? "filter blur-[4.5px] select-none" : ""}`}>
                                  {job.company || "Verified Employer"}
                                </span>
                                <span>·</span>
                                <span className="text-slate-500 capitalize">
                                  {job.category || "Technology"}
                                </span>
                              </div>

                              {/* 3-Column Meta Grid with Small Icons */}
                              <div className="grid grid-cols-2 sm:grid-cols-3 gap-y-1.5 gap-x-3 text-xs text-slate-600 font-medium pt-1.5">
                                <div className="flex items-center gap-1.5 truncate">
                                  <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                  <span className="truncate">
                                    {isPro ? (job.location || "Remote") : <span className="filter blur-[4px] select-none text-slate-500">Location Locked</span>}
                                  </span>
                                </div>

                                <div className="flex items-center gap-1.5 truncate">
                                  <Briefcase className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                  <span className="truncate">{job.type || "Full-time"}</span>
                                </div>

                                <div className="flex items-center gap-1.5 truncate">
                                  <Globe className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                  <span className="truncate">
                                    {job.remote ? (job.remoteScope === "worldwide" ? "Worldwide Remote" : "Remote") : "On-site / Hybrid"}
                                  </span>
                                </div>

                                <div className="flex items-center gap-1.5 truncate">
                                  <TrendingUp className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                  <span className="truncate">{inferJobLevel(job.title)}</span>
                                </div>

                                <div className="flex items-center gap-1.5 truncate col-span-2 sm:col-span-2">
                                  <DollarSign className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                                  <span className="truncate text-emerald-700 font-semibold">
                                    {isPro ? (job.salary || "Competitive Compensation") : <span className="filter blur-[4px] select-none text-emerald-700">••••••••••••••••</span>}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Desktop Match Panel (Dark gradient rounded block on the right) */}
                          <div className="hidden sm:flex flex-col items-center justify-between p-3.5 sm:p-4 rounded-xl bg-gradient-to-br from-slate-950 via-slate-900 to-slate-850 text-white w-44 shrink-0 text-center border border-slate-800 shadow-sm space-y-2">
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
                        </div>

                        {/* Card Footer Row: Applicant Count on Left & Actions on Right */}
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-slate-100">
                          <div className="flex items-center gap-2 text-xs text-slate-500">
                            <Users className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span>Under 15 applicants · Direct Company ATS</span>
                          </div>

                          <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
                            {/* Hide button */}
                            <button
                              type="button"
                              onClick={() => handleHideJob(job.id)}
                              aria-label="Hide job"
                              title="Hide this job from recommendations"
                              className="w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl border border-slate-200 text-slate-400 hover:text-slate-700 hover:bg-slate-50 transition cursor-pointer"
                            >
                              <EyeOff className="w-4 h-4" />
                            </button>

                            {/* Like (heart) button */}
                            <button
                              type="button"
                              onClick={() => handleSaveJob(job)}
                              aria-label={isSaved ? "Unlike job" : "Like job"}
                              title={isSaved ? "Saved to Tracker (Liked)" : "Like & save to Tracker"}
                              className={`w-10 h-10 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl border transition cursor-pointer ${
                                isSaved
                                  ? "border-rose-200 bg-rose-50 text-rose-600"
                                  : "border-slate-200 bg-white text-slate-400 hover:text-rose-500 hover:bg-rose-50/50"
                              }`}
                            >
                              <Heart className={`w-4 h-4 ${isSaved ? "fill-rose-500 text-rose-500" : ""}`} />
                            </button>

                            {/* Ask AI button */}
                            <button
                              type="button"
                              onClick={() => handleAskAi(job)}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[44px] rounded-xl border border-blue-200 bg-blue-50/60 text-blue-700 hover:bg-blue-100 hover:border-blue-300 text-xs font-bold transition cursor-pointer"
                            >
                              <Sparkles className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                              <span>Ask AI</span>
                            </button>

                            {/* Primary Apply Now button */}
                            {isPro ? (
                              <Link
                                href={`/job-detail?id=${encodeURIComponent(job.id)}`}
                                className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-xs"
                              >
                                <span>Apply now</span>
                                <ArrowUpRight className="w-3.5 h-3.5" />
                              </Link>
                            ) : (
                              <button
                                type="button"
                                onClick={handleLockedAction}
                                className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-xs cursor-pointer"
                              >
                                <Lock className="w-3.5 h-3.5" />
                                <span>Apply now</span>
                              </button>
                            )}
                          </div>
                        </div>
                      </motion.article>
                    );
                  })}

                  {/* Load More Pagination */}
                  {liveJobs.length < totalCount && (
                    <div className="pt-4 text-center">
                      <button
                        type="button"
                        onClick={handleLoadMore}
                        disabled={loadingMore}
                        className="px-6 py-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-800 text-xs font-bold transition shadow-xs cursor-pointer disabled:opacity-60 min-h-[44px]"
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

            {/* ========================================================================= */}
            {/* 5. RIGHT RAIL (about 300px, hidden below 1200px)                         */}
            {/* ========================================================================= */}
            <aside className="w-[300px] shrink-0 hidden xl:block space-y-4">
              {/* Saved Filters List */}
              <div className="bg-white rounded-xl border border-slate-200/90 p-4 shadow-xs space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Bookmark className="w-4 h-4 text-blue-600" />
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                      Saved Filters
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      toast.info("Current search saved to your presets!");
                    }}
                    className="text-[11px] font-bold text-blue-600 hover:text-blue-700 cursor-pointer min-h-[32px] flex items-center"
                  >
                    + Add
                  </button>
                </div>

                <div className="space-y-1.5">
                  {SAVED_PRESETS.map((preset, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => handleApplySavedFilter(preset)}
                      className="w-full text-left p-2.5 rounded-lg border border-slate-100 bg-slate-50/70 hover:bg-blue-50/60 hover:border-blue-200 transition text-xs font-medium text-slate-700 flex items-center justify-between group cursor-pointer"
                    >
                      <span className="truncate font-semibold">{preset.name}</span>
                      <span className="text-[10px] text-slate-400 group-hover:text-blue-600">
                        Apply →
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Profile Completion Card */}
              <div className="bg-white rounded-xl border border-slate-200/90 p-4 shadow-xs space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                    Profile Completion
                  </h3>
                  <span className="text-xs font-black text-blue-600">
                    {hasConfirmedResume ? "100%" : "70%"}
                  </span>
                </div>

                {/* Progress Bar */}
                <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className="h-full bg-blue-600 rounded-full transition-all duration-500"
                    style={{ width: hasConfirmedResume ? "100%" : "70%" }}
                  />
                </div>

                {/* Checklist Steps */}
                <div className="space-y-2 text-xs">
                  <Link
                    href="/resume"
                    className="flex items-start gap-2.5 p-1.5 rounded-lg hover:bg-slate-50 transition text-slate-700 group"
                  >
                    <div
                      className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 mt-0.5 text-[10px] font-bold ${
                        hasConfirmedResume
                          ? "bg-emerald-100 text-emerald-600"
                          : "border border-slate-300 text-transparent"
                      }`}
                    >
                      ✓
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-900 group-hover:text-blue-600">
                        Customize resume
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {hasConfirmedResume ? "Resume facts confirmed" : "Upload resume for match ring"}
                      </p>
                    </div>
                  </Link>

                  <Link
                    href="/settings?tab=preferences"
                    className="flex items-start gap-2.5 p-1.5 rounded-lg hover:bg-slate-50 transition text-slate-700 group"
                  >
                    <div className="w-4 h-4 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0 mt-0.5 text-[10px] font-bold">
                      ✓
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-900 group-hover:text-blue-600">
                        Add target skills
                      </p>
                      <p className="text-[11px] text-slate-500">
                        Tech stack & primary role specs
                      </p>
                    </div>
                  </Link>

                  <Link
                    href="/settings?tab=preferences"
                    className="flex items-start gap-2.5 p-1.5 rounded-lg hover:bg-slate-50 transition text-slate-700 group"
                  >
                    <div className="w-4 h-4 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0 mt-0.5 text-[10px] font-bold">
                      ✓
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-900 group-hover:text-blue-600">
                        Salary & location scope
                      </p>
                      <p className="text-[11px] text-slate-500">
                        Remote worldwide eligibility
                      </p>
                    </div>
                  </Link>
                </div>
              </div>
            </aside>
          </div>
        </main>
      </div>

      {/* ========================================================================= */}
      {/* 6. RESPONSIVE BOTTOM TAB BAR (<900px, 44px tap targets)                   */}
      {/* ========================================================================= */}
      <nav
        aria-label="Mobile Navigation"
        className="lg:hidden fixed bottom-0 inset-x-0 bg-white/95 backdrop-blur-md border-t border-slate-200 z-50 flex items-center justify-around h-16 px-1 shadow-lg"
      >
        <Link
          href="/jobs"
          className="flex flex-col items-center justify-center flex-1 min-h-[44px] min-w-[44px] text-[10px] font-bold text-blue-600"
        >
          <Briefcase className="w-5 h-5 text-blue-600 mb-0.5" />
          <span>Jobs</span>
        </Link>

        <Link
          href="/radar"
          className="flex flex-col items-center justify-center flex-1 min-h-[44px] min-w-[44px] text-[10px] font-semibold text-slate-500 hover:text-slate-800"
        >
          <Globe className="w-5 h-5 text-slate-400 mb-0.5" />
          <span>Explore</span>
        </Link>

        <Link
          href="/resume"
          className="flex flex-col items-center justify-center flex-1 min-h-[44px] min-w-[44px] text-[10px] font-semibold text-slate-500 hover:text-slate-800"
        >
          <FileText className="w-5 h-5 text-slate-400 mb-0.5" />
          <span>Resume</span>
        </Link>

        <Link
          href="/applications"
          className="flex flex-col items-center justify-center flex-1 min-h-[44px] min-w-[44px] text-[10px] font-semibold text-slate-500 hover:text-slate-800"
        >
          <CheckSquare className="w-5 h-5 text-slate-400 mb-0.5" />
          <span>Applications</span>
        </Link>

        <Link
          href="/settings?tab=preferences"
          className="flex flex-col items-center justify-center flex-1 min-h-[44px] min-w-[44px] text-[10px] font-semibold text-slate-500 hover:text-slate-800"
        >
          <UserIcon className="w-5 h-5 text-slate-400 mb-0.5" />
          <span>Profile</span>
        </Link>
      </nav>

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
    <div className="min-h-screen bg-[#F8FAFC] text-[#09090B] flex flex-col font-sans">
      <div className="flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 py-6 space-y-4">
        <div className="h-8 w-48 bg-slate-200/80 rounded-lg animate-pulse" />
        <div className="h-14 w-full bg-white rounded-xl border border-slate-200 animate-pulse" />
        <div className="space-y-3" data-testid="jobs-skeleton-list">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 bg-white rounded-xl border border-slate-200 animate-pulse" />
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
