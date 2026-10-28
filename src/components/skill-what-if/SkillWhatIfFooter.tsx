import React from "react";
import { ShieldCheck } from "lucide-react";

export default function SkillWhatIfFooter() {
  return (
    <footer className="pt-4 pb-8 text-center border-t border-[#E2E8F0]">
      <div className="max-w-2xl mx-auto flex items-center justify-center gap-2 text-[15px] text-[#64748B]">
        <ShieldCheck className="w-4 h-4 text-[#2563EB] shrink-0" />
        <p>
          Estimate from your resume and job descriptions. Not a guarantee of interviews or jobs.
        </p>
      </div>
    </footer>
  );
}
