"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import AppIconRail from "@/components/shell/AppIconRail";
import AppTopBar from "@/components/shell/AppTopBar";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import { useSidebarMode } from "@/lib/sidebar";
import ProUpgradeScreen from "@/components/billing/ProUpgradeScreen";
import ProOnboardingCard from "@/components/onboarding/ProOnboardingCard";
import ResumeUploadAndConfirm from "@/components/resume/ResumeUploadAndConfirm";
import TopTenCompatibleJobs from "@/components/dashboard/TopTenCompatibleJobs";
import FreeDashboardTopTenPreview from "@/components/dashboard/FreeDashboardTopTenPreview";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { buttonClasses } from "@/components/ui/button";
import { getAuthUser, getUserPreferences } from "@/lib/auth/session";
import { UserPreferences } from "@/lib/auth/types";
import { getCandidateProfile } from "@/lib/resume/storage";
import { CandidateProfile } from "@/lib/resume/types";
import { getProAccessStatus } from "@/lib/billing/subscription";
import { getTrackedApplications } from "@/lib/tracker/storage";
import { TrackedApplication, STAGE_CONFIG, ApplicationStage } from "@/lib/tracker/types";
import type { User } from "@supabase/supabase-js";
import {
  Sparkles,
  Lock,
  Briefcase,
  FileText,
  CheckCircle2,
  Settings,
  ArrowRight,
  TrendingUp,
  BookmarkPlus,
  Clock,
} from "lucide-react";

type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger";

const STAGE_TONE: Record<ApplicationStage, BadgeTone> = {
  saved: "neutral",
  applied: "brand",
  interview: "warning",
  offer: "success",
  rejected: "neutral",
};

/**
 * Layout-matching skeleton: greeting, 3 stat cards, next-action + recent-activity
 * cards, step bar and step content. Prevents layout shift while auth/entitlement load.
 */
