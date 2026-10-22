"use client";

import { useEffect } from "react";

export default function JobsDetailRedirectPage() {
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.location.replace(`/jobs${window.location.search || ""}`);
    }
  }, []);

  return null;
}
