"use client";

import React, { useEffect } from "react";
import Link from "next/link";
import BrandIcon from "@/components/BrandIcon";
import { reportErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";

export interface BrandedErrorFallbackProps {
  error: Error & { digest?: string };
  reset: () => void;
  badgeLabel?: string;
  title?: string;
  description?: string;
  showHomeLink?: boolean;
  showBrowseJobs?: boolean;
  fullScreen?: boolean;
}

export default function BrandedErrorFallback({
  error,
  reset,
  badgeLabel = "Error \u2022 Something went wrong",
  title = "Something went wrong",
  description = "An unexpected error occurred while loading this page. You can try again or return to the homepage.",
  showHomeLink = true,
  showBrowseJobs = false,
  fullScreen = true,
}: BrandedErrorFallbackProps) {
  useEffect(() => {
    reportErrorToSentry(error);
  }, [error]);

  return (
    <div
      className={`bg-white text-[#09090B] flex flex-col justify-center items-center px-6 py-16 ${
        fullScreen ? "min-h-screen" : "min-h-[60vh] flex-1"
      }`}
      role="alert"
      aria-live="assertive"
    >
      {/* Brand Icon Header */}
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-blue-600 mb-8 group"
        aria-label="CareerMonke Home"
      >
        <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center shadow-sm">
          <BrandIcon className="w-5 h-5 text-white" />
        </div>
        <span className="text-2xl font-bold tracking-tight text-blue-600">CareerMonke</span>
      </Link>

      <div className="max-w-md w-full text-center space-y-4">
        <div className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-red-50 text-red-700 border border-red-200">
          {badgeLabel}
        </div>

        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-gray-900">
          {title}
        </h1>

        <p className="text-sm sm:text-base text-gray-500 leading-relaxed">
          {description}
        </p>

        <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="w-full sm:w-auto inline-flex items-center justify-center px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm transition-colors shadow-sm cursor-pointer"
          >
            Try again
          </button>
          {showHomeLink && (
            <Link
              href="/"
              className="w-full sm:w-auto inline-flex items-center justify-center px-6 py-3 rounded-lg border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm transition-colors"
            >
              &larr; Back to Homepage
            </Link>
          )}
          {showBrowseJobs && (
            <Link
              href="/jobs"
              className="w-full sm:w-auto inline-flex items-center justify-center px-6 py-3 rounded-lg border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm transition-colors"
            >
              Browse Unindexed Jobs
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
