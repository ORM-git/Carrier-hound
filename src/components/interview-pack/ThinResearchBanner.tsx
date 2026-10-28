"use client";

import React from "react";
import { Info, ExternalLink } from "lucide-react";

interface ThinResearchBannerProps {
  isThinResearch: boolean;
  onOpenSources?: () => void;
}

export default function ThinResearchBanner({
  isThinResearch,
  onOpenSources,
}: ThinResearchBannerProps) {
  if (!isThinResearch) return null;

  return (
    <div
      data-testid="thin-research-banner"
      role="alert"
      className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-r-xl shadow-xs flex items-start gap-3 my-4"
    >
      <Info className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 space-y-1">
        <h4 className="text-[15px] font-bold text-amber-900 leading-tight">
          Limited Company-Specific Interview Data Found
        </h4>
        <p className="text-[14px] text-amber-800 leading-relaxed">
          Questions and interview formats in this dossier reflect generalized industry benchmarks for this role tier. We synthesize verified patterns from comparable organizations.
        </p>
      </div>
      {onOpenSources && (
        <button
          type="button"
          onClick={onOpenSources}
          className="text-xs font-bold text-amber-900 hover:text-amber-950 underline shrink-0 inline-flex items-center gap-1 cursor-pointer pt-0.5"
        >
          <span>View sources</span>
          <ExternalLink className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
