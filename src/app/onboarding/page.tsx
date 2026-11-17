"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import BrandIcon from "@/components/BrandIcon";
import { createClient } from "@/lib/supabase/client";
import { checkAccountOnboardingCompleted, markAccountOnboardingCompleted } from "@/lib/auth/onboarding";
import {
  getValidReturnUrl,
  getAuthUser,
  saveUserPreferences,
  getUserPreferences,
} from "@/lib/auth/session";
import { UserPreferences } from "@/lib/auth/types";
import { trackFunnelEvent } from "@/lib/analytics/funnel";
import { updateSwr, invalidateSwr } from "@/lib/cache/swr";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Sparkles,
  Loader2,
  Briefcase,
  Compass,
  MapPin,
  Clock,
  Layers,
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
  "Mobile Developer",
  "QA / Test Engineer",
  "Engineering Manager",
];

const EXPERIENCE_LEVELS: {
  id: UserPreferences["experienceLevel"];
  label: string;
  desc: string;
}[] = [
  { id: "entry", label: "Entry-Level", desc: "0 – 2 years of professional experience" },
  { id: "mid", label: "Mid-Level", desc: "2 – 5 years of professional experience" },
  { id: "senior", label: "Senior", desc: "5 – 8 years of professional experience" },
  { id: "lead", label: "Lead / Principal", desc: "8+ years of technical leadership" },
  { id: "intern", label: "Intern / Student", desc: "Current student or recent graduate" },
];

const WORK_MODELS: {
  id: UserPreferences["remotePreference"];
  label: string;
  desc: string;
}[] = [
  { id: "remote", label: "Remote Only", desc: "Work from home or anywhere worldwide" },
  { id: "hybrid", label: "Hybrid", desc: "Mix of office and remote days" },
  { id: "onsite", label: "On-site", desc: "Working in the employer's office" },
  { id: "any", label: "Any / Flexible", desc: "Open to remote, hybrid, or on-site roles" },
];

const PREFERRED_REGIONS = [
  "Worldwide / Remote",
  "United States",
  "United Kingdom",
  "Canada",
  "European Union",
  "India",
  "Australia / APAC",
  "Latin America",
];

const EMPLOYMENT_TYPES: {
  id: string;
  label: string;
  desc: string;
}[] = [
  { id: "full-time", label: "Full-Time", desc: "Permanent full-time role with benefits" },
  { id: "contract", label: "Contract", desc: "Contract, freelance, or consulting" },
  { id: "part-time", label: "Part-Time", desc: "Flexible or reduced hours" },
  { id: "internship", label: "Internship", desc: "Internship or graduate program" },
];

const TOTAL_STEPS = 5;

function OnboardingPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawNext = searchParams.get("returnTo") || searchParams.get("return_to") || searchParams.get("next");
  const next = getValidReturnUrl(rawNext, "/dashboard");

  // Onboarding screens: 1 = Role, 2 = Experience, 3 = Work Model, 4 = Preferred Countries, 5 = Job Type
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [existingPrefs, setExistingPrefs] = useState<UserPreferences | null>(null);

  // Preference fields (saved to existing UserPreferences and profiles)
  const [roles, setRoles] = useState<string[]>([]);
  const [customRoleInput, setCustomRoleInput] = useState("");
  const [experienceLevel, setExperienceLevel] = useState<UserPreferences["experienceLevel"] | "">("");
  const [remotePreference, setRemotePreference] = useState<UserPreferences["remotePreference"] | "">("");
  const [locations, setLocations] = useState<string[]>([]);
  const [employmentTypes, setEmploymentTypes] = useState<string[]>([]);
  const [dailyDigestOptIn] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState(false);

  // Funnel: onboarding started (once per mount, consent-gated in the emitter)
  useEffect(() => {
    trackFunnelEvent("onboarding_started", { path: "/onboarding" });
  }, []);

  // Load authenticated user and existing preferences
  useEffect(() => {
    let isMounted = true;
    getAuthUser().then(async (user) => {
      if (!isMounted) return;
      if (!user) {
        const returnUrl = rawNext ? `/onboarding?next=${encodeURIComponent(rawNext)}` : "/onboarding";
        router.replace(`/login?returnTo=${encodeURIComponent(returnUrl)}`);
        return;
      }
      setUserId(user.id);
      setCheckingAuth(false);

      try {
        const supabase = createClient();
        const isCompleted = await checkAccountOnboardingCompleted(supabase, user.id);
        if (isCompleted) {
          router.replace(next);
          return;
        }

        const prefs = await getUserPreferences(user.id);
        if (prefs) {
          setExistingPrefs(prefs);
          if (Array.isArray(prefs.roles) && prefs.roles.length > 0) setRoles(prefs.roles);
          if (prefs.experienceLevel) setExperienceLevel(prefs.experienceLevel);
          if (prefs.remotePreference) setRemotePreference(prefs.remotePreference);
          if (Array.isArray(prefs.locations) && prefs.locations.length > 0) setLocations(prefs.locations);
          if (Array.isArray(prefs.employmentTypes) && prefs.employmentTypes.length > 0) {
            setEmploymentTypes(prefs.employmentTypes);
          }
        }
      } catch (err) {
        console.warn("Could not load initial preferences:", err);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [router, rawNext, next]);

  // Persist preferences snapshot helper
  const persistPreferences = async (completed = false) => {
    if (!userId) return;
    try {
      const basePrefs: Partial<UserPreferences> = existingPrefs ? { ...existingPrefs } : {};
      const payload: UserPreferences = {
        ...basePrefs,
        roles: roles.length > 0 ? roles : (existingPrefs?.roles ?? []),
        experienceLevel: (experienceLevel || existingPrefs?.experienceLevel || "mid") as UserPreferences["experienceLevel"],
        remotePreference: (remotePreference || existingPrefs?.remotePreference || "remote") as UserPreferences["remotePreference"],
        locations: locations.length > 0 ? locations : (existingPrefs?.locations ?? []),
        employmentTypes: employmentTypes.length > 0 ? employmentTypes : (existingPrefs?.employmentTypes ?? []),
        categories: existingPrefs?.categories ?? [],
        salaryCurrency: existingPrefs?.salaryCurrency ?? "USD",
        workAuth: existingPrefs?.workAuth,
        minSalary: existingPrefs?.minSalary,
        dailyDigestOptIn,
        onboardingCompleted: completed,
        updatedAt: new Date().toISOString(),
      };
      await saveUserPreferences(payload, userId);
      setExistingPrefs(payload);

      if (completed) {
        const supabase = createClient();
        await markAccountOnboardingCompleted(supabase, userId).catch((err) => {
          console.warn("Could not mark onboarding completed in profiles:", err);
        });
        if (roles.length > 0) {
          await supabase.from("profiles").upsert(
            {
              user_id: userId,
              target_roles: roles,
              onboarding_completed_at: new Date().toISOString(),
            },
            { onConflict: "user_id" }
          ).catch(() => {});
        }
      }
    } catch (err: any) {
      console.warn("Could not save preferences snapshot:", err);
      if (completed) {
        throw err;
      }
    }
  };

  // Navigation handlers
  const handleNextStep = async () => {
    await persistPreferences(false);
    if (currentStep < TOTAL_STEPS) {
      setCurrentStep((prev) => prev + 1);
    } else {
      await handleCompleteOnboarding();
    }
  };

  const handlePrevStep = () => {
    if (currentStep > 1) {
      setCurrentStep((prev) => prev - 1);
    }
  };

  const handleSkipQuestion = async () => {
    await persistPreferences(false);
    if (currentStep < TOTAL_STEPS) {
      setCurrentStep((prev) => prev + 1);
    } else {
      await handleCompleteOnboarding();
    }
  };

  const handleCompleteOnboarding = async () => {
    setIsSaving(true);
    try {
      await persistPreferences(true);
      if (userId) {
        updateSwr<any>(`dashboard:${userId}`, (current) =>
          current ? { ...current, onboardingCompleted: true } : current
        );
        invalidateSwr(`dashboard:${userId}`);
      }
      trackFunnelEvent("onboarding_completed", { path: "/onboarding" });
      toast.success("Preferences saved! Your personalized recommendations are ready.");
      router.push(next);
    } catch (err: any) {
      toast.error(err?.message || "Failed to save preferences. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  // Role toggle
  const toggleRole = (role: string) => {
    setRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  };

  const handleAddCustomRole = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = customRoleInput.trim();
    if (!trimmed) return;
    if (!roles.includes(trimmed)) {
      setRoles((prev) => [...prev, trimmed]);
    }
    setCustomRoleInput("");
  };

  // Location toggle
  const toggleLocation = (loc: string) => {
    setLocations((prev) =>
      prev.includes(loc) ? prev.filter((l) => l !== loc) : [...prev, loc]
    );
  };

  // Employment type toggle
  const toggleEmploymentType = (type: string) => {
    setEmploymentTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  };

  // Loading auth state
  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="flex flex-col items-center gap-3" role="status" aria-label="Loading your setup">
          <Loader2 aria-hidden="true" className="w-8 h-8 text-blue-600 animate-spin" />
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            Loading your setup...
          </p>
        </div>
      </div>
    );
  }

  // Calculate progress bar % (5 questions)
  const progressPercent = Math.round((currentStep / TOTAL_STEPS) * 100);

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col">
      {/* Top Header */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-30 shadow-2xs">
        <div className="max-w-3xl mx-auto px-4 h-14 sm:h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center p-0.5 shadow-xs border border-slate-100">
              <BrandIcon className="w-7 h-7" />
            </div>
            <span className="text-base sm:text-lg font-black text-blue-600 tracking-tight">
              CareerMonke
            </span>
          </div>

          <button
            type="button"
            onClick={handleCompleteOnboarding}
            disabled={isSaving}
            className="text-xs font-bold text-slate-500 hover:text-slate-800 transition cursor-pointer disabled:opacity-50"
          >
            Skip Setup →
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-2xl w-full mx-auto px-4 py-6 sm:py-10 flex flex-col justify-between space-y-6">
        {/* Progress Bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs font-bold text-slate-600">
            <span className="flex items-center gap-1.5 text-blue-600">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Step {currentStep} of {TOTAL_STEPS}</span>
            </span>
            <span className="text-slate-400 font-semibold">{progressPercent}%</span>
          </div>
          <div className="w-full bg-slate-200/70 rounded-full h-1.5 sm:h-2 overflow-hidden">
            <div
              className="bg-blue-600 h-full transition-all duration-300 rounded-full"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {/* STEP 1: TARGET ROLE */}
        {currentStep === 1 && (
          <div className="bg-white rounded-2xl p-5 sm:p-7 border border-slate-200 shadow-sm space-y-5 animate-fadeIn">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-bold uppercase tracking-wider">
                <Briefcase className="w-3 h-3" />
                <span>Target Role</span>
              </div>
              <h2 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                What role are you targeting?
              </h2>
              <p className="text-xs sm:text-sm text-slate-500">
                Select your target titles. We match you with verified roles.
              </p>
            </div>

            {/* Role Options */}
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {PRESET_ROLES.map((role) => {
                  const isSelected = roles.includes(role);
                  return (
                    <button
                      key={role}
                      type="button"
                      onClick={() => toggleRole(role)}
                      className={`px-3 sm:px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold border transition cursor-pointer ${
                        isSelected
                          ? "bg-blue-600 text-white border-blue-600 shadow-xs"
                          : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
                      }`}
                    >
                      {role}
                    </button>
                  );
                })}
              </div>

              {/* Custom Role Input */}
              <form onSubmit={handleAddCustomRole} className="flex gap-2 pt-1">
                <input
                  type="text"
                  aria-label="Add custom role title"
                  value={customRoleInput}
                  onChange={(e) => setCustomRoleInput(e.target.value)}
                  placeholder="Or enter a custom title (e.g. Platform Engineer)"
                  className="flex-1 text-xs sm:text-sm px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white focus:outline-blue-600 shadow-2xs"
                />
                <button
                  type="submit"
                  className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-xl transition cursor-pointer"
                >
                  + Add
                </button>
              </form>
            </div>
          </div>
        )}

        {/* STEP 2: EXPERIENCE LEVEL */}
        {currentStep === 2 && (
          <div className="bg-white rounded-2xl p-5 sm:p-7 border border-slate-200 shadow-sm space-y-5 animate-fadeIn">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-bold uppercase tracking-wider">
                <Layers className="w-3 h-3" />
                <span>Seniority Level</span>
              </div>
              <h2 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                What is your experience level?
              </h2>
              <p className="text-xs sm:text-sm text-slate-500">
                This ensures you receive opportunities matching your seniority without under- or over-qualifying.
              </p>
            </div>

            <div className="space-y-2.5">
              {EXPERIENCE_LEVELS.map((lvl) => {
                const isSelected = experienceLevel === lvl.id;
                return (
                  <button
                    key={lvl.id}
                    type="button"
                    onClick={() => setExperienceLevel(lvl.id)}
                    className={`w-full text-left p-3.5 sm:p-4 rounded-xl border transition flex items-center justify-between gap-3 cursor-pointer ${
                      isSelected
                        ? "bg-blue-50/70 border-blue-500 shadow-2xs ring-1 ring-blue-500"
                        : "bg-white border-slate-200 hover:bg-slate-50/80"
                    }`}
                  >
                    <div>
                      <p className={`text-xs sm:text-sm font-bold ${isSelected ? "text-blue-900" : "text-slate-800"}`}>
                        {lvl.label}
                      </p>
                      <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5">{lvl.desc}</p>
                    </div>
                    <div
                      className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${
                        isSelected ? "bg-blue-600 border-blue-600 text-white" : "border-slate-300"
                      }`}
                    >
                      {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* STEP 3: WORK MODEL */}
        {currentStep === 3 && (
          <div className="bg-white rounded-2xl p-5 sm:p-7 border border-slate-200 shadow-sm space-y-5 animate-fadeIn">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-bold uppercase tracking-wider">
                <Compass className="w-3 h-3" />
                <span>Work Model</span>
              </div>
              <h2 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                What work model do you prefer?
              </h2>
              <p className="text-xs sm:text-sm text-slate-500">
                Filter jobs by remote flexibility, hybrid schedules, or on-site openings.
              </p>
            </div>

            <div className="space-y-2.5">
              {WORK_MODELS.map((model) => {
                const isSelected = remotePreference === model.id;
                return (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => setRemotePreference(model.id)}
                    className={`w-full text-left p-3.5 sm:p-4 rounded-xl border transition flex items-center justify-between gap-3 cursor-pointer ${
                      isSelected
                        ? "bg-blue-50/70 border-blue-500 shadow-2xs ring-1 ring-blue-500"
                        : "bg-white border-slate-200 hover:bg-slate-50/80"
                    }`}
                  >
                    <div>
                      <p className={`text-xs sm:text-sm font-bold ${isSelected ? "text-blue-900" : "text-slate-800"}`}>
                        {model.label}
                      </p>
                      <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5">{model.desc}</p>
                    </div>
                    <div
                      className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${
                        isSelected ? "bg-blue-600 border-blue-600 text-white" : "border-slate-300"
                      }`}
                    >
                      {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* STEP 4: PREFERRED COUNTRIES */}
        {currentStep === 4 && (
          <div className="bg-white rounded-2xl p-5 sm:p-7 border border-slate-200 shadow-sm space-y-5 animate-fadeIn">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-bold uppercase tracking-wider">
                <MapPin className="w-3 h-3" />
                <span>Location Eligibility</span>
              </div>
              <h2 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                Where are you eligible to work?
              </h2>
              <p className="text-xs sm:text-sm text-slate-500">
                Choose the countries or regions matching your location and work authorization.
              </p>
            </div>

            <div className="flex flex-wrap gap-2.5 pt-1">
              {PREFERRED_REGIONS.map((region) => {
                const isSelected = locations.includes(region);
                return (
                  <button
                    key={region}
                    type="button"
                    onClick={() => toggleLocation(region)}
                    className={`px-3.5 py-2.5 rounded-xl text-xs sm:text-sm font-semibold border transition flex items-center gap-2 cursor-pointer ${
                      isSelected
                        ? "bg-blue-600 text-white border-blue-600 shadow-xs"
                        : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
                    }`}
                  >
                    <span>{region}</span>
                    {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* STEP 5: JOB TYPE */}
        {currentStep === 5 && (
          <div className="bg-white rounded-2xl p-5 sm:p-7 border border-slate-200 shadow-sm space-y-5 animate-fadeIn">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-bold uppercase tracking-wider">
                <Clock className="w-3 h-3" />
                <span>Employment Type</span>
              </div>
              <h2 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                What type of role are you seeking?
              </h2>
              <p className="text-xs sm:text-sm text-slate-500">
                Select all employment agreements you are currently open to accepting.
              </p>
            </div>

            <div className="space-y-2.5">
              {EMPLOYMENT_TYPES.map((type) => {
                const isSelected = employmentTypes.includes(type.id);
                return (
                  <button
                    key={type.id}
                    type="button"
                    onClick={() => toggleEmploymentType(type.id)}
                    className={`w-full text-left p-3.5 sm:p-4 rounded-xl border transition flex items-center justify-between gap-3 cursor-pointer ${
                      isSelected
                        ? "bg-blue-50/70 border-blue-500 shadow-2xs ring-1 ring-blue-500"
                        : "bg-white border-slate-200 hover:bg-slate-50/80"
                    }`}
                  >
                    <div>
                      <p className={`text-xs sm:text-sm font-bold ${isSelected ? "text-blue-900" : "text-slate-800"}`}>
                        {type.label}
                      </p>
                      <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5">{type.desc}</p>
                    </div>
                    <div
                      className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${
                        isSelected ? "bg-blue-600 border-blue-600 text-white" : "border-slate-300"
                      }`}
                    >
                      {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Bottom Navigation Buttons */}
        <div className="flex items-center justify-between gap-3 pt-4 border-t border-slate-200/60">
          {currentStep > 1 ? (
            <button
              type="button"
              onClick={handlePrevStep}
              disabled={isSaving}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs sm:text-sm transition cursor-pointer disabled:opacity-50"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back</span>
            </button>
          ) : (
            <div />
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSkipQuestion}
              disabled={isSaving}
              className="px-3.5 py-2.5 rounded-xl text-slate-500 hover:text-slate-800 font-bold text-xs sm:text-sm transition cursor-pointer disabled:opacity-50"
            >
              Skip
            </button>

            {currentStep < TOTAL_STEPS ? (
              <button
                type="button"
                onClick={handleNextStep}
                disabled={isSaving}
                className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-bold text-xs sm:text-sm shadow-2xs transition cursor-pointer disabled:opacity-50"
              >
                <span>Continue</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleCompleteOnboarding}
                disabled={isSaving}
                className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-bold text-xs sm:text-sm shadow-2xs transition cursor-pointer disabled:opacity-50"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <>
                    <span>View Recommended Jobs</span>
                    <Check className="w-4 h-4 stroke-[2.5]" />
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </main>
      <footer className="py-4 text-center text-xs text-slate-400">
        © 2026 Olive Ridley Media Private Limited. All rights reserved.
      </footer>
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
          <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
        </div>
      }
    >
      <OnboardingPageInner />
    </Suspense>
  );
}
