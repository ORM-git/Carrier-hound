"use client";

import { useEffect } from "react";

export default function JobsDetailRedirectPage() {
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.location.replace(`/job-detail${window.location.search || ""}`);
    }
  }, []);

  return null;
}
