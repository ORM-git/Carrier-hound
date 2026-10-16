"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import BrandIcon from "@/components/BrandIcon";
import { getValidReturnUrl, getAuthUser, saveUserPreferences, getUserPreferences } from "@/lib/auth/session";
import { UserPreferences, DEFAULT_USER_PREFERENCES } from "@/lib/auth/types";
import ResumeUploadAndConfirm from "@/components/resume/ResumeUploadAndConfirm";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import ProUpgradeScreen from "@/components/billing/ProUpgradeScreen";
import { getCandidateProfile, deleteCandidateProfile } from "@/lib/resume/storage";
import { CandidateProfile } from "@/lib/resume/types";
import { getProAccessStatus } from "@/lib/billing/subscription";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Briefcase,
  FileText,
  Check,
  ShieldCheck,
  Mail,
  DollarSign,
  MapPin,
  Sparkles,
  HelpCircle,
  Clock
} from "lucide-react";
import { toast } from "react-toastify";

const PRESET_ROLES = [
  "Frontend Developer",
  "Backend Engineer",
  "Full-Stack Developer",
  "Data Scientist / AI",
  "Product Manager",
  "UI/UX Designer",
  "DevOps / Cloud Engineer",
  "Sales & Business Dev",
  "Operations / Marketing"
];

function OnboardingPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawNext = searchParams.get("next");
  const next = getValidReturnUrl(rawNext, "/dashboard");

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isPro, setIsPro] = useState(false);
  const [isProDefinitive, setIsProDefinitive] = useState(false);

  // Step 1: Preferences State
  const [roles, setRoles] = useState<string[]>(["Full-Stack Developer"]);
  const [customRole, setCustomRole] = useState("");
  const [experienceLevel, setExperienceLevel] = useState<UserPreferences["experienceLevel"]>("mid");
  const [employmentTypes, setEmploymentTypes] = useState<string[]>(["full-time"]);
  const [remotePreference, setRemotePreference] = useState<UserPreferences["remotePreference"]>("remote");
  const [locations, setLocations] = useState<string[]>(["Worldwide / Remote"]);
  const [workAuth, setWorkAuth] = useState("Authorized (No sponsorship needed)");
  const [minSalary, setMinSalary] = useState<number | undefined>(80000);
  const [salaryCurrency, setSalaryCurrency] = useState("USD");

  // Step 2: Resume State
  const [candidateProfile, setCandidateProfile] = useState<CandidateProfile | null>(null);
  const [resumeSkipped, setResumeSkipped] = useState(false);

  // Step 3: Review & Notification State
  const [dailyDigestOptIn, setDailyDigestOptIn] = useState(true);

  useEffect(() => {
    getAuthUser().then(async (user) => {
      if (!user) {
        const returnUrl = rawNext ? `/onboarding?next=${encodeURIComponent(rawNext)}` : "/onboarding";
        router.replace(`/login?next=${encodeURIComponent(returnUrl)}`);
        return;
      }
      setUserId(user.id);
      const proRes = await getProAccessStatus(user.id);
      setIsPro(proRes.isPro);
      setIsProDefinitive(Boolean(proRes.isDefinitive));
      setCheckingAuth(false);

      getUserPreferences(user.id).then((p) => {
        if (p.roles && p.roles.length > 0) setRoles(p.roles);
        if (p.experienceLevel) setExperienceLevel(p.experienceLevel);
        if (p.employmentTypes) setEmploymentTypes(p.employmentTypes);
        if (p.remotePreference) setRemotePreference(p.remotePreference);
        if (p.locations) setLocations(p.locations);
        if (p.workAuth) setWorkAuth(p.workAuth);
        if (p.minSalary !== undefined) setMinSalary(p.minSalary);
        if (p.salaryCurrency) setSalaryCurrency(p.salaryCurrency);
        setDailyDigestOptIn(p.dailyDigestOptIn);
      });
    });

    getCandidateProfile().then((p) => {
      // If user has a non-default confirmed profile
      if (p && p.name !== "Software Engineer") {
        setCandidateProfile(p);
      }
    });
  }, []);

  const toggleRole = (r: string) => {
    if (roles.includes(r)) {
      if (roles.length > 1) {
        setRoles(roles.filter((x) => x !== r));
      }
    } else {
      setRoles([...roles, r]);
    }
  };

  const handleAddCustomRole = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = customRole.trim();
    if (clean && !roles.includes(clean)) {
      setRoles([...roles, clean]);
      setCustomRole("");
    }
  };

  const toggleEmploymentType = (type: string) => {
    if (employmentTypes.includes(type)) {
      if (employmentTypes.length > 1) {
        setEmploymentTypes(employmentTypes.filter((t) => t !== type));
      }
    } else {
      setEmploymentTypes([...employmentTypes, type]);
    }
  };

  const handleResumeConfirmed = (p: CandidateProfile) => {
    setCandidateProfile(p);
    setResumeSkipped(false);
    toast.success("Resume facts verified! Moving to final step.");
    setStep(3);
  };

  const handleSkipResume = () => {
    setResumeSkipped(true);
    setStep(3);
  };

  const handleResumeLater = async () => {
    await savePreferences(false);
    toast.info("Preferences saved. You can complete your setup anytime from Settings.");
    router.push(next);
  };

  const savePreferences = async (completed: boolean) => {
    const prefs: UserPreferences = {
      roles,
      categories: roles.map((r) => r.toLowerCase()),
      experienceLevel,
      employmentTypes,
      locations,
      remotePreference,
      workAuth,
      minSalary,
      salaryCurrency,
      dailyDigestOptIn,
      onboardingCompleted: completed,
      updatedAt: new Date().toISOString(),
    };
    await saveUserPreferences(prefs, userId);
  };

  const handleFinishOnboarding = async () => {
    setLoading(true);
    await savePreferences(true);
    toast.success("Welcome aboard! Displaying matching career page listings.");
    router.push(next);
  };

  if (checkingAuth || (!isPro && !isProDefinitive)) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <GuideHeader />
        <main className="flex-1 flex items-center justify-center p-6">
          <div className="text-center space-y-2">
            <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-xs font-semibold text-slate-500">Checking access...</p>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  // Definitively signed-in non-Pro
  if (!isPro) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <GuideHeader />
        <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-8">
          <ProUpgradeScreen
            title="Unlock CareerMonke Pro"
            subtitle="The personalized guided setup and job matches are exclusive to CareerMonke Pro members."
          />
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#09090B] flex flex-col">
      {/* Top Header */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-30 shadow-2xs">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center p-0.5 shadow-xs border border-slate-100">
              <BrandIcon className="w-7 h-7" />
            </div>
            <span className="text-lg font-black text-blue-600 tracking-tight">CareerMonke</span>
          </div>

          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={handleResumeLater}
              className="text-xs font-semibold text-slate-500 hover:text-slate-900 transition cursor-pointer"
            >
              Resume Later
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-8 sm:py-12 space-y-6">
        {/* Step Progress Bar */}
        <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-2xs space-y-3">
          <div className="flex items-center justify-between text-xs font-bold text-slate-700">
            <span className="flex items-center gap-1.5 text-blue-600">
              <Sparkles className="w-4 h-4" />
              <span>Step {step} of 3: {step === 1 ? "Target Preferences" : step === 2 ? "Upload Resume" : "Review & Launch"}</span>
            </span>
            <span className="text-slate-400 font-medium">{Math.round((step / 3) * 100)}% Completed</span>
          </div>

          <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
            <div
              className="bg-blue-600 h-full transition-all duration-300 rounded-full"
              style={{ width: `${(step / 3) * 100}%` }}
            />
          </div>

          <div className="grid grid-cols-3 gap-2 text-center text-[11px] font-semibold text-slate-400 pt-1">
            <span className={step >= 1 ? "text-blue-600 font-bold" : ""}>1. Preferences</span>
            <span className={step >= 2 ? "text-blue-600 font-bold" : ""}>2. Resume Facts</span>
            <span className={step >= 3 ? "text-blue-600 font-bold" : ""}>3. Ready</span>
          </div>
        </div>

        {/* ========================================================================= */}
        {/* STEP 1: PREFERENCES                                                       */}
        {/* ========================================================================= */}
        {step === 1 && (
          <div className="bg-white rounded-2xl p-6 sm:p-8 border border-slate-200 shadow-2xs space-y-6 animate-fadeIn">
            <div>
              <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
                What roles are you looking for?
              </h2>
              <p className="text-xs sm:text-sm text-slate-500 mt-1">
                We use your target roles and location preferences to surface unlisted opportunities directly from employer career portals.
              </p>
            </div>

            {/* Target Roles selection */}
            <div className="space-y-3">
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
                Target Roles (Select all that apply)
              </label>
              <div className="flex flex-wrap gap-2">
                {PRESET_ROLES.map((r) => {
                  const isSelected = roles.includes(r);
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() => toggleRole(r)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition cursor-pointer ${
                        isSelected
                          ? "bg-blue-600 text-white border-blue-600 shadow-xs"
                          : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
                      }`}
                    >
                      {r}
                    </button>
                  );
                })}
              </div>

              {/* Custom Role Input */}
              <form onSubmit={handleAddCustomRole} className="flex gap-2 pt-1">
                <input
                  type="text"
                  aria-label="Or type a custom role"
                  value={customRole}
                  onChange={(e) => setCustomRole(e.target.value)}
                  placeholder="Or type a custom role (e.g. Technical Product Manager)"
                  className="flex-1 text-xs px-3.5 py-2 rounded-xl border border-slate-200 bg-white focus:outline-blue-600 shadow-2xs"
                />
                <button
                  type="submit"
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-xl transition cursor-pointer"
                >
                  + Add
                </button>
              </form>
            </div>

            {/* Experience Level & Remote Eligibility */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
                  Seniority Level
                </label>
                <select
                  value={experienceLevel}
                  onChange={(e) => setExperienceLevel(e.target.value as any)}
                  className="w-full text-xs sm:text-sm py-2.5 px-3 rounded-xl border border-slate-200 bg-white focus:outline-blue-600 shadow-2xs cursor-pointer"
                >
                  <option value="intern">Internship / Student</option>
                  <option value="entry">Entry-Level (0 - 2 years)</option>
                  <option value="mid">Mid-Level (2 - 5 years)</option>
                  <option value="senior">Senior (5 - 8 years)</option>
                  <option value="lead">Lead / Staff / Principal (8+ years)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
                  Remote Preference
                </label>
                <select
                  value={remotePreference}
                  onChange={(e) => setRemotePreference(e.target.value as any)}
                  className="w-full text-xs sm:text-sm py-2.5 px-3 rounded-xl border border-slate-200 bg-white focus:outline-blue-600 shadow-2xs cursor-pointer"
                >
                  <option value="remote">100% Remote Only</option>
                  <option value="hybrid">Hybrid (Remote + Office)</option>
                  <option value="onsite">On-Site Only</option>
                  <option value="any">Open to Any Setup</option>
                </select>
              </div>
            </div>

            {/* Employment Types */}
            <div className="space-y-2">
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
                Employment Type
              </label>
              <div className="flex flex-wrap gap-2">
                {[
                  { id: "full-time", label: "Full-Time" },
                  { id: "contract", label: "Contract / Freelance" },
                  { id: "internship", label: "Internship" },
                ].map((type) => {
                  const isSelected = employmentTypes.includes(type.id);
                  return (
                    <button
                      key={type.id}
                      type="button"
                      onClick={() => toggleEmploymentType(type.id)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition cursor-pointer ${
                        isSelected
                          ? "bg-slate-900 text-white border-slate-900 shadow-xs"
                          : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
                      }`}
                    >
                      {type.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Work Authorization & Salary Target */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
                  Work Authorization
                </label>
                <select
                  value={workAuth}
                  onChange={(e) => setWorkAuth(e.target.value)}
                  className="w-full text-xs sm:text-sm py-2.5 px-3 rounded-xl border border-slate-200 bg-white focus:outline-blue-600 shadow-2xs cursor-pointer"
                >
                  <option value="Authorized (No sponsorship needed)">Authorized (No sponsorship needed)</option>
                  <option value="Requires Visa Sponsorship">Requires Visa Sponsorship</option>
                  <option value="Worldwide Contract Eligible">Worldwide Contract / Remote Eligible</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
                  Target Salary (Optional)
                </label>
                <div className="flex gap-2">
                  <select
                    value={salaryCurrency}
                    onChange={(e) => setSalaryCurrency(e.target.value)}
                    className="w-20 text-xs py-2.5 px-2 rounded-xl border border-slate-200 bg-white focus:outline-blue-600 shadow-2xs font-bold"
                  >
                    <option value="USD">USD $</option>
                    <option value="INR">INR ₹</option>
                    <option value="EUR">EUR €</option>
                    <option value="GBP">GBP £</option>
                  </select>
                  <input
                    type="number"
                    aria-label="Minimum annual compensation expectation"
                    value={minSalary || ""}
                    onChange={(e) => setMinSalary(e.target.value ? Number(e.target.value) : undefined)}
                    placeholder="e.g. 90000"
                    className="flex-1 text-xs sm:text-sm px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white focus:outline-blue-600 shadow-2xs"
                  />
                </div>
              </div>
            </div>

            {/* Bottom Actions */}
            <div className="pt-4 border-t border-slate-100 flex items-center justify-between">
              <span className="text-xs text-slate-400">Step 1 of 3</span>
              <button
                type="button"
                onClick={() => setStep(2)}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white text-xs sm:text-sm font-bold shadow-xs transition cursor-pointer"
              >
                <span>Continue to Resume</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* STEP 2: RESUME UPLOAD OR SKIP                                             */}
        {/* ========================================================================= */}
        {step === 2 && (
          <div className="space-y-6 animate-fadeIn">
            {/* Privacy Explanation Banner */}
            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 sm:p-5 flex items-start gap-3 shadow-2xs">
              <ShieldCheck className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
              <div className="space-y-1 text-xs text-blue-900">
                <span className="font-bold">Strict Privacy & Verified Matching Policy</span>
                <p className="text-blue-800 leading-relaxed">
                  Your resume is parsed to extract real facts (skills, timeline, education).
                  We <strong>never hallucinate credentials</strong> or share your raw file.
                  If you choose to skip, we will match jobs purely based on your preferences without computing fake personal scores.
                </p>
              </div>
            </div>

            {/* Resume Upload Component */}
            <div className="bg-white rounded-2xl p-6 sm:p-8 border border-slate-200 shadow-2xs space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
                    Upload Your Resume
                  </h2>
                  <p className="text-xs sm:text-sm text-slate-500 mt-1">
                    Accepts PDF or Word (.docx). Review extracted facts before confirmation.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleSkipResume}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50 text-xs font-semibold transition cursor-pointer self-start sm:self-auto"
                >
                  Skip for now →
                </button>
              </div>

              <ResumeUploadAndConfirm onProfileConfirmed={handleResumeConfirmed} />

              <div className="pt-4 border-t border-slate-100 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-600 hover:text-slate-900 cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back to Preferences</span>
                </button>

                <button
                  type="button"
                  onClick={handleSkipResume}
                  className="text-xs font-bold text-blue-600 hover:text-blue-800 cursor-pointer"
                >
                  Skip this step & continue →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* STEP 3: REVIEW & LAUNCH                                                   */}
        {/* ========================================================================= */}
        {step === 3 && (
          <div className="bg-white rounded-2xl p-6 sm:p-8 border border-slate-200 shadow-2xs space-y-6 animate-fadeIn">
            <div className="text-center max-w-md mx-auto space-y-2">
              <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto shadow-xs">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <h2 className="text-2xl font-bold text-slate-900 tracking-tight">
                You&apos;re All Set!
              </h2>
              <p className="text-xs sm:text-sm text-slate-500">
                Review your profile summary below before viewing relevant career page listings.
              </p>
            </div>

            {/* Summary Review Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
              {/* Preferences Summary */}
              <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 space-y-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                  <Briefcase className="w-3.5 h-3.5" />
                  <span>Target Roles & Setup</span>
                </span>
                <div className="space-y-1 text-xs">
                  <div className="font-bold text-slate-800">{roles.join(", ")}</div>
                  <div className="text-slate-600 capitalize">
                    {experienceLevel} Level • {remotePreference} Setup
                  </div>
                  {minSalary && (
                    <div className="text-emerald-700 font-semibold">
                      Target Salary: {salaryCurrency} {minSalary.toLocaleString()}
                    </div>
                  )}
                </div>
              </div>

              {/* Resume Summary */}
              <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 space-y-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5" />
                  <span>Resume Status</span>
                </span>
                <div className="space-y-1 text-xs">
                  {candidateProfile && !resumeSkipped ? (
                    <>
                      <div className="font-bold text-emerald-700 flex items-center gap-1">
                        <Check className="w-3.5 h-3.5" />
                        <span>Confirmed Fact Profile</span>
                      </div>
                      <div className="text-slate-600">
                        {candidateProfile.skills.length} Skills • {candidateProfile.experience.length} Positions verified
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="font-bold text-slate-700">Skipped (No Resume)</div>
                      <div className="text-slate-500">
                        Jobs will be surfaced by target role preferences without fake personal match scores.
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Daily Digest Opt-In Checkbox */}
            <div className="p-4 rounded-xl border border-blue-100 bg-blue-50/50 flex items-start gap-3">
              <input
                type="checkbox"
                id="daily-digest"
                checked={dailyDigestOptIn}
                onChange={(e) => setDailyDigestOptIn(e.target.checked)}
                className="mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
              />
              <label htmlFor="daily-digest" className="text-xs text-slate-700 cursor-pointer">
                <span className="font-bold text-slate-900 block">Enable Automated Daily AI Matching Digest</span>
                Scan connected company career portals daily and queue verified matching positions into your tracker.
              </label>
            </div>

            {/* Final CTAs */}
            <div className="pt-4 border-t border-slate-100 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep(2)}
                className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-600 hover:text-slate-900 cursor-pointer"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>

              <button
                type="button"
                onClick={handleFinishOnboarding}
                disabled={loading}
                className="inline-flex items-center gap-2 px-8 py-3.5 rounded-xl bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white text-sm font-bold shadow-md transition cursor-pointer disabled:opacity-60"
              >
                <span>{loading ? "Preparing Dashboard…" : "Show My Jobs →"}</span>
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense>
      <OnboardingPageInner />
    </Suspense>
  );
}
