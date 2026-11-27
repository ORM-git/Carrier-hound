"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import GuideHeader from "@/components/GuideHeader";
import AppIconRail from "@/components/shell/AppIconRail";
import { useSidebarMode } from "@/lib/sidebar";
import AppTopBar from "@/components/shell/AppTopBar";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import { getAuthUser, getUserPreferences, saveUserPreferences, signOutUser } from "@/lib/auth/session";
import { UserPreferences } from "@/lib/auth/types";
import { categoriesForRoles } from "@/lib/onboarding/roleCategories";
import { workModelsFromLegacy } from "@/lib/preferences/feedConstraints";
import { getUserSubscription, cancelAutoRenewSubscription } from "@/lib/billing/subscription";
import { normalizePlanCode, PLAN_DEFINITIONS } from "@/lib/billing/quota";
import { UserSubscription } from "@/lib/billing/types";
import { getCandidateProfile, deleteCandidateProfile } from "@/lib/resume/storage";
import { getTrackedApplications } from "@/lib/tracker/storage";
import PaymentHistory from "@/components/billing/PaymentHistory";
import PaywallModal from "@/components/PaywallModal";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import {
  Settings,
  Bell,
  CreditCard,
  ShieldCheck,
  Download,
  Trash2,
  CheckCircle2,
  Save,
  Lock,
  ArrowRight,
  AlertCircle
} from "lucide-react";
import { toast } from "react-toastify";
import { WORK_AUTH_OPTIONS } from "@/data/onboardingCategories";
import { isWorkAuthComplete, parseWorkAuth, toggleWorkAuth, type WorkAuthId } from "@/lib/onboarding/workAuth";

