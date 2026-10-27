"use client";

import React from "react";
import Link from "next/link";
import { Lock, Sparkles, ArrowRight } from "lucide-react";

export interface LockedPreviewProps {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  ctaText?: string;
  ctaHref?: string;
  badge?: string;
  blurIntensity?: "sm" | "md" | "lg";
  className?: string;
  overlayClassName?: string;
  cardClassName?: string;
  showLockIcon?: boolean;
  minHeight?: string;
  testId?: string;
}

export default function LockedPreview({
  children,
  title = "Unlock to see your compatible score and your Top 10 jobs.",
  subtitle = "Your match score is ready. Only you can't see it yet. Recruiters filter by fit. Find out where you stand.",
  ctaText = "Unlock my score",
  ctaHref = "/pricing",
  badge = "PRO FEATURE",
  blurIntensity = "md",
  className = "",
  overlayClassName = "",
  cardClassName = "",
  showLockIcon = true,
  minHeight = "min-h-[220px]",
  testId = "locked-preview-overlay",
}: LockedPreviewProps) {
  const blurClass =
    blurIntensity === "sm"
      ? "blur-xs"
      : blurIntensity === "lg"
      ? "blur-lg"
      : "blur-md";

  return (
    <div
      className={`relative overflow-hidden rounded-2xl ${minHeight} ${className}`}
      data-testid="locked-preview-container"
    >
      {/* Blurred silhouette layer (real CSS blur, strictly aria-hidden, non-selectable) */}
      <div
        aria-hidden="true"
        tabIndex={-1}
        className={`w-full select-none pointer-events-none filter ${blurClass} opacity-60 transition-all duration-200`}
      >
        {children}
      </div>

      {/* High-contrast centered paywall overlay */}
      <div
        data-testid={testId}
        className={`absolute inset-0 z-10 flex items-center justify-center p-3 sm:p-6 bg-slate-900/10 backdrop-blur-[2px] ${overlayClassName}`}
      >
        <div
          className={`w-full max-w-md bg-white/95 backdrop-blur-md rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-xl text-center space-y-3.5 sm:space-y-4 animate-fadeIn ${cardClassName}`}
        >
          {badge && (
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-[11px] font-bold tracking-wide uppercase">
              <Sparkles className="w-3 h-3 text-blue-600" />
              <span>{badge}</span>
            </div>
          )}

          {showLockIcon && (
            <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-blue-50 border border-blue-100 text-blue-600 flex items-center justify-center mx-auto shadow-2xs">
              <Lock className="w-5 h-5 sm:w-6 sm:h-6" />
            </div>
          )}

          <div className="space-y-1 sm:space-y-1.5">
            <h3 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight leading-snug">
              {title}
            </h3>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed max-w-sm mx-auto">
              {subtitle}
            </p>
          </div>

          <div className="pt-1">
            <Link
              href={ctaHref}
              data-testid="locked-preview-cta"
              className="inline-flex items-center justify-center gap-2 w-full py-2.5 sm:py-3 px-5 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white font-bold text-xs sm:text-sm shadow-sm transition duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              <span>{ctaText}</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
