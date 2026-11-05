"use client";

import React from "react";
import BrandedErrorFallback from "@/components/error/BrandedErrorFallback";

export default function JobsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <BrandedErrorFallback
      error={error}
      reset={reset}
      badgeLabel="Jobs \u2022 Something went wrong"
      title="Unable to load jobs"
      description="An unexpected error occurred while loading the job feed. You can try reloading or return to the homepage."
      showHomeLink={true}
      showBrowseJobs={false}
      fullScreen={false}
    />
  );
}
