"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import CompanyLogo from "@/components/CompanyLogo";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getLiveJobById, LiveJob, getJobRemoteEligibility } from "@/lib/jobs/service";
import { getAuthUser } from "@/lib/auth/session";
import { getCandidateProfile } from "@/lib/resume/storage";
import { CandidateProfile } from "@/lib/resume/types";
import { computeFitDiagnostics, FitDiagnosticsResult } from "@/lib/matcher/scoring";
import { addApplicationToTracker, getTrackedApplications, removeApplicationFromTracker } from "@/lib/tracker/storage";
import { getProAccessStatus } from "@/lib/billing/subscription";
import { sanitizeExternalUrl, stripHtmlAndExecutableMarkup } from "@/lib/security/xss";
import dynamic from "next/dynamic";
import PaywallModal from "@/components/PaywallModal";
import ProUpgradeScreen from "@/components/billing/ProUpgradeScreen";

const CoverLetterModal = dynamic(() => import("@/components/resume/CoverLetterModal"), { ssr: false });
const TailorResumeModal = dynamic(() => import("@/components/resume/TailorResumeModal"), { ssr: false });
const FitDiagnosticsModal = dynamic(() => import("@/components/matcher/FitDiagnosticsModal"), { ssr: false });
import type { User } from "@supabase/supabase-js";
import {
  ArrowLeft,
  Building,
  MapPin,
  Calendar,
  DollarSign,
  Briefcase,
  Globe,
  ExternalLink,
  ShieldCheck,
  CheckCircle2,
  Lock,
  BookmarkPlus,
  FileText,
  Sparkles,
  AlertCircle,
  ChevronRight,
  ArrowRight,
} from "lucide-react";
import { toast } from "react-toastify";

