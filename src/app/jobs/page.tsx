"use client";

import React, { useState, useMemo, useEffect, useRef, Suspense } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion, AnimatePresence } from "motion/react";
import GuideHeader from "@/components/GuideHeader";
import CategoryPillBar from "@/components/CategoryPillBar";
import { getLiveJobs, LiveJob } from "@/lib/jobs/service";
import { getAuthUser, getUserPreferences } from "@/lib/auth/session";
import { getCandidateProfile } from "@/lib/resume/storage";
import { CandidateProfile } from "@/lib/resume/types";
import { UserPreferences } from "@/lib/auth/types";
import { addApplicationToTracker, getTrackedApplications, removeApplicationFromTracker } from "@/lib/tracker/storage";
import { getProAccessStatus } from "@/lib/billing/subscription";
import type { User } from "@supabase/supabase-js";
import {
  Search,
  MapPin,
  Building,
  DollarSign,
  BookmarkPlus,
  ArrowRight,
  Lock,
  RotateCcw,
  ChevronRight,
  Globe,
  SlidersHorizontal,
  X,
  Check
} from "lucide-react";
import CompanyLogo from "@/components/CompanyLogo";
import { toast } from "react-toastify";

const PaywallModal = dynamic(() => import("@/components/PaywallModal"), { ssr: false });
const MatchScoreBadge = dynamic(() => import("@/components/matcher/MatchScoreBadge"), { ssr: false });
const Footer = dynamic(() => import("@/components/Footer"), { ssr: false });

