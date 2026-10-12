"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import { getLiveJobById, LiveJob, getJobRemoteEligibility } from "@/lib/jobs/service";
import { getAuthUser } from "@/lib/auth/session";
import { getCandidateProfile } from "@/lib/resume/storage";
import { CandidateProfile } from "@/lib/resume/types";
import { computeFitDiagnostics, FitDiagnosticsResult } from "@/lib/matcher/scoring";
import { addApplicationToTracker, getTrackedApplications, removeApplicationFromTracker } from "@/lib/tracker/storage";
import { getProAccessStatus } from "@/lib/billing/subscription";
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
  Clock,
  HelpCircle,
  Share2,
  ChevronRight,
  ArrowRight
} from "lucide-react";
import { toast } from "react-toastify";

function getResolvedJobId(searchParams: URLSearchParams | null): string {
  const queryId = searchParams?.get("id");
  if (queryId && queryId.trim()) return queryId.trim();

  if (typeof window !== "undefined") {
    const urlParams = new URLSearchParams(window.location.search);
    const winId = urlParams.get("id");
    if (winId && winId.trim()) return winId.trim();

    const pathname = window.location.pathname;
    const match = pathname.match(/^\/jobs\/([^/?#]+)/);
    if (match && match[1] && match[1] !== "detail") {
      return decodeURIComponent(match[1]).trim();
    }
  }

  return "";
}

function JobDetailInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

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

  const urlJobId = searchParams?.get("id") || searchParams?.get("jobId") || "";

  useEffect(() => {
    const resolvedId = getResolvedJobId(searchParams);

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
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <GuideHeader />
        <div className="flex-1 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  // Tier 1: Signed-out visitor
  if (!user) {
    const returnUrl = typeof window !== "undefined" ? window.location.pathname + window.location.search : `/jobs/detail?id=${job?.id || ""}`;
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex flex-col">
        <GuideHeader />
        <main className="flex-1 max-w-lg w-full mx-auto px-4 py-16 flex flex-col items-center justify-center text-center space-y-5">
          <div className="w-14 h-14 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-200 shadow-xs">
            <Lock className="w-7 h-7" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Sign in to view job details</h1>
            <p className="text-sm text-slate-600 max-w-sm mx-auto leading-relaxed">
              Sign in to unlock full role descriptions, company info, salary ranges, and match scores.
            </p>
          </div>
          <Link
            href={`/login?next=${encodeURIComponent(returnUrl)}`}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-blue-600 text-white font-bold text-sm shadow-xs hover:bg-blue-700 transition"
          >
            <span>Sign In to Continue</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        </main>
        <Footer />
      </div>
    );
  }

  // Tier 2: Signed-in non-Pro member (Definitively confirmed by server)
  if (!isPro) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex flex-col">
        <GuideHeader />
        <main className="flex-1 max-w-4xl w-full mx-auto px-4 py-8">
          <ProUpgradeScreen
            title="Unlock Full Job Details"
            subtitle="Upgrade to CareerMonke Pro to see verified company names, compensation, direct ATS apply links, and compatibility scores."
          />
        </main>
        <Footer />
      </div>
    );
  }

  // Not found or closed job state (for Pro user)
  if (!job) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <GuideHeader />
        <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-16 text-center space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto border border-amber-200">
            <AlertCircle className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Job Opening Not Found</h1>
          <p className="text-sm text-slate-600 max-w-md mx-auto">
            This opening may have been unlisted or closed by the employer.
          </p>
          <div className="pt-4">
            <Link
              href="/jobs"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-blue-600 text-white font-bold text-sm shadow-xs hover:bg-blue-700 transition"
            >
              <span>Browse Active Verified Jobs</span>
              <ArrowLeft className="w-4 h-4 rotate-180" />
            </Link>
          </div>
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

  const handleApplyClick = () => {
    if (!isPro) {
      setIsPaywallOpen(true);
      return;
    }

    // Open employer ATS in new tab
    if (job.applyUrl) {
      window.open(job.applyUrl, "_blank", "noopener,noreferrer");
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
        applyUrl: job.applyUrl,
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
      const currentUrl = typeof window !== "undefined" ? window.location.pathname + window.location.search : `/jobs/detail?id=${job.id}`;
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

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#09090B] flex flex-col">
      <GuideHeader />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-10 space-y-6">
        {/* Back Link */}
        <div className="flex items-center justify-between">
          <Link
            href="/jobs"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-900 transition"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to All Jobs</span>
          </Link>

          <span className="text-[11px] font-bold text-slate-400">
            Job ID: {job.id.slice(0, 8)}
          </span>
        </div>

        {/* ========================================================================= */}
        {/* 1. HEADER CARD: Title, Company, Eligibility, Source                       */}
        {/* ========================================================================= */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-2xs space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div className="space-y-2 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                  {job.category || "Engineering"}
                </span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                  {job.type || "Full-time"}
                </span>
                {(() => {
                  const elig = getJobRemoteEligibility(job);
                  if (elig === "worldwide") {
                    return (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                        Worldwide Remote Eligible
                      </span>
                    );
                  }
                  if (elig === "country_restricted") {
                    return (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                        Remote ({job.location || "Geographically Restricted"})
                      </span>
                    );
                  }
                  if (job.remote) {
                    return (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                        Remote (Eligibility Unknown)
                      </span>
                    );
                  }
                  return null;
                })()}
              </div>

              <h1 className="text-xl sm:text-3xl font-black text-slate-900 tracking-tight">
                {job.title}
              </h1>

              {/* Company & Location */}
              <div className="flex flex-wrap items-center gap-3 text-xs sm:text-sm text-slate-600 font-medium">
                <div className="flex items-center gap-1.5">
                  <Building className="w-4 h-4 text-slate-400 shrink-0" />
                  <span className="font-bold text-slate-900">
                    {job.company}
                  </span>
                </div>

                <span>•</span>

                <div className="flex items-center gap-1.5">
                  <MapPin className="w-4 h-4 text-slate-400 shrink-0" />
                  <span>{job.location || "Remote / Global"}</span>
                </div>

                {job.salary && (
                  <>
                    <span>•</span>
                    <div className="flex items-center gap-1 text-emerald-700 font-semibold">
                      <DollarSign className="w-4 h-4 shrink-0" />
                      <span>{job.salary}</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Direct Feed Badge */}
            <div className="sm:text-right shrink-0 space-y-1">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
                <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
                <span>Verified Direct Feed</span>
              </span>
              <p className="text-[10px] text-slate-400">Official career portal</p>
            </div>
          </div>

          {/* Match Score Banner */}
          {candidate && diagnostics ? (
            <div className="p-4 sm:p-5 rounded-2xl bg-slate-50 border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div
                  className={`w-14 h-14 sm:w-16 sm:h-16 rounded-2xl flex flex-col items-center justify-center border font-black text-xl sm:text-2xl shadow-xs shrink-0 ${
                    diagnostics.score >= 80
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : diagnostics.score >= 65
                      ? "bg-blue-50 text-blue-700 border-blue-200"
                      : diagnostics.score >= 45
                      ? "bg-amber-50 text-amber-800 border-amber-200"
                      : "bg-rose-50 text-rose-700 border-rose-200"
                  }`}
                >
                  <span>{diagnostics.score}%</span>
                  <span className="text-[9px] uppercase font-bold tracking-wider -mt-1">Match</span>
                </div>
                <div className="space-y-1">
                  <div className="text-xs sm:text-sm font-bold text-slate-900 flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-blue-600" />
                    <span>
                      {diagnostics.score >= 80
                        ? "Strong Match"
                        : diagnostics.score >= 65
                        ? "Good Alignment"
                        : diagnostics.score >= 45
                        ? "Moderate Fit"
                        : "Low Match"}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    {diagnostics.matchedSkills.length} matched skills • {diagnostics.missingSkills.length} missing • {diagnostics.breakdown.yearsOfExperience}y experience alignment
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setIsDiagnosticsOpen(true)}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-white hover:bg-slate-100 border border-slate-300 text-xs font-bold text-slate-800 shadow-2xs transition cursor-pointer shrink-0 min-h-[44px]"
              >
                <span>View Match Breakdown</span>
                <ChevronRight className="w-4 h-4 text-blue-600" />
              </button>
            </div>
          ) : (
            <div className="p-4 rounded-xl bg-blue-50/70 border border-blue-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-blue-600 text-white flex items-center justify-center font-bold text-sm shrink-0">
                  <Sparkles className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-xs sm:text-sm font-bold text-blue-950">
                    See Your AI Job Fit Score & Skill Diagnostics
                  </h3>
                  <p className="text-xs text-blue-700 mt-0.5">
                    Upload your ATS resume facts to see matched skills, missing requirements, and experience fit for this role.
                  </p>
                </div>
              </div>

              <Link
                href="/resume"
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-xs transition shrink-0 min-h-[44px]"
              >
                <span>Upload Resume</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          )}

          {/* Action Ribbon */}
          <div className="pt-4 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleApplyClick}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white text-xs sm:text-sm font-bold shadow-xs transition cursor-pointer"
              >
                <span>{isPro ? "Apply on Employer Site" : "Unlock Direct Apply (Pro)"}</span>
                <ExternalLink className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={handleSaveOnly}
                className={`inline-flex items-center gap-1.5 px-4 py-3 rounded-xl text-xs sm:text-sm font-bold border transition cursor-pointer ${
                  isSavedInTracker
                    ? "bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200"
                    : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                }`}
              >
                <BookmarkPlus className="w-4 h-4" />
                <span>{isSavedInTracker ? "Remove from Saved" : "Save Job"}</span>
              </button>
            </div>

            {/* AI Tailoring Actions */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (!candidate) {
                    toast.info("Please upload your resume first to view ATS skill highlighting for this job.");
                    router.push("/resume");
                    return;
                  }
                  setIsTailorResumeOpen(true);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-xl border border-emerald-300 bg-emerald-50 hover:bg-emerald-100/80 text-emerald-900 text-xs font-bold transition cursor-pointer shadow-2xs"
              >
                <Sparkles className="w-4 h-4 text-emerald-600" />
                <span>ATS Skill Highlighting</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  if (!candidate) {
                    toast.info("Please upload your resume first to generate tailored cover letters.");
                    router.push("/resume");
                    return;
                  }
                  setIsCoverLetterOpen(true);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-xl border border-blue-200 bg-blue-50/70 hover:bg-blue-100 text-blue-700 text-xs font-bold transition cursor-pointer"
              >
                <FileText className="w-4 h-4" />
                <span>Prepare Cover Letter</span>
              </button>
            </div>
          </div>
        </div>

        {/* ========================================================================= */}
        {/* 2. MATCH & SKILL ANALYSIS SECTION                                         */}
        {/* ========================================================================= */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-2xs space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-blue-600" />
              <h2 className="text-base sm:text-lg font-bold text-slate-900">
                Match & Skill Analysis
              </h2>
            </div>

            {diagnostics && (
              <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                {diagnostics.score}% Match
              </span>
            )}
          </div>

          {candidate ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                <div className="p-4 rounded-xl bg-emerald-50/60 border border-emerald-100 space-y-2 text-xs">
                  <span className="font-bold text-emerald-900 block text-xs">
                    ✓ Matched Skills
                  </span>
                  <p className="text-emerald-800 text-[11px]">
                    Skills from your profile found in this job:
                  </p>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {diagnostics?.matchedSkills.length ? (
                      diagnostics.matchedSkills.map((s) => (
                        <span key={s} className="px-2 py-0.5 rounded bg-white text-emerald-800 font-semibold border border-emerald-200 text-[11px]">
                          {s}
                        </span>
                      ))
                    ) : (
                      <span className="text-slate-400 italic">No direct skill overlap</span>
                    )}
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-amber-50/60 border border-amber-100 space-y-2 text-xs">
                  <span className="font-bold text-amber-900 block text-xs">
                    ⚠ Missing Skills
                  </span>
                  <p className="text-amber-800 text-[11px]">
                    Required skills not currently on your profile:
                  </p>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {diagnostics?.missingSkills.length ? (
                      diagnostics.missingSkills.map((s) => (
                        <span key={s} className="px-2 py-0.5 rounded bg-white text-amber-800 font-semibold border border-amber-200 text-[11px]">
                          {s}
                        </span>
                      ))
                    ) : (
                      <span className="text-emerald-700 font-semibold">Zero critical skill gaps!</span>
                    )}
                  </div>
                </div>
              </div>

              {diagnostics && (
                <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setIsDiagnosticsOpen(true)}
                    className="text-xs font-bold text-blue-600 hover:text-blue-800 flex items-center gap-1 cursor-pointer"
                  >
                    <span>View Full Score Breakdown →</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsTailorResumeOpen(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 text-xs font-bold transition cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Highlight Skills for this Role →</span>
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-center space-y-2">
              <p className="text-xs text-slate-600">
                Upload your resume to see your match score and skill gaps.
              </p>
              <Link
                href="/resume"
                className="inline-flex items-center gap-1.5 text-xs font-bold text-blue-600 hover:text-blue-800"
              >
                <span>Upload Resume →</span>
              </Link>
            </div>
          )}
        </div>

        {/* ========================================================================= */}
        {/* 3. ROLE OVERVIEW                                                          */}
        {/* ========================================================================= */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-2xs space-y-4">
          <h2 className="text-base sm:text-lg font-bold text-slate-900">
            About the Role
          </h2>

          <div className="text-xs sm:text-sm text-slate-700 leading-relaxed space-y-3">
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-100 space-y-2 font-mono text-xs text-slate-800">
              <p>• Category: {job.category || "General Tech"}</p>
              <p>• Location: {job.location || "Remote"}</p>
              <p>• Employment Type: {job.type || "Full-Time"}</p>
              {job.salary && <p>• Compensation: {job.salary}</p>}
            </div>
            {job.description ? (
              <div className="pt-2 whitespace-pre-wrap">{job.description}</div>
            ) : (
              <p className="text-slate-500">
                Apply directly on the employer&apos;s site to view the complete posting and application requirements.
              </p>
            )}
          </div>
        </div>
      </main>

      {/* ========================================================================= */}
      {/* 4. POST-APPLY CONFIRMATION MODAL ("Did you submit it?")                   */}
      {/* ========================================================================= */}
      {showApplyConfirmModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200 space-y-4">
            <div className="w-12 h-12 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-6 h-6" />
            </div>

            <div className="text-center space-y-1">
              <h3 className="text-base sm:text-lg font-bold text-slate-900">
                Did you submit your application?
              </h3>
              <p className="text-xs text-slate-500">
                Opening the company portal doesn&apos;t automatically record an application. If you finalized the employer&apos;s form, we will update your pipeline.
              </p>
            </div>

            <div className="pt-2 flex flex-col sm:flex-row items-center gap-2">
              <button
                type="button"
                onClick={() => handleConfirmApplication("applied")}
                className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs sm:text-sm transition shadow-xs cursor-pointer"
              >
                Yes, Mark as Applied
              </button>

              <button
                type="button"
                onClick={() => handleConfirmApplication("saved")}
                className="w-full py-3 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold text-xs sm:text-sm transition cursor-pointer"
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
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-50 flex flex-col">
          <GuideHeader />
          <div className="flex-1 flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        </div>
      }
    >
      <JobDetailInner />
    </Suspense>
  );
}
