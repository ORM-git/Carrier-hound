"use client";

import { useEffect, Suspense } from "react";
import { useRouter } from "next/navigation";
import { getAuthUser } from "@/lib/auth/session";

function JobsDetailRedirectInner() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    getAuthUser().then((user) => {
      if (cancelled) return;
      if (!user) {
        const fullUrl =
          typeof window !== "undefined"
            ? `${window.location.pathname}${window.location.search}`
            : "/jobs";
        router.replace(`/login?next=${encodeURIComponent(fullUrl)}`);
        return;
      }
      const search = typeof window !== "undefined" ? window.location.search || "" : "";
      router.replace(`/jobs${search}`);
    });

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center">
      <div className="w-8 h-8 rounded-full border-2 border-[#2563EB] border-t-transparent animate-spin" />
    </div>
  );
}

export default function JobsDetailRedirectPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#F8FAFC]" />}>
      <JobsDetailRedirectInner />
    </Suspense>
  );
}
