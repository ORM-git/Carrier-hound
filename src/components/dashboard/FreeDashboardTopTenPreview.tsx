"use client";

import React from "react";
import LockedPreview from "@/components/billing/LockedPreview";
import { Sparkles, Layers } from "lucide-react";

export default function FreeDashboardTopTenPreview() {
  // Render 10 structural placeholder rows matching the exact layout of TopTenCompatibleJobs
  const placeholderCards = Array.from({ length: 10 }, (_, i) => i + 1);

  return (
    <div className="space-y-4" data-testid="free-dashboard-top10-preview">
      {/* Top 10 Section Header */}
      <div className="bg-white rounded-2xl p-4 sm:p-5 border border-slate-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 text-xs font-bold uppercase tracking-wider">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Ranked Candidates</span>
            </span>
            <span className="text-xs font-semibold text-slate-500">• Top 10 Jobs</span>
          </div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
            Top 10 Roles Ranked by Fit
          </h2>
        </div>
      </div>

      {/* Blurred 10-card preview behind truthful, loss-aversion LockedPreview overlay */}
      <LockedPreview
        title="Unlock your Top 10 jobs ranked by fit"
        subtitle="Unlock to see your match score and fit analysis. Recruiters filter by fit. Find out where you stand."
        ctaText="Unlock my score"
        ctaHref="/pricing"
        badge="PRO SUBSCRIPTION REQUIRED"
        blurIntensity="md"
        testId="free-dashboard-locked-overlay"
        minHeight="min-h-[420px]"
      >
        <div className="space-y-3" aria-hidden="true">
          {placeholderCards.map((num) => (
            <div
              key={num}
              className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-2xs space-y-4"
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                {/* Left: Silhouette Match Ring & Role Details */}
                <div className="flex items-start gap-4 flex-1 min-w-0">
                  {/* Score Ring Silhouette (generic shape, no fake percentage) */}
                  <div className="w-14 h-14 rounded-full border-4 border-slate-200 bg-slate-100 flex flex-col items-center justify-center shrink-0">
                    <div className="w-6 h-3 bg-slate-300 rounded-sm mb-1" />
                    <span className="text-[9px] text-slate-400 font-bold uppercase">Match</span>
                  </div>

                  {/* Role and Company Metadata Skeletons */}
                  <div className="space-y-2 flex-1 min-w-0">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-slate-200 shrink-0" />
                      <div className="h-5 bg-slate-200 rounded-md w-48 sm:w-64" />
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <div className="h-3.5 bg-slate-200 rounded-sm w-24" />
                      <span className="text-slate-300">•</span>
                      <div className="h-3.5 bg-slate-200 rounded-sm w-28" />
                      <span className="text-slate-300">•</span>
                      <div className="h-3.5 bg-slate-200 rounded-sm w-20" />
                    </div>

                    {/* Matched Skill Chip Skeletons */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <div className="h-4 bg-slate-200 rounded-md w-16" />
                      <div className="h-4 bg-slate-200 rounded-md w-20" />
                      <div className="h-4 bg-slate-200 rounded-md w-14" />
                    </div>
                  </div>
                </div>

                {/* Right: Action Buttons Skeleton */}
                <div className="flex items-center gap-2 shrink-0 pt-2 md:pt-0">
                  <div className="h-9 w-24 bg-slate-100 rounded-xl border border-slate-200" />
                  <div className="h-9 w-24 bg-slate-100 rounded-xl border border-slate-200" />
                  <div className="h-9 w-9 bg-slate-100 rounded-xl border border-slate-200" />
                </div>
              </div>

              {/* Why Match Sub-Score Rings Skeleton Outline */}
              <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full border-2 border-slate-200 bg-slate-100" />
                    <div className="h-3 bg-slate-200 rounded-sm w-16" />
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full border-2 border-slate-200 bg-slate-100" />
                    <div className="h-3 bg-slate-200 rounded-sm w-14" />
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full border-2 border-slate-200 bg-slate-100" />
                    <div className="h-3 bg-slate-200 rounded-sm w-12" />
                  </div>
                </div>
                <div className="h-3 bg-slate-200 rounded-sm w-36" />
              </div>
            </div>
          ))}
        </div>
      </LockedPreview>
    </div>
  );
}
