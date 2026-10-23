"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import { toast } from "react-toastify";
import GuideHeader from "@/components/GuideHeader";
import AppIconRail from "@/components/shell/AppIconRail";
import { useSidebarMode } from "@/lib/sidebar";
import AppTopBar from "@/components/shell/AppTopBar";
import type { User } from "@supabase/supabase-js";
import Footer from "@/components/Footer";
import ProUpgradeScreen from "@/components/billing/ProUpgradeScreen";
import ResumeUploadAndConfirm from "@/components/resume/ResumeUploadAndConfirm";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { buttonClasses } from "@/components/ui/button";
import { getCandidateProfile, deleteCandidateProfile } from "@/lib/resume/storage";
import { CandidateProfile } from "@/lib/resume/types";
import { getAuthUser } from "@/lib/auth/session";
import { getProAccessStatus } from "@/lib/billing/subscription";
import { downloadAtsResumeDocx, downloadAtsResumeText } from "@/lib/resume/tailor";
import {
  FileText,
  Download,
  Trash2,
  CheckCircle2,
  FileCheck,
  UploadCloud,
  Cpu,
  Check,
  Sparkles,
  ArrowRight,
  MapPin,
  Mail,
  Phone,
  Briefcase,
  GraduationCap,
} from "lucide-react";

function ResumeSkeleton({ user, isPro }: { user?: User | null; isPro?: boolean }) {
  const { isExpanded } = useSidebarMode();
  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex flex-col font-sans">
      <AppIconRail />
      <div className={`flex-1 ${isExpanded ? "md:pl-[240px]" : "md:pl-[72px]"} flex flex-col min-w-0 pb-6 md:pb-0 transition-[padding] duration-300 ease-[cubic-bezier(0.2,0,0,1)]`}>
        <AppTopBar pageLabel="RESUME" user={user} isPro={isPro} />
        <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-tk-3 sm:py-tk-4 space-y-tk-3">
        {/* Header Ribbon Skeleton */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-tk-2 pb-tk-2 border-b border-line">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-7 w-56 rounded-tk-md" />
              <Skeleton className="h-6 w-32 rounded-tk-full" />
            </div>
            <Skeleton className="h-4 w-80 rounded-tk-sm" />
          </div>
          <Skeleton className="h-10 w-28 rounded-tk-lg" />
        </div>

        {/* Step Progress Skeleton */}
        <Card variant="surface" className="p-tk-2 flex items-center justify-between gap-tk-2">
          <Skeleton className="h-6 w-40 rounded-tk-full" />
          <div className="flex items-center gap-tk-2">
            <Skeleton className="h-8 w-28 rounded-tk-lg" />
            <Skeleton className="h-8 w-28 rounded-tk-lg" />
            <Skeleton className="h-8 w-28 rounded-tk-lg" />
          </div>
        </Card>

        {/* Upload/Review Area Skeleton */}
        <Card variant="surface" className="p-tk-3 sm:p-tk-4 space-y-tk-2">
          <Skeleton className="h-32 w-full rounded-tk-lg" />
          <Skeleton className="h-16 w-full rounded-tk-lg" />
        </Card>
      </main>
      <Footer />
      </div>
    </div>
  );
}

