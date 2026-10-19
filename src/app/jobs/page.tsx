"use client";

import React, { useState, useMemo, useEffect, useRef, Suspense } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
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
  Globe
} from "lucide-react";
import CompanyLogo from "@/components/CompanyLogo";
import { toast } from "react-toastify";

const PaywallModal = dynamic(() => import("@/components/PaywallModal"), { ssr: false });
const MatchScoreBadge = dynamic(() => import("@/components/matcher/MatchScoreBadge"), { ssr: false });
const Footer = dynamic(() => import("@/components/Footer"), { ssr: false });

function JobsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL Query Params
  const querySearch = searchParams.get("search") || "";
  const queryCategory = searchParams.get("category") || searchParams.get("categories") || "";
  const queryRemote = searchParams.get("remote") === "true";

  // Active Tab: 'foryou' | 'all' | 'saved'
  const [activeTab, setActiveTab] = useState<"foryou" | "all" | "saved">("all");

  // Search & Filter state
  const [search, setSearch] = useState(querySearch);
  const [selectedCategory, setSelectedCategory] = useState(queryCategory);
  const [remoteOnly, setRemoteOnly] = useState(queryRemote);
  const [sortBy, setSortBy] = useState<"match" | "newest">("newest");

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
              if (searchParams.get("tab") === "foryou" && p.onboardingCompleted) {
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

    // Eliminate duplicate identical fetches when effect re-triggers from unrelated state updates (e.g. isProDefinitive resolving for guests)
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

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#09090B] flex flex-col">
      <GuideHeader />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        {/* Top Header & Search Ribbon */}
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                Explore Open Roles
              </h1>
              <p className="text-xs text-slate-500">
                Openings synced directly from verified company career portals.
              </p>
            </div>

            {/* Navigation Tabs: For you / All jobs / Saved */}
            <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-200/70 border border-slate-300/60 self-start sm:self-auto">
              {user && (
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab("foryou");
                    setPage(1);
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                    activeTab === "foryou"
                      ? "bg-white text-blue-600 shadow-2xs"
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
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  activeTab === "all"
                    ? "bg-white text-blue-600 shadow-2xs"
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
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer flex items-center gap-1 ${
                  activeTab === "saved"
                    ? "bg-white text-blue-600 shadow-2xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                <span>Saved</span>
                {savedJobIds.length > 0 && (
                  <span className="text-[10px] bg-slate-200 px-1.5 py-0.2 rounded-full">
                    {savedJobIds.length}
                  </span>
                )}
              </button>
            </div>
          </div>

          {/* Search Bar & Secondary Controls */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="Search by job title, company, or keyword"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by job title, company, or keyword..."
                className="w-full text-xs sm:text-sm pl-10 pr-4 py-2.5 rounded-xl border border-slate-300 bg-white focus:outline-blue-600 shadow-2xs"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-700"
                >
                  Clear
                </button>
              )}
            </div>

            {/* Remote Only Toggle */}
            <button
              type="button"
              onClick={() => setRemoteOnly(!remoteOnly)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border text-xs font-bold transition cursor-pointer ${
                remoteOnly
                  ? "bg-blue-50 border-blue-300 text-blue-700"
                  : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
              }`}
            >
              <MapPin className="w-3.5 h-3.5" />
              <span>Remote Only</span>
            </button>

            {/* Sort Dropdown */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500 font-medium">Sort:</span>
              <select
                aria-label="Sort by"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="text-xs font-bold py-2 px-3 rounded-xl border border-slate-200 bg-white text-slate-800 focus:outline-blue-600 cursor-pointer shadow-2xs"
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

          {/* Category Pill Bar */}
          <CategoryPillBar
            selectedCategory={selectedCategory}
            onSelectCategory={(cat) => setSelectedCategory(cat === selectedCategory ? "" : (cat || ""))}
          />
        </div>

        {/* Results Count Banner */}
        <div className="flex items-center justify-between text-xs text-slate-500 pb-1 border-b border-slate-200">
          <span>
            {loadingJobs ? (
              <span>Loading active jobs…</span>
            ) : (
              <>
                Showing <strong className="text-slate-900">{displayedJobs.length}</strong> of {totalCount > 0 ? `${totalCount.toLocaleString()} active jobs` : "active jobs"}
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
        {/* JOBS LIST OR EMPTY ZERO RESULTS                                           */}
        {/* ========================================================================= */}
        {loadingJobs ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="bg-white rounded-2xl border border-slate-200 p-5 shadow-2xs animate-pulse space-y-3">
                <div className="h-5 bg-slate-200 rounded w-1/3" />
                <div className="h-4 bg-slate-100 rounded w-1/2" />
              </div>
            ))}
          </div>
        ) : filteredJobs.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center space-y-4 shadow-2xs">
            <div className="w-12 h-12 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
              <Search className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-bold text-slate-900">
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
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
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
            {activeTab === "foryou" && !user ? (
              <Link
                href="/login?next=/jobs"
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-xs"
              >
                <span>Sign In to View Matches</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            ) : activeTab === "foryou" ? (
              <button
                type="button"
                onClick={() => setActiveTab("all")}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-xs cursor-pointer"
              >
                <span>View All Jobs</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            ) : Boolean(search || selectedCategory || remoteOnly) ? (
              <button
                type="button"
                onClick={handleResetFilters}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-xs cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset All Filters</span>
              </button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            {displayedJobs.map((job) => {
              const isSaved = savedJobIds.includes(job.id);
              return (
                <div
                  key={job.id}
                  className="bg-white rounded-2xl border border-slate-200 p-5 shadow-2xs hover:shadow-md transition space-y-3 flex flex-col sm:flex-row sm:items-center justify-between gap-4 group"
                >
                  <div className="flex items-start gap-3.5 min-w-0 flex-1">
                    <CompanyLogo company={job.company} applyUrl={job.applyUrl} className="w-11 h-11 shrink-0" />

                    <div className="space-y-1.5 flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {isPro ? (
                          <Link
                            href={`/jobs/detail?id=${encodeURIComponent(job.id)}`}
                            className="text-base sm:text-lg font-bold text-slate-900 hover:text-blue-600 transition-colors break-words"
                          >
                            {job.title}
                          </Link>
                        ) : (
                          <button
                            type="button"
                            onClick={handleLockedAction}
                            className="text-base sm:text-lg font-bold text-slate-900 hover:text-blue-600 transition-colors break-words text-left cursor-pointer"
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

                      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600 font-medium">
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

                        <span>•</span>

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
                            <span>•</span>
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
                            <span>•</span>
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
                          className={`text-xs text-slate-500 line-clamp-1 mt-1 ${
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
                      className={`p-2 rounded-xl border text-xs font-bold transition cursor-pointer ${
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
                        href={`/jobs/detail?id=${encodeURIComponent(job.id)}`}
                        className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-xs"
                      >
                        <span>Inspect Job</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </Link>
                    ) : (
                      <button
                        type="button"
                        onClick={handleLockedAction}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-bold transition shadow-2xs border border-blue-200/70 cursor-pointer"
                      >
                        <Lock className="w-3.5 h-3.5 text-blue-600" />
                        <span>{!user ? "Sign In to Inspect" : "Unlock with Pro"}</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Load More Pagination */}
            {liveJobs.length < totalCount && (
              <div className="pt-4 text-center">
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="px-6 py-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-800 text-xs font-bold transition shadow-2xs cursor-pointer disabled:opacity-60"
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
    <div className="min-h-screen bg-[#F8FAFC] text-[#09090B] flex flex-col">
      <GuideHeader />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        {/* Top Header & Search Ribbon */}
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                Explore Open Roles
              </h1>
              <p className="text-xs text-slate-500">
                Openings synced directly from verified company career portals.
              </p>
            </div>

            {/* Navigation Tabs: For you / All jobs / Saved */}
            <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-200/70 border border-slate-300/60 self-start sm:self-auto">
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer bg-white text-blue-600 shadow-2xs"
              >
                All jobs
              </button>
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer flex items-center gap-1 text-slate-600 hover:text-slate-900"
              >
                <span>Saved</span>
              </button>
            </div>
          </div>

          {/* Search Bar & Secondary Controls */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="Search by job title, company, or keyword"
                defaultValue=""
                placeholder="Search by job title, company, or keyword..."
                className="w-full text-xs sm:text-sm pl-10 pr-4 py-2.5 rounded-xl border border-slate-300 bg-white focus:outline-blue-600 shadow-2xs"
                readOnly
              />
            </div>

            {/* Remote Only Toggle */}
            <button
              type="button"
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border text-xs font-bold transition cursor-pointer bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
            >
              <MapPin className="w-3.5 h-3.5" />
              <span>Remote Only</span>
            </button>

            {/* Sort Dropdown */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500 font-medium">Sort:</span>
              <select
                aria-label="Sort by"
                defaultValue="newest"
                className="text-xs font-bold py-2 px-3 rounded-xl border border-slate-200 bg-white text-slate-800 focus:outline-blue-600 cursor-pointer shadow-2xs"
                disabled
              >
                <option value="newest">Newest First</option>
              </select>
            </div>
          </div>

          {/* Category Pill Bar */}
          <CategoryPillBar
            selectedCategory=""
            onSelectCategory={() => {}}
          />
        </div>

        {/* Results Count Banner */}
        <div className="flex items-center justify-between text-xs text-slate-500 pb-1 border-b border-slate-200">
          <span>
            <span>Loading active jobs…</span>
          </span>
        </div>

        {/* JOBS LIST SKELETON */}
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="bg-white rounded-2xl border border-slate-200 p-5 shadow-2xs animate-pulse space-y-3">
              <div className="h-5 bg-slate-200 rounded w-1/3" />
              <div className="h-4 bg-slate-100 rounded w-1/2" />
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

