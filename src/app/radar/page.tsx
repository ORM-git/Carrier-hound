"use client";

import React, { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import ProUpgradeScreen from "@/components/billing/ProUpgradeScreen";
import { getAuthUser } from "@/lib/auth/session";
import { getProAccessStatus } from "@/lib/billing/subscription";
import type { User } from "@supabase/supabase-js";

// Dynamically import JobRadarGlobe with SSR disabled for Mapbox GL JS
const JobRadarGlobe = dynamic(() => import("@/components/JobRadarGlobe"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[calc(100vh-56px)] min-h-[540px] bg-[#040610] flex flex-col items-center justify-center text-cyan-400 gap-4">
      <div className="relative w-16 h-16">
        <div className="absolute inset-0 rounded-full border-2 border-cyan-500/20 border-t-cyan-400 animate-spin"></div>
        <div
          className="absolute inset-2 rounded-full border-2 border-emerald-500/20 border-b-emerald-400 animate-spin"
          style={{ animationDirection: "reverse" }}
        ></div>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="w-3 h-3 rounded-full bg-cyan-400 animate-ping"></span>
        </div>
      </div>
      <div className="text-center space-y-1">
        <p className="text-sm font-bold tracking-widest uppercase text-cyan-300">
          INITIALIZING 3D GLOBE RADAR...
        </p>
        <p className="text-xs text-slate-400">
          Calibrating orbital telemetry & scanning direct-ATS job pipelines
        </p>
      </div>
    </div>
  ),
});

export default function RadarPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPro, setIsPro] = useState(false);
  const [isProDefinitive, setIsProDefinitive] = useState(false);

  useEffect(() => {
    getAuthUser().then(async (authUser) => {
      if (!authUser) {
        router.replace("/login?next=/radar");
        return;
      }
      setUser(authUser);
      const proRes = await getProAccessStatus(authUser.id);
      setIsPro(proRes.isPro);
      setIsProDefinitive(Boolean(proRes.isDefinitive));
      setLoading(false);
    });
  }, [router]);

  if (loading || (!isPro && !isProDefinitive)) {
    return (
      <LoggedInAppShell pageLabel="RADAR" user={user} isPro={false}>
        <div className="flex-1 flex items-center justify-center min-h-[60vh] p-6">
          <div className="text-center space-y-3">
            <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-xs font-semibold text-slate-500">Checking radar access...</p>
          </div>
        </div>
      </LoggedInAppShell>
    );
  }

  // Definitively signed-in non-Pro
  if (!isPro) {
    return (
      <LoggedInAppShell pageLabel="RADAR" user={user} isPro={false}>
        <div className="max-w-5xl w-full mx-auto px-4 py-8">
          <ProUpgradeScreen
            title="Unlock 3D Job Radar"
            subtitle="The interactive 3D Globe Radar is exclusive to CareerMonke Pro members."
          />
        </div>
      </LoggedInAppShell>
    );
  }

  return (
    <LoggedInAppShell
      pageLabel="RADAR"
      user={user}
      isPro={true}
      mainClassName="flex-1 w-full relative bg-[#040610] overflow-hidden flex flex-col"
    >
      <JobRadarGlobe />
    </LoggedInAppShell>
  );
}