function DashboardSkeleton() {
  const { isExpanded } = useSidebarMode();
  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex flex-col font-sans">
      <AppIconRail />
      <div className={`flex-1 ${isExpanded ? "md:pl-[240px]" : "md:pl-[72px]"} flex flex-col min-w-0 pb-6 md:pb-0 transition-[padding] duration-300 ease-[cubic-bezier(0.2,0,0,1)]`}>
        <AppTopBar pageLabel="DASHBOARD" />
        <main
          id="main-content"
          className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-tk-3 sm:py-tk-3 min-w-0"
        >
        <div
          role="status"
          aria-label="Loading your account"
          data-testid="dashboard-skeleton"
          className="space-y-tk-3 sm:space-y-tk-2"
        >
          <span className="sr-only">Loading your account...</span>

          {/* Greeting header */}
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-tk-2">
            <div className="space-y-2">
              <Skeleton className="h-6 w-28 rounded-tk-full" />
              <Skeleton className="h-9 w-72 max-w-full rounded-tk-md" />
              <Skeleton shape="text" className="h-4 w-56 max-w-full" />
            </div>
            <Skeleton className="h-11 w-40 rounded-tk-lg" />
          </div>

          {/* Stat cards row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-tk-2">
            {[0, 1, 2].map((i) => (
              <Card key={i} variant="surface" className="p-tk-3 sm:p-tk-2 space-y-tk-1">
                <div className="flex items-center justify-between">
                  <Skeleton shape="text" className="h-3.5 w-28" />
                  <Skeleton className="w-9 h-9 rounded-tk-lg" />
                </div>
                <Skeleton className="h-8 w-16 rounded-tk-md" />
                <Skeleton shape="text" className="h-3 w-32" />
              </Card>
            ))}
          </div>

          {/* Next action + recent activity */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-tk-2">
            <Card variant="surface" className="lg:col-span-2 p-tk-3 sm:p-tk-2 space-y-tk-2">
              <Skeleton shape="text" className="h-4 w-28" />
              <Skeleton className="h-6 w-48 rounded-tk-sm" />
              <Skeleton shape="text" className="h-3.5 w-full" />
              <Skeleton className="h-11 w-36 rounded-tk-lg" />
            </Card>
            <Card variant="surface" className="lg:col-span-3 p-tk-3 sm:p-tk-2 space-y-tk-2">
              <Skeleton shape="text" className="h-4 w-32" />
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center justify-between gap-tk-2">
                  <div className="space-y-1.5 flex-1">
                    <Skeleton shape="text" className="h-4 w-3/5" />
                    <Skeleton shape="text" className="h-3 w-2/5" />
                  </div>
                  <Skeleton className="h-6 w-20 rounded-tk-full" />
                </div>
              ))}
            </Card>
          </div>

          {/* Step bar */}
          <Card variant="surface" className="p-tk-2 flex flex-wrap items-center justify-between gap-tk-2">
            <Skeleton className="h-6 w-56 rounded-tk-full" />
            <div className="flex items-center gap-tk-1">
              <Skeleton className="h-11 w-28 rounded-tk-lg" />
              <Skeleton className="h-11 w-24 rounded-tk-lg" />
              <Skeleton className="h-11 w-32 rounded-tk-lg" />
            </div>
          </Card>

          {/* Step content */}
          <Card variant="surface" className="p-tk-3 sm:p-tk-2 space-y-tk-2">
            <Skeleton className="h-6 w-56 rounded-tk-sm" />
            <Skeleton className="h-24 w-full rounded-tk-lg" />
            <Skeleton className="h-24 w-full rounded-tk-lg" />
          </Card>
        </div>
        </main>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const shouldReduceMotion = useReducedMotion();

  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPro, setIsPro] = useState(false);
  const [isProDefinitive, setIsProDefinitive] = useState(false);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [candidate, setCandidate] = useState<CandidateProfile | null>(null);
  const [applications, setApplications] = useState<TrackedApplication[]>([]);
  const [activeStep, setActiveStep] = useState<"onboarding" | "resume" | "matches">("matches");

  const loadData = useCallback(async (authUser: User) => {
    setLoading(true);
    try {
      const [proRes, prefRes, profileRes, appsRes] = await Promise.all([
        getProAccessStatus(authUser.id),
        getUserPreferences(authUser.id),
        getCandidateProfile(authUser.id),
        getTrackedApplications(authUser.id),
      ]);

      setIsPro(proRes.isPro);
      setIsProDefinitive(Boolean(proRes.isDefinitive));
      setPreferences(prefRes);
      setCandidate(profileRes && profileRes.confirmedAt ? profileRes : null);
      setApplications(appsRes);

      // Determine starting step in the guided flow
      if (!prefRes.onboardingCompleted) {
        setActiveStep("onboarding");
      } else if (!profileRes || !profileRes.confirmedAt) {
        setActiveStep("resume");
      } else {
        setActiveStep("matches");
      }
    } catch (err) {
      console.warn("Could not load dashboard data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    getAuthUser().then((authUser) => {
      if (!authUser) {
        router.replace("/login?returnTo=/dashboard");
        return;
      }
      setUser(authUser);
      loadData(authUser);
    });
  }, [router, loadData]);

  if (loading || (!isPro && !isProDefinitive)) {
    return <DashboardSkeleton />;
  }



  // ---------------------------------------------------------------------------
  // Overview data — derived strictly from already-loaded state (no new numbers)
  // ---------------------------------------------------------------------------
  const savedCount = applications.filter((a) => a.stage === "saved").length;
  const recentApplications = [...applications]
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
    .slice(0, 4);

  const metaName =
    (user?.user_metadata?.full_name as string | undefined) ||
    (user?.user_metadata?.name as string | undefined);
  const firstName = (candidate?.name || metaName || user?.email?.split("@")[0] || "")
    .trim()
    .split(/\s+/)[0];

  const entrance = shouldReduceMotion
    ? { initial: false as const, animate: { opacity: 1, y: 0 }, transition: { duration: 0.01 } }
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.25, ease: [0.22, 1, 0.36, 1] as const },
      };

  const stepButtonClass = (isActive: boolean) =>
    `min-h-[44px] px-tk-2 rounded-tk-lg text-tk-body-sm font-semibold transition duration-tk-fast ease-tk-standard cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:shadow-tk-focus ${
      isActive
        ? "bg-brand-50 text-brand-700 border border-brand-200"
        : "text-ink-muted border border-transparent hover:bg-surface-muted hover:text-ink"
    }`;

  // Next action derived from the existing guided-flow state
  const nextAction: {
    eyebrow: string;
    title: string;
    body: string;
    icon: React.ReactNode;
    action: React.ReactNode;
  } = !preferences?.onboardingCompleted
    ? {
        eyebrow: "Step 1",
        title: "Preferences",
        body: "Guided Setup in Progress",
        icon: <Settings className="w-5 h-5" />,
        action: (
          <button
            type="button"
            onClick={() => setActiveStep("onboarding")}
            className={buttonClasses({ variant: "ghost", className: "border border-line text-ink" })}
          >
            <span>Continue Setup</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        ),
      }
    : !candidate?.confirmedAt
    ? {
        eyebrow: "Step 2",
        title: "Verify Your Resume Facts",
        body: "Upload your resume document or skip to fill in verified facts manually.",
        icon: <FileText className="w-5 h-5" />,
        action: (
          <button
            type="button"
            onClick={() => setActiveStep("resume")}
            className={buttonClasses({ variant: "ghost", className: "border border-line text-ink" })}
          >
            <span>Add Resume Facts</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        ),
      }
    : {
        eyebrow: "Step 3",
        title: "Top 10 Jobs",
        body: `Active Profile: ${candidate.headline || candidate.name}`,
        icon: <TrendingUp className="w-5 h-5" />,
        action: (
          <Link
            href="/tracker"
            prefetch={false}
            className={buttonClasses({ variant: "ghost", className: "border border-line text-ink" })}
          >
            <span>Open Application Tracker</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        ),
      };

  // TIER 3: PRO USER (Guided Pro Flow)
  return (
    <LoggedInAppShell pageLabel="DASHBOARD" user={user} isPro={isPro}>
      <div className="max-w-5xl w-full mx-auto px-4 sm:px-6 py-tk-3 sm:py-tk-3">
        <motion.div {...entrance} className="space-y-tk-3 sm:space-y-tk-2">
          {/* ================================================================= */}
          {/* GREETING HEADER + ONE PRIMARY CTA                                 */}
          {/* ================================================================= */}
          <div
            data-testid="dashboard-greeting"
            className="flex flex-col sm:flex-row sm:items-end justify-between gap-tk-2"
          >
            <div className="space-y-1.5 min-w-0">
              <Badge tone={isPro ? "brand" : "neutral"} size="md" className="font-extrabold">
                {isPro ? "PRO MEMBER" : "FREE PLAN"}
              </Badge>
              <h1 className="text-[18px] font-bold uppercase tracking-wider text-ink break-words">
                {firstName ? `Welcome back, ${firstName}` : "Welcome back"}
              </h1>
              <p className="text-tk-body-sm text-ink-muted">
                {candidate?.confirmedAt
                  ? `Active Profile: ${candidate.headline || candidate.name}`
                  : "Guided Setup in Progress"}
              </p>
            </div>

            <Link
              href="/jobs"
              data-testid="dashboard-primary-cta"
              className={buttonClasses({ variant: "primary", size: "lg", className: "shrink-0" })}
            >
              <span>Continue to Jobs</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>

          {/* ================================================================= */}
          {/* STAT CARDS ROW (existing data only)                               */}
          {/* ================================================================= */}
          <div data-testid="dashboard-stats" className="grid grid-cols-1 sm:grid-cols-3 gap-tk-2">
            <Card variant="surface" className="p-tk-3 sm:p-tk-2 space-y-1">
              <div className="flex items-center justify-between gap-tk-1">
                <span className="text-tk-caption font-semibold uppercase tracking-wider text-ink-subtle">
                  Applications Tracked
                </span>
                <span className="w-9 h-9 rounded-tk-lg bg-brand-50 text-brand-600 flex items-center justify-center">
                  <Briefcase className="w-4 h-4" />
                </span>
              </div>
              <p className="text-tk-h2 text-ink">{applications.length}</p>
              <p className="text-tk-caption text-ink-muted">Application Pipeline</p>
            </Card>

            <Card variant="surface" className="p-tk-3 sm:p-tk-2 space-y-1">
              <div className="flex items-center justify-between gap-tk-1">
                <span className="text-tk-caption font-semibold uppercase tracking-wider text-ink-subtle">
                  Matches
                </span>
                <span className={`w-9 h-9 rounded-tk-lg flex items-center justify-center ${
                  isPro ? "bg-success-50 text-success-700" : "bg-brand-50 text-brand-600"
                }`}>
                  {isPro ? <Sparkles className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                </span>
              </div>
              <p className="text-tk-h2 text-ink">
                {candidate?.confirmedAt ? (isPro ? "Top 10" : "Top 10 (Locked)") : "—"}
              </p>
              <p className="text-tk-caption text-ink-muted">
                {candidate?.confirmedAt
                  ? (isPro ? "Ready to review" : "Unlock your Top 10 jobs ranked by fit")
                  : "Resume Required for Scoring"}
              </p>
            </Card>

            <Card variant="surface" className="p-tk-3 sm:p-tk-2 space-y-1">
              <div className="flex items-center justify-between gap-tk-1">
                <span className="text-tk-caption font-semibold uppercase tracking-wider text-ink-subtle">
                  Saved
                </span>
                <span className="w-9 h-9 rounded-tk-lg bg-surface-muted text-ink-muted flex items-center justify-center">
                  <BookmarkPlus className="w-4 h-4" />
                </span>
              </div>
              <p className="text-tk-h2 text-ink">{savedCount}</p>
              <p className="text-tk-caption text-ink-muted">{STAGE_CONFIG.saved.label}</p>
            </Card>
          </div>

          {/* ================================================================= */}
          {/* NEXT ACTION + RECENT ACTIVITY                                     */}
          {/* ================================================================= */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-tk-2">
            <Card
              variant="surface"
              data-testid="dashboard-next-action"
              className="lg:col-span-2 p-tk-3 sm:p-tk-2 flex flex-col gap-tk-2"
            >
              <div className="flex items-center gap-tk-1">
                <span className="w-9 h-9 rounded-tk-lg bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
                  {nextAction.icon}
                </span>
                <div className="min-w-0">
                  <p className="text-tk-caption font-semibold uppercase tracking-wider text-brand-700">
                    Next action • {nextAction.eyebrow}
                  </p>
                  <h2 className="text-tk-h3 text-ink truncate">{nextAction.title}</h2>
                </div>
              </div>
              <p className="text-tk-body-sm text-ink-muted flex-1 break-words">{nextAction.body}</p>
              <div>{nextAction.action}</div>
            </Card>

            <Card
              variant="surface"
              data-testid="dashboard-recent-activity"
              className="lg:col-span-3 p-tk-3 sm:p-tk-2 space-y-tk-2"
            >
              <div className="flex items-center justify-between gap-tk-1">
                <h2 className="text-tk-h3 text-ink flex items-center gap-tk-1">
                  <Clock className="w-5 h-5 text-ink-subtle" />
                  <span>Recent Activity</span>
                </h2>
                {applications.length > 0 && (
                  <Link
                    href="/tracker"
                    prefetch={false}
                    className="min-h-[44px] px-tk-1 inline-flex items-center gap-1 rounded-tk-md text-tk-body-sm font-semibold text-brand-700 hover:text-brand-800 focus-visible:outline-none focus-visible:shadow-tk-focus"
                  >
                    <span>Open Application Tracker</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                )}
              </div>

              {recentApplications.length > 0 ? (
                <ul className="divide-y divide-line">
                  {recentApplications.map((app) => (
                    <li key={app.id} className="py-3 flex items-center justify-between gap-tk-2">
                      <div className="min-w-0">
                        <p className="text-tk-body-sm font-semibold text-ink truncate">{app.title}</p>
                        <p className="text-tk-caption text-ink-muted truncate">
                          {app.company}
                          {app.location ? ` • ${app.location}` : ""}
                        </p>
                      </div>
                      <Badge tone={STAGE_TONE[app.stage] || "neutral"} size="md" dot className="shrink-0">
                        {STAGE_CONFIG[app.stage]?.label || app.stage}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <div
                  data-testid="dashboard-activity-empty"
                  className="rounded-tk-lg border border-dashed border-line-strong bg-surface-subtle p-tk-3 text-center space-y-tk-1"
                >
                  <div className="w-11 h-11 rounded-tk-lg bg-surface text-ink-subtle border border-line flex items-center justify-center mx-auto">
                    <Briefcase className="w-5 h-5" />
                  </div>
                  <p className="text-tk-body-sm font-semibold text-ink">0 tracked applications</p>
                  <Link
                    href="/tracker"
                    prefetch={false}
                    className={buttonClasses({ variant: "ghost", size: "md", className: "text-brand-700" })}
                  >
                    <span>Open Application Tracker</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
              )}
            </Card>
          </div>

          {/* ================================================================= */}
          {/* GUIDED FLOW STEP BAR                                              */}
          {/* ================================================================= */}
          <Card
            variant="surface"
            className="p-tk-2 flex flex-wrap items-center justify-between gap-tk-2"
          >
            <div className="flex items-center gap-tk-1 min-w-0">
              <CheckCircle2 className="w-4 h-4 text-success-700 shrink-0" />
              <span className="text-tk-body-sm font-semibold text-ink">Guided Pro Flow</span>
            </div>

            <nav aria-label="Guided Pro Flow steps" className="flex flex-wrap items-center gap-1 sm:gap-tk-1">
              <button
                type="button"
                onClick={() => setActiveStep("onboarding")}
                aria-current={activeStep === "onboarding" ? "step" : undefined}
                className={stepButtonClass(activeStep === "onboarding")}
              >
                1. Preferences
              </button>
              <span aria-hidden="true" className="text-ink-subtle">→</span>
              <button
                type="button"
                onClick={() => setActiveStep("resume")}
                aria-current={activeStep === "resume" ? "step" : undefined}
                className={stepButtonClass(activeStep === "resume")}
              >
                2. Resume
              </button>
              <span aria-hidden="true" className="text-ink-subtle">→</span>
              <button
                type="button"
                onClick={() => {
                  if (candidate?.confirmedAt) setActiveStep("matches");
                }}
                disabled={!candidate?.confirmedAt}
                aria-current={activeStep === "matches" ? "step" : undefined}
                className={stepButtonClass(activeStep === "matches")}
              >
                3. Top 10 Jobs
              </button>
            </nav>
          </Card>

          {/* STEP 1: ONBOARDING QUESTIONS */}
          {activeStep === "onboarding" && user && (
            <ProOnboardingCard
              userId={user.id}
              initialPreferences={preferences}
              onComplete={() => {
                if (candidate?.confirmedAt) {
                  setActiveStep("matches");
                } else {
                  setActiveStep("resume");
                }
              }}
              onSkip={() => {
                if (candidate?.confirmedAt) {
                  setActiveStep("matches");
                } else {
                  setActiveStep("resume");
                }
              }}
            />
          )}

          {/* STEP 2: RESUME STEP (Upload or Skip & fill manually) */}
          {activeStep === "resume" && (
            <Card variant="surface" className="p-tk-3 sm:p-tk-2">
              <div className="mb-tk-2 pb-tk-2 border-b border-line flex flex-wrap items-center justify-between gap-tk-1">
                <div className="space-y-0.5">
                  <span className="text-tk-caption font-semibold text-brand-700 uppercase tracking-wider">
                    Step 2 of 2 • Guided Pro Flow
                  </span>
                  <h2 className="text-tk-h3 sm:text-tk-h2 text-ink">Verify Your Resume Facts</h2>
                  <p className="text-tk-body-sm text-ink-muted">
                    Upload your resume document or skip to fill in verified facts manually.
                  </p>
                </div>

                {candidate?.confirmedAt && (
                  <button
                    type="button"
                    onClick={() => setActiveStep("matches")}
                    className={buttonClasses({ variant: "ghost", className: "text-brand-700" })}
                  >
                    View Top 10 Matches →
                  </button>
                )}
              </div>

              <ResumeUploadAndConfirm
                isPro={isPro}
                onProfileConfirmed={(p) => {
                  setCandidate(p);
                  setActiveStep("matches");
                }}
              />
            </Card>
          )}

          {/* STEP 3 & 4: TOP 10 JOBS WITH COMPATIBLE SCORE & PER-JOB AI ACTIONS */}
          {activeStep === "matches" && candidate && (
            isPro ? (
              <TopTenCompatibleJobs candidate={candidate} isPro={isPro} userId={user?.id || null} />
            ) : (
              <FreeDashboardTopTenPreview />
            )
          )}

          {/* Fallback prompt if step is matches but resume is not uploaded */}
          {activeStep === "matches" && !candidate && (
            <Card
              variant="surface"
              data-testid="dashboard-resume-empty"
              className="p-tk-4 sm:p-tk-3 text-center space-y-tk-2"
            >
              <div className="w-12 h-12 rounded-tk-xl bg-brand-50 text-brand-600 flex items-center justify-center mx-auto">
                <FileText className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h3 className="text-tk-h3 text-ink">Resume Required for Scoring</h3>
                <p className="text-tk-body-sm text-ink-muted max-w-sm mx-auto">
                  Upload your resume or fill skills manually to compute your Top 10 compatible job matches.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveStep("resume")}
                className={buttonClasses({ variant: "ghost", className: "border border-line text-ink" })}
              >
                <span>Add Resume Facts</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </Card>
          )}
        </motion.div>
      </div>
    </LoggedInAppShell>
  );
}
