"use client";

import React from "react";
import { GitBranch, Clock, Video, Lightbulb } from "lucide-react";
import type { InterviewPackData } from "@/data/interviewPackFixture";

interface ProcessSectionProps {
  processData: InterviewPackData["process"];
  companyName: string;
}

export default function ProcessSection({
  processData,
  companyName,
}: ProcessSectionProps) {
  return (
    <div className="space-y-8 max-w-4xl">
      {/* Title */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#2563EB]">
          <GitBranch className="w-4 h-4" />
          <span>Section 2 · The Pipeline</span>
        </div>
        <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight">
          Interview Rounds & Evaluation Criteria at {companyName}
        </h2>
        <p className="text-[15px] sm:text-[16px] text-[#475569] leading-relaxed">
          {processData.overview}
        </p>
      </div>

      {/* Stages Vertical Timeline */}
      <div className="space-y-4">
        {processData.stages.map((stg) => (
          <div
            key={stg.step}
            className="p-6 rounded-2xl bg-white ring-1 ring-[#E2E8F0] shadow-xs space-y-4 relative"
          >
            {/* Top row */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] font-black text-sm flex items-center justify-center shrink-0">
                  {stg.step}
                </div>
                <div>
                  <h3 className="text-lg font-bold text-[#0F172A]">{stg.name}</h3>
                  <div className="flex items-center gap-3 text-xs text-[#64748B] font-medium mt-0.5">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5 text-[#2563EB]" />
                      <span>{stg.duration}</span>
                    </span>
                    <span>•</span>
                    <span className="flex items-center gap-1">
                      <Video className="w-3.5 h-3.5 text-[#2563EB]" />
                      <span>{stg.format}</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Core Focus */}
            <div className="space-y-1">
              <span className="text-xs font-bold uppercase tracking-wider text-[#64748B]">
                Primary Evaluation Focus:
              </span>
              <p className="text-[15px] text-[#334155] leading-relaxed font-medium">
                {stg.focus}
              </p>
            </div>

            {/* Pro Tip */}
            <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] text-[14px] text-[#1E40AF] leading-relaxed">
              <Lightbulb className="w-4 h-4 text-[#2563EB] shrink-0 mt-0.5" />
              <div>
                <strong className="font-bold">Insider tip:</strong> {stg.proTip}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
