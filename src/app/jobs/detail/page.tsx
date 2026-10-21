"use client";

import React, { useEffect } from "react";

export default function JobDetailRedirectPage() {
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.location.replace("/job-detail" + window.location.search);
    }
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mb-4" />
      <p className="text-sm text-slate-500">Redirecting to job details...</p>
    </div>
  );
}
