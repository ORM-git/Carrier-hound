"use client";

import React from "react";
import BrandedErrorFallback from "@/components/error/BrandedErrorFallback";

export default function DashboardError({
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
      badgeLabel="Dashboard \u2022 Something went wrong"
      title="Unable to load dashboard"
      description="An unexpected error occurred while loading your dashboard. You can try reloading or return to the homepage."
      showHomeLink={true}
      showBrowseJobs={true}
      fullScreen={false}
    />
  );
}
