"use client";

import React, { useState, useEffect, useRef, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import BrandIcon from "@/components/BrandIcon";
import { createClient } from "@/lib/supabase/client";
import { checkAccountOnboardingCompleted } from "@/lib/auth/onboarding";
import {
  getValidReturnUrl,
  getAuthUser,
  saveUserPreferences,
  getUserPreferences,
} from "@/lib/auth/session";
import { UserPreferences } from "@/lib/auth/types";
import { trackFunnelEvent } from "@/lib/analytics/funnel";
import {
  validateResumeUploadFile,
  extractTextFromFile,
  parseResumeText,
} from "@/lib/resume/parser";
import { saveConfirmedCandidateProfile } from "@/lib/resume/storage";
import { CandidateProfile } from "@/lib/resume/types";
import { updateSwr, invalidateSwr } from "@/lib/cache/swr";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  FileText,
  Upload,
  Sparkles,
  Loader2,
  AlertCircle,
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

type ProcessingStep = 1 | 2 | 3 | 4;

function OnboardingPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawNext = searchParams.get("returnTo") || searchParams.get("return_to") || searchParams.get("next");
  const next = getValidReturnUrl(rawNext, "/dashboard");

  // Onboarding screens: 1 = Role, 2 = Experience, 3 = Work Model, 4 = Preferred Countries, 5 = Job Type, 6 = Upload Resume
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [existingPrefs, setExistingPrefs] = useState<UserPreferences | null>(null);

  // Preference fields (saved to existing UserPreferences)
  const [roles, setRoles] = useState<string[]>([]);
  const [customRoleInput, setCustomRoleInput] = useState("");
  const [experienceLevel, setExperienceLevel] = useState<UserPreferences["experienceLevel"] | "">("");
  const [remotePreference, setRemotePreference] = useState<UserPreferences["remotePreference"] | "">("");
  const [locations, setLocations] = useState<string[]>([]);
  const [employmentTypes, setEmploymentTypes] = useState<string[]>([]);
  const [dailyDigestOptIn, setDailyDigestOptIn] = useState<boolean>(true);

  // Resume Processing State (Jobright style)
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStep, setProcessingStep] = useState<ProcessingStep>(1);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
          if (typeof prefs.dailyDigestOptIn === "boolean") {
            setDailyDigestOptIn(prefs.dailyDigestOptIn);
          }
        }
      } catch (err) {
        console.warn("Could not load initial preferences:", err);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [router, rawNext]);

  // Persist preferences snapshot helper
  const persistPreferences = async (completed = false) => {
    if (!userId) return;
    try {
      const basePrefs: Partial<UserPreferences> = existingPrefs ? { ...existingPrefs } : {};
      const payload: UserPreferences = {
        ...basePrefs,
        // Save only the 5 answered fields on top, keeping skipped fields empty/unchanged
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
    if (currentStep < 6) {
      setCurrentStep((prev) => prev + 1);
    }
  };

  const handlePrevStep = () => {
    if (currentStep > 1) {
      setCurrentStep((prev) => prev - 1);
    }
  };

  const handleSkipQuestion = async () => {
    await persistPreferences(false);
    if (currentStep < 6) {
      setCurrentStep((prev) => prev + 1);
    } else {
      await handleSkipResume();
    }
  };

  const handleSkipResume = async () => {
    try {
      await persistPreferences(true);
      if (userId) {
        updateSwr<any>(`dashboard:${userId}`, (current) =>
          current ? { ...current, onboardingCompleted: true } : current
        );
        invalidateSwr(`dashboard:${userId}`);
      }
      toast.info("Preferences saved! You can upload your resume anytime from the dashboard.");
      router.push(next);
    } catch (err: any) {
      toast.error(err?.message || "Failed to save preferences. Please try again.");
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

  // Resume Processing Stepper Execution (Strictly real events, no fake timers, no AI before payment)
  const processResumeFile = async (file: File) => {
    setSelectedFile(file);
    setIsProcessing(true);
    setProcessingError(null);

    try {
      // Step 1: Uploading & format validation
      setProcessingStep(1);
      const validation = validateResumeUploadFile(file);
      if (!validation.valid) {
        throw new Error(validation.error || "Invalid file format. Please upload a PDF, DOCX, or TXT document under 10MB.");
      }

      // Step 2: Reading your resume (extracting raw text)
      setProcessingStep(2);
      const extractedText = await extractTextFromFile(file);
      if (!extractedText || extractedText.trim().length < 40) {
        throw new Error(
          "Could not extract sufficient text from this file. Please ensure the document is not an image-only scan or password-protected."
        );
      }

      // Step 3: Extracting skills and experience (Strictly deterministic non-AI parser)
      setProcessingStep(3);
      const parsed = parseResumeText(extractedText);
      const candidateProfile: CandidateProfile = {
        ...parsed.profile,
        confirmedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await saveConfirmedCandidateProfile(candidateProfile);

      // Step 4: Saving your preferences (Persist final completed preferences)
      setProcessingStep(4);
      const basePrefs: Partial<UserPreferences> = existingPrefs ? { ...existingPrefs } : {};
      const finalPrefs: UserPreferences = {
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
        onboardingCompleted: true,
        updatedAt: new Date().toISOString(),
      };
      await saveUserPreferences(finalPrefs, userId);
      setExistingPrefs(finalPrefs);
      if (userId) {
        updateSwr<any>(`dashboard:${userId}`, (current) =>
          current ? { ...current, onboardingCompleted: true } : current
        );
        invalidateSwr(`dashboard:${userId}`);
      }
      trackFunnelEvent("onboarding_completed", { path: "/onboarding" });

      // Successfully processed: redirect to dashboard
      toast.success("Resume saved");
      setTimeout(() => {
        router.push(next);
      }, 400);
    } catch (err: any) {
      console.error("Resume processing failed:", err);
      setProcessingError(err?.message || "Failed to process resume. Please try another file or skip to dashboard.");
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processResumeFile(file);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processResumeFile(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
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

  // =========================================================================
  // FULL-PAGE RESUME PROCESSING SCREEN (Jobright Style)
  // =========================================================================
  if (isProcessing) {
    const stepsConfig = [
      {
        step: 1,
        title: "Uploading",
        desc: "Validating file format and secure payload",
        doneDesc: "File validated successfully",
      },
      {
        step: 2,
        title: "Reading your resume",
        desc: "Extracting raw text from document",
        doneDesc: "Document text read successfully",
      },
      {
        step: 3,
        title: "Extracting skills and experience",
        desc: "Structuring skills, experience, and timeline",
        doneDesc: "Verified candidate profile created",
      },
      {
        step: 4,
        title: "Saving your preferences",
        desc: "Updating your target role, work model, and location preferences",
        doneDesc: "Preferences saved successfully",
      },
    ];

    return (
      <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col items-center justify-center p-4 sm:p-6 animate-fadeIn">
        <div className="w-full max-w-lg bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-xl space-y-6">
          {/* Header */}
          <div className="text-center space-y-2">
            <div className="w-12 h-12 rounded-2xl bg-blue-50 border border-blue-100 flex items-center justify-center mx-auto shadow-2xs">
              <BrandIcon className="w-8 h-8" />
            </div>
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
              Analyzing Your Profile
            </h1>
            <p className="text-xs sm:text-sm text-slate-500 max-w-sm mx-auto">
              We extract your verified facts and match you against active remote jobs.
            </p>
          </div>

          {/* Stepper list */}
          <div className="space-y-3 pt-2">
            {stepsConfig.map((s) => {
              const isDone = processingStep > s.step || (processingStep === 4 && !processingError);
              const isCurrent = processingStep === s.step && !processingError;
              const isFailed = processingStep === s.step && Boolean(processingError);

              return (
                <div
                  key={s.step}
                  className={`flex items-start gap-3.5 p-3.5 rounded-xl border transition-all duration-200 ${
                    isCurrent
                      ? "bg-blue-50/70 border-blue-200 shadow-2xs"
                      : isDone
                      ? "bg-slate-50/60 border-slate-200"
                      : isFailed
                      ? "bg-rose-50/70 border-rose-200"
                      : "bg-white border-slate-100 opacity-60"
                  }`}
                >
                  {/* Status Icon */}
                  <div className="shrink-0 mt-0.5">
                    {isDone ? (
                      <div className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shadow-2xs">
                        <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                      </div>
                    ) : isCurrent ? (
                      <div className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center shadow-2xs">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      </div>
                    ) : isFailed ? (
                      <div className="w-6 h-6 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center shadow-2xs">
                        <AlertCircle className="w-3.5 h-3.5" />
                      </div>
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-slate-100 text-slate-400 text-xs font-bold flex items-center justify-center">
                        {s.step}
                      </div>
                    )}
                  </div>

                  {/* Text Content */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p
                        className={`text-xs sm:text-sm font-bold truncate ${
                          isFailed
                            ? "text-rose-900"
                            : isCurrent
                            ? "text-blue-900"
                            : isDone
                            ? "text-slate-800"
                            : "text-slate-500"
                        }`}
                      >
                        {s.title}
                      </p>
                      {isDone && (
                        <span className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider shrink-0">
                          Complete
                        </span>
                      )}
                      {isCurrent && (
                        <span className="text-[10px] font-bold text-blue-600 uppercase tracking-wider shrink-0 animate-pulse">
                          In progress
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5 leading-snug">
                      {isDone ? s.doneDesc : s.desc}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Error & Retry Display */}
          {processingError && (
            <div role="alert" className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 text-xs space-y-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <p className="leading-relaxed">{processingError}</p>
              </div>
              <div className="flex flex-col sm:flex-row items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setIsProcessing(false);
                    setProcessingError(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  className="w-full sm:w-auto px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs shadow-2xs transition cursor-pointer"
                >
                  Try Another File
                </button>
                <button
                  type="button"
                  onClick={handleSkipResume}
                  className="w-full sm:w-auto px-4 py-2 rounded-xl bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 font-bold text-xs transition cursor-pointer"
                >
                  Skip to Dashboard
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Calculate progress bar % (5 questions + 1 resume step = 6 steps)
  const progressPercent = Math.round((currentStep / 6) * 100);

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
            onClick={handleSkipResume}
            className="text-xs font-bold text-slate-500 hover:text-slate-800 transition cursor-pointer"
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
              <span>Step {currentStep} of 6</span>
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
                Select your target titles. We match you with roles directly from career pages before aggregators index them.
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

        {/* STEP 6: UPLOAD RESUME */}
        {currentStep === 6 && (
          <div className="bg-white rounded-2xl p-5 sm:p-7 border border-slate-200 shadow-sm space-y-5 animate-fadeIn">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-bold uppercase tracking-wider">
                <FileText className="w-3 h-3" />
                <span>Resume Upload</span>
              </div>
              <h2 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                Upload your resume to see where you stand
              </h2>
              <p className="text-xs sm:text-sm text-slate-500">
                We extract your verified skills and compute match compatibility with unindexed jobs.
              </p>
            </div>

            {/* Drag & Drop Upload Zone */}
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl p-8 sm:p-10 text-center cursor-pointer transition-all duration-150 ${
                isDragging
                  ? "border-blue-500 bg-blue-50/50"
                  : "border-slate-200 hover:border-blue-400 bg-slate-50/60"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.txt"
                onChange={handleFileChange}
                className="hidden"
                aria-label="Upload resume file"
              />

              <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto mb-3 shadow-2xs">
                <Upload className="w-6 h-6" />
              </div>

              <p className="text-xs sm:text-sm font-bold text-slate-900">
                Click to browse or drag and drop your resume
              </p>
              <p className="text-[11px] sm:text-xs text-slate-500 mt-1">
                Supports PDF, DOCX, and TXT (up to 10MB)
              </p>
            </div>

            {/* Daily Digest Opt-In Checkbox */}
            <div className="p-3.5 rounded-xl border border-blue-100 bg-blue-50/50 flex items-start gap-3 text-left">
              <input
                type="checkbox"
                id="daily-digest"
                checked={dailyDigestOptIn}
                onChange={(e) => setDailyDigestOptIn(e.target.checked)}
                className="mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
              />
              <label htmlFor="daily-digest" className="text-xs text-slate-700 cursor-pointer select-none">
                <span className="font-bold text-slate-900 block">Enable Automated Daily Job Matching Digest</span>
                Scan connected company career portals daily and queue verified matching positions into your tracker.
              </label>
            </div>

            <div className="text-center pt-2">
              <button
                type="button"
                onClick={handleSkipResume}
                className="text-xs font-semibold text-slate-500 hover:text-slate-800 underline transition cursor-pointer"
              >
                Skip upload and configure manually on Dashboard →
              </button>
            </div>
          </div>
        )}

        {/* Bottom Navigation Buttons */}
        <div className="flex items-center justify-between gap-3 pt-4 border-t border-slate-200/60">
          {currentStep > 1 ? (
            <button
              type="button"
              onClick={handlePrevStep}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs sm:text-sm transition cursor-pointer"
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
              className="px-3.5 py-2.5 rounded-xl text-slate-500 hover:text-slate-800 font-bold text-xs sm:text-sm transition cursor-pointer"
            >
              Skip
            </button>

            {currentStep < 6 && (
              <button
                type="button"
                onClick={handleNextStep}
                className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-bold text-xs sm:text-sm shadow-2xs transition cursor-pointer"
              >
                <span>Continue</span>
                <ArrowRight className="w-4 h-4" />
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
