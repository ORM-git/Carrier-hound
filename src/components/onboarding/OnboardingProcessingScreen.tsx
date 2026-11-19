"use client";

import React, { useState, useEffect, useRef } from "react";
import { FileText, AlertCircle, RefreshCw } from "lucide-react";
import OnboardingFeatureHighlights from "./OnboardingFeatureHighlights";

export type ProcessingPhase = "uploading" | "saving" | "error" | "complete";

export interface OnboardingProcessingScreenProps {
  fileName?: string | null;
  phase?: ProcessingPhase;
  isSavingPreferences?: boolean;
  statusMessage?: string;
  statusText?: string;
  subText?: string;
  error?: string | null;
  onRetry?: () => void;
  className?: string;
  showHighlights?: boolean;
}

/**
 * Exact truthful status lines rotated while the single upload+parse request is pending.
 * These are status/helper lines, not claims of completed backend phases.
 */
export const UPLOAD_ROTATING_MESSAGES = [
  "Uploading and reading your file.",
  "Your job preferences stay in place.",
  "Next, review the roles available to you.",
] as const;

export const SAVING_PREFERENCES_MESSAGE = "Saving your preferences.";

/**
 * OnboardingProcessingScreen
 *
 * Isolated presentational processing screen matching reference image-65957ef3.jpg:
 * - Generous white page
 * - Centered floating document animation with blue scanning sweep
 * - Slim indeterminate CM-blue progress bar (no fake percentage, no timer to 100%)
 * - Fixed-height stable status line with restrained vertical/crossfade rotation
 * - Large rounded Feature Highlights card below
 * - Fully accessible and compliant with prefers-reduced-motion
 */
