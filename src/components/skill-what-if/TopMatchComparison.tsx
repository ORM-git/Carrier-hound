import React from "react";
import { ArrowUpRight, Minus } from "lucide-react";

interface TopMatchComparisonProps {
  baseMatch: number;
  newMatch: number;
}

export default function TopMatchComparison({
  baseMatch,
  newMatch,
}: TopMatchComparisonProps) {
  const delta = newMatch - baseMatch;
  const isPositive = delta > 0;

  return (
    <div className="bg-white rounded-2xl ring-1 ring-[#E2E8F0] shadow-xs p-6 sm:p-8 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-bold text-[#0F172A]">Match Score Simulation</h2>
        <span className="text-[15px] font-medium text-[#64748B]">
          Based on target job requirements
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
        {/* Current Match */}
        <div className="rounded-xl border border-[#E2E8F0] bg-slate-50/70 p-5 space-y-2">
          <span className="text-[15px] font-semibold text-[#64748B] block">
            Current Profile Match
          </span>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl sm:text-5xl font-extrabold text-[#334155] tracking-tight">
              {baseMatch}%
            </span>
          </div>
          <p className="text-[15px] text-[#64748B]">
            Match with your current resume
          </p>
        </div>

        {/* New Simulated Match */}
        <div className="rounded-xl border-2 border-[#BFDBFE] bg-blue-50/40 p-5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[15px] font-bold text-[#1D4ED8] block">
              Simulated Match
            </span>
            {isPositive ? (
              <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[15px] font-bold text-[#1D4ED8]">
                <ArrowUpRight className="w-4 h-4 text-[#2563EB]" />
                +{delta}% match gain
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-slate-100 text-[15px] font-medium text-[#64748B]">
                <Minus className="w-4 h-4 text-[#64748B]" />
                no change
              </span>
            )}
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl sm:text-5xl font-extrabold text-[#2563EB] tracking-tight">
              {newMatch}%
            </span>
          </div>
          <p className="text-[15px] text-[#1E40AF]">
            Projected match with simulated skills added
          </p>
        </div>
      </div>
    </div>
  );
}
