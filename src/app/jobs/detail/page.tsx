"use client";

import { useEffect } from "react";

export default function JobsDetailRedirectPage() {
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.location.replace(`/jobs${window.location.search || ""}`);
    }
  }, []);

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col justify-between p-6">
      <div />
      <div className="w-8 h-8 rounded-full border-2 border-[#2563EB] border-t-transparent animate-spin mx-auto" />
      <footer className="py-2 text-center text-xs text-slate-400">
        © 2026 Olive Ridley Media Private Limited. All rights reserved.
      </footer>
    </div>
  );
}