export default function ResumePage() {
  const { isExpanded } = useSidebarMode();
  const router = useRouter();
  const shouldReduceMotion = useReducedMotion();

  const [candidate, setCandidate] = useState<CandidateProfile | null>(null);
  const [isPro, setIsPro] = useState(false);
  const [isProDefinitive, setIsProDefinitive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);

  const loadData = useCallback(async (userId?: string) => {
    try {
      const [proRes, cp] = await Promise.all([
        getProAccessStatus(userId),
        getCandidateProfile(userId),
      ]);
      setIsPro(proRes.isPro);
      setIsProDefinitive(Boolean(proRes.isDefinitive));
      if (cp && cp.confirmedAt) {
        setCandidate(cp);
      } else {
        setCandidate(null);
      }
    } catch {
      setCandidate(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    getAuthUser().then((u) => {
      if (!u) {
        router.replace("/login?next=/resume");
        return;
      }
      setUser(u);
      loadData(u.id);
    });

    const handleUpdate = () => {
      getAuthUser().then((u) => {
        if (u) {
          setUser(u);
          loadData(u.id);
        }
      });
    };
    window.addEventListener("careermonke_profile_updated", handleUpdate);
    return () => window.removeEventListener("careermonke_profile_updated", handleUpdate);
  }, [router, loadData]);

  const handleDeleteProfile = async () => {
    if (
      !window.confirm(
        "Are you sure you want to delete your confirmed resume facts? This will reset all personalized match scores."
      )
    ) {
      return;
    }
    await deleteCandidateProfile();
    setCandidate(null);
    toast.info("Resume facts deleted. Personalized match scores reset.");
  };

  if (loading || (!isPro && !isProDefinitive)) {
    return <ResumeSkeleton user={user} isPro={isPro} />;
  }

  // Definitively non-Pro
  if (!isPro) {
    return (
      <div className="min-h-screen bg-surface-subtle text-ink flex flex-col font-sans">
        <GuideHeader />
        <main id="main-content" className="flex-1 max-w-5xl mx-auto px-4 sm:px-6 py-tk-3 sm:py-tk-4 w-full">
          <ProUpgradeScreen
            title="Unlock CareerMonke Pro"
            subtitle="Upgrade to Pro to upload your resume, compute compatibility scores, and generate AI tailored applications."
          />
        </main>
        <Footer />
      </div>
    );
  }

  const entrance = shouldReduceMotion
    ? {}
    : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.2 } };

  // Step state for progress bar
  const isConfirmed = Boolean(candidate && candidate.confirmedAt);

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex flex-col font-sans">
      <AppIconRail />

      <div className={`flex-1 ${isExpanded ? "md:pl-[240px]" : "md:pl-[72px]"} flex flex-col min-w-0 pb-6 md:pb-0 transition-[padding] duration-300 ease-[cubic-bezier(0.2,0,0,1)]`}>
        <AppTopBar pageLabel="RESUME" user={user} isPro={isPro} />

        <main
          id="main-content"
          className="flex-1 max-w-5xl mx-auto px-4 sm:px-6 py-tk-3 sm:py-tk-4 w-full"
        >
        <motion.div {...entrance} className="space-y-tk-3">
          {/* ================================================================= */}
          {/* HEADER RIBBON                                                     */}
          {/* ================================================================= */}
          <div
            data-testid="resume-header"
            className="flex flex-col sm:flex-row sm:items-center justify-between gap-tk-2 pb-tk-2 border-b border-line"
          >
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[18px] font-bold uppercase tracking-wider text-ink">
                  Resume & Fact Profile
                </h1>
                {isConfirmed ? (
                  <Badge tone="success" size="md" dot>
                    <span>Confirmed Facts</span>
                  </Badge>
                ) : (
                  <Badge tone="neutral" size="md">
                    <span>No Resume Uploaded</span>
                  </Badge>
                )}
              </div>
              <p className="text-tk-body-sm text-ink-muted">
                Verified fact extraction with zero invented achievements. Review and confirm facts before saving.
              </p>
            </div>

            {candidate && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleDeleteProfile}
                  className={buttonClasses({
                    variant: "destructive",
                    size: "md",
                    className: "min-h-[44px] cursor-pointer",
                  })}
                >
                  <Trash2 className="w-4 h-4" />
                  <span>Delete Facts</span>
                </button>
              </div>
            )}
          </div>

          {/* ================================================================= */}
          {/* PROGRESS STEP BAR                                                 */}
          {/* ================================================================= */}
          <Card
            variant="surface"
            data-testid="resume-progress-steps"
            className="p-tk-2 flex flex-wrap items-center justify-between gap-tk-2"
          >
            <div className="flex items-center gap-tk-1">
              <span className="w-8 h-8 rounded-tk-lg bg-brand-50 text-brand-700 flex items-center justify-center font-bold text-tk-caption">
                3-Step
              </span>
              <span className="text-tk-body-sm font-semibold text-ink">Fact Extraction Pipeline</span>
            </div>

            <nav aria-label="Resume upload pipeline steps" className="flex flex-wrap items-center gap-1 sm:gap-tk-1">
              <div
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-tk-md text-tk-caption font-semibold transition-colors ${
                  isConfirmed
                    ? "bg-success-50 text-success-800"
                    : "bg-brand-50 text-brand-700 ring-1 ring-brand-200"
                }`}
              >
                {isConfirmed ? <Check className="w-3.5 h-3.5" /> : <UploadCloud className="w-3.5 h-3.5" />}
                <span>1. Upload File</span>
              </div>
              <span aria-hidden="true" className="text-ink-subtle">→</span>
              <div
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-tk-md text-tk-caption font-semibold transition-colors ${
                  isConfirmed
                    ? "bg-success-50 text-success-800"
                    : "bg-surface text-ink-muted border border-line"
                }`}
              >
                {isConfirmed ? <Check className="w-3.5 h-3.5" /> : <Cpu className="w-3.5 h-3.5" />}
                <span>2. Parse Facts</span>
              </div>
              <span aria-hidden="true" className="text-ink-subtle">→</span>
              <div
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-tk-md text-tk-caption font-semibold transition-colors ${
                  isConfirmed
                    ? "bg-success-100 text-success-900 ring-1 ring-success-300 font-bold"
                    : "bg-surface text-ink-muted border border-line"
                }`}
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>3. Confirmed Profile</span>
              </div>
            </nav>
          </Card>

          {/* ================================================================= */}
          {/* CONFIRMED PROFILE TIDY SUMMARY CARD (When Active)                */}
          {/* ================================================================= */}
          {candidate && candidate.confirmedAt && (
            <Card
              variant="surface"
              data-testid="resume-confirmed-summary"
              className="p-tk-3 sm:p-tk-4 space-y-tk-2"
            >
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-tk-2">
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-tk-h2 font-bold text-ink truncate">
                      {candidate.name || "Confirmed Candidate"}
                    </h2>
                    <Badge tone="success" size="md">
                      Verified Facts
                    </Badge>
                  </div>
                  {candidate.headline && (
                    <p className="text-tk-body-sm font-medium text-brand-700 break-words">
                      {candidate.headline}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-tk-caption text-ink-muted pt-1">
                    {candidate.location && (
                      <span className="flex items-center gap-1">
                        <MapPin className="w-3.5 h-3.5 text-ink-subtle" />
                        <span>{candidate.location}</span>
                      </span>
                    )}
                    {candidate.email && (
                      <span className="flex items-center gap-1">
                        <Mail className="w-3.5 h-3.5 text-ink-subtle" />
                        <span>{candidate.email}</span>
                      </span>
                    )}
                    {candidate.phone && (
                      <span className="flex items-center gap-1">
                        <Phone className="w-3.5 h-3.5 text-ink-subtle" />
                        <span>{candidate.phone}</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Quick ATS Export Actions */}
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => downloadAtsResumeDocx(candidate)}
                    className={buttonClasses({
                      variant: "ghost",
                      size: "md",
                      className: "min-h-[44px] cursor-pointer border border-line bg-surface hover:bg-surface-muted text-ink",
                    })}
                    title="Export ATS-Friendly Word Document (.docx)"
                  >
                    <Download className="w-4 h-4 text-brand-600" />
                    <span>Export Word (.docx)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadAtsResumeText(candidate)}
                    className={buttonClasses({
                      variant: "ghost",
                      size: "md",
                      className: "min-h-[44px] cursor-pointer",
                    })}
                    title="Export Plain Text (.txt)"
                  >
                    <FileText className="w-4 h-4 text-ink-muted" />
                    <span>Export Text</span>
                  </button>
                </div>
              </div>

              {/* Quick metrics counters */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-tk-1 pt-2 border-t border-line">
                <div className="p-2.5 rounded-tk-md bg-surface-subtle">
                  <span className="text-tk-caption text-ink-muted font-medium">Skills Identified</span>
                  <p className="text-tk-body font-bold text-ink">{candidate.skills?.length || 0}</p>
                </div>
                <div className="p-2.5 rounded-tk-md bg-surface-subtle">
                  <span className="text-tk-caption text-ink-muted font-medium">Work History</span>
                  <p className="text-tk-body font-bold text-ink">{candidate.experience?.length || 0} roles</p>
                </div>
                <div className="p-2.5 rounded-tk-md bg-surface-subtle">
                  <span className="text-tk-caption text-ink-muted font-medium">Education</span>
                  <p className="text-tk-body font-bold text-ink">{candidate.education?.length || 0} entries</p>
                </div>
                <div className="p-2.5 rounded-tk-md bg-surface-subtle">
                  <span className="text-tk-caption text-ink-muted font-medium">Status</span>
                  <p className="text-tk-body font-bold text-success-700">Confirmed</p>
                </div>
              </div>

              {/* Top Skills Preview */}
              {candidate.skills && candidate.skills.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <span className="text-tk-caption font-semibold uppercase tracking-wider text-ink-subtle">
                    Extracted Core Competencies
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {candidate.skills.slice(0, 12).map((skill, idx) => (
                      <Badge key={idx} tone="neutral" size="sm">
                        {skill}
                      </Badge>
                    ))}
                    {candidate.skills.length > 12 && (
                      <Badge tone="neutral" size="sm">
                        +{candidate.skills.length - 12} more
                      </Badge>
                    )}
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* ================================================================= */}
          {/* FACT PARSER & REVIEW INTERFACE                                    */}
          {/* ================================================================= */}
          <section data-testid="resume-upload-section">
            <ResumeUploadAndConfirm onProfileConfirmed={(cp: CandidateProfile) => setCandidate(cp)} />
          </section>

          {/* ================================================================= */}
          {/* EXPLANATION ON JOB TAILORING                                      */}
          {/* ================================================================= */}
          <Card variant="surface" className="p-tk-3 sm:p-tk-4 space-y-tk-1">
            <div className="flex items-center gap-2 text-ink font-bold text-tk-body-sm">
              <FileCheck className="w-4 h-4 text-brand-600" />
              <span>Role-Specific Resumes & Cover Letters</span>
            </div>
            <p className="text-tk-caption sm:text-tk-body-sm text-ink-muted leading-relaxed">
              AI resume tools are applied directly to specific roles. From your{" "}
              <Link href="/dashboard" className="text-brand-700 font-semibold hover:underline">
                Top 10 Jobs
              </Link>
              {" "}or the{" "}
              <Link href="/jobs" className="text-brand-700 font-semibold hover:underline">
                Jobs Feed
              </Link>
              , click <strong>&quot;AI Resume&quot;</strong> or <strong>&quot;Cover Letter&quot;</strong>. All generated content is strictly grounded in your confirmed profile facts.
            </p>
          </Card>
        </motion.div>
      </main>

      <Footer />
      </div>
    </div>
  );
}