function SettingsPageInner() {
  const { isExpanded } = useSidebarMode();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isPendingQuery = searchParams.get("state") === "deletion_pending";
  const initialTab = searchParams.get("tab") || (isPendingQuery ? "privacy" : "preferences");

  const [activeTab, setActiveTab] = useState<"preferences" | "notifications" | "billing" | "privacy">(
    initialTab as any
  );
  const [isDeletionPending, setIsDeletionPending] = useState(isPendingQuery);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Preferences form state
  const [roles, setRoles] = useState<string[]>([]);
  const [customRole, setCustomRole] = useState("");
  // The loaded row: a save spreads it so fields this form does not edit (country, eligibility,
  // saved feed constraints) are never erased.
  const [loadedPrefs, setLoadedPrefs] = useState<UserPreferences | null>(null);
  const [experienceLevel, setExperienceLevel] = useState<UserPreferences["experienceLevel"]>("");
  const [remotePreference, setRemotePreference] = useState<UserPreferences["remotePreference"]>("any");
  const [locations, setLocations] = useState<string[]>([]);
  const [workAuth, setWorkAuth] = useState("");
  const [workAuthError, setWorkAuthError] = useState<string | null>(null);
  const [savingPrefs, setSavingPrefs] = useState(false);
  // Not editable here; loaded so a save writes the onboarding job types back instead of overwriting them.
  const [employmentTypes, setEmploymentTypes] = useState<string[]>([]);
  const [minSalary, setMinSalary] = useState<number | undefined>(undefined);
  const [salaryCurrency, setSalaryCurrency] = useState("USD");
  // Not editable here; loaded only so a preferences save writes the stored choice back unchanged.
  const [dailyDigestOptIn, setDailyDigestOptIn] = useState(false);

  // Billing state
  const [subscription, setSubscription] = useState<UserSubscription | null>(null);
  const [isPaywallOpen, setIsPaywallOpen] = useState(false);
  const [isCancellingAutoRenew, setIsCancellingAutoRenew] = useState(false);

  const handleCancelAutoRenew = async () => {
    if (isCancellingAutoRenew) return;
    setIsCancellingAutoRenew(true);
    try {
      const res = await cancelAutoRenewSubscription();
      if (res.success) {
        toast.success("Auto-renewal cancelled. Pro access remains active until the end of your billing cycle.");
        setSubscription((prev) => (prev ? { ...prev, cancelAtPeriodEnd: true } : null));
      } else {
        toast.error(res.error || "Failed to cancel auto-renewal. Please contact support.");
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to cancel auto-renewal.");
    } finally {
      setIsCancellingAutoRenew(false);
    }
  };

  // Derive plan & pricing from central normalized plan ID and real subscription record
  const normalizedPlan = normalizePlanCode(subscription?.planId);
  const planDef = normalizedPlan ? PLAN_DEFINITIONS[normalizedPlan] : null;

  const planCurrency = subscription?.currency || "INR";
  const currencySymbol =
    planCurrency === "USD" ? "$" : planCurrency === "EUR" ? "€" : planCurrency === "GBP" ? "£" : "₹";

  // When subscriptions.amount is null, do not combine the INR catalog price with a non-INR currency
  // (USD quarterly must not show $3,999). Hide the price when currency is not INR and amount is unknown.
  const planPriceNumber = typeof subscription?.amount === "number"
    ? subscription.amount
    : (planCurrency === "INR" && planDef ? Math.round(planDef.price_paise / 100) : undefined);

  const planInterval = normalizedPlan === "weekly" ? "week" : normalizedPlan === "quarterly" ? "quarter" : "month";

  const formattedPlanText = typeof planPriceNumber === "number"
    ? `${currencySymbol}${planPriceNumber.toLocaleString()} / ${planInterval}`
    : null;

  useEffect(() => {
    getAuthUser().then((u) => {
      if (!u) {
        router.replace("/login?returnTo=/settings");
        return;
      }
      setUser(u);

      getUserPreferences(u.id).then((p) => {
        setLoadedPrefs(p);
        setRoles(p.roles || []);
        setExperienceLevel(p.experienceLevel || "");
        setRemotePreference(p.remotePreference || "any");
        setLocations(p.locations || []);
        setWorkAuth(p.workAuth || "");
        setEmploymentTypes(p.employmentTypes || []);
        setMinSalary(p.minSalary);
        setSalaryCurrency(p.salaryCurrency || "USD");
        setDailyDigestOptIn(p.dailyDigestOptIn ?? false);
      });

      getUserSubscription().then((sub: UserSubscription | null) => {
        setSubscription(sub);
      });

      // Check server account status for interrupted deletion
      createClient().auth.getSession().then((sessionRes: any) => {
        const session = sessionRes?.data?.session;
        if (session?.access_token) {
          fetch("/api/account/status", {
            headers: { Authorization: `Bearer ${session.access_token}` },
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((status) => {
              if (status?.deletionPending) {
                setIsDeletionPending(true);
                setActiveTab("privacy");
              }
            })
            .catch(() => {});
        }
      });

      setLoading(false);
    });
  }, [router]);

  const handleSavePreferences = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingPrefs) return;
    // Same rule as onboarding: one of {1}, {2}, {3}, {2,3}. Never filled in for the user.
    if (!isWorkAuthComplete(workAuth)) {
      setWorkAuthError("Choose your work authorization before saving.");
      return;
    }
    const remoteChanged = remotePreference !== (loadedPrefs?.remotePreference || "any");
    const updated: UserPreferences = {
      ...(loadedPrefs ?? {}),
      roles,
      categories: categoriesForRoles(roles),
      experienceLevel: experienceLevel || undefined,
      // An untouched select keeps a saved multi-select (e.g. Hybrid + Remote) instead of collapsing it.
      workModels: remoteChanged ? workModelsFromLegacy(remotePreference) : loadedPrefs?.workModels,
      employmentTypes,
      locations,
      remotePreference,
      workAuth,
      minSalary,
      salaryCurrency,
      dailyDigestOptIn,
      onboardingCompleted: true,
      updatedAt: new Date().toISOString(),
    };
    setSavingPrefs(true);
    try {
      await saveUserPreferences(updated, user?.id);
      setLoadedPrefs(updated);
      toast.success("Job target preferences saved successfully.");
    } catch {
      // The form keeps the edited values so the user can retry.
      toast.error("Could not save your preferences. Your changes are still here, please try again.");
    } finally {
      setSavingPrefs(false);
    }
  };

  const handleAddRole = (e: React.FormEvent) => {
    e.preventDefault();
    if (customRole.trim() && !roles.includes(customRole.trim())) {
      setRoles([...roles, customRole.trim()]);
      setCustomRole("");
    }
  };

  const handleExportData = async () => {
    const prefs = await getUserPreferences(user?.id);
    const resume = await getCandidateProfile();
    const apps = await getTrackedApplications();

    const exportBundle = {
      user: {
        id: user?.id,
        email: user?.email,
      },
      preferences: prefs,
      candidateProfile: resume,
      trackedApplications: apps,
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(exportBundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `careermonke_data_export_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Exported your complete account data as JSON.");
  };

  const handleDeleteResume = async () => {
    if (!window.confirm("Are you sure you want to permanently delete your resume facts? This cannot be undone.")) {
      return;
    }
    await deleteCandidateProfile();
    toast.info("Resume facts permanently deleted.");
  };

  const handleDeleteAccount = async () => {
    if (
      !window.confirm(
        "WARNING: This will permanently delete your account, authentication identity, saved resume facts, preferences, and application history. This action cannot be undone. Are you sure?"
      )
    ) {
      return;
    }

    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      if (!token) {
        toast.error("You must be signed in to delete your account.");
        return;
      }

      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });

      const result = await res.json().catch(() => ({}));

      // Only an explicit, confirmed full success clears local state and signs out.
      if (!res.ok || result.success !== true) {
        toast.error(result.error || "Failed to delete account. Please contact support.");
        return;
      }

      // Success: clean local state and sign out
      await deleteCandidateProfile();
      await signOutUser();
      router.push("/");
      toast.info("Account and all personal data permanently deleted.");
    } catch (err: any) {
      console.error("Delete account error:", err);
      toast.error(err?.message || "An unexpected error occurred while deleting your account.");
    }
  };

  const handleCancelDeletion = async () => {
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      if (!token) {
        toast.error("You must be signed in to cancel deletion.");
        return;
      }

      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: "cancel" }),
      });

      const result = await res.json().catch(() => ({}));
      if (!res.ok || result.success !== true) {
        toast.error(result.error || "Failed to cancel deletion request.");
        return;
      }

      setIsDeletionPending(false);
      toast.info("Deletion request cancelled. Account reset for fresh setup.");
      router.push("/onboarding");
    } catch (err: any) {
      console.error("Cancel deletion error:", err);
      toast.error(err?.message || "An error occurred cancelling deletion.");
    }
  };

  if (loading) {
    return (
      <LoggedInAppShell pageLabel="SETTINGS" user={user} isPro={false}>
        <div className="flex-1 flex items-center justify-center min-h-[60vh]">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      </LoggedInAppShell>
    );
  }

  const isPro = subscription?.status === "active";

  return (
    <LoggedInAppShell pageLabel="SETTINGS" user={user} isPro={isPro}>
      <div className="max-w-5xl w-full mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-8">
        <div>
          <h1 className="text-[18px] font-bold uppercase tracking-wider text-[#0F172A]">
            SETTINGS
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            Manage your target preferences, notifications, billing, and privacy controls.
          </p>
        </div>

        {/* Signed-in Account Identity Card */}
        {user && (
          <div className="bg-white rounded-2xl p-5 sm:p-6 border border-slate-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Signed-in Account
              </span>
              <div className="text-sm sm:text-base font-bold text-slate-900 flex items-center gap-2">
                <span>{user.email || "Authenticated User"}</span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                  Verified
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-slate-600">
                <span className="text-slate-500">Auth Method:</span>
                {user.app_metadata?.providers?.includes("google") ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-800 text-xs font-semibold border border-slate-200">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                    Google OAuth
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-800 text-xs font-semibold border border-blue-200">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
                    Email &amp; password
                  </span>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={async () => {
                await signOutUser();
                router.push("/");
              }}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-bold transition cursor-pointer min-h-[44px] shrink-0"
            >
              <span>Sign Out</span>
            </button>
          </div>
        )}

        {/* Tab Navigation */}
        <div className="flex flex-wrap sm:flex-nowrap items-center gap-1.5 sm:gap-2 border-b border-slate-200 overflow-x-auto pb-px">
          {[
            { id: "preferences", label: "Profile & Preferences", icon: Settings },
            { id: "notifications", label: "Notifications", icon: Bell },
            { id: "billing", label: "Billing & Plans", icon: CreditCard },
            { id: "privacy", label: "Privacy & Data", icon: ShieldCheck },
          ].map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id as any)}
                className={`flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2.5 border-b-2 text-xs sm:text-sm font-bold transition whitespace-nowrap cursor-pointer shrink-0 min-h-[44px] ${
                  active
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>

        {/* ========================================================================= */}
        {/* TAB 1: PREFERENCES                                                        */}
        {/* ========================================================================= */}
        {activeTab === "preferences" && (
          <form onSubmit={handleSavePreferences} className="bg-white rounded-2xl p-6 sm:p-8 border border-slate-200 shadow-2xs space-y-6">
            <h2 className="text-base sm:text-lg font-bold text-slate-900">
              Target Job Preferences
            </h2>

            <div className="space-y-3">
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
                Target Roles
              </label>
              <div className="flex flex-wrap gap-2">
                {roles.map((r) => (
                  <span
                    key={r}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-blue-50 text-blue-800 text-xs font-semibold border border-blue-200"
                  >
                    <span>{r}</span>
                    <button
                      aria-label={`Remove ${r}`}
                      type="button"
                      onClick={() => setRoles(roles.filter((x) => x !== r))}
                      className="hover:text-red-500 cursor-pointer ml-1 text-sm font-bold"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  aria-label="Add another role"
                  value={customRole}
                  onChange={(e) => setCustomRole(e.target.value)}
                  placeholder="Add another role (e.g. Lead Frontend Engineer)"
                  className="flex-1 text-xs px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white focus:outline-blue-600 shadow-2xs"
                />
                <button
                  type="button"
                  onClick={handleAddRole}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-xl transition cursor-pointer"
                >
                  + Add
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
                  Seniority Level
                </label>
                <select
                  value={experienceLevel}
                  onChange={(e) => setExperienceLevel(e.target.value as any)}
                  className="w-full text-xs sm:text-sm py-2.5 px-3 rounded-xl border border-slate-200 bg-white focus:outline-blue-600 shadow-2xs cursor-pointer"
                >
                  <option value="">Not set</option>
                  <option value="intern">Internship / Student</option>
                  <option value="entry">Entry-Level (0 - 2 years)</option>
                  <option value="mid">Mid-Level (2 - 5 years)</option>
                  <option value="senior">Senior (5 - 8 years)</option>
                  <option value="lead">Lead / Staff (8+ years)</option>
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
                {(loadedPrefs?.workModels?.length ?? 0) > 1 && remotePreference === (loadedPrefs?.remotePreference || "any") && (
                  <p className="mt-1 text-[11px] text-slate-500">
                    Saved in Preferences: {loadedPrefs!.workModels!.map((m) => m[0].toUpperCase() + m.slice(1)).join(" + ")}. Changing this replaces it.
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                {/* Same canonical 1 / 2 / 3 / 2+3 contract as onboarding; free text could save values the API rejects. */}
                <fieldset>
                  <legend className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
                    Work Authorization
                  </legend>
                  {WORK_AUTH_OPTIONS.map((opt) => (
                    <label key={opt.id} className="flex items-center gap-2.5 min-h-[44px] text-xs sm:text-sm text-slate-800 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={(parseWorkAuth(workAuth) ?? []).includes(opt.id as WorkAuthId)}
                        onChange={() => {
                          setWorkAuth(toggleWorkAuth(workAuth, opt.id as WorkAuthId));
                          setWorkAuthError(null);
                        }}
                        aria-describedby={workAuthError ? "settings-work-auth-error" : undefined}
                        className="w-4 h-4 accent-blue-600"
                      />
                      <span>{opt.label}</span>
                    </label>
                  ))}
                  {workAuthError && (
                    <p id="settings-work-auth-error" role="alert" className="text-xs text-red-700 mt-1">
                      {workAuthError}
                    </p>
                  )}
                </fieldset>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
                  Target Salary & Currency
                </label>
                <div className="flex gap-2">
                  <select
                    value={salaryCurrency}
                    onChange={(e) => setSalaryCurrency(e.target.value)}
                    className="w-20 text-xs py-2.5 px-2 rounded-xl border border-slate-200 bg-white font-bold"
                  >
                    <option value="USD">USD $</option>
                    <option value="INR">INR ₹</option>
                    <option value="EUR">EUR €</option>
                    <option value="GBP">GBP £</option>
                  </select>
                  <input
                    type="number"
                    aria-label="Minimum salary target"
                    value={minSalary || ""}
                    onChange={(e) => setMinSalary(e.target.value ? Number(e.target.value) : undefined)}
                    placeholder="Min salary target"
                    className="flex-1 text-xs sm:text-sm px-3 py-2.5 rounded-xl border border-slate-200 bg-white"
                  />
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-100 flex justify-end">
              <button
                type="submit"
                disabled={savingPrefs}
                className="inline-flex items-center gap-1.5 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs sm:text-sm transition shadow-xs cursor-pointer disabled:opacity-60"
              >
                <Save className="w-4 h-4" />
                <span>{savingPrefs ? "Saving..." : "Save Preferences"}</span>
              </button>
            </div>
          </form>
        )}

        {/* ========================================================================= */}
        {/* TAB 2: NOTIFICATIONS                                                      */}
        {/* ========================================================================= */}
        {activeTab === "notifications" && (
          <div className="bg-white rounded-2xl p-6 sm:p-8 border border-slate-200 shadow-2xs space-y-6">
            <h2 className="text-base sm:text-lg font-bold text-slate-900">
              Notification Preferences
            </h2>

            {/* The AI matching digest opt-in is intentionally not offered; stored choices are kept as-is. */}
            <p className="text-sm text-slate-500">There are no notification settings to manage right now.</p>
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB 3: BILLING                                                            */}
        {/* ========================================================================= */}
        {activeTab === "billing" && (
          <div className="bg-white rounded-2xl p-6 sm:p-8 border border-slate-200 shadow-2xs space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base sm:text-lg font-bold text-slate-900">
                  Subscription & Billing
                </h2>
                <p className="text-xs text-slate-500">
                  Manage your Career Monke Pro access and payment orders.
                </p>
              </div>

              <span
                className={`text-xs font-bold px-3 py-1 rounded-full ${
                  isPro
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-slate-100 text-slate-700"
                }`}
              >
                {isPro ? "Pro Active" : "Free Plan"}
              </span>
            </div>

            <div className="p-5 rounded-2xl border border-slate-200 bg-slate-50/70 space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-bold text-sm text-slate-900">
                    {isPro ? "Career Monke Pro Plan" : "Career Monke Free Tier"}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {isPro
                      ? formattedPlanText
                        ? `${formattedPlanText}. Full direct apply unlocked.`
                        : "Career Monke Pro Plan. Full direct apply unlocked."
                      : "Standard title browsing, 5 tracker slots, 1 ATS resume export."}
                  </p>
                </div>

                {!isPro && (
                  <button
                    type="button"
                    onClick={() => setIsPaywallOpen(true)}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl transition shadow-xs cursor-pointer"
                  >
                    Upgrade to Pro
                  </button>
                )}
              </div>

              {isPro && subscription?.currentPeriodEnd && (
                <div className="pt-3 border-t border-slate-200/80 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs">
                  {subscription.subscriptionId?.startsWith("sub_") ? (
                    subscription.cancelAtPeriodEnd ? (
                      <div>
                        <span className="text-amber-700 dark:text-amber-400 font-semibold block">
                          Auto-renewal cancelled
                        </span>
                        <span className="text-slate-500">
                          Your Pro access remains active until <strong>{new Date(subscription.currentPeriodEnd).toLocaleDateString()}</strong>.
                        </span>
                      </div>
                    ) : (
                      <>
                        <div>
                          <span className="text-slate-600 block">
                            Auto-renews on: <strong>{new Date(subscription.currentPeriodEnd).toLocaleDateString()}</strong> (₹499/month)
                          </span>
                          <span className="text-slate-400 text-[11px]">
                            Renews monthly for up to 12 cycles unless cancelled. Cancel anytime before your renewal date.
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={handleCancelAutoRenew}
                          disabled={isCancellingAutoRenew}
                          className="self-start sm:self-auto px-3 py-1.5 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 text-xs font-semibold transition disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                        >
                          {isCancellingAutoRenew ? "Cancelling..." : "Cancel Auto-Renewal"}
                        </button>
                      </>
                    )
                  ) : (
                    <span className="text-slate-600">
                      Pro access ends on: <strong>{new Date(subscription.currentPeriodEnd).toLocaleDateString()}</strong> (plans do not auto-renew)
                    </span>
                  )}
                </div>
              )}
            </div>
            {user?.id && <PaymentHistory userId={user.id} />}
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB 4: PRIVACY & DATA                                                     */}
        {/* ========================================================================= */}
        {activeTab === "privacy" && (
          <div className="bg-white rounded-2xl p-6 sm:p-8 border border-slate-200 shadow-2xs space-y-6">
            <h2 className="text-base sm:text-lg font-bold text-slate-900">
              Privacy, Data & Account Controls
            </h2>

            <div className="space-y-4">
              {/* Account Deletion Interrupted Recovery Banner */}
              {isDeletionPending && (
                <div className="p-4 rounded-xl border border-amber-300 bg-amber-50/80 space-y-3">
                  <div className="space-y-1">
                    <span className="font-bold text-xs sm:text-sm text-amber-900 block">
                      Account Deletion Incomplete
                    </span>
                    <p className="text-xs text-amber-800">
                      A previous account deletion attempt was interrupted before completion. Your profile data has been removed. You can retry deletion now to permanently delete your auth account, or cancel the deletion request to start fresh.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleDeleteAccount}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold transition cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Retry Account Deletion</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelDeletion}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-bold transition cursor-pointer"
                    >
                      <span>Cancel Deletion & Start Fresh</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Export Data */}
              <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <span className="font-bold text-xs sm:text-sm text-slate-900 block">Export All Account Data</span>
                  <p className="text-[11px] text-slate-500">
                    Download a copy of your preferences, confirmed resume facts, and tracked applications.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleExportData}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-bold transition shadow-2xs cursor-pointer shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export JSON</span>
                </button>
              </div>

              {/* Delete Resume */}
              <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <span className="font-bold text-xs sm:text-sm text-slate-900 block">Delete Resume Facts</span>
                  <p className="text-[11px] text-slate-500">
                    Purge all parsed resume facts from our database and reset personalized match calculations.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleDeleteResume}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white border border-amber-300 hover:bg-amber-50 text-amber-700 text-xs font-bold transition shadow-2xs cursor-pointer shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Resume</span>
                </button>
              </div>

              {/* Delete Account */}
              <div className="p-4 rounded-xl border border-red-200 bg-red-50/40 flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <span className="font-bold text-xs sm:text-sm text-red-900 block">Delete Account</span>
                  <p className="text-[11px] text-red-700">
                    Permanently deletes your account, authentication identity, saved resume facts, preferences, and application history.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleDeleteAccount}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-bold transition shadow-2xs cursor-pointer shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Account</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      
      <PaywallModal
        open={isPaywallOpen}
        onOpenChange={setIsPaywallOpen}
        user={user}
        featureTitle="Upgrade to Career Monke Pro"
      />
    </LoggedInAppShell>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsPageInner />
    </Suspense>
  );
}
