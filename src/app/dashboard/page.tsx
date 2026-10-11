"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import ProUpgradeScreen from "@/components/billing/ProUpgradeScreen";
import ProOnboardingCard from "@/components/onboarding/ProOnboardingCard";
import ResumeUploadAndConfirm from "@/components/resume/ResumeUploadAndConfirm";
import TopTenCompatibleJobs from "@/components/dashboard/TopTenCompatibleJobs";
import { getAuthUser, getUserPreferences } from "@/lib/auth/session";
import { UserPreferences } from "@/lib/auth/types";
import { getCandidateProfile } from "@/lib/resume/storage";
import { CandidateProfile } from "@/lib/resume/types";
import { getProAccessStatus } from "@/lib/billing/subscription";
import { getTrackedApplications } from "@/lib/tracker/storage";
import { TrackedApplication } from "@/lib/tracker/types";
import type { User } from "@supabase/supabase-js";
import {
  Sparkles,
  Briefcase,
  FileText,
  CheckCircle2,
  Settings,
  ArrowRight,
  TrendingUp,
} from "lucide-react";

export default function DashboardPage() {
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPro, setIsPro] = useState(false);
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
        router.replace("/login?next=/dashboard");
        return;
      }
      setUser(authUser);
      loadData(authUser);
    });
  }, [router, loadData]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <GuideHeader />
        <main className="flex-1 flex items-center justify-center p-6">
          <div className="text-center space-y-2">
            <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-xs font-semibold text-slate-500">Loading your account...</p>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  // TIER 2: Signed-in but NOT Pro
  if (!isPro) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <GuideHeader />
        <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-8">
          <ProUpgradeScreen
            title="Unlock CareerMonke Pro"
            subtitle="Access full job details, compatibility scores, and the guided Top 10 job-fit flow."
          />
        </main>
        <Footer />
      </div>
    );
  }

  // TIER 3: PRO USER (Guided Pro Flow)
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      <GuideHeader />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        {/* Step Indicator & Flow Bar */}
        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-2xs flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-1 rounded-full text-xs font-extrabold bg-blue-600 text-white shadow-2xs">
              PRO MEMBER
            </span>
            <span className="text-xs text-slate-500 font-medium">
              {candidate?.confirmedAt
                ? `Active Profile: ${candidate.headline || candidate.name}`
                : "Guided Setup in Progress"}
            </span>
          </div>

          <div className="flex items-center gap-1 sm:gap-2 text-xs">
            <button
              type="button"
              onClick={() => setActiveStep("onboarding")}
              className={`px-3 py-1.5 rounded-xl font-bold transition cursor-pointer ${
                activeStep === "onboarding"
                  ? "bg-blue-50 text-blue-700 border border-blue-200"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              1. Preferences
            </button>
            <span className="text-slate-300">→</span>
            <button
              type="button"
              onClick={() => setActiveStep("resume")}
              className={`px-3 py-1.5 rounded-xl font-bold transition cursor-pointer ${
                activeStep === "resume"
                  ? "bg-blue-50 text-blue-700 border border-blue-200"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              2. Resume
            </button>
            <span className="text-slate-300">→</span>
            <button
              type="button"
              onClick={() => {
                if (candidate?.confirmedAt) setActiveStep("matches");
              }}
              disabled={!candidate?.confirmedAt}
              className={`px-3 py-1.5 rounded-xl font-bold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                activeStep === "matches"
                  ? "bg-blue-50 text-blue-700 border border-blue-200"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              3. Top 10 Jobs
            </button>
          </div>
        </div>

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
          <div className="space-y-4">
            <div className="bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 shadow-md">
              <div className="mb-4 pb-3 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-blue-600 uppercase tracking-wider">
                    Step 2 of 2 • Guided Pro Flow
                  </span>
                  <h2 className="text-xl sm:text-2xl font-extrabold text-slate-900">
                    Verify Your Resume Facts
                  </h2>
                  <p className="text-xs text-slate-500">
                    Upload your resume document or skip to fill in verified facts manually.
                  </p>
                </div>

                {candidate?.confirmedAt && (
                  <button
                    type="button"
                    onClick={() => setActiveStep("matches")}
                    className="text-xs font-bold text-blue-600 hover:underline px-3 py-1.5 rounded-lg hover:bg-blue-50"
                  >
                    View Top 10 Matches →
                  </button>
                )}
              </div>

              <ResumeUploadAndConfirm
                onProfileConfirmed={(p) => {
                  setCandidate(p);
                  setActiveStep("matches");
                }}
              />
            </div>
          </div>
        )}

        {/* STEP 3 & 4: TOP 10 JOBS WITH COMPATIBLE SCORE & PER-JOB AI ACTIONS */}
        {activeStep === "matches" && candidate && (
          <div className="space-y-6">
            <TopTenCompatibleJobs candidate={candidate} isPro={isPro} />

            {/* Quick Pipeline Status Strip */}
            <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-2xs flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
              <div className="flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-blue-600" />
                <span className="font-bold text-slate-800">Application Pipeline:</span>
                <span>
                  {applications.length > 0
                    ? `${applications.length} saved or active applications`
                    : "0 tracked applications"}
                </span>
              </div>
              <Link
                href="/tracker"
                prefetch={false}
                className="font-bold text-blue-600 hover:text-blue-800 inline-flex items-center gap-1"
              >
                <span>Open Application Tracker</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        )}

        {/* Fallback prompt if step is matches but resume is not uploaded */}
        {activeStep === "matches" && !candidate && (
          <div className="bg-white rounded-3xl border border-slate-200 p-8 text-center space-y-4 shadow-sm">
            <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto">
              <FileText className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-bold text-slate-900">Resume Required for Scoring</h3>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Upload your resume or fill skills manually to compute your Top 10 compatible job matches.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setActiveStep("resume")}
              className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-xs cursor-pointer inline-flex items-center gap-1.5"
            >
              <span>Add Resume Facts</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
