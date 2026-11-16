"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import ProUpgradeScreen from "@/components/billing/ProUpgradeScreen";
import SkillWhatIfView from "@/components/skill-what-if/SkillWhatIfView";
import ComingSoonView from "@/components/common/ComingSoonView";
import { getAuthUser } from "@/lib/auth/session";
import { getProAccessStatus } from "@/lib/billing/subscription";
import { createClient } from "@/lib/supabase/client";
import type { SkillWhatIfData } from "@/data/skillWhatIfFixture";
import type { User } from "@supabase/supabase-js";

interface SkillWhatIfClientProps {
  jobId: string;
}

export default function SkillWhatIfClient({ jobId }: SkillWhatIfClientProps) {
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [isPro, setIsPro] = useState(false);
  const [isProDefinitive, setIsProDefinitive] = useState(false);

  const [simulation, setSimulation] = useState<SkillWhatIfData | null>(null);
  const [loadingSimulation, setLoadingSimulation] = useState(true);
  const [simError, setSimError] = useState<string | null>(null);

  // Check feature flag: disabled in production unless NEXT_PUBLIC_ENABLE_SKILL_WHAT_IF is true
  const isFeatureEnabled =
    process.env.NEXT_PUBLIC_ENABLE_SKILL_WHAT_IF === "true" ||
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
        router.replace(`/login?returnTo=/jobs/${jobId}/skill-what-if`);
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

  // 2. Fetch simulation data strictly from server-enforced endpoint when user is Pro
  const fetchSimulationData = useCallback(async () => {
    if (!user || !isPro) return;

    setLoadingSimulation(true);
    setSimError(null);

    try {
      const supabase = createClient();
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

      const res = await fetch(`/api/jobs/skill-what-if?jobId=${encodeURIComponent(jobId)}`, {
        headers: {
          Authorization: token ? `Bearer ${token}` : "",
        },
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 403) {
          setIsPro(false);
          setLoadingSimulation(false);
          return;
        }
        throw new Error(
          json?.message ||
            json?.error ||
            "Skill What-If simulation is not available yet for this role."
        );
      }

      if (json.simulation && json.available !== false) {
        setSimulation(json.simulation);
      } else {
        throw new Error(
          json?.message ||
            json?.error ||
            "Skill What-If simulation is not available yet for this role."
        );
      }
    } catch (err: any) {
      console.warn("Error fetching simulation from server:", err);
      setSimError(err.message || "Failed to load skill simulation. Please try again.");
      setSimulation(null);
    } finally {
      setLoadingSimulation(false);
    }
  }, [user, isPro, jobId]);

  if (!isFeatureEnabled) {
    return null;
  }

  return (
    <LoggedInAppShell pageLabel="SKILL WHAT-IF" user={user} isPro={isPro}>
      <div className="max-w-5xl w-full mx-auto px-4 py-8">
        <ComingSoonView
          title="Skill What-If Simulator"
          description="Interactive skill match simulations, market leverage projections, and gap analysis are coming soon."
        />
      </div>
      <div className="hidden" aria-hidden="true" role="status" aria-label="Verifying your Pro membership">
        <div className="w-10 h-10 border-4 border-[#2563EB] border-t-transparent rounded-full animate-spin" />
        <ProUpgradeScreen
          title="Unlock Skill What-If Simulator"
          subtitle="Interactive skill match simulations, market leverage projections, and additional threshold job discovery are exclusive to CareerMonke Pro members."
        />
        <SkillWhatIfView
          simulation={simulation}
          loading={false}
          error={simError}
          onRetry={fetchSimulationData}
          jobId={jobId}
        />
      </div>
    </LoggedInAppShell>
  );
}
