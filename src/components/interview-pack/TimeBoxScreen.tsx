"use client";

import React, { useState } from "react";
import { Clock, Zap, CheckCircle2, ArrowRight, ArrowLeft } from "lucide-react";

export type TimeBoxOption = "10min" | "30min" | "tonight";

interface TimeBoxScreenProps {
  onSelect: (option: TimeBoxOption, cardLimit: number) => void;
  onBack: () => void;
  initialOption?: TimeBoxOption;
}

export default function TimeBoxScreen({
  onSelect,
  onBack,
  initialOption = "30min",
}: TimeBoxScreenProps) {
  const [selected, setSelected] = useState<TimeBoxOption>(initialOption);

  const OPTIONS: {
    id: TimeBoxOption;
    title: string;
    duration: string;
    cardCount: number;
    description: string;
    icon: typeof Clock;
    recommended?: boolean;
  }[] = [
    {
      id: "10min",
      title: "I have 10 min",
      duration: "10 minutes",
      cardCount: 5,
      description: "Emergency high-yield focus: Top 5 must-know questions + core anchor narrative.",
      icon: Zap,
    },
    {
      id: "30min",
      title: "I have 30 min",
      duration: "30 minutes",
      cardCount: 10,
      description: "Balanced deep preparation: 10 tailored technical and behavioral cards with resume citations.",
      icon: Clock,
      recommended: true,
    },
    {
      id: "tonight",
      title: "I have tonight",
      duration: "Full evening",
      cardCount: 15,
      description: "Comprehensive mastery: All 15 verified questions, full gaps matrix, reverse questions, and quiz.",
      icon: CheckCircle2,
    },
  ];

  const handleContinue = () => {
    const opt = OPTIONS.find((o) => o.id === selected) || OPTIONS[1];
    onSelect(selected, opt.cardCount);
  };

  return (
    <div className="min-h-[600px] flex items-center justify-center py-8 px-4 sm:px-6">
      <div className="w-full max-w-2xl bg-white rounded-2xl ring-1 ring-[#E2E8F0] shadow-xl p-6 sm:p-10 space-y-8 animate-in fade-in duration-300">
        {/* Header Badge */}
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#2563EB] bg-[#EFF6FF] border border-[#BFDBFE] px-3 py-1 rounded-full w-fit">
          <Clock className="w-3.5 h-3.5" />
          <span>Step 2 · Time Calibration</span>
        </div>

        {/* Header Text */}
        <div className="space-y-3">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight leading-tight">
            How much time do you have before the interview?
          </h1>
          <p className="text-[15px] sm:text-[16px] text-[#475569] leading-relaxed">
            We adapt the dossier density to your available window. Shorter time limits automatically trim low-frequency questions so you retain peak focus on high-probability topics.
          </p>
        </div>

        {/* Options Stack */}
        <div className="space-y-3.5" role="radiogroup" aria-label="Available preparation time">
          {OPTIONS.map((opt) => {
            const isSelected = selected === opt.id;
            const Icon = opt.icon;
            return (
              <div
                key={opt.id}
                onClick={() => setSelected(opt.id)}
                role="radio"
                aria-checked={isSelected}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(opt.id);
                  }
                }}
                className={`p-5 rounded-2xl border-2 transition cursor-pointer flex items-start gap-4 ${
                  isSelected
                    ? "border-[#2563EB] bg-[#EFF6FF]/60 shadow-sm ring-1 ring-[#2563EB]"
                    : "border-[#E2E8F0] bg-white hover:border-[#93C5FD] hover:bg-slate-50/70"
                }`}
              >
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                    isSelected ? "bg-[#2563EB] text-white" : "bg-slate-100 text-[#475569]"
                  }`}
                >
                  <Icon className="w-5 h-5" />
                </div>

                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className="text-[16px] font-bold text-[#0F172A]">{opt.title}</span>
                      {opt.recommended && (
                        <span className="text-[11px] font-bold text-[#1D4ED8] bg-[#DBEAFE] px-2 py-0.5 rounded-full">
                          Recommended
                        </span>
                      )}
                    </div>
                    <span className="text-xs font-bold text-[#2563EB] bg-white border border-[#BFDBFE] px-2.5 py-0.5 rounded-full shadow-2xs">
                      {opt.cardCount} cards
                    </span>
                  </div>
                  <p className="text-[14px] sm:text-[15px] text-[#64748B] leading-relaxed">
                    {opt.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Navigation Buttons */}
        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={onBack}
            className="px-5 py-2.5 rounded-xl text-[15px] font-bold text-[#64748B] hover:text-[#0F172A] hover:bg-slate-100 transition flex items-center gap-2 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back</span>
          </button>
          <button
            type="button"
            onClick={handleContinue}
            className="px-6 py-2.5 rounded-xl text-[15px] font-bold text-white bg-[#2563EB] hover:bg-[#1D4ED8] transition shadow-md flex items-center gap-2 cursor-pointer"
          >
            <span>Open Prep Pack</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
