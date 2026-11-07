"use client";

import React, { useState } from "react";
import { copyTextToClipboard } from "@/lib/clipboard";
import { HelpCircle, Copy, Check, Ear, Sparkles } from "lucide-react";
import type { ReverseQuestion } from "@/data/interviewPackFixture";

interface AskThemSectionProps {
  questions: ReverseQuestion[];
}

export default function AskThemSection({ questions }: AskThemSectionProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = async (id: string, text: string) => {
    if (await copyTextToClipboard(text)) {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  return (
    <div className="space-y-8 max-w-4xl">
      {/* Title */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#2563EB]">
          <HelpCircle className="w-4 h-4" />
          <span>Section 6 · Reverse Interview</span>
        </div>
        <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight">
          High-Leverage Questions to Ask Your Interviewers
        </h2>
        <p className="text-[15px] sm:text-[16px] text-[#475569] leading-relaxed">
          The questions you ask at the end of the round signal senior judgment. These questions uncover true engineering culture and team dynamics while demonstrating leadership.
        </p>
      </div>

      {/* Questions List */}
      <div className="space-y-4">
        {questions.map((q) => (
          <div
            key={q.id}
            className="p-6 rounded-2xl bg-white ring-1 ring-[#E2E8F0] shadow-xs space-y-4"
          >
            {/* Header + Category */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="space-y-1">
                <span className="text-xs font-bold text-[#2563EB] uppercase tracking-wider">
                  {q.category}
                </span>
                <h3 className="text-lg font-bold text-[#0F172A] leading-snug">
                  &ldquo;{q.question}&rdquo;
                </h3>
              </div>

              <button
                type="button"
                onClick={() => handleCopy(q.id, q.question)}
                className="px-3 py-1.5 rounded-lg border border-[#E2E8F0] hover:bg-slate-50 text-xs font-bold text-[#334155] flex items-center gap-1.5 transition cursor-pointer"
              >
                {copiedId === q.id ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    <span className="text-emerald-700">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-[#64748B]" />
                    <span>Copy question</span>
                  </>
                )}
              </button>
            </div>

            {/* Why Ask This */}
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
              <span className="text-xs font-bold uppercase tracking-wider text-[#475569]">
                Why Ask This (Strategic Intent):
              </span>
              <p className="text-[14px] sm:text-[15px] text-[#1E293B] leading-relaxed">
                {q.whyAskThis}
              </p>
            </div>

            {/* What to listen for */}
            <div className="p-4 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] space-y-1">
              <span className="text-xs font-bold uppercase tracking-wider text-[#1D4ED8] flex items-center gap-1.5">
                <Ear className="w-3.5 h-3.5 text-[#2563EB]" />
                <span>What to Listen for in Their Answer:</span>
              </span>
              <p className="text-[14px] sm:text-[15px] text-[#1E40AF] leading-relaxed font-medium">
                {q.whatToListenFor}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
