"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import { getAuthUser, getUserPreferences, saveUserPreferences, signOutUser } from "@/lib/auth/session";
import { UserPreferences } from "@/lib/auth/types";
import { getUserSubscription, cancelSubscription } from "@/lib/billing/subscription";
import { UserSubscription } from "@/lib/billing/types";
import { getCandidateProfile, deleteCandidateProfile } from "@/lib/resume/storage";
import { getTrackedApplications } from "@/lib/tracker/storage";
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

function SettingsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") || "preferences";

  const [activeTab, setActiveTab] = useState<"preferences" | "notifications" | "billing" | "privacy">(
    initialTab as any
  );
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Preferences form state
  const [roles, setRoles] = useState<string[]>([]);
  const [customRole, setCustomRole] = useState("");
  const [experienceLevel, setExperienceLevel] = useState<UserPreferences["experienceLevel"]>("mid");
  const [remotePreference, setRemotePreference] = useState<UserPreferences["remotePreference"]>("remote");
  const [locations, setLocations] = useState<string[]>([]);
  const [workAuth, setWorkAuth] = useState("");
  const [minSalary, setMinSalary] = useState<number | undefined>(undefined);
  const [salaryCurrency, setSalaryCurrency] = useState("USD");
  const [dailyDigestOptIn, setDailyDigestOptIn] = useState(true);

  // Billing state
  const [subscription, setSubscription] = useState<UserSubscription | null>(null);
  const [isPaywallOpen, setIsPaywallOpen] = useState(false);

  useEffect(() => {
    getAuthUser().then((u) => {
      if (!u) {
        router.replace("/login?next=/settings");
        return;
      }
      setUser(u);

      getUserPreferences(u.id).then((p) => {
        setRoles(p.roles || []);
        setExperienceLevel(p.experienceLevel || "mid");
        setRemotePreference(p.remotePreference || "remote");
        setLocations(p.locations || []);
        setWorkAuth(p.workAuth || "");
        setMinSalary(p.minSalary);
        setSalaryCurrency(p.salaryCurrency || "USD");
        setDailyDigestOptIn(p.dailyDigestOptIn ?? true);
      });

      getUserSubscription().then((sub: UserSubscription | null) => {
        setSubscription(sub);
      });

      setLoading(false);
    });
  }, [router]);

  const handleSavePreferences = async (e: React.FormEvent) => {
    e.preventDefault();
    const updated: UserPreferences = {
      roles,
      categories: roles.map((r) => r.toLowerCase()),
      experienceLevel,
      employmentTypes: ["full-time"],
      locations,
      remotePreference,
      workAuth,
      minSalary,
      salaryCurrency,
      dailyDigestOptIn,
      onboardingCompleted: true,
      updatedAt: new Date().toISOString(),
    };
    await saveUserPreferences(updated, user?.id);
    toast.success("Job target preferences saved successfully.");
  };

  const handleAddRole = (e: React.FormEvent) => {
    e.preventDefault();
    if (customRole.trim() && !roles.includes(customRole.trim())) {
      setRoles([...roles, customRole.trim()]);
      setCustomRole("");
    }
  };

  const handleCancelSubscription = async () => {
    if (!window.confirm("Are you sure you want to cancel your Pro renewal? You will retain Pro access until the end of the billing period.")) {
      return;
    }
    const updated = await cancelSubscription();
    setSubscription(updated);
    toast.info("Subscription marked for cancellation at period end.");
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

      if (!res.ok || !result.success) {
        toast.error(result.error || "Failed to delete account. Please contact support.");
        return;
      }

      // Success: clean local state and sign out
      await deleteCandidateProfile();
      if (typeof window !== "undefined") {
        localStorage.clear();
      }
      await signOutUser();
      router.push("/");
      toast.info("Account and all personal data permanently deleted.");
    } catch (err: any) {
      console.error("Delete account error:", err);
      toast.error(err?.message || "An unexpected error occurred while deleting your account.");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <GuideHeader />
        <div className="flex-1 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  const isPro = subscription?.status === "active";

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#09090B] flex flex-col">
      <GuideHeader />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-8">
        <div>
          <h1 className="text-xl sm:text-3xl font-black text-slate-900 tracking-tight">
            Account & Settings
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            Manage your target preferences, notifications, billing, and privacy controls.
          </p>
        </div>

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
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
                  Work Authorization
                </label>
                <input
                  type="text"
                  value={workAuth}
                  onChange={(e) => setWorkAuth(e.target.value)}
                  placeholder="e.g. Authorized (No sponsorship needed)"
                  className="w-full text-xs sm:text-sm py-2.5 px-3.5 rounded-xl border border-slate-200 bg-white focus:outline-blue-600 shadow-2xs"
                />
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
                className="inline-flex items-center gap-1.5 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs sm:text-sm transition shadow-xs cursor-pointer"
              >
                <Save className="w-4 h-4" />
                <span>Save Preferences</span>
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

            <div className="space-y-4">
              <div className="flex items-start justify-between gap-4 p-4 rounded-xl border border-slate-200 bg-slate-50/70">
                <div className="space-y-1">
                  <span className="font-bold text-sm text-slate-900 block">
                    Daily AI Matching Digest
                  </span>
                  <p className="text-xs text-slate-500">
                    Receive daily curated job recommendations matching your confirmed resume and target roles.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={dailyDigestOptIn}
                  onChange={(e) => setDailyDigestOptIn(e.target.checked)}
                  className="mt-1 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                />
              </div>
            </div>

            <div className="pt-4 border-t border-slate-100 flex justify-end">
              <button
                type="button"
                onClick={handleSavePreferences}
                className="inline-flex items-center gap-1.5 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs sm:text-sm transition shadow-xs cursor-pointer"
              >
                <Save className="w-4 h-4" />
                <span>Save Notification Settings</span>
              </button>
            </div>
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
                  Manage your CareerMonke Pro access, invoices, and renewal.
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
                    {isPro ? "CareerMonke Pro Plan" : "CareerMonke Free Tier"}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {isPro
                      ? "₹199 / month (Domestic) or $9 / month (International). Full direct ATS apply unlocked."
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

              {isPro && (
                <div className="pt-3 border-t border-slate-200/80 flex items-center justify-between text-xs">
                  <span className="text-slate-600">
                    Auto-renews on: <strong>{new Date(subscription?.currentPeriodEnd || Date.now()).toLocaleDateString()}</strong>
                  </span>

                  <button
                    type="button"
                    onClick={handleCancelSubscription}
                    className="text-red-600 hover:text-red-800 font-semibold cursor-pointer"
                  >
                    Cancel Renewal
                  </button>
                </div>
              )}
            </div>
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
      </main>

      <PaywallModal
        open={isPaywallOpen}
        onOpenChange={setIsPaywallOpen}
        user={user}
        featureTitle="Upgrade to CareerMonke Pro"
      />

      <Footer />
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsPageInner />
    </Suspense>
  );
}
