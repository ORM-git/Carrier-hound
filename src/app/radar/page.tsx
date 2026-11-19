"use client";

import React, { useState, useEffect, useCallback } from "react";
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
          Calibrating orbital telemetry & scanning verified direct job feeds
        </p>
      </div>
    </div>
  ),
});

type AccessState = "checking" | "error" | "pro" | "free";

export default function RadarPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [access, setAccess] = useState<AccessState>("checking");

  // Spinner only while the request is in flight; a transient failure (network/5xx/timeout,
  // reported by getProAccessStatus as non-definitive, or a throw) shows a retry state instead.
  const checkAccess = useCallback(async () => {
    setAccess("checking");
    try {
      const authUser = await getAuthUser();
      if (!authUser) {
        router.replace("/login?returnTo=/radar");
        return;
      }
      setUser(authUser);
      const proRes = await getProAccessStatus(authUser.id);
      setAccess(proRes.isPro ? "pro" : proRes.isDefinitive ? "free" : "error");
    } catch {
      setAccess("error");
    }
  }, [router]);

  useEffect(() => {
    void checkAccess();
    // Entitlement lifecycle: re-check when the subscription or session changes (purchase, expiry, sign-out).
    const onChange = () => void checkAccess();
    window.addEventListener("careermonke_pro_updated", onChange);
    window.addEventListener("careermonke_auth_updated", onChange);
    return () => {
      window.removeEventListener("careermonke_pro_updated", onChange);
      window.removeEventListener("careermonke_auth_updated", onChange);
    };
  }, [checkAccess]);

  if (access === "checking") {
    return (
      <LoggedInAppShell pageLabel="RADAR" user={user} isPro={false}>
        <div className="flex-1 flex items-center justify-center min-h-[60vh] p-6">
          <div className="text-center space-y-3" role="status">
            <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-xs font-semibold text-slate-500">Checking radar access...</p>
          </div>
        </div>
      </LoggedInAppShell>
    );
  }

  if (access === "error") {
    return (
      <LoggedInAppShell pageLabel="RADAR" user={user} isPro={false}>
        <div className="flex-1 flex items-center justify-center min-h-[60vh] p-6">
          <div className="text-center space-y-3" role="alert">
            <p className="text-sm font-semibold text-slate-700">We couldn&apos;t verify your radar access.</p>
            <p className="text-xs text-slate-500">Check your connection and try again.</p>
            <button
              type="button"
              onClick={() => void checkAccess()}
              data-testid="radar-access-retry"
              className="px-4 py-2 rounded-full text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Try again
            </button>
          </div>
        </div>
      </LoggedInAppShell>
    );
  }

  // Definitively signed-in non-Pro
  if (access === "free") {
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
