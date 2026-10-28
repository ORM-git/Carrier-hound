"use client";

import React from "react";
import { ShieldCheck } from "lucide-react";

export default function DossierFooter() {
  return (
    <footer
      role="contentinfo"
      aria-label="Interview pack disclaimer"
      className="mt-16 pt-8 pb-12 border-t border-[#E2E8F0] text-center space-y-2 max-w-3xl mx-auto px-4"
    >
      <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-[#64748B]">
        <ShieldCheck className="w-4 h-4 text-[#2563EB]" />
        <span>Public Evidence Intelligence · Grounded Career Prep</span>
      </div>
      <p className="text-[15px] text-[#475569] leading-relaxed font-medium">
        Preparation aid based on public sources; no hiring outcome is guaranteed.
      </p>
      <p className="text-xs text-[#94A3B8]">
        CareerMonke does not make claims of algorithmic ATS ranking or recruiter shortlist guarantees. Responses are strictly intended as structured preparation frameworks.
      </p>
    </footer>
  );
}
