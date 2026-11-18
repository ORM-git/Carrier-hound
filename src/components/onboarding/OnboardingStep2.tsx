"use client";

import React from "react";
import BrandIcon from "@/components/BrandIcon";
import { ArrowLeft, FileText, CheckCircle2 } from "lucide-react";

interface OnboardingStep2Props {
  onBack: () => void;
  onFinish: () => void;
  isSaving: boolean;
}

export default function OnboardingStep2({
  onBack,
  onFinish,
  isSaving,
}: OnboardingStep2Props) {
  return (
    <div className="w-full max-w-lg mx-auto flex flex-col pb-28 pt-4 px-4 sm:px-6">
      {/* Back button */}
      <div className="mb-4">
        <button
          type="button"
          onClick={onBack}
          disabled={isSaving}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to preferences</span>
        </button>
      </div>

      {/* Copilot Message Header */}
      <div className="flex items-start gap-3 mb-6">
        <div className="relative flex-shrink-0">
          <div className="w-11 h-11 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center p-2 text-emerald-600 shadow-sm">
            <BrandIcon className="w-7 h-7" />
          </div>
          <span
            className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-emerald-500 border-2 border-white dark:border-zinc-900 rounded-full"
            title="Copilot Online"
          />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100">CareerMonke Copilot</span>
            <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300">AI</span>
          </div>
          <div className="p-3.5 rounded-2xl rounded-tl-sm bg-white dark:bg-zinc-800/80 border border-zinc-200/80 dark:border-zinc-700/80 shadow-sm text-sm text-zinc-800 dark:text-zinc-200 leading-relaxed">
            Seeing some exciting opportunities for you already! Connect your profile or skip ahead to your personalized recommendations.
          </div>
        </div>
      </div>

      {/* Cards Container */}
      <div className="space-y-4">
        {/* 1. LinkedIn URL Card (Disabled - Coming soon) */}
        <div className="relative bg-white dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-6 sm:p-8 flex flex-col items-center justify-center text-center shadow-sm opacity-80">
          <div className="absolute top-4 right-4">
            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
              Coming soon
            </span>
          </div>

          <div className="w-14 h-14 rounded-2xl bg-[#0077b5]/10 flex items-center justify-center text-[#0077b5] mb-4">
            <svg
              className="w-8 h-8 fill-current"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
            </svg>
          </div>

          <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            Connect LinkedIn Profile
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-xs mb-5">
            Auto-import your verified skills, experience, and recommendations.
          </p>

          <button
            type="button"
            disabled
            className="w-full sm:w-auto px-6 py-2.5 rounded-full text-xs font-bold text-zinc-400 dark:text-zinc-500 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 cursor-not-allowed"
          >
            Enter LinkedIn URL
          </button>
        </div>

        {/* 2. Resume Upload Card (Disabled - Coming soon) */}
        <div className="relative bg-white dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-6 sm:p-8 flex flex-col items-center justify-center text-center shadow-sm opacity-80">
          <div className="absolute top-4 right-4">
            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
              Coming soon
            </span>
          </div>

          <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center text-emerald-600 mb-4">
            <FileText className="w-8 h-8" />
          </div>

          <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            Upload Your Resume
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-xs mb-5">
            AI extracts your skills and matches you directly with hiring teams.
          </p>

          <button
            type="button"
            disabled
            className="w-full sm:w-auto px-6 py-2.5 rounded-full text-xs font-bold text-zinc-400 dark:text-zinc-500 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 cursor-not-allowed"
          >
            Upload Resume
          </button>
        </div>
      </div>

      {/* Sticky Bottom Bar */}
      <div className="fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md border-t border-zinc-200/80 dark:border-zinc-800 p-4">
        <div className="max-w-lg mx-auto space-y-3">
          {/* Progress bar (Step 2 of 2 -> 100%) */}
          <div className="w-full bg-zinc-100 dark:bg-zinc-800 h-1.5 rounded-full overflow-hidden">
            <div
              className="bg-emerald-500 h-full rounded-full transition-all duration-300"
              style={{ width: "100%" }}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <span className="text-xs font-semibold text-zinc-400 dark:text-zinc-500">
              Step 2 of 2
            </span>
            <button
              type="button"
              disabled={isSaving}
              onClick={onFinish}
              className="px-8 py-3 rounded-full text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 shadow-md hover:shadow-lg transition flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <span>{isSaving ? "Saving..." : "Skip for now & Finish"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
