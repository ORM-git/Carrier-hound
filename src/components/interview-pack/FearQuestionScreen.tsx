"use client";

import React, { useState } from "react";
import { AlertCircle, ArrowRight, Sparkles, HelpCircle } from "lucide-react";
import type { InterviewPackData } from "@/data/interviewPackFixture";

interface FearQuestionScreenProps {
  pack: InterviewPackData;
  onComplete: (customQuestion?: string, matchedFearOptionId?: string) => void;
  onSkip: () => void;
}

export default function FearQuestionScreen({
  pack,
  onComplete,
  onSkip,
}: FearQuestionScreenProps) {
  const [selectedChipId, setSelectedChipId] = useState<string | null>(null);
  const [customQuestionText, setCustomQuestionText] = useState("");

  const handleChipClick = (id: string, defaultQ: string) => {
    setSelectedChipId(id);
    setCustomQuestionText(defaultQ);
  };

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    onComplete(customQuestionText.trim() || undefined, selectedChipId || undefined);
  };

  return (
    <div className="min-h-[600px] flex items-center justify-center py-8 px-4 sm:px-6">
      <div className="w-full max-w-2xl bg-white rounded-2xl ring-1 ring-[#E2E8F0] shadow-xl p-6 sm:p-10 space-y-8 animate-in fade-in duration-300">
        {/* Header Badge */}
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#2563EB] bg-[#EFF6FF] border border-[#BFDBFE] px-3 py-1 rounded-full w-fit">
          <Sparkles className="w-3.5 h-3.5" />
          <span>Step 1 · Fear Confrontation</span>
        </div>

        {/* Primary Prompt */}
        <div className="space-y-3">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight leading-tight">
            Is there one question you&apos;re most afraid of?
          </h1>
          <p className="text-[15px] sm:text-[16px] text-[#475569] leading-relaxed">
            Name the question that keeps you awake. We will place it first in your prep deck with a battle-tested draft grounded in your real resume evidence.
          </p>
        </div>

        {/* Quick Chips */}
        <div className="space-y-3">
          <label className="text-xs font-bold text-[#64748B] uppercase tracking-wider flex items-center gap-1.5">
            <HelpCircle className="w-3.5 h-3.5 text-[#2563EB]" />
            <span>Common fear areas (tap to load):</span>
          </label>
          <div className="flex flex-wrap gap-2.5">
            {pack.fearQuestionOptions.map((opt) => {
              const isSelected = selectedChipId === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleChipClick(opt.id, opt.question)}
                  className={`px-4 py-2 rounded-full text-[14px] sm:text-[15px] font-semibold transition cursor-pointer border ${
                    isSelected
                      ? "bg-[#2563EB] text-white border-[#2563EB] shadow-sm"
                      : "bg-[#F8FAFC] text-[#334155] border-[#CBD5E1] hover:border-[#93C5FD] hover:bg-[#EFF6FF]"
                  }`}
                >
                  {opt.chip}
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom Text Area */}
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <label
              htmlFor="fear-question-input"
              className="text-xs font-bold text-[#475569] uppercase tracking-wider"
            >
              Your targeted fear question:
            </label>
            <textarea
              id="fear-question-input"
              value={customQuestionText}
              onChange={(e) => {
                setCustomQuestionText(e.target.value);
                if (selectedChipId && e.target.value !== pack.fearQuestionOptions.find(o => o.id === selectedChipId)?.question) {
                  setSelectedChipId(null);
                }
              }}
              placeholder="e.g. Why did you leave your last role after only 8 months?"
              rows={3}
              className="w-full p-4 rounded-xl border border-[#CBD5E1] text-[15px] text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent transition placeholder:text-[#94A3B8]"
            />
          </div>

          {/* Psychology Reassurance */}
          <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-[#F0FDF4] border border-[#BBF7D0] text-[#166534] text-[13px] leading-relaxed">
            <AlertCircle className="w-4 h-4 shrink-0 text-[#16A34A] mt-0.5" />
            <span>
              <strong>Psychological fact:</strong> Facing your single most feared question first neutralizes 70% of pre-interview anxiety.
            </span>
          </div>

          {/* Action Row */}
          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={onSkip}
              className="px-5 py-2.5 rounded-xl text-[15px] font-bold text-[#64748B] hover:text-[#0F172A] hover:bg-slate-100 transition cursor-pointer"
            >
              Skip for now
            </button>
            <button
              type="submit"
              className="px-6 py-2.5 rounded-xl text-[15px] font-bold text-white bg-[#2563EB] hover:bg-[#1D4ED8] transition shadow-md flex items-center gap-2 cursor-pointer"
            >
              <span>Save & Continue</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
