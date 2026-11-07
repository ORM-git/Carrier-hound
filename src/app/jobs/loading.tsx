import React from "react";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";

export default function JobsLoading() {
  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#09090B] flex flex-col">
      <GuideHeader />

      <main role="status" aria-label="Loading jobs" className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        {/* Top Header & Search Ribbon Skeleton */}
        <div aria-hidden="true" className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-2">
              <div className="h-7 w-64 bg-slate-200 rounded animate-pulse" />
              <div className="h-4 w-96 max-w-full bg-slate-100 rounded animate-pulse" />
            </div>
            <div className="h-9 w-48 bg-slate-200 rounded-xl animate-pulse" />
          </div>

          <div className="p-3 bg-white rounded-2xl border border-slate-200 shadow-2xs space-y-3">
            <div className="h-10 w-full bg-slate-100 rounded-xl animate-pulse" />
            <div className="flex gap-2">
              <div className="h-8 w-24 bg-slate-100 rounded-lg animate-pulse" />
              <div className="h-8 w-24 bg-slate-100 rounded-lg animate-pulse" />
              <div className="h-8 w-32 bg-slate-100 rounded-lg animate-pulse" />
            </div>
          </div>
        </div>

        {/* Job Cards Skeleton */}
        <div aria-hidden="true" className="space-y-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="p-5 rounded-2xl border border-slate-200 bg-white shadow-2xs space-y-3 animate-pulse"
            >
              <div className="flex items-center justify-between">
                <div className="h-5 w-48 bg-slate-200 rounded" />
                <div className="h-6 w-20 bg-slate-100 rounded-full" />
              </div>
              <div className="h-4 w-32 bg-slate-100 rounded" />
              <div className="flex gap-2 pt-2">
                <div className="h-6 w-16 bg-slate-100 rounded-md" />
                <div className="h-6 w-24 bg-slate-100 rounded-md" />
                <div className="h-6 w-20 bg-slate-100 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      </main>

      <Footer />
    </div>
  );
}