function JobsPageInner() {
  const router = useRouter();
  const shouldReduceMotion = useReducedMotion();

  // Active Tab: 'foryou' | 'all' | 'saved'
  const [activeTab, setActiveTab] = useState<"foryou" | "all" | "saved">("all");

  // Search & Filter state
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [sortBy, setSortBy] = useState<"match" | "newest">("newest");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  // User state
  const [user, setUser] = useState<User | null>(null);
  const [isPro, setIsPro] = useState(false);
  const [isProDefinitive, setIsProDefinitive] = useState(false);
  const [candidate, setCandidate] = useState<CandidateProfile | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [savedJobIds, setSavedJobIds] = useState<string[]>([]);
  const [isPaywallOpen, setIsPaywallOpen] = useState(false);
  const [page, setPage] = useState(1);
  const JOBS_PER_PAGE = 25;

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
    if (qTab === "foryou" || qTab === "all" || qTab === "saved") {
      setActiveTab(qTab);
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

        if (u) {
          getUserPreferences(u.id).then((p) => {
            if (!cancelled) {
              setPreferences(p);
              const tabParam = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tab") : null;
              if (tabParam === "foryou" && p.onboardingCompleted) {
                setActiveTab("foryou");
              }
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
    // If authenticated user is still resolving Pro status, avoid fetching jobs with unverified Free mask prematurely
    if (user && !isPro && !isProDefinitive) {
      setLoadingJobs(true);
      return;
    }

    const isForYouTab = activeTab === "foryou";
    const effectiveSortBy = isForYouTab ? "match" : sortBy;
    const effectiveCandidate = (isForYouTab || sortBy === "match") ? candidate : null;
    const effectivePreferences = (isForYouTab || sortBy === "match") ? preferences : null;

    // Eliminate duplicate identical fetches when effect re-triggers from unrelated state updates
    const queryKey = JSON.stringify({
      tab: activeTab,
      category: selectedCategory,
      search: search.trim(),
      remoteOnly,
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
    }).then((res) => {
      if (queryKey === lastQueryKeyRef.current) {
        setLiveJobs(res.jobs);
        setTotalCount(res.totalCount);
        setLoadingJobs(false);
      }
    }).catch((err) => {
      console.warn("Failed to fetch live jobs:", err);
      if (queryKey === lastQueryKeyRef.current) {
        setLoadingJobs(false);
      }
    });
  }, [selectedCategory, search, remoteOnly, isPro, isProDefinitive, user, sortBy, activeTab, candidate, preferences]);

  const handleLoadMore = async () => {
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const isForYouTab = activeTab === "foryou";
      const effectiveSortBy = isForYouTab ? "match" : sortBy;
      const effectiveCandidate = (isForYouTab || sortBy === "match") ? candidate : null;
      const effectivePreferences = (isForYouTab || sortBy === "match") ? preferences : null;

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

  // Filtered Jobs (Server handles corpus-wide ranking and sorting)
  const filteredJobs = useMemo(() => {
    let result = liveJobs.slice();

    if (activeTab === "saved") {
      result = result.filter((job) => savedJobIds.includes(job.id));
    } else if (activeTab === "foryou") {
      if (!user) {
        result = [];
      } else if (preferences?.roles?.length || preferences?.categories?.length) {
        result = result.filter((job) => {
          const titleMatches = preferences.roles?.some((r) =>
            job.title.toLowerCase().includes(r.toLowerCase())
          );
          const categoryMatches = preferences.categories?.some((c) =>
            job.category?.toLowerCase().includes(c.toLowerCase())
          );
          return Boolean(titleMatches || categoryMatches);
        });
      }
    }

    return result;
  }, [liveJobs, activeTab, savedJobIds, preferences, user]);

  const displayedJobs = filteredJobs;

  const handleResetFilters = () => {
    setSearch("");
    setSelectedCategory("");
    setRemoteOnly(false);
    setActiveTab("all");
    setPage(1);
    setMobileFiltersOpen(false);
  };

  const handleSaveJob = async (job: LiveJob) => {
    if (!user) {
      toast.info("Please create a free account or sign in to save jobs to your tracker.");
      router.push(`/signup?next=${encodeURIComponent("/jobs")}`);
      return;
    }

    if (savedJobIds.includes(job.id)) {
      try {
        await removeApplicationFromTracker(job.id);
        setSavedJobIds((prev) => prev.filter((id) => id !== job.id));
        toast.info(`Removed "${job.title}" from your Applications Tracker.`);
      } catch (e) {
        toast.error("Could not remove application.");
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
      toast.success(`Saved "${job.title}" to your Applications Tracker.`);
    } catch (e) {
      toast.error("Could not save application.");
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

  const activeFiltersCount =
    (search.trim() ? 1 : 0) + (selectedCategory ? 1 : 0) + (remoteOnly ? 1 : 0);
  const hasActiveFilters = activeFiltersCount > 0;

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#09090B] flex flex-col font-sans">
      <GuideHeader />

      <main id="main-content" className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        {/* Top Header & Search Ribbon */}
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                Explore Open Roles
              </h1>
              <p className="text-xs text-slate-500 mt-0.5">
                Openings synced directly from verified company career portals.
              </p>
            </div>

            {/* Navigation Tabs: For you / All jobs / Saved */}
            <div className="flex items-center gap-1 p-1 rounded-tk-lg bg-slate-200/70 border border-slate-300/60 self-start sm:self-auto">
              {user && (
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab("foryou");
                    setPage(1);
                  }}
                  className={`px-3 py-1.5 rounded-tk-md text-xs font-bold transition cursor-pointer min-h-[36px] ${
                    activeTab === "foryou"
                      ? "bg-white text-blue-600 shadow-tk-xs"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  For you
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setActiveTab("all");
                  setSortBy("newest");
                  setPage(1);
                }}
                className={`px-3 py-1.5 rounded-tk-md text-xs font-bold transition cursor-pointer min-h-[36px] ${
                  activeTab === "all"
                    ? "bg-white text-blue-600 shadow-tk-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                All jobs
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab("saved");
                  setPage(1);
                }}
                className={`px-3 py-1.5 rounded-tk-md text-xs font-bold transition cursor-pointer flex items-center gap-1.5 min-h-[36px] ${
                  activeTab === "saved"
                    ? "bg-white text-blue-600 shadow-tk-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                <span>Saved</span>
                {savedJobIds.length > 0 && (
                  <span className="text-[10px] bg-slate-200 px-1.5 py-0.5 rounded-full font-bold">
                    {savedJobIds.length}
                  </span>
                )}
              </button>
            </div>
          </div>

          {/* Sticky Filter Bar on Scroll */}
          <div className="sticky top-[64px] z-tk-sticky bg-white/95 backdrop-blur-md rounded-tk-xl border border-slate-200/90 shadow-tk-xs p-3 sm:p-4 space-y-3 transition-shadow">
            {/* Desktop & Mobile Main Filter Row */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
              {/* Search Bar */}
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  aria-label="Search by job title, company, or keyword"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by job title, company, or keyword..."
                  className="w-full text-xs sm:text-sm pl-10 pr-9 py-2.5 rounded-tk-lg border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600/30 focus:border-blue-600 transition shadow-tk-xs min-h-[44px]"
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

              {/* Desktop Filters Group */}
              <div className="hidden sm:flex items-center gap-2.5">
                {/* Remote Only Toggle */}
                <button
                  type="button"
                  onClick={() => setRemoteOnly(!remoteOnly)}
                  aria-pressed={remoteOnly}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-tk-lg border text-xs font-bold transition cursor-pointer min-h-[44px] ${
                    remoteOnly
                      ? "bg-blue-50 border-blue-300 text-blue-700 shadow-tk-xs"
                      : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-slate-300"
                  }`}
                >
                  <MapPin className="w-3.5 h-3.5" />
                  <span>Remote Only</span>
                  {remoteOnly && <Check className="w-3 h-3 text-blue-600" />}
                </button>

                {/* Sort Dropdown */}
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-slate-500 font-medium">Sort:</span>
                  <select
                    aria-label="Sort by"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as any)}
                    className="text-xs font-bold py-2.5 px-3 rounded-tk-lg border border-slate-200 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-600/30 focus:border-blue-600 cursor-pointer shadow-tk-xs min-h-[44px]"
                  >
                    <option value="newest">Newest First</option>
                    {user && (
                      <option value="match" disabled={!hasConfirmedResume}>
                        {hasConfirmedResume ? "Highest Fit Match" : "Highest Match (Requires Resume)"}
                      </option>
                    )}
                  </select>
                </div>
              </div>

              {/* Mobile Filter Toggle Button */}
              <div className="flex sm:hidden items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setMobileFiltersOpen((prev) => !prev)}
                  aria-expanded={mobileFiltersOpen}
                  aria-label="Toggle filters sheet"
                  className={`flex-1 inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-tk-lg border text-xs font-bold transition cursor-pointer min-h-[44px] ${
                    mobileFiltersOpen || hasActiveFilters
                      ? "bg-blue-50 border-blue-300 text-blue-700 shadow-tk-xs"
                      : "bg-white border-slate-200 text-slate-800 hover:bg-slate-50"
                  }`}
                >
                  <SlidersHorizontal className="w-4 h-4 text-slate-500" />
                  <span>Filters</span>
                  {activeFiltersCount > 0 && (
                    <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[11px] font-bold flex items-center justify-center">
                      {activeFiltersCount}
                    </span>
                  )}
                </button>

                {/* Mobile Remote Quick Toggle */}
                <button
                  type="button"
                  onClick={() => setRemoteOnly(!remoteOnly)}
                  aria-pressed={remoteOnly}
                  className={`inline-flex items-center gap-1 px-3 py-2.5 rounded-tk-lg border text-xs font-bold transition cursor-pointer min-h-[44px] ${
                    remoteOnly
                      ? "bg-blue-50 border-blue-300 text-blue-700 shadow-tk-xs"
                      : "bg-white border-slate-200 text-slate-700"
                  }`}
                >
                  <MapPin className="w-3.5 h-3.5" />
                  <span>Remote</span>
                </button>
              </div>
            </div>

            {/* Mobile Collapsible Filter Sheet */}
            <AnimatePresence>
              {mobileFiltersOpen && (
                <motion.div
                  initial={shouldReduceMotion ? false : { height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={shouldReduceMotion ? undefined : { height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                  className="sm:hidden overflow-hidden border-t border-slate-200/80 pt-3 space-y-3"
                >
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-700">Sort results:</span>
                      <select
                        aria-label="Sort by"
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as any)}
                        className="text-xs font-bold py-2 px-3 rounded-tk-lg border border-slate-200 bg-white text-slate-800 focus:outline-none min-h-[44px]"
                      >
                        <option value="newest">Newest First</option>
                        {user && (
                          <option value="match" disabled={!hasConfirmedResume}>
                            {hasConfirmedResume ? "Highest Fit Match" : "Highest Match (Requires Resume)"}
                          </option>
                        )}
                      </select>
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
                        className="px-4 py-2 rounded-tk-lg bg-blue-600 text-white text-xs font-bold shadow-tk-xs min-h-[44px]"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Category Pill Bar */}
            <CategoryPillBar
              selectedCategory={selectedCategory}
              onSelectCategory={(cat) => setSelectedCategory(cat === selectedCategory ? "" : (cat || ""))}
            />

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

        {/* Results Count Banner */}
        <div className="flex items-center justify-between text-xs text-slate-500 pb-1 border-b border-slate-200">
          <span>
            {loadingJobs ? (
              <span>Loading active jobs…</span>
            ) : (
              <>
                Showing <strong className="text-slate-900 font-bold">{displayedJobs.length}</strong> of {totalCount > 0 ? `${totalCount.toLocaleString()} active jobs` : "active jobs"}
              </>
            )}
          </span>

          {user && !hasConfirmedResume && (
            <Link href="/resume" className="text-blue-600 hover:underline font-semibold">
              + Upload resume to unlock match percentages
            </Link>
          )}
        </div>

        {/* ========================================================================= */}
        {/* JOBS LIST OR SKELETON / EMPTY ZERO RESULTS                                */}
        {/* ========================================================================= */}
        {loadingJobs ? (
          /* SKELETON LOADING CARDS (Matches final card layout exactly - zero CLS) */
          <div className="space-y-3.5" data-testid="jobs-skeleton-list">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div
                key={i}
                className="bg-white rounded-tk-xl border border-slate-200/90 p-5 shadow-tk-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div className="flex items-start gap-4 min-w-0 flex-1">
                  <div className="w-12 h-12 rounded-tk-lg bg-slate-200/70 shrink-0 animate-pulse motion-reduce:animate-none" />
                  <div className="space-y-2.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="h-5 w-48 sm:w-64 bg-slate-200/80 rounded-tk-sm animate-pulse motion-reduce:animate-none" />
                      <div className="h-5 w-20 bg-slate-100 rounded-tk-sm animate-pulse motion-reduce:animate-none" />
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="h-4 w-28 bg-slate-100 rounded-tk-xs animate-pulse motion-reduce:animate-none" />
                      <div className="h-4 w-32 bg-slate-100 rounded-tk-xs animate-pulse motion-reduce:animate-none" />
                      <div className="h-4 w-24 bg-emerald-50 rounded-tk-xs animate-pulse motion-reduce:animate-none" />
                    </div>
                    <div className="h-3.5 w-80 max-w-full bg-slate-100/70 rounded-tk-xs animate-pulse motion-reduce:animate-none" />
                  </div>
                </div>

                <div className="flex items-center gap-2 self-start sm:self-auto shrink-0">
                  <div className="w-10 h-10 rounded-tk-lg bg-slate-100 animate-pulse motion-reduce:animate-none" />
                  <div className="w-28 h-10 rounded-tk-lg bg-slate-200/70 animate-pulse motion-reduce:animate-none" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredJobs.length === 0 ? (
          /* EMPTY STATE */
          <div className="bg-white rounded-tk-xl border border-slate-200/90 p-10 sm:p-14 text-center space-y-4 shadow-tk-xs">
            <div className="w-14 h-14 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center mx-auto border border-blue-100">
              <Search className="w-6 h-6" />
            </div>
            <div className="space-y-1.5 max-w-md mx-auto">
              <h3 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight">
                {activeTab === "foryou" && !user
                  ? "Sign in to view your tailored 'For you' jobs"
                  : activeTab === "foryou"
                  ? "No jobs match your specific role preferences yet"
                  : activeTab === "saved"
                  ? "You have not saved any jobs yet"
                  : Boolean(search || selectedCategory || remoteOnly)
                  ? "No jobs match your active filters"
                  : "No positions currently found"}
              </h3>
              <p className="text-xs sm:text-sm text-slate-500 leading-relaxed">
                {activeTab === "foryou" && !user
                  ? "Sign in with your account to get recommendations tailored to your profile and preferences."
                  : activeTab === "foryou"
                  ? "Try switching to 'All Jobs' or updating your preferred roles in Settings."
                  : activeTab === "saved"
                  ? "Click the bookmark icon on any job card to save it to your pipeline."
                  : Boolean(search || selectedCategory || remoteOnly)
                  ? "Try clearing your search terms or expanding your category preferences to see more openings."
                  : "Check back soon as new verified openings are added regularly."}
              </p>
            </div>
            <div className="pt-2">
              {activeTab === "foryou" && !user ? (
                <Link
                  href="/login?next=/jobs"
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-tk-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-tk-xs min-h-[44px]"
                >
                  <span>Sign In to View Matches</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              ) : activeTab === "foryou" ? (
                <button
                  type="button"
                  onClick={() => setActiveTab("all")}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-tk-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-tk-xs cursor-pointer min-h-[44px]"
                >
                  <span>View All Jobs</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              ) : Boolean(search || selectedCategory || remoteOnly) ? (
                <button
                  type="button"
                  onClick={handleResetFilters}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-tk-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-tk-xs cursor-pointer min-h-[44px]"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset All Filters</span>
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          /* CARD-BASED JOB RESULTS (Jobright-style with first-mount stagger entrance) */
          <div className="space-y-3.5">
            {displayedJobs.map((job, index) => {
              const isSaved = savedJobIds.includes(job.id);
              // Max 60ms stagger per card, capped at 300ms total
              const staggerDelay = Math.min(index * 0.03, 0.3);

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
                  className="bg-white rounded-tk-xl border border-slate-200/90 p-5 shadow-tk-xs hover:shadow-tk-md transition-all duration-200 motion-safe:hover:-translate-y-0.5 space-y-3 flex flex-col sm:flex-row sm:items-center justify-between gap-4 group relative"
                >
                  <div className="flex items-start gap-4 min-w-0 flex-1">
                    <CompanyLogo company={job.company} applyUrl={job.applyUrl} className="w-12 h-12 rounded-tk-lg shrink-0 object-contain p-1 border border-slate-100 bg-slate-50" />

                    <div className="space-y-1.5 flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
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

                        {isPro ? (
                          <MatchScoreBadge
                            job={{
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
                            }}
                            candidateProfile={candidate}
                            size="xs"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={handleLockedAction}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-50 border border-blue-200/60 text-blue-700 text-[11px] font-bold cursor-pointer hover:bg-blue-100 transition"
                            title={!user ? "Sign in to view match score" : "Unlock match score with Pro"}
                          >
                            <span className="filter blur-[4px] select-none font-mono">••% Match</span>
                            <Lock className="w-2.5 h-2.5 text-blue-600 shrink-0 ml-0.5" />
                          </button>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2.5 text-xs text-slate-600 font-medium">
                        <div
                          onClick={!isPro ? handleLockedAction : undefined}
                          className={`flex items-center gap-1 ${!isPro ? "cursor-pointer" : ""}`}
                          title={!isPro ? (!user ? "Sign in to see company" : "Unlock company with Pro") : undefined}
                        >
                          <Building className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span className={`font-bold text-slate-900 ${!isPro ? "filter blur-[4.5px] select-none" : ""}`}>
                            {job.company || "Verified Company"}
                          </span>
                          {!isPro && <Lock className="w-2.5 h-2.5 text-slate-400 shrink-0" />}
                        </div>

                        <span className="text-slate-300">•</span>

                        <div
                          onClick={!isPro ? handleLockedAction : undefined}
                          className={`flex items-center gap-1 ${!isPro ? "cursor-pointer" : ""}`}
                          title={!isPro ? (!user ? "Sign in to see location" : "Unlock location with Pro") : undefined}
                        >
                          <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span className={!isPro ? "filter blur-[4.5px] select-none text-slate-600" : ""}>
                            {job.location || (job.remote ? "Remote (Worldwide)" : "San Francisco, CA")}
                          </span>
                          {!isPro && <Lock className="w-2.5 h-2.5 text-slate-400 shrink-0" />}
                        </div>

                        {job.remote && (
                          <>
                            <span className="text-slate-300">•</span>
                            <div
                              onClick={!isPro ? handleLockedAction : undefined}
                              className={`flex items-center gap-1 ${!isPro ? "cursor-pointer" : ""}`}
                              title={!isPro ? (!user ? "Sign in to see remote scope" : "Unlock remote scope with Pro") : undefined}
                            >
                              <Globe className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              <span className={!isPro ? "filter blur-[4.5px] select-none text-slate-600" : ""}>
                                {job.remoteScope === "worldwide" ? "Worldwide Remote" : "Remote Eligible"}
                              </span>
                              {!isPro && <Lock className="w-2.5 h-2.5 text-slate-400 shrink-0" />}
                            </div>
                          </>
                        )}

                        {(Boolean(job.salary) || !isPro) && (
                          <>
                            <span className="text-slate-300">•</span>
                            <div
                              onClick={!isPro ? handleLockedAction : undefined}
                              className={`flex items-center gap-1 text-emerald-700 font-semibold ${!isPro ? "cursor-pointer" : ""}`}
                              title={!isPro ? (!user ? "Sign in to see compensation" : "Unlock compensation with Pro") : undefined}
                            >
                              <DollarSign className="w-3.5 h-3.5 shrink-0 text-emerald-600" />
                              <span className={!isPro ? "filter blur-[5px] select-none text-emerald-700" : ""}>
                                {job.salary || "••••••••••••••••"}
                              </span>
                              {!isPro && <Lock className="w-2.5 h-2.5 text-emerald-600/70 shrink-0" />}
                            </div>
                          </>
                        )}
                      </div>

                      {Boolean(job.description || !isPro) && (
                        <p
                          onClick={!isPro ? handleLockedAction : undefined}
                          className={`text-xs text-slate-500 line-clamp-1 mt-1 leading-relaxed ${
                            !isPro ? "filter blur-[4px] select-none cursor-pointer" : ""
                          }`}
                        >
                          {job.description || "We are seeking a talented professional to join our team for this verified role."}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Right Actions */}
                  <div className="flex items-center gap-2 self-start sm:self-auto shrink-0">
                    <button
                      type="button"
                      onClick={() => handleSaveJob(job)}
                      aria-label={isSaved ? "Remove from Tracker" : "Save to Tracker"}
                      className={`p-2.5 rounded-tk-lg border text-xs font-bold transition cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center ${
                        isSaved
                          ? "bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100"
                          : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                      }`}
                      title={isSaved ? "Saved - click to remove from Tracker" : "Save to Tracker"}
                    >
                      <BookmarkPlus className="w-4 h-4" />
                    </button>

                    {isPro ? (
                      <Link
                        href={`/job-detail?id=${encodeURIComponent(job.id)}`}
                        className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-tk-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-tk-xs min-h-[44px]"
                      >
                        <span>Inspect Job</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </Link>
                    ) : (
                      <button
                        type="button"
                        onClick={handleLockedAction}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-tk-lg bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-bold transition shadow-tk-xs border border-blue-200/70 cursor-pointer min-h-[44px]"
                      >
                        <Lock className="w-3.5 h-3.5 text-blue-600" />
                        <span>{!user ? "Sign In to Inspect" : "Unlock with Pro"}</span>
                      </button>
                    )}
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
                  className="px-6 py-3 rounded-tk-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-800 text-xs font-bold transition shadow-tk-xs cursor-pointer disabled:opacity-60 min-h-[44px]"
                >
                  {loadingMore
                    ? "Loading Positions..."
                    : `Load More Verified Positions (${Math.max(0, totalCount - liveJobs.length).toLocaleString()} remaining)`}
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Paywall Modal */}
      <PaywallModal
        open={isPaywallOpen}
        onOpenChange={setIsPaywallOpen}
        user={user}
        featureTitle="Unlock Verified Company Names & Direct ATS Apply"
      />

      <Footer />
    </div>
  );
}

function JobsPageFallback() {
  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#09090B] flex flex-col font-sans">
      <GuideHeader />

      <main id="main-content" className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                Explore Open Roles
              </h1>
              <p className="text-xs text-slate-500 mt-0.5">
                Openings synced directly from verified company career portals.
              </p>
            </div>

            <div className="flex items-center gap-1 p-1 rounded-tk-lg bg-slate-200/70 border border-slate-300/60 self-start sm:self-auto">
              <button
                type="button"
                className="px-3 py-1.5 rounded-tk-md text-xs font-bold transition cursor-pointer bg-white text-blue-600 shadow-tk-xs min-h-[36px]"
              >
                All jobs
              </button>
              <button
                type="button"
                className="px-3 py-1.5 rounded-tk-md text-xs font-bold transition cursor-pointer flex items-center gap-1 text-slate-600 hover:text-slate-900 min-h-[36px]"
              >
                <span>Saved</span>
              </button>
            </div>
          </div>

          <div className="rounded-tk-xl border border-slate-200/90 shadow-tk-xs p-3 sm:p-4 bg-white space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  aria-label="Search by job title, company, or keyword"
                  defaultValue=""
                  placeholder="Search by job title, company, or keyword..."
                  className="w-full text-xs sm:text-sm pl-10 pr-4 py-2.5 rounded-tk-lg border border-slate-300 bg-white min-h-[44px]"
                  readOnly
                />
              </div>

              <div className="hidden sm:flex items-center gap-2.5">
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-tk-lg border text-xs font-bold transition cursor-pointer bg-white border-slate-200 text-slate-700 min-h-[44px]"
                >
                  <MapPin className="w-3.5 h-3.5" />
                  <span>Remote Only</span>
                </button>

                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-slate-500 font-medium">Sort:</span>
                  <select
                    aria-label="Sort by"
                    defaultValue="newest"
                    className="text-xs font-bold py-2.5 px-3 rounded-tk-lg border border-slate-200 bg-white text-slate-800 min-h-[44px]"
                    disabled
                  >
                    <option value="newest">Newest First</option>
                  </select>
                </div>
              </div>
            </div>

            <CategoryPillBar
              selectedCategory=""
              onSelectCategory={() => {}}
            />
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-slate-500 pb-1 border-b border-slate-200">
          <span>Loading active jobs…</span>
        </div>

        {/* Skeleton matches layout exactly */}
        <div className="space-y-3.5" data-testid="jobs-skeleton-list">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="bg-white rounded-tk-xl border border-slate-200/90 p-5 shadow-tk-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
              <div className="flex items-start gap-4 min-w-0 flex-1">
                <div className="w-12 h-12 rounded-tk-lg bg-slate-200/70 shrink-0" />
                <div className="space-y-2.5 flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="h-5 w-48 bg-slate-200/80 rounded-tk-sm" />
                    <div className="h-5 w-20 bg-slate-100 rounded-tk-sm" />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="h-4 w-28 bg-slate-100 rounded-tk-xs" />
                    <div className="h-4 w-32 bg-slate-100 rounded-tk-xs" />
                    <div className="h-4 w-24 bg-emerald-50 rounded-tk-xs" />
                  </div>
                  <div className="h-3.5 w-72 max-w-full bg-slate-100/70 rounded-tk-xs" />
                </div>
              </div>
              <div className="flex items-center gap-2 self-start sm:self-auto shrink-0">
                <div className="w-10 h-10 rounded-tk-lg bg-slate-100" />
                <div className="w-28 h-10 rounded-tk-lg bg-slate-200/70" />
              </div>
            </div>
          ))}
        </div>
      </main>

      <Footer />
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
