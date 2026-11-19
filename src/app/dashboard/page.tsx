"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Legacy /dashboard URL. Dashboard was retired; Jobs is the signed-in home.
 * Middleware and public/_redirects send /dashboard and /dashboard/* to /jobs first;
 * this covers client-side navigations and static hosting. No Dashboard UI or data loads here.
 */
export default function LegacyDashboardRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/jobs");
  }, [router]);

  return (
    <main id="main-content" className="min-h-[50vh] flex items-center justify-center p-6 text-sm text-slate-500">
      <p role="status">
        Redirecting to <a href="/jobs" className="font-semibold text-blue-600 underline">Jobs</a>…
      </p>
    </main>
  );
}
