"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { checkAccountOnboardingCompleted, markAccountOnboardingCompleted } from "@/lib/auth/onboarding";
import {
  getValidReturnUrl,
  getAuthUser,
  getUserPreferences,
  saveUserPreferences,
} from "@/lib/auth/session";
import { UserPreferences } from "@/lib/auth/types";
import { trackFunnelEvent } from "@/lib/analytics/funnel";
import { updateSwr, invalidateSwr } from "@/lib/cache/swr";
import { Loader2, AlertCircle } from "lucide-react";
import { toast } from "react-toastify";
import OnboardingStep1 from "@/components/onboarding/OnboardingStep1";
import OnboardingStep2 from "@/components/onboarding/OnboardingStep2";
import { isOnboardingActive } from "@/config/onboarding";
import { normalizeUserCountries } from "@/lib/countries";

function OnboardingPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawNext = searchParams.get("returnTo") || searchParams.get("return_to") || searchParams.get("next");
  const next = getValidReturnUrl(rawNext, "/dashboard");

  const mode = searchParams.get("mode") || searchParams.get("edit");
  const isEditMode = mode === "edit" || mode === "true";

  const [currentStep, setCurrentStep] = useState<1 | 2>(1);
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const [authToken, setAuthToken] = useState<string | undefined>(undefined);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [processingError, setProcessingError] = useState<string | null>(null);

  // Form state - strictly NO invented defaults
  const [roles, setRoles] = useState<string[]>([]);
  const [employmentTypes, setEmploymentTypes] = useState<string[]>([]);
  const [country, setCountry] = useState<string>("");
  const [countryCode, setCountryCode] = useState<string>("");
  const [workAuth, setWorkAuth] = useState<string>("");
  const [openToRemote, setOpenToRemote] = useState<boolean>(true);
  const [remoteTouched, setRemoteTouched] = useState(false);
  const [existingPrefs, setExistingPrefs] = useState<UserPreferences | null>(null);

  // Funnel tracking: onboarding started on mount
  useEffect(() => {
    trackFunnelEvent("onboarding_started", { path: isEditMode ? "/onboarding?mode=edit" : "/onboarding" });
  }, [isEditMode]);

  // Auth gate & existing preferences check
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

      try {
        const supabase = createClient();
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          setAuthToken(session.access_token);
        }

        const isCompleted = await checkAccountOnboardingCompleted(supabase, user.id);
        if (!isOnboardingActive() || (isCompleted && !isEditMode)) {
          router.replace(next);
          return;
        }

        // Migrate and prefill any existing preferences
        const prefs = await getUserPreferences(user.id);
        if (prefs) {
          setExistingPrefs(prefs);

          // In edit mode or for completed users, prefill their saved values
          if (isEditMode || prefs.onboardingCompleted) {
            if (Array.isArray(prefs.roles) && prefs.roles.length > 0) {
              setRoles(prefs.roles);
            }
            if (Array.isArray(prefs.employmentTypes) && prefs.employmentTypes.length > 0) {
              setEmploymentTypes(prefs.employmentTypes);
            }
            if (prefs.country) {
              setCountry(prefs.country);
              if (prefs.countryCode) setCountryCode(prefs.countryCode);
            } else if (Array.isArray(prefs.locations) && prefs.locations.length > 0) {
              const normalized = normalizeUserCountries(prefs.locations);
              if (normalized.names.length > 0) {
                setCountry(normalized.names[0]);
                if (normalized.codes.length > 0) {
                  setCountryCode(normalized.codes[0]);
                }
              }
            }
            if (prefs.workAuth) {
              setWorkAuth(prefs.workAuth);
            }
            if (prefs.remotePreference) {
              setOpenToRemote(prefs.remotePreference !== "onsite");
            }
          } else {
            // Brand new onboarding user: strict blank state (no invented defaults)
            // Only preserve explicit prior country if specifically recognized
            if (prefs.country) {
              setCountry(prefs.country);
              if (prefs.countryCode) setCountryCode(prefs.countryCode);
            } else if (Array.isArray(prefs.locations) && prefs.locations.length > 0) {
              const normalized = normalizeUserCountries(prefs.locations);
              if (normalized.names.length > 0) {
                setCountry(normalized.names[0]);
                if (normalized.codes.length > 0) {
                  setCountryCode(normalized.codes[0]);
                }
              }
            }
            if (prefs.workAuth && prefs.workAuth !== "Authorized") {
              setWorkAuth(prefs.workAuth);
            }
          }
        }
      } catch (err) {
        console.warn("Could not load initial onboarding preferences:", err);
      } finally {
        if (isMounted) {
          setCheckingAuth(false);
        }
      }
    });

    return () => {
      isMounted = false;
    };
  }, [router, rawNext, next, isEditMode]);

  // Role toggles
  const handleToggleRole = (role: string) => {
    setRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  };

  const handleRemoveRole = (role: string) => {
    setRoles((prev) => prev.filter((r) => r !== role));
  };

  // Employment type toggle
  const handleToggleEmploymentType = (type: string) => {
    setEmploymentTypes((prev) => {
      if (prev.includes(type)) {
        return prev.filter((t) => t !== type);
      }
      return [...prev, type];
    });
  };

  // Country selection handler
  const handleSelectCountry = (c: { code: string; name: string }) => {
    setCountry(c.name);
    setCountryCode(c.code);
  };

  // Finish and save answers to user profile
  const handleFinishOnboarding = async () => {
    if (!userId) return;
    setIsSaving(true);
    setProcessingError(null);

    // Keep the saved any/hybrid/remote/onsite value unless the user actually flipped the toggle.
    const finalRemotePref: UserPreferences["remotePreference"] =
      !remoteTouched && existingPrefs?.remotePreference
        ? existingPrefs.remotePreference
        : openToRemote
          ? "remote"
          : "onsite";

    const payload = {
      roles,
      employmentTypes,
      country,
      countryCode,
      workAuth,
      remotePreference: finalRemotePref,
    };

    try {
      let savedSuccessfully = false;

      // Try server-validated endpoint first if token is available
      if (authToken) {
        let res: Response | null = null;
        try {
          res = await fetch("/api/onboarding", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify(payload),
          });
        } catch {
          // Network failure only: fall back to client session persistence below
        }
        if (res && !res.ok) {
          // The server rejected or failed the save: never bypass its validation with a client write.
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || "Failed to save preferences");
        }
        if (res?.ok) {
          savedSuccessfully = true;
        }
      }

      // Preserve all old saved locations without narrowing
      const existingLocations: string[] = Array.isArray(existingPrefs?.locations)
        ? existingPrefs.locations
        : [];
      const mergedLocations = Array.from(new Set([country, ...existingLocations])).filter(Boolean);

      const userPrefs: UserPreferences = {
        ...(existingPrefs || {}),
        roles,
        categories: existingPrefs?.categories || [],
        experienceLevel: existingPrefs?.experienceLevel || undefined,
        employmentTypes,
        locations: mergedLocations,
        country,
        countryCode: countryCode || undefined,
        workAuth,
        remotePreference: finalRemotePref,
        salaryCurrency: existingPrefs?.salaryCurrency || undefined,
        dailyDigestOptIn: false,
        onboardingCompleted: true,
        updatedAt: new Date().toISOString(),
      };

      // Always refresh local preference cache and dispatch update event
      localStorage.setItem("careermonke_preferences", JSON.stringify(userPrefs));
      window.dispatchEvent(new Event("careermonke_preferences_updated"));

      if (!savedSuccessfully) {
        // Fallback: client-side session save
        await saveUserPreferences(userPrefs, userId);
        const supabase = createClient();
        await markAccountOnboardingCompleted(supabase, userId).catch(() => {});
      }

      // Funnel event: onboarding completed
      trackFunnelEvent("onboarding_completed", { path: isEditMode ? "/onboarding?mode=edit" : "/onboarding" });

      // Update dashboard SWR cache so next mount reflects completed status
      updateSwr<any>(`dashboard:${userId}`, (current) =>
        current ? { ...current, onboardingCompleted: true } : current
      );
      invalidateSwr(`dashboard:${userId}`);

      toast.success(
        isEditMode
          ? "Preferences updated! Showing recommended jobs for your profile."
          : "Preferences saved! Showing recommended jobs for your profile."
      );

      // Post-submit navigation
      setTimeout(() => {
        router.push(next);
      }, 400);
    } catch (err: any) {
      setProcessingError(err?.message || "Failed to save your preferences. Please try again.");
      toast.error(err?.message || "Failed to save preferences.");
      setIsSaving(false);
    }
  };

  if (checkingAuth) {
    return (
      <div
        role="status"
        aria-label="Checking account status"
        aria-live="polite"
        className="min-h-screen flex flex-col items-center justify-center p-4 bg-zinc-50 dark:bg-zinc-950 text-zinc-500"
      >
        <Loader2 className="w-8 h-8 animate-spin text-emerald-600 mb-3" aria-hidden="true" />
        <span className="text-sm font-medium">Checking account status...</span>
        <span className="sr-only">Checking account status</span>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50/60 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex flex-col justify-between">
      <div>
        {/* Error alert banner if submission fails */}
        {processingError && (
          <div className="max-w-lg mx-auto w-full px-4 pt-4">
            <div
              role="alert"
              className="p-3.5 rounded-2xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300 flex items-center gap-2.5 shadow-sm"
            >
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{processingError}</span>
            </div>
          </div>
        )}

        {isSaving && (
          <p role="status" aria-live="polite" className="sr-only">
            Saving your preferences
          </p>
        )}

        {currentStep === 1 ? (
          <OnboardingStep1
            roles={roles}
            onToggleRole={handleToggleRole}
            onRemoveRole={handleRemoveRole}
            employmentTypes={employmentTypes}
            onToggleEmploymentType={handleToggleEmploymentType}
            country={country}
            onSelectCountry={handleSelectCountry}
            openToRemote={openToRemote}
            onToggleOpenToRemote={() => {
              setRemoteTouched(true);
              setOpenToRemote(!openToRemote);
            }}
            workAuth={workAuth}
            onSelectWorkAuth={setWorkAuth}
            isEditMode={isEditMode}
            onNext={() => {
              setProcessingError(null);
              setCurrentStep(2);
            }}
          />
        ) : (
          <OnboardingStep2
            onBack={() => {
              setProcessingError(null);
              setCurrentStep(1);
            }}
            onFinish={handleFinishOnboarding}
            isSaving={isSaving}
          />
        )}
      </div>

      {/* Corporate copyright footer */}
      <footer className="py-4 text-center text-xs text-zinc-400 dark:text-zinc-500 border-t border-zinc-100 dark:border-zinc-800/40">
        © 2026 Olive Ridley Media Private Limited. All rights reserved.
      </footer>
    </main>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <div
          role="status"
          aria-label="Loading onboarding"
          aria-live="polite"
          className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 text-zinc-500"
        >
          <Loader2 className="w-8 h-8 animate-spin text-emerald-600" aria-hidden="true" />
          <span className="sr-only">Loading onboarding...</span>
        </div>
      }
    >
      <OnboardingPageInner />
    </Suspense>
  );
}
