"use client";

import React from "react";
import BrandedErrorFallback from "@/components/error/BrandedErrorFallback";

export default function RootError({
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
      badgeLabel="Error \u2022 Something went wrong"
      title="Something went wrong"
      description="An unexpected error occurred while loading this page. You can try again or return to the homepage."
      showHomeLink={true}
      showBrowseJobs={true}
      fullScreen={true}
    />
  );
}
