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
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [isPro, setIsPro] = useState(false);
  const [isProDefinitive, setIsProDefinitive] = useState(false);

  const [pack, setPack] = useState<InterviewPackData | null>(null);
  const [loadingPack, setLoadingPack] = useState(true);
  const [packError, setPackError] = useState<string | null>(null);

  // Check feature flag: disabled in production unless NEXT_PUBLIC_ENABLE_INTERVIEW_PACK is true
  const isFeatureEnabled =
    process.env.NEXT_PUBLIC_ENABLE_INTERVIEW_PACK === "true" ||
    process.env.NODE_ENV !== "production";

  // 1. Check Auth & Server-Verified Pro status (strictly never trust user_metadata)
  useEffect(() => {
    if (!isFeatureEnabled) {
      router.replace("/dashboard");
      return;
    }

    getAuthUser().then(async (authUser) => {
      if (!authUser) {
        // Redirect to login if unauthenticated
        router.replace(`/login?returnTo=/jobs/${jobId}/interview-pack`);
        return;
      }

      setUser(authUser);
      setLoadingAuth(false);

      try {
        const proStatus = await getProAccessStatus(authUser.id);
        setIsPro(Boolean(proStatus.isPro));
        setIsProDefinitive(true);
      } catch (err) {
        console.warn("Failed checking Pro status:", err);
        setIsPro(false);
        setIsProDefinitive(true);
      }
    });
  }, [jobId, router, isFeatureEnabled]);

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

      if (!res.ok) {
        if (res.status === 403) {
          setIsPro(false);
          setLoadingPack(false);
          return;
        }
        throw new Error(`Failed to load interview pack (status ${res.status})`);
      }

      const json = await res.json();
      if (json.pack) {
        setPack(json.pack);
      } else {
        throw new Error("Invalid interview pack response from server");
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
  if (loadingAuth || !isProDefinitive) {
    return (
      <LoggedInAppShell pageLabel="INTERVIEW PACK" user={user} isPro={false}>
        <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 space-y-4">
          <div className="w-10 h-10 border-4 border-[#2563EB] border-t-transparent rounded-full animate-spin" />
          <p className="text-[15px] font-semibold text-[#64748B]">
            Verifying your CareerMonke Pro membership...
          </p>
        </div>
      </LoggedInAppShell>
    );
  }

  // Non-Pro users see existing locked state
  if (!isPro) {
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
