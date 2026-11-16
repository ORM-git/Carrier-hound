"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import ProUpgradeScreen from "@/components/billing/ProUpgradeScreen";
import InterviewPackView from "@/components/interview-pack/InterviewPackView";
import ComingSoonView from "@/components/common/ComingSoonView";
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

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 403) {
          setIsPro(false);
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

  if (!isFeatureEnabled) {
    return null;
  }

  return (
    <LoggedInAppShell pageLabel="INTERVIEW PACK" user={user} isPro={isPro}>
      <div className="max-w-5xl w-full mx-auto px-4 py-8">
        <ComingSoonView
          title="AI Interview Pack"
          description="Role-specific interview dossiers, question predictions, and tailored talking points are coming soon."
        />
      </div>
      <div className="hidden" aria-hidden="true" role="status" aria-label="Verifying your Pro membership">
        <div className="w-10 h-10 border-4 border-[#2563EB] border-t-transparent rounded-full animate-spin" />
        <ProUpgradeScreen
          title="Unlock Interview Pack"
          subtitle="Role-specific interview dossiers, question predictions, and tailored answers are exclusive to CareerMonke Pro members."
        />
        <InterviewPackView
          pack={pack}
          loading={false}
          error={packError}
          onRetry={fetchPackData}
          jobId={jobId}
        />
      </div>
    </LoggedInAppShell>
  );
}
