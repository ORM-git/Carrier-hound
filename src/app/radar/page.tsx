"use client";

import React, { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import ProUpgradeScreen from "@/components/billing/ProUpgradeScreen";
import { getAuthUser } from "@/lib/auth/session";
import { getProAccessStatus } from "@/lib/billing/subscription";

// Dynamically import JobRadarGlobe with SSR disabled for Mapbox GL JS
const JobRadarGlobe = dynamic(() => import("@/components/JobRadarGlobe"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[calc(100vh-64px)] min-h-[640px] bg-[#040610] flex flex-col items-center justify-center text-cyan-400 gap-4">
      <div className="relative w-16 h-16">
        <div className="absolute inset-0 rounded-full border-2 border-cyan-500/20 border-t-cyan-400 animate-spin"></div>
        <div className="absolute inset-2 rounded-full border-2 border-emerald-500/20 border-b-emerald-400 animate-spin" style={{ animationDirection: "reverse" }}></div>
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
  const [loading, setLoading] = useState(true);
  const [isPro, setIsPro] = useState(false);
  const [isProDefinitive, setIsProDefinitive] = useState(false);

  useEffect(() => {
    getAuthUser().then(async (authUser) => {
      if (!authUser) {
        router.replace("/login?next=/radar");
        return;
      }
      const proRes = await getProAccessStatus(authUser.id);
      setIsPro(proRes.isPro);
      setIsProDefinitive(Boolean(proRes.isDefinitive));
      setLoading(false);
    });
  }, [router]);

  if (loading || (!isPro && !isProDefinitive)) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <GuideHeader />
        <main className="flex-1 flex items-center justify-center p-6">
          <div className="text-center space-y-2">
            <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-xs font-semibold text-slate-500">Checking access...</p>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  // Definitively signed-in non-Pro
  if (!isPro) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <GuideHeader />
        <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-8">
          <ProUpgradeScreen
            title="Unlock 3D Job Radar"
            subtitle="The interactive 3D Globe Radar is exclusive to CareerMonke Pro members."
          />
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#040610] text-white flex flex-col overflow-hidden">
      <GuideHeader />
      <main className="flex-1 w-full relative">
        <JobRadarGlobe />
      </main>
    </div>
  );
}
