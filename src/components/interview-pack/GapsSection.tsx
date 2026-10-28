"use client";

import React from "react";
import { GitCompare, CheckCircle2, AlertTriangle, XCircle, ArrowRight } from "lucide-react";
import type { GapMatrixItem } from "@/data/interviewPackFixture";

interface GapsSectionProps {
  gaps: GapMatrixItem[];
}

export default function GapsSection({ gaps }: GapsSectionProps) {
  const getStatusBadge = (status: GapMatrixItem["resumeStatus"]) => {
    switch (status) {
      case "matched":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-300">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            <span>Direct Match</span>
          </span>
        );
      case "partial":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-50 text-amber-800 border border-amber-300">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
            <span>Partial Match</span>
          </span>
        );
      case "gap":
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-50 text-rose-800 border border-rose-300">
            <XCircle className="w-3.5 h-3.5 text-rose-600" />
            <span>Experience Gap</span>
          </span>
        );
    }
  };

  return (
    <div className="space-y-8 max-w-4xl">
      {/* Title */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#2563EB]">
          <GitCompare className="w-4 h-4" />
          <span>Section 5 · Gaps Analysis</span>
        </div>
        <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight">
          JD Needs vs. Your Resume Evidence
        </h2>
        <p className="text-[15px] sm:text-[16px] text-[#475569] leading-relaxed">
          Where your profile aligns directly, where slight gaps exist, and actionable bridge strategies to address them confidently during the interview.
        </p>
      </div>

      {/* Gaps Matrix */}
      <div className="space-y-4">
        {gaps.map((item) => (
          <div
            key={item.id}
            className="p-6 rounded-2xl bg-white ring-1 ring-[#E2E8F0] shadow-xs space-y-4"
          >
            {/* Header: Requirement + Status */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="space-y-1">
                <span className="text-xs font-bold text-[#64748B] uppercase tracking-wider">
                  Target Requisition Need
                </span>
                <h3 className="text-[17px] font-bold text-[#0F172A]">
                  {item.jdRequirement}
                </h3>
              </div>
              {getStatusBadge(item.resumeStatus)}
            </div>

            {/* Split row: Evidence vs Bridge */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
              {/* Evidence */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-[#475569]">
                  Confirmed in Your Resume:
                </span>
                <p className="text-[14px] sm:text-[15px] text-[#1E293B] leading-relaxed font-medium">
                  {item.resumeEvidence}
                </p>
              </div>

              {/* Bridge Strategy */}
              <div className="p-4 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] space-y-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-[#1D4ED8]">
                  How to Bridge in the Room:
                </span>
                <p className="text-[14px] sm:text-[15px] text-[#1E40AF] leading-relaxed font-medium">
                  {item.bridgeStrategy}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
