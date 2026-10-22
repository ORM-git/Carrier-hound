"use client";

import React, { useEffect, Suspense } from "react";
import { useRouter } from "next/navigation";

function JobDetailRedirectInner() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window !== "undefined") {
      const search = window.location.search || "";
      router.replace(`/jobs${search}`);
    }
  }, [router]);

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center">
      <div className="w-8 h-8 rounded-full border-2 border-[#2563EB] border-t-transparent animate-spin" />
    </div>
  );
}

export default function JobDetailPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#F8FAFC]" />}>
      <JobDetailRedirectInner />
    </Suspense>
  );
}
