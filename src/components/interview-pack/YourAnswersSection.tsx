"use client";

import React, { useState } from "react";
import { MessageSquareQuote, Copy, Check, FileText, Sparkles } from "lucide-react";
import type { InterviewCard } from "@/data/interviewPackFixture";

interface YourAnswersSectionProps {
  cards: InterviewCard[];
}

export default function YourAnswersSection({ cards }: YourAnswersSectionProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = (id: string, text: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  return (
    <div className="space-y-8 max-w-4xl">
      {/* Title */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#2563EB]">
          <MessageSquareQuote className="w-4 h-4" />
          <span>Section 4 · Your Answers Cheat Sheet</span>
        </div>
        <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight">
          Tailored Answer Drafts Grounded in Your Resume
        </h2>
        <p className="text-[15px] sm:text-[16px] text-[#475569] leading-relaxed">
          Every response is built directly from facts confirmed on your resume bullets. Copy answers for quick reference or practice them out loud.
        </p>
      </div>

      {/* Answers Grid */}
      <div className="space-y-4">
        {cards.map((card, idx) => (
          <div
            key={card.id}
            className="p-6 rounded-2xl bg-white ring-1 ring-[#E2E8F0] shadow-xs space-y-4"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="space-y-1 max-w-2xl">
                <span className="text-xs font-bold text-[#2563EB] uppercase tracking-wider">
                  Q{idx + 1} · {card.category.toUpperCase()}
                </span>
                <h3 className="text-[17px] font-bold text-[#0F172A] leading-snug">
                  {card.question}
                </h3>
              </div>

              <button
                type="button"
                onClick={() => handleCopy(card.id, card.answerDraft)}
                className="px-3 py-1.5 rounded-lg border border-[#E2E8F0] hover:bg-slate-50 text-xs font-bold text-[#334155] flex items-center gap-1.5 transition cursor-pointer"
              >
                {copiedId === card.id ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    <span className="text-emerald-700">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-[#64748B]" />
                    <span>Copy answer</span>
                  </>
                )}
              </button>
            </div>

            {/* Answer Box */}
            <div className="p-4 rounded-xl bg-[#EFF6FF]/60 border border-[#BFDBFE] text-[15px] sm:text-[16px] text-[#0F172A] leading-relaxed font-medium">
              &ldquo;{card.answerDraft}&rdquo;
            </div>

            {/* Resume Source Citation */}
            <div className="flex items-start gap-2 text-xs text-[#475569] bg-[#F8FAFC] p-3 rounded-xl border border-[#E2E8F0]">
              <FileText className="w-4 h-4 text-[#2563EB] shrink-0 mt-0.5" />
              <div>
                <strong className="text-[#1E293B]">Resume Bullet Used:</strong>{" "}
                <span className="text-[#334155]">
                  {card.resumeBulletSource.role} @ {card.resumeBulletSource.company}
                </span>{" "}
                — &ldquo;{card.resumeBulletSource.bullet}&rdquo;
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
