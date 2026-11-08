"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { buildJobsRedirectUrl } from "@/lib/jobs/redirects";

export default function JobSearchAllRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window !== "undefined") {
      const target = buildJobsRedirectUrl(window.location.search, window.location.hash);
      router.replace(target);
    }
  }, [router]);

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="text-center space-y-3" role="status" aria-label="Redirecting to the jobs directory">
        <div aria-hidden="true" className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-xs font-semibold text-slate-500">
          Redirecting to canonical CareerMonke Jobs directory…
        </p>
      </div>
    </div>
  );
}