export default function OnboardingProcessingScreen({
  fileName,
  phase = "uploading",
  isSavingPreferences = false,
  statusMessage,
  statusText,
  subText: _subText,
  error,
  onRetry,
  className = "",
  showHighlights = true,
}: OnboardingProcessingScreenProps) {
  const isSaving = isSavingPreferences || phase === "saving";
  const isError = Boolean(error || phase === "error");
  const manualMessage = statusMessage || statusText;

  const [messageIndex, setMessageIndex] = useState(0);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const rotationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check prefers-reduced-motion
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);

    const listener = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches);
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", listener);
      return () => mediaQuery.removeEventListener("change", listener);
    } else if (mediaQuery.addListener) {
      mediaQuery.addListener(listener);
      return () => mediaQuery.removeListener(listener);
    }
  }, []);

  // Sentence rotation timer during upload
  useEffect(() => {
    if (rotationTimerRef.current) {
      clearInterval(rotationTimerRef.current);
      rotationTimerRef.current = null;
    }

    // Do not rotate if saving, in error, or if manual status message is supplied
    if (!isSaving && !isError && !manualMessage) {
      rotationTimerRef.current = setInterval(() => {
        setMessageIndex((prev) => (prev + 1) % UPLOAD_ROTATING_MESSAGES.length);
      }, 3200);
    }

    return () => {
      if (rotationTimerRef.current) {
        clearInterval(rotationTimerRef.current);
        rotationTimerRef.current = null;
      }
    };
  }, [isSaving, isError, manualMessage]);

  // Determine current active status text
  const currentStatusText = isError
    ? error || "An error occurred while processing your file."
    : isSaving
    ? SAVING_PREFERENCES_MESSAGE
    : manualMessage || UPLOAD_ROTATING_MESSAGES[messageIndex];

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Processing your file and preferences"
      className={`min-h-screen w-full bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex flex-col items-center justify-between py-10 sm:py-14 md:py-16 px-4 sm:px-6 md:px-8 ${className}`}
    >
      <style>{`
        @keyframes cmFloatBob {
          0%, 100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-8px);
          }
        }

        @keyframes cmScanSweep {
          0% {
            top: 6px;
            opacity: 0.2;
          }
          50% {
            top: 50px;
            opacity: 0.9;
          }
          100% {
            top: 6px;
            opacity: 0.2;
          }
        }

        @keyframes cmIndeterminateBar {
          0% {
            left: -35%;
            width: 35%;
          }
          50% {
            left: 35%;
            width: 45%;
          }
          100% {
            left: 100%;
            width: 35%;
          }
        }

        @keyframes cmFadeSlideIn {
          0% {
            opacity: 0;
            transform: translateY(3px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .cm-doc-float {
          animation: cmFloatBob 3s ease-in-out infinite;
        }

        .cm-scan-sweep {
          animation: cmScanSweep 2.2s ease-in-out infinite;
        }

        .cm-bar-indeterminate {
          animation: cmIndeterminateBar 1.8s cubic-bezier(0.65, 0.815, 0.735, 0.395) infinite;
        }

        .cm-text-enter {
          animation: cmFadeSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }

        @media (prefers-reduced-motion: reduce) {
          .cm-doc-float,
          .cm-scan-sweep,
          .cm-bar-indeterminate,
          .cm-text-enter {
            animation: none !important;
            transform: none !important;
          }
          .cm-bar-indeterminate {
            left: 0 !important;
            width: 100% !important;
            opacity: 0.8 !important;
          }
        }
      `}</style>

      {/* Top spacer for vertical rhythm */}
      <div className="w-full h-2 sm:h-4" aria-hidden="true" />

      {/* Center Section: Document Animation, Indeterminate Bar, and Status Line */}
      <div className="w-full max-w-xl mx-auto flex flex-col items-center justify-center text-center">
        {/* Floating Document Container */}
        <div
          data-testid="cm-document-container"
          className={`relative mb-5 flex items-center justify-center ${
            prefersReducedMotion ? "" : "cm-doc-float"
          }`}
        >
          {/* Circular badge container */}
          <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-full bg-blue-50/90 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900/60 flex items-center justify-center relative shadow-xs p-4">
            {/* Document SVG with folded top-right corner and text lines */}
            <div className="relative w-12 h-16 sm:w-14 sm:h-18 flex items-center justify-center overflow-hidden">
              <svg
                viewBox="0 0 48 60"
                className="w-full h-full drop-shadow-2xs"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                {/* Document Body */}
                <path
                  d="M4 2C4 0.895431 4.89543 0 6 0H32L46 14V58C46 59.1046 45.1046 60 44 60H6C4.89543 60 4 59.1046 4 58V2Z"
                  className="fill-white dark:fill-zinc-900 stroke-blue-600 dark:stroke-blue-400"
                  strokeWidth="2"
                />
                {/* Folded Corner */}
                <path
                  d="M32 0V14H46"
                  className="fill-blue-50 dark:fill-blue-950 stroke-blue-600 dark:stroke-blue-400"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
                {/* Document Text Skeleton Lines */}
                <rect x="10" y="20" width="28" height="2.5" rx="1.25" className="fill-blue-200 dark:fill-blue-900" />
                <rect x="10" y="27" width="24" height="2.5" rx="1.25" className="fill-blue-200 dark:fill-blue-900" />
                <rect x="10" y="34" width="26" height="2.5" rx="1.25" className="fill-blue-200 dark:fill-blue-900" />
                <rect x="10" y="41" width="18" height="2.5" rx="1.25" className="fill-blue-200 dark:fill-blue-900" />
                <rect x="10" y="48" width="22" height="2.5" rx="1.25" className="fill-blue-200 dark:fill-blue-900" />
              </svg>

              {/* Animated CM-Blue Scanning Sweep Line across the document */}
              {!prefersReducedMotion && (
                <div
                  data-testid="cm-scanning-sweep"
                  className="cm-scan-sweep absolute inset-x-0 h-1 bg-gradient-to-r from-transparent via-blue-500 to-transparent shadow-[0_0_8px_rgba(37,99,235,0.8)] pointer-events-none"
                  aria-hidden="true"
                />
              )}
            </div>
          </div>
        </div>

        {/* File Name Pill (if file is present) */}
        {fileName && (
          <div
            data-testid="cm-file-badge"
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50/80 dark:bg-blue-950/60 text-xs font-semibold text-blue-900 dark:text-blue-200 mb-3 border border-blue-200/60 dark:border-blue-800/60 max-w-xs truncate"
          >
            <FileText className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
            <span className="truncate">{fileName}</span>
          </div>
        )}

        {/* Slim Blue CM Indeterminate Progress Bar */}
        {/* Strictly indeterminate: no fabricated percentage, no timer reaching 100% */}
        <div
          data-testid="cm-progress-bar-container"
          aria-hidden="true"
          className="w-56 sm:w-64 md:w-72 h-1 sm:h-1.5 bg-blue-100 dark:bg-blue-950/80 rounded-full overflow-hidden relative my-3 sm:my-4"
        >
          <div
            data-testid="cm-indeterminate-bar"
            className="cm-bar-indeterminate absolute top-0 bottom-0 bg-blue-600 dark:bg-blue-500 rounded-full"
          />
        </div>

        {/* One Short Status Line (Fixed minimum height to guarantee zero layout shift) */}
        <div
          data-testid="cm-status-line-container"
          className="min-h-[2rem] sm:min-h-[2.25rem] flex items-center justify-center px-4"
        >
          {isError ? (
            <div
              role="alert"
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-xs sm:text-sm font-semibold text-red-700 dark:text-red-300"
            >
              <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0" />
              <span>{currentStatusText}</span>
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="ml-2 inline-flex items-center gap-1 text-xs font-bold underline underline-offset-2 hover:text-red-900 dark:hover:text-red-100"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Retry</span>
                </button>
              )}
            </div>
          ) : (
            <p
              key={currentStatusText}
              data-testid="cm-status-text"
              className={`text-sm sm:text-base font-semibold text-zinc-800 dark:text-zinc-200 tracking-tight leading-normal ${
                prefersReducedMotion ? "" : "cm-text-enter"
              }`}
            >
              {currentStatusText}
            </p>
          )}
        </div>
      </div>

      {/* Large Rounded Feature Card Below (Listing-only Feature Highlights) */}
      {showHighlights && (
        <div className="w-full mt-8 sm:mt-12 md:mt-16">
          <OnboardingFeatureHighlights />
        </div>
      )}

      {/* Bottom spacer for vertical balance */}
      <div className="w-full h-2 sm:h-4" aria-hidden="true" />
    </div>
  );
}