function getResolvedJobId(): string {
  if (typeof window !== "undefined") {
    const urlParams = new URLSearchParams(window.location.search);
    const winId = urlParams.get("id") || urlParams.get("jobId");
    if (winId && winId.trim()) return winId.trim();

    const pathname = window.location.pathname;
    const match = pathname.match(/^\/jobs\/([^/?#]+)/);
    if (match && match[1] && match[1] !== "detail") {
      return decodeURIComponent(match[1]).trim();
    }
  }

  return "";
}

function formatPostedDateLabel(dateStr?: string, postedAt?: string): string {
  if (dateStr && dateStr.trim()) return dateStr.trim();
  if (postedAt) {
    const parsed = new Date(postedAt);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
  }
  return "Recently verified";
}

/**
 * Full-layout skeleton matching the final 2-column desktop + mobile sticky CTA layout
 * to prevent Cumulative Layout Shift (CLS) while auth, entitlement, and job data resolve.
 */
function JobDetailSkeleton() {
  return (
    <div className="min-h-screen bg-surface-subtle text-ink flex flex-col">
      <GuideHeader />
      <main
        id="main-content"
        className="flex-1 max-w-container w-full mx-auto px-4 sm:px-6 lg:px-8 py-tk-3 sm:py-tk-4 pb-28 lg:pb-tk-6"
      >
        <div
          role="status"
          aria-label="Loading job details"
          data-testid="job-detail-skeleton"
          className="space-y-tk-3"
        >
          {/* Top breadcrumb bar skeleton */}
          <div className="flex items-center justify-between min-h-[44px]">
            <Skeleton shape="text" className="h-5 w-36 rounded-tk-sm" />
            <Skeleton shape="text" className="h-5 w-28 rounded-tk-sm" />
          </div>

          {/* 2-Column Jobright-style layout skeleton */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-tk-3 lg:gap-tk-4 items-start">
            {/* Left column (8 cols) */}
            <div className="lg:col-span-8 space-y-tk-3">
              {/* Header + Meta Block card skeleton */}
              <Card variant="surface" className="p-tk-3 sm:p-tk-4 space-y-tk-3">
                <div className="flex items-start gap-tk-2">
                  <Skeleton className="w-14 h-14 rounded-tk-lg shrink-0" />
                  <div className="flex-1 space-y-tk-1.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-tk-1">
                      <Skeleton className="h-6 w-24 rounded-tk-full" />
                      <Skeleton className="h-6 w-36 rounded-tk-full" />
                    </div>
                    <Skeleton className="h-8 sm:h-9 w-4/5 rounded-tk-md" />
                    <Skeleton className="h-5 w-48 rounded-tk-sm" />
                  </div>
                </div>

                {/* Scannable 4-item Meta Block skeleton */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-tk-1.5 sm:gap-tk-2 pt-tk-2 border-t border-line">
                  {[0, 1, 2, 3].map((idx) => (
                    <div
                      key={idx}
                      className="rounded-tk-lg bg-surface-subtle border border-line p-tk-1.5 space-y-1.5"
                    >
                      <Skeleton shape="text" className="h-3 w-16" />
                      <Skeleton shape="text" className="h-4 w-24" />
                    </div>
                  ))}
                </div>
              </Card>

              {/* Match & Skill Analysis card skeleton */}
              <Card variant="surface" className="p-tk-3 sm:p-tk-4 space-y-tk-3">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-6 w-48 rounded-tk-sm" />
                  <Skeleton className="h-6 w-24 rounded-tk-full" />
                </div>
                <div className="p-tk-2 rounded-tk-xl bg-surface-subtle border border-line flex items-center justify-between gap-tk-2">
                  <div className="flex items-center gap-tk-2 flex-1">
                    <Skeleton className="w-14 h-14 rounded-tk-xl shrink-0" />
                    <div className="space-y-2 flex-1">
                      <Skeleton shape="text" className="h-4 w-36" />
                      <Skeleton shape="text" className="h-3.5 w-64 max-w-full" />
                    </div>
                  </div>
                  <Skeleton className="h-11 w-40 rounded-tk-lg hidden sm:block" />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-tk-2">
                  <Skeleton className="h-28 w-full rounded-tk-lg" />
                  <Skeleton className="h-28 w-full rounded-tk-lg" />
                </div>
              </Card>

              {/* Role Overview card skeleton */}
              <Card variant="surface" className="p-tk-3 sm:p-tk-4 space-y-tk-3">
                <Skeleton className="h-6 w-40 rounded-tk-sm" />
                <Skeleton className="h-24 w-full rounded-tk-lg" />
                <div className="space-y-2.5 max-w-[70ch]">
                  <Skeleton shape="text" className="h-4 w-full" />
                  <Skeleton shape="text" className="h-4 w-11/12" />
                  <Skeleton shape="text" className="h-4 w-4/5" />
                  <Skeleton shape="text" className="h-4 w-full" />
                  <Skeleton shape="text" className="h-4 w-3/4" />
                </div>
              </Card>
            </div>

            {/* Right column: Sticky Apply CTA skeleton (4 cols) */}
            <aside className="hidden lg:block lg:col-span-4 lg:sticky lg:top-[84px]">
              <Card variant="elevated" className="p-tk-3 space-y-tk-2">
                <Skeleton shape="text" className="h-5 w-3/4" />
                <Skeleton shape="text" className="h-4 w-1/2" />
                <Skeleton className="h-11 w-full rounded-tk-lg" />
                <Skeleton className="h-11 w-full rounded-tk-lg" />
                <div className="pt-tk-2 border-t border-line space-y-tk-1">
                  <Skeleton shape="text" className="h-3 w-28" />
                  <Skeleton className="h-11 w-full rounded-tk-lg" />
                  <Skeleton className="h-11 w-full rounded-tk-lg" />
                </div>
              </Card>
            </aside>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function JobDetailInner() {
  const router = useRouter();
  const shouldReduceMotion = useReducedMotion();

  const [user, setUser] = useState<User | null>(null);
  const [isPro, setIsPro] = useState(false);
  const [isProDefinitive, setIsProDefinitive] = useState(false);
  const [candidate, setCandidate] = useState<CandidateProfile | null>(null);
  const [job, setJob] = useState<LiveJob | null>(null);
  const [loading, setLoading] = useState(true);

  // Modals & States
  const [isPaywallOpen, setIsPaywallOpen] = useState(false);
  const [isCoverLetterOpen, setIsCoverLetterOpen] = useState(false);
  const [isTailorResumeOpen, setIsTailorResumeOpen] = useState(false);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [showApplyConfirmModal, setShowApplyConfirmModal] = useState(false);
  const [isSavedInTracker, setIsSavedInTracker] = useState(false);

  const urlJobId =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("id") ||
        new URLSearchParams(window.location.search).get("jobId") ||
        ""
      : "";

  useEffect(() => {
    const resolvedId = getResolvedJobId();

    // 1. Load server-verified Pro status and user
    getProAccessStatus().then((subRes) => {
      const activePro = subRes.isPro;
      setIsPro(activePro);
      setIsProDefinitive(Boolean(subRes.isDefinitive));

      getAuthUser().then((u) => {
        setUser(u);
        if (resolvedId) {
          getLiveJobById(resolvedId, activePro).then((foundJob) => {
            setJob(foundJob);
            setLoading(false);
          });
        } else {
          setLoading(false);
        }
      });
    });

    getCandidateProfile().then((cp) => {
      if (cp && cp.confirmedAt) {
        setCandidate(cp);
      } else {
        setCandidate(null);
      }
    });

    // 3. Check if already tracked
    if (resolvedId) {
      getTrackedApplications().then((apps) => {
        const tracked = apps.some((a) => a.jobId === resolvedId);
        setIsSavedInTracker(tracked);
      });
    }
  }, [urlJobId]);

  if (loading || (user && !isPro && !isProDefinitive)) {
    return <JobDetailSkeleton />;
  }

  const entranceMotionProps = shouldReduceMotion
    ? { initial: false as const, animate: { opacity: 1, y: 0 }, transition: { duration: 0.01 } }
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.25, ease: [0.22, 1, 0.36, 1] as const },
      };

  // Tier 1: Signed-out visitor
  if (!user) {
    const returnUrl =
      typeof window !== "undefined"
        ? window.location.pathname + window.location.search
        : `/job-detail?id=${job?.id || ""}`;
    return (
      <div className="min-h-screen bg-surface-subtle text-ink flex flex-col">
        <GuideHeader />
        <main
          id="main-content"
          className="flex-1 max-w-lg w-full mx-auto px-4 py-tk-6 flex flex-col items-center justify-center"
        >
          <motion.div
            {...entranceMotionProps}
            data-testid="guest-signin-wall"
            className="w-full bg-surface rounded-tk-2xl border border-line p-tk-4 shadow-tk-md text-center space-y-tk-2"
          >
            <div className="w-14 h-14 rounded-tk-xl bg-brand-50 text-brand-600 flex items-center justify-center border border-brand-200 shadow-tk-xs mx-auto">
              <Lock className="w-7 h-7" />
            </div>
            <div className="space-y-tk-1">
              <h1 className="text-[18px] font-bold uppercase tracking-wider text-ink">
                Sign in to view job details
              </h1>
              <p className="text-tk-body-sm text-ink-muted max-w-sm mx-auto">
                Sign in to unlock full role descriptions, company info, salary ranges, and match scores.
              </p>
            </div>
            <div className="pt-tk-1">
              <Link
                href={`/login?next=${encodeURIComponent(returnUrl)}`}
                className="inline-flex items-center justify-center gap-2 px-tk-3 min-h-[44px] rounded-tk-lg bg-brand-600 text-ink-inverse font-semibold text-tk-body-sm shadow-tk-sm hover:bg-brand-700 transition duration-tk-fast ease-tk-standard focus-visible:outline-none focus-visible:shadow-tk-focus"
              >
                <span>Sign In to Continue</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </motion.div>
        </main>
        <Footer />
      </div>
    );
  }

  // Tier 2: Signed-in non-Pro member (Definitively confirmed by server)
  if (!isPro) {
    return (
      <div className="min-h-screen bg-surface-subtle text-ink flex flex-col">
        <GuideHeader />
        <main id="main-content" className="flex-1 max-w-4xl w-full mx-auto px-4 py-tk-4">
          <motion.div {...entranceMotionProps} data-testid="free-user-pro-wall">
            <ProUpgradeScreen
              title="Unlock Full Job Details"
              subtitle="Upgrade to CareerMonke Pro to see verified company names, compensation, direct ATS apply links, and compatibility scores."
            />
          </motion.div>
        </main>
        <Footer />
      </div>
    );
  }

  // Not found or closed job state (for Pro user)
  if (!job) {
    return (
      <div className="min-h-screen bg-surface-subtle text-ink flex flex-col">
        <GuideHeader />
        <main
          id="main-content"
          className="flex-1 max-w-3xl w-full mx-auto px-4 py-tk-6 flex items-center justify-center"
        >
          <motion.div
            {...entranceMotionProps}
            className="w-full bg-surface rounded-tk-2xl border border-line p-tk-4 shadow-tk-sm text-center space-y-tk-2"
          >
            <div className="w-16 h-16 rounded-tk-xl bg-warning-50 text-warning-700 flex items-center justify-center mx-auto border border-warning-100">
              <AlertCircle className="w-8 h-8" />
            </div>
            <h1 className="text-[18px] font-bold uppercase tracking-wider text-ink">Job Opening Not Found</h1>
            <p className="text-tk-body-sm text-ink-muted max-w-md mx-auto">
              This opening may have been unlisted or closed by the employer.
            </p>
            <div className="pt-tk-1">
              <Link
                href="/jobs"
                className="inline-flex items-center justify-center gap-2 px-tk-3 min-h-[44px] rounded-tk-lg bg-brand-600 text-ink-inverse font-semibold text-tk-body-sm shadow-tk-sm hover:bg-brand-700 transition duration-tk-fast ease-tk-standard"
              >
                <span>Browse Active Verified Jobs</span>
                <ArrowLeft className="w-4 h-4 rotate-180" />
              </Link>
            </div>
          </motion.div>
        </main>
        <Footer />
      </div>
    );
  }

  const diagnostics: FitDiagnosticsResult | null = candidate
    ? computeFitDiagnostics(candidate, {
        id: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        remote_scope: job.remoteScope || (job.remote ? "worldwide" : undefined),
        category: job.category,
        skills: job.skills,
        description: job.description,
        salary_text: job.salary,
      })
    : null;

  const postedDateLabel = formatPostedDateLabel(job.date, job.postedAt);

  const handleApplyClick = () => {
    if (!isPro) {
      setIsPaywallOpen(true);
      return;
    }

    // Open employer ATS in new tab (strictly http/https/mailto only)
    const safeApplyUrl = sanitizeExternalUrl(job.applyUrl);
    if (safeApplyUrl) {
      window.open(safeApplyUrl, "_blank", "noopener,noreferrer");
      // Prompt user with confirmation modal
      setShowApplyConfirmModal(true);
    }
  };

  const handleConfirmApplication = async (status: "applied" | "saved") => {
    setShowApplyConfirmModal(false);
    try {
      await addApplicationToTracker({
        jobId: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        salaryText: job.salary,
        applyUrl: sanitizeExternalUrl(job.applyUrl) || undefined,
        stage: status,
        appliedAt: status === "applied" ? new Date().toISOString() : undefined,
      });
      setIsSavedInTracker(true);
      if (status === "applied") {
        toast.success(`Application confirmed! Moved "${job.title}" to Applied stage.`);
      } else {
        toast.info(`Saved "${job.title}" to your Applications pipeline.`);
      }
    } catch (e) {
      toast.error("Could not update tracker.");
    }
  };

  const handleSaveOnly = async () => {
    if (!user) {
      toast.info("Please sign up or sign in to save jobs to your tracker.");
      const currentUrl =
        typeof window !== "undefined"
          ? window.location.pathname + window.location.search
          : `/job-detail?id=${job.id}`;
      router.push(`/signup?next=${encodeURIComponent(currentUrl)}`);
      return;
    }

    if (isSavedInTracker) {
      try {
        await removeApplicationFromTracker(job.id);
        setIsSavedInTracker(false);
        toast.info(`Removed "${job.title}" from Applications.`);
      } catch (e) {
        toast.error("Could not remove from tracker.");
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
      setIsSavedInTracker(true);
      toast.success(`Saved "${job.title}" to Applications.`);
    } catch (e) {
      toast.error("Could not save to tracker.");
    }
  };

  const handleTailorResumeClick = () => {
    if (!candidate) {
      toast.info("Please upload your resume first to view ATS skill highlighting for this job.");
      router.push("/resume");
      return;
    }
    setIsTailorResumeOpen(true);
  };

  const handleCoverLetterClick = () => {
    if (!candidate) {
      toast.info("Please upload your resume first to generate tailored cover letters.");
      router.push("/resume");
      return;
    }
    setIsCoverLetterOpen(true);
  };

  const remoteElig = getJobRemoteEligibility(job);

  return (
    <div className="min-h-screen bg-surface-subtle text-ink flex flex-col">
      <GuideHeader />

      <main
        id="main-content"
        className="flex-1 max-w-container w-full mx-auto px-4 sm:px-6 lg:px-8 py-tk-3 sm:py-tk-4 pb-28 lg:pb-tk-6"
      >
        <motion.div {...entranceMotionProps} className="space-y-tk-3">
          {/* Top Breadcrumb & Source Verification Bar */}
          <div className="flex flex-wrap items-center justify-between gap-tk-1">
            <Link
              href="/jobs"
              className="inline-flex items-center gap-1.5 min-h-[44px] px-tk-1 -ml-tk-1 rounded-tk-md text-tk-body-sm font-semibold text-ink-muted hover:text-ink transition-colors duration-tk-fast focus-visible:outline-none focus-visible:shadow-tk-focus"
            >
              <ArrowLeft className="w-4 h-4 shrink-0" />
              <span>Back to All Jobs</span>
            </Link>

            <div className="flex items-center gap-tk-1.5">
              <Badge tone="neutral" size="md">
                <ShieldCheck className="w-3.5 h-3.5 text-brand-600 shrink-0" />
                <span>Verified Direct Feed</span>
              </Badge>
              <span className="text-tk-caption font-semibold text-ink-subtle">
                Job ID: {job.id.slice(0, 8)}
              </span>
            </div>
          </div>

          {/* ========================================================================= */}
          {/* 2-COLUMN JOBRIGHT-STYLE SCANNABLE LAYOUT                                  */}
          {/* ========================================================================= */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-tk-3 lg:gap-tk-4 items-start">
            {/* LEFT COLUMN: Header + Meta Block, Match Analysis, Role Description */}
            <div className="lg:col-span-8 space-y-tk-3 min-w-0">
              {/* 1. HEADER & SCANNABLE META BLOCK CARD */}
              <Card variant="surface" className="p-tk-3 sm:p-tk-4 space-y-tk-3">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-tk-2">
                  <div className="flex items-start gap-tk-2 flex-1 min-w-0">
                    <CompanyLogo
                      company={job.company}
                      applyUrl={job.applyUrl}
                      className="w-14 h-14 rounded-tk-lg shrink-0 object-contain p-1.5 border border-line bg-surface-subtle"
                    />

                    <div className="space-y-tk-1 flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone="brand" size="md" className="uppercase tracking-wider">
                          {job.category || "Engineering"}
                        </Badge>
                        {remoteElig === "worldwide" && (
                          <Badge tone="success" size="md" dot>
                            Worldwide Remote Eligible
                          </Badge>
                        )}
                        {remoteElig === "country_restricted" && (
                          <Badge tone="warning" size="md" dot>
                            Remote ({job.location || "Geographically Restricted"})
                          </Badge>
                        )}
                        {remoteElig !== "worldwide" && remoteElig !== "country_restricted" && job.remote && (
                          <Badge tone="neutral" size="md">
                            Remote (Eligibility Unknown)
                          </Badge>
                        )}
                      </div>

                      <h1 className="text-[22px] font-bold text-ink tracking-tight break-words">
                        {job.title}
                      </h1>

                      <div className="flex flex-wrap items-center gap-2 text-tk-body-sm text-ink-muted">
                        <span className="inline-flex items-center gap-1.5 font-bold text-ink">
                          <Building className="w-4 h-4 text-ink-subtle shrink-0" />
                          <span>{job.company}</span>
                        </span>
                        <span aria-hidden="true" className="text-ink-subtle">•</span>
                        <span className="text-tk-caption text-ink-subtle">Official career portal</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* SCANNABLE META BLOCK: Location, Type, Posted Date, Salary (when visible) */}
                <div
                  data-testid="job-meta-block"
                  className={`grid grid-cols-2 ${
                    job.salary ? "sm:grid-cols-4" : "sm:grid-cols-3"
                  } gap-tk-1.5 sm:gap-tk-2 pt-tk-2 border-t border-line`}
                >
                  <div className="rounded-tk-lg bg-surface-subtle border border-line p-tk-1.5 space-y-0.5 min-w-0">
                    <div className="flex items-center gap-1 text-tk-caption font-semibold text-ink-subtle">
                      <MapPin className="w-3.5 h-3.5 shrink-0" />
                      <span>Location</span>
                    </div>
                    <p className="text-tk-body-sm font-bold text-ink truncate" title={job.location || "Remote / Global"}>
                      {job.location || "Remote / Global"}
                    </p>
                  </div>

                  <div className="rounded-tk-lg bg-surface-subtle border border-line p-tk-1.5 space-y-0.5 min-w-0">
                    <div className="flex items-center gap-1 text-tk-caption font-semibold text-ink-subtle">
                      <Briefcase className="w-3.5 h-3.5 shrink-0" />
                      <span>Employment Type</span>
                    </div>
                    <p className="text-tk-body-sm font-bold text-ink truncate">
                      {job.type || "Full-time"}
                    </p>
                  </div>

                  <div className="rounded-tk-lg bg-surface-subtle border border-line p-tk-1.5 space-y-0.5 min-w-0">
                    <div className="flex items-center gap-1 text-tk-caption font-semibold text-ink-subtle">
                      <Calendar className="w-3.5 h-3.5 shrink-0" />
                      <span>Posted</span>
                    </div>
                    <p className="text-tk-body-sm font-bold text-ink truncate">
                      {postedDateLabel}
                    </p>
                  </div>

                  {job.salary && (
                    <div className="rounded-tk-lg bg-success-50/70 border border-success-100 p-tk-1.5 space-y-0.5 min-w-0">
                      <div className="flex items-center gap-1 text-tk-caption font-semibold text-success-700">
                        <DollarSign className="w-3.5 h-3.5 shrink-0" />
                        <span>Compensation</span>
                      </div>
                      <p className="text-tk-body-sm font-bold text-success-700 truncate" title={job.salary}>
                        {job.salary}
                      </p>
                    </div>
                  )}
                </div>

                {/* Mobile / Tablet AI Copilot Quick Actions (Desktop has them in the sticky right rail) */}
                <div className="flex flex-wrap items-center gap-tk-1 pt-tk-1 border-t border-line lg:hidden">
                  <button
                    type="button"
                    onClick={handleTailorResumeClick}
                    className="inline-flex items-center justify-center gap-1.5 px-tk-2 min-h-[44px] rounded-tk-lg border border-success-100 bg-success-50 hover:bg-success-100 text-success-700 text-tk-body-sm font-semibold transition duration-tk-fast cursor-pointer"
                  >
                    <Sparkles className="w-4 h-4 shrink-0" />
                    <span>ATS Skill Highlighting</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleCoverLetterClick}
                    className="inline-flex items-center justify-center gap-1.5 px-tk-2 min-h-[44px] rounded-tk-lg border border-brand-200 bg-brand-50 hover:bg-brand-100 text-brand-700 text-tk-body-sm font-semibold transition duration-tk-fast cursor-pointer"
                  >
                    <FileText className="w-4 h-4 shrink-0" />
                    <span>Prepare Cover Letter</span>
                  </button>
                </div>
              </Card>

              {/* 2. MATCH & SKILL ANALYSIS SECTION */}
              <Card variant="surface" className="p-tk-3 sm:p-tk-4 space-y-tk-3">
                <div className="flex items-center justify-between gap-tk-2">
                  <div className="flex items-center gap-tk-1">
                    <Sparkles className="w-5 h-5 text-brand-600 shrink-0" />
                    <h2 className="text-tk-h3 font-bold text-ink">
                      Match & Skill Analysis
                    </h2>
                  </div>

                  {diagnostics && (
                    <Badge
                      tone={
                        diagnostics.score >= 80
                          ? "success"
                          : diagnostics.score >= 65
                          ? "brand"
                          : diagnostics.score >= 45
                          ? "warning"
                          : "danger"
                      }
                      size="md"
                      dot
                    >
                      {diagnostics.score}% Match
                    </Badge>
                  )}
                </div>

                {candidate && diagnostics ? (
                  <>
                    {/* Match Score Summary Banner */}
                    <div className="p-tk-2 sm:p-tk-3 rounded-tk-xl bg-surface-subtle border border-line flex flex-col sm:flex-row sm:items-center justify-between gap-tk-2">
                      <div className="flex items-center gap-tk-2">
                        <div
                          className={`w-14 h-14 sm:w-16 sm:h-16 rounded-[16px] flex flex-col items-center justify-center font-extrabold text-xl sm:text-2xl shadow-none shrink-0 text-white border border-white/10 ${
                            diagnostics.score >= 80
                              ? "bg-gradient-to-br from-[#1E3A8A] to-[#2563EB]"
                              : diagnostics.score >= 50
                              ? "bg-gradient-to-br from-[#0F172A] to-[#1E3A8A]"


                              : "bg-gradient-to-br from-[#0F172A] to-[#334155]"
                          }`}
                        >
                          <span>{diagnostics.score}%</span>
                          <span className="text-[10px] uppercase font-bold tracking-wider -mt-0.5">
                            Match
                          </span>
                        </div>
                        <div className="space-y-0.5">
                          <div className="text-tk-body-sm font-bold text-ink flex items-center gap-1.5">
                            <span>
                              {diagnostics.score >= 80
                                ? "Strong Match"
                                : diagnostics.score >= 50
                                ? "Good Alignment"
  
                                : "Moderate Fit"}

                            </span>
                          </div>
                          <p className="text-tk-caption sm:text-tk-body-sm text-ink-muted">
                            {diagnostics.matchedSkills.length} matched skills • {diagnostics.missingSkills.length} missing • {diagnostics.breakdown.yearsOfExperience}y experience alignment
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => setIsDiagnosticsOpen(true)}
                        className="inline-flex items-center justify-center gap-1.5 px-tk-2 min-h-[44px] rounded-tk-lg bg-surface hover:bg-surface-muted border border-line-strong text-tk-body-sm font-semibold text-ink shadow-tk-xs transition duration-tk-fast cursor-pointer shrink-0"
                      >
                        <span>View Match Breakdown</span>
                        <ChevronRight className="w-4 h-4 text-brand-600" />
                      </button>
                    </div>

                    {/* Matched vs Missing Skills Grid */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-tk-2">
                      <div className="p-tk-2 rounded-tk-lg bg-success-50/70 border border-success-100 space-y-1.5">
                        <span className="font-bold text-success-700 block text-tk-body-sm">
                          ✓ Matched Skills
                        </span>
                        <p className="text-ink-muted text-tk-caption">
                          Skills from your profile found in this job:
                        </p>
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {diagnostics.matchedSkills.length ? (
                            diagnostics.matchedSkills.map((s) => (
                              <span
                                key={s}
                                className="px-2 py-0.5 rounded-tk-sm bg-surface text-success-700 font-semibold border border-success-100 text-tk-caption"
                              >
                                {s}
                              </span>
                            ))
                          ) : (
                            <span className="text-ink-subtle italic text-tk-caption">
                              No direct skill overlap
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="p-tk-2 rounded-tk-lg bg-warning-50/70 border border-warning-100 space-y-1.5">
                        <span className="font-bold text-warning-700 block text-tk-body-sm">
                          ⚠ Missing Skills
                        </span>
                        <p className="text-ink-muted text-tk-caption">
                          Required skills not currently on your profile:
                        </p>
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {diagnostics.missingSkills.length ? (
                            diagnostics.missingSkills.map((s) => (
                              <span
                                key={s}
                                className="px-2 py-0.5 rounded-tk-sm bg-surface text-warning-700 font-semibold border border-warning-100 text-tk-caption"
                              >
                                {s}
                              </span>
                            ))
                          ) : (
                            <span className="text-success-700 font-semibold text-tk-caption">
                              Zero critical skill gaps!
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="pt-tk-2 border-t border-line flex flex-wrap items-center justify-between gap-tk-1.5">
                      <button
                        type="button"
                        onClick={() => setIsDiagnosticsOpen(true)}
                        className="min-h-[44px] px-tk-1 -ml-tk-1 rounded-tk-md text-tk-body-sm font-semibold text-brand-700 hover:text-brand-800 inline-flex items-center gap-1 cursor-pointer"
                      >
                        <span>View Full Score Breakdown →</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setIsTailorResumeOpen(true)}
                        className="inline-flex items-center gap-1.5 px-tk-2 min-h-[44px] rounded-tk-lg bg-success-50 hover:bg-success-100 text-success-700 border border-success-100 text-tk-body-sm font-semibold transition duration-tk-fast cursor-pointer"
                      >
                        <Sparkles className="w-3.5 h-3.5 shrink-0" />
                        <span>Highlight Skills for this Role →</span>
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="p-tk-2 sm:p-tk-3 rounded-tk-xl bg-brand-50/70 border border-brand-200 flex flex-col sm:flex-row sm:items-center justify-between gap-tk-2">
                    <div className="flex items-center gap-tk-2">
                      <div className="w-12 h-12 rounded-tk-lg bg-brand-600 text-ink-inverse flex items-center justify-center font-bold shrink-0">
                        <Sparkles className="w-6 h-6" />
                      </div>
                      <div className="space-y-0.5">
                        <h3 className="text-tk-body-sm font-bold text-ink">
                          See Your AI Job Fit Score & Skill Diagnostics
                        </h3>
                        <p className="text-tk-caption text-ink-muted">
                          Upload your ATS resume facts to see matched skills, missing requirements, and experience fit for this role.
                        </p>
                      </div>
                    </div>

                    <Link
                      href="/resume"
                      className="inline-flex items-center justify-center gap-1.5 px-tk-2 min-h-[44px] rounded-tk-lg bg-brand-600 hover:bg-brand-700 text-ink-inverse text-tk-body-sm font-semibold shadow-tk-xs transition duration-tk-fast shrink-0"
                    >
                      <span>Upload Resume</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </Link>
                  </div>
                )}
              </Card>

              {/* 3. ROLE OVERVIEW / DESCRIPTION (Readable measure <= 70ch) */}
              <Card variant="surface" className="p-tk-3 sm:p-tk-4 space-y-tk-3">
                <h2 className="text-tk-h3 font-bold text-ink">
                  About the Role
                </h2>

                <div className="p-tk-2 rounded-tk-lg bg-surface-subtle border border-line space-y-1 font-mono text-tk-caption text-ink-muted">
                  <p>• Category: {job.category || "General Tech"}</p>
                  <p>• Location: {job.location || "Remote"}</p>
                  <p>• Employment Type: {job.type || "Full-Time"}</p>
                  {job.salary && <p>• Compensation: {job.salary}</p>}
                </div>

                <div
                  data-testid="job-description-body"
                  className="max-w-[70ch] text-tk-body text-ink leading-relaxed"
                >
                  {job.description ? (
                    <div className="whitespace-pre-wrap break-words">
                      {stripHtmlAndExecutableMarkup(job.description)}
                    </div>
                  ) : (
                    <p className="text-ink-muted">
                      Apply directly on the employer&apos;s site to view the complete posting and application requirements.
                    </p>
                  )}
                </div>
              </Card>
            </div>

            {/* RIGHT COLUMN: DESKTOP STICKY APPLY CTA CARD */}
            <aside
              aria-label="Job application actions"
              data-testid="desktop-sticky-apply-card"
              className="hidden lg:block lg:col-span-4 lg:sticky lg:top-[84px]"
            >
              <Card variant="elevated" className="p-tk-3 space-y-tk-2">
                <div className="space-y-1">
                  <p className="text-tk-caption font-semibold uppercase tracking-wider text-brand-700">
                    Direct Employer Portal
                  </p>
                  <h2 className="text-tk-h3 font-bold text-ink line-clamp-2">
                    {job.title}
                  </h2>
                  <p className="text-tk-body-sm font-medium text-ink-muted flex items-center gap-1.5">
                    <Building className="w-3.5 h-3.5 text-ink-subtle shrink-0" />
                    <span className="truncate">{job.company}</span>
                  </p>
                </div>

                {job.salary && (
                  <div className="rounded-tk-lg bg-success-50 border border-success-100 px-tk-1.5 py-tk-1 flex items-center gap-1.5 text-tk-body-sm font-bold text-success-700">
                    <DollarSign className="w-4 h-4 shrink-0" />
                    <span className="truncate">{job.salary}</span>
                  </div>
                )}

                {/* ONE Primary High-Contrast CTA */}
                <button
                  type="button"
                  onClick={handleApplyClick}
                  className="w-full min-h-[44px] h-12 px-tk-3 rounded-tk-lg bg-brand-600 hover:bg-brand-700 motion-safe:active:scale-[0.98] text-ink-inverse text-tk-body-sm font-semibold shadow-tk-sm transition duration-tk-fast ease-tk-standard inline-flex items-center justify-center gap-2 cursor-pointer focus-visible:outline-none focus-visible:shadow-tk-focus"
                >
                  <span>{isPro ? "Apply on Employer Site" : "Unlock Direct Apply (Pro)"}</span>
                  <ExternalLink className="w-4 h-4 shrink-0" />
                </button>

                {/* Secondary Action: Save to Tracker */}
                <button
                  type="button"
                  onClick={handleSaveOnly}
                  className={`w-full min-h-[44px] px-tk-2 rounded-tk-lg text-tk-body-sm font-semibold border transition duration-tk-fast inline-flex items-center justify-center gap-1.5 cursor-pointer focus-visible:outline-none focus-visible:shadow-tk-focus ${
                    isSavedInTracker
                      ? "bg-surface-muted text-ink border-line-strong hover:bg-surface-sunken"
                      : "bg-surface text-ink-muted border-line hover:bg-surface-muted hover:text-ink"
                  }`}
                >
                  <BookmarkPlus className="w-4 h-4 shrink-0" />
                  <span>{isSavedInTracker ? "Remove from Saved" : "Save Job"}</span>
                </button>

                {/* Secondary AI Copilot Actions */}
                <div className="pt-tk-2 border-t border-line space-y-tk-1">
                  <p className="text-tk-caption font-semibold uppercase tracking-wider text-ink-subtle">
                    AI Application Copilot
                  </p>

                  <button
                    type="button"
                    onClick={handleTailorResumeClick}
                    className="w-full min-h-[44px] px-tk-2 rounded-tk-lg border border-line bg-surface-subtle hover:bg-surface-muted text-ink text-tk-body-sm font-semibold transition duration-tk-fast inline-flex items-center justify-center gap-1.5 cursor-pointer focus-visible:outline-none focus-visible:shadow-tk-focus"
                  >
                    <Sparkles className="w-4 h-4 text-success-700 shrink-0" />
                    <span>ATS Skill Highlighting</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleCoverLetterClick}
                    className="w-full min-h-[44px] px-tk-2 rounded-tk-lg border border-line bg-surface-subtle hover:bg-surface-muted text-ink text-tk-body-sm font-semibold transition duration-tk-fast inline-flex items-center justify-center gap-1.5 cursor-pointer focus-visible:outline-none focus-visible:shadow-tk-focus"
                  >
                    <FileText className="w-4 h-4 text-brand-600 shrink-0" />
                    <span>Prepare Cover Letter</span>
                  </button>
                </div>

                <div className="pt-tk-1.5 border-t border-line flex items-center justify-between text-tk-caption text-ink-subtle">
                  <span className="inline-flex items-center gap-1">
                    <Globe className="w-3.5 h-3.5 shrink-0" />
                    <span>Direct ATS Link</span>
                  </span>
                  <span>Posted {postedDateLabel}</span>
                </div>
              </Card>
            </aside>
          </div>
        </motion.div>
      </main>

      {/* ========================================================================= */}
      {/* MOBILE STICKY BOTTOM APPLY BAR (one primary CTA, 44px touch targets)      */}
      {/* ========================================================================= */}
      <div
        role="region"
        aria-label="Quick apply bar"
        data-testid="mobile-sticky-apply-bar"
        className="lg:hidden fixed bottom-0 inset-x-0 z-tk-sticky bg-surface/95 backdrop-blur-md border-t border-line px-4 py-3 shadow-tk-lg"
      >
        <div className="max-w-container mx-auto flex items-center gap-tk-1.5">
          <button
            type="button"
            onClick={handleSaveOnly}
            aria-label={isSavedInTracker ? "Remove from Saved" : "Save Job"}
            className={`min-h-[44px] min-w-[44px] px-tk-2 rounded-tk-lg border text-tk-body-sm font-semibold transition duration-tk-fast inline-flex items-center justify-center gap-1.5 shrink-0 cursor-pointer focus-visible:outline-none focus-visible:shadow-tk-focus ${
              isSavedInTracker
                ? "bg-surface-muted text-ink border-line-strong"
                : "bg-surface text-ink-muted border-line hover:bg-surface-muted hover:text-ink"
            }`}
          >
            <BookmarkPlus className="w-4 h-4 shrink-0" />
            <span className="hidden xs:inline">
              {isSavedInTracker ? "Saved" : "Save"}
            </span>
          </button>

          <button
            type="button"
            onClick={handleApplyClick}
            className="flex-1 min-h-[44px] px-tk-2 rounded-tk-lg bg-brand-600 hover:bg-brand-700 motion-safe:active:scale-[0.98] text-ink-inverse text-tk-body-sm font-semibold shadow-tk-sm transition duration-tk-fast inline-flex items-center justify-center gap-2 cursor-pointer focus-visible:outline-none focus-visible:shadow-tk-focus"
          >
            <span>{isPro ? "Apply on Employer Site" : "Unlock Direct Apply (Pro)"}</span>
            <ExternalLink className="w-4 h-4 shrink-0" />
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 4. POST-APPLY CONFIRMATION MODAL ("Did you submit it?")                   */}
      {/* ========================================================================= */}
      {showApplyConfirmModal && (
        <div className="fixed inset-0 z-tk-modal bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 motion-safe:animate-tk-fade-in">
          <div className="bg-surface rounded-tk-2xl max-w-md w-full p-tk-3 shadow-tk-xl border border-line space-y-tk-2">
            <div className="w-12 h-12 rounded-tk-full bg-brand-50 text-brand-600 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-6 h-6" />
            </div>

            <div className="text-center space-y-1">
              <h3 className="text-tk-h3 font-bold text-ink">
                Did you submit your application?
              </h3>
              <p className="text-tk-caption text-ink-muted">
                Opening the company portal doesn&apos;t automatically record an application. If you finalized the employer&apos;s form, we will update your pipeline.
              </p>
            </div>

            <div className="pt-tk-1 flex flex-col sm:flex-row items-center gap-tk-1">
              <button
                type="button"
                onClick={() => handleConfirmApplication("applied")}
                className="w-full min-h-[44px] py-2.5 rounded-tk-lg bg-brand-600 hover:bg-brand-700 text-ink-inverse font-semibold text-tk-body-sm transition duration-tk-fast shadow-tk-xs cursor-pointer"
              >
                Yes, Mark as Applied
              </button>

              <button
                type="button"
                onClick={() => handleConfirmApplication("saved")}
                className="w-full min-h-[44px] py-2.5 rounded-tk-lg border border-line hover:bg-surface-muted text-ink font-semibold text-tk-body-sm transition duration-tk-fast cursor-pointer"
              >
                Not yet, keep Saved
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Paywall Modal */}
      <PaywallModal
        open={isPaywallOpen}
        onOpenChange={setIsPaywallOpen}
        user={user}
        featureTitle="Unlock Direct Company ATS Applications"
      />

      {/* Cover Letter Modal */}
      {isCoverLetterOpen && candidate && (
        <CoverLetterModal
          open={isCoverLetterOpen}
          onOpenChange={setIsCoverLetterOpen}
          candidate={candidate}
          job={{
            id: job.id,
            title: job.title,
            company: job.company,
            location: job.location,
            description: job.description || `${job.title} at ${job.company} (${job.location}, ${job.category}).`,
          }}
        />
      )}

      {/* Tailor Resume Modal */}
      {isTailorResumeOpen && candidate && (
        <TailorResumeModal
          open={isTailorResumeOpen}
          onOpenChange={setIsTailorResumeOpen}
          candidate={candidate}
          job={{
            id: job.id,
            title: job.title,
            company: job.company,
            location: job.location,
            category: job.category,
            skills: job.skills,
            description: job.description || `${job.title} at ${job.company} (${job.location}, ${job.category}).`,
          }}
          onOpenCoverLetter={() => setIsCoverLetterOpen(true)}
        />
      )}

      {/* Fit Diagnostics Breakdown Modal */}
      {isDiagnosticsOpen && candidate && diagnostics && (
        <FitDiagnosticsModal
          open={isDiagnosticsOpen}
          onOpenChange={setIsDiagnosticsOpen}
          diagnostics={diagnostics}
          candidate={candidate}
          job={{
            id: job.id,
            title: job.title,
            company: job.company,
            location: job.location,
            salary_text: job.salary,
            apply_url: job.applyUrl,
          }}
          onOpenCoverLetter={() => setIsCoverLetterOpen(true)}
          onExportResume={() => setIsTailorResumeOpen(true)}
        />
      )}

      <Footer />
    </div>
  );
}

export default function JobDetailPage() {
  return (
    <Suspense fallback={<JobDetailSkeleton />}>
      <JobDetailInner />
    </Suspense>
  );
}
