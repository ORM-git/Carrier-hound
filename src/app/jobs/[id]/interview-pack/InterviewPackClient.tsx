"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import ProUpgradeScreen from "@/components/billing/ProUpgradeScreen";
import InterviewPackView from "@/components/interview-pack/InterviewPackView";
import { getAuthUser } from "@/lib/auth/session";
import { getProAccessStatus } from "@/lib/billing/subscription";
import { createClient } from "@/lib/supabase/client";
import type { InterviewPackData } from "@/data/interviewPackFixture";
import type { User } from "@supabase/supabase-js";

interface InterviewPackClientProps {
  jobId: string;
}

export default function InterviewPackClient({ jobId }: InterviewPackClientProps) {
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  // "free" only when entitlement is definitively non-Pro; a transient failure is "error" (retry), never an upgrade screen.
  const [access, setAccess] = useState<"checking" | "error" | "pro" | "free">("checking");
  const isPro = access === "pro";

  const [pack, setPack] = useState<InterviewPackData | null>(null);
  const [loadingPack, setLoadingPack] = useState(true);
  const [packError, setPackError] = useState<string | null>(null);

  // Check feature flag: disabled in production unless NEXT_PUBLIC_ENABLE_INTERVIEW_PACK is true
  const isFeatureEnabled =
    process.env.NEXT_PUBLIC_ENABLE_INTERVIEW_PACK === "true" ||
    process.env.NODE_ENV !== "production";

  // 1. Check Auth & Server-Verified Pro status (strictly never trust user_metadata)
  const checkAccess = useCallback(async () => {
    setAccess("checking");
    try {
      const authUser = await getAuthUser();
      if (!authUser) {
        router.replace(`/login?returnTo=/jobs/${jobId}/interview-pack`);
        return;
      }
      setUser(authUser);
      const proStatus = await getProAccessStatus(authUser.id);
      setAccess(proStatus.isPro ? "pro" : proStatus.isDefinitive ? "free" : "error");
    } catch (err) {
      console.warn("Failed checking Pro status:", err);
      setAccess("error");
    }
  }, [jobId, router]);

  useEffect(() => {
    if (!isFeatureEnabled) {
      router.replace("/jobs");
      return;
    }
    void checkAccess();
    // Entitlement lifecycle (same as Radar): re-check on purchase, expiry or sign-in/out.
    const onChange = () => void checkAccess();
    window.addEventListener("careermonke_pro_updated", onChange);
    window.addEventListener("careermonke_auth_updated", onChange);
    return () => {
      window.removeEventListener("careermonke_pro_updated", onChange);
      window.removeEventListener("careermonke_auth_updated", onChange);
    };
  }, [checkAccess, isFeatureEnabled, router]);

  // 2. Fetch pack data strictly from server-enforced endpoint when user is Pro
  const fetchPackData = useCallback(async () => {
    if (!user || !isPro) return;

    setLoadingPack(true);
    setPackError(null);

    try {
      const supabase = createClient();
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

      const res = await fetch(`/api/jobs/interview-pack?jobId=${encodeURIComponent(jobId)}`, {
        headers: {
          Authorization: token ? `Bearer ${token}` : "",
        },
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 403) {
          setAccess("free"); // server-verified: definitively not Pro
          setLoadingPack(false);
          return;
        }
        throw new Error(
          json?.message ||
            json?.error ||
            "Interview Pack is not available yet for this role."
        );
      }

      if (json.pack && json.available !== false) {
        setPack(json.pack);
      } else {
        throw new Error(
          json?.message ||
            json?.error ||
            "Interview Pack is not available yet for this role."
        );
      }
    } catch (err: any) {
      console.warn("Error fetching pack from server:", err);
      setPackError(err.message || "Failed to load interview pack. Please try again.");
      setPack(null);
    } finally {
      setLoadingPack(false);
    }
  }, [user, isPro, jobId]);

  useEffect(() => {
    if (isPro && user) {
      fetchPackData();
    }
  }, [isPro, user, fetchPackData]);

  if (!isFeatureEnabled) {
    return null;
  }

  // Loading Screen while authenticating
  if (access === "checking") {
    return (
      <LoggedInAppShell pageLabel="INTERVIEW PACK" user={user} isPro={false}>
        <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 space-y-4" role="status" aria-label="Verifying your Pro membership">
          <div aria-hidden="true" className="w-10 h-10 border-4 border-[#2563EB] border-t-transparent rounded-full animate-spin" />
          <p className="text-[15px] font-semibold text-[#64748B]">
            Verifying your CareerMonke Pro membership...
          </p>
        </div>
      </LoggedInAppShell>
    );
  }

  // Transient entitlement failure: offer a retry, never a definitive Free/upgrade screen
  if (access === "error") {
    return (
      <LoggedInAppShell pageLabel="INTERVIEW PACK" user={user} isPro={false}>
        <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 space-y-3 text-center" role="alert">
          <p className="text-sm font-semibold text-slate-700">We couldn&apos;t verify your Pro membership.</p>
          <p className="text-xs text-slate-500">Check your connection and try again.</p>
          <button
            type="button"
            onClick={() => void checkAccess()}
            data-testid="interview-pack-access-retry"
            className="px-4 py-2 rounded-full text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Try again
          </button>
        </div>
      </LoggedInAppShell>
    );
  }

  // Definitively non-Pro users see the locked state
  if (access === "free") {
    return (
      <LoggedInAppShell pageLabel="INTERVIEW PACK" user={user} isPro={false}>
        <div className="max-w-5xl w-full mx-auto px-4 py-8">
          <ProUpgradeScreen
            title="Unlock Interview Pack"
            subtitle="Role-specific interview dossiers, question predictions, and tailored answers are exclusive to CareerMonke Pro members."
          />
        </div>
      </LoggedInAppShell>
    );
  }

  // Pro users see the full interactive dossier
  return (
    <LoggedInAppShell pageLabel="INTERVIEW PACK" user={user} isPro={true}>
      <InterviewPackView
        pack={pack}
        loading={loadingPack}
        error={packError}
        onRetry={fetchPackData}
        jobId={jobId}
      />
    </LoggedInAppShell>
  );
}
