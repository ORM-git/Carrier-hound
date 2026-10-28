"use client";

import React, { useState } from "react";
import { Moon, CheckSquare, Square, Sparkles, AlertCircle } from "lucide-react";
import type { InterviewCard } from "@/data/interviewPackFixture";
import QuestionsCardDeck from "./QuestionsCardDeck";

interface LastNightModeViewProps {
  cards: InterviewCard[];
  onSelectSection?: (section: string) => void;
}

export default function LastNightModeView({
  cards,
  onSelectSection,
}: LastNightModeViewProps) {
  // Only the 5 must-know cards
  const mustKnowCards = cards.filter((c) => c.isMustKnow).slice(0, 5);

  const [checklist, setChecklist] = useState<Record<string, boolean>>({
    anchor: true,
    techSetup: false,
    questions: false,
    jobDesc: false,
    sleep: false,
  });

  const toggleCheck = (key: string) => {
    setChecklist((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const completedChecks = Object.values(checklist).filter(Boolean).length;
  const totalChecks = Object.keys(checklist).length;

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      {/* Last Night Mode Header */}
      <div className="p-6 rounded-2xl bg-[#09151E] text-white border border-blue-900/60 shadow-xl space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2.5 text-xs font-bold uppercase tracking-wider text-cyan-400 bg-cyan-950/60 border border-cyan-800/60 px-3 py-1 rounded-full">
            <Moon className="w-3.5 h-3.5" />
            <span>Active: Last-Night Panic Defusion Mode</span>
          </div>
          <span className="text-xs font-semibold text-slate-300">
            Filtered to 5 essential cards only
          </span>
        </div>

        <div className="space-y-1.5">
          <h2 className="text-2xl font-extrabold text-white tracking-tight">
            Tonight&apos;s High-Yield Focus Deck
          </h2>
          <p className="text-[15px] text-slate-300 leading-relaxed">
            Do not overwhelm your memory tonight. Master these 5 high-yield cards, run through the pre-interview ritual checklist, and prioritize rest.
          </p>
        </div>
      </div>

      {/* Pre-Interview Evening Checklist */}
      <div className="p-6 rounded-2xl bg-white ring-1 ring-[#E2E8F0] shadow-sm space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-lg font-bold text-[#0F172A] flex items-center gap-2">
            <CheckSquare className="w-5 h-5 text-[#2563EB]" />
            <span>Last-Night Preparation Checklist</span>
          </h3>
          <span className="text-xs font-bold text-[#2563EB] bg-[#EFF6FF] border border-[#BFDBFE] px-2.5 py-0.5 rounded-full">
            {completedChecks} of {totalChecks} done
          </span>
        </div>

        <div className="space-y-2.5" role="group" aria-label="Pre-interview checklist">
          {[
            {
              id: "anchor",
              label: "Practice your 90-second 'Tell me about yourself' anchor out loud once.",
            },
            {
              id: "techSetup",
              label: "Verify video tool (Zoom/Google Meet), microphone input, and stable internet.",
            },
            {
              id: "questions",
              label: "Pick 2 smart questions to ask the interviewer from Section 6.",
            },
            {
              id: "jobDesc",
              label: "Re-read the job description once to refresh core team terminology.",
            },
            {
              id: "sleep",
              label: "Log off 45 minutes before sleep. Rested working memory boosts interview performance by 30%.",
            },
          ].map((item) => {
            const isChecked = checklist[item.id];
            return (
              <div
                key={item.id}
                onClick={() => toggleCheck(item.id)}
                role="checkbox"
                aria-checked={isChecked}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleCheck(item.id);
                  }
                }}
                className={`p-3.5 rounded-xl border transition flex items-center gap-3 cursor-pointer ${
                  isChecked
                    ? "bg-[#F0FDF4] border-[#BBF7D0] text-[#166534]"
                    : "bg-white border-[#E2E8F0] text-[#334155] hover:bg-slate-50"
                }`}
              >
                {isChecked ? (
                  <CheckSquare className="w-5 h-5 text-[#16A34A] shrink-0" />
                ) : (
                  <Square className="w-5 h-5 text-slate-400 shrink-0" />
                )}
                <span
                  className={`text-[15px] font-medium leading-relaxed ${
                    isChecked ? "line-through text-[#15803D]" : ""
                  }`}
                >
                  {item.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Cards Deck for the 5 Must-Knows */}
      <div className="space-y-4">
        <h3 className="text-lg font-bold text-[#0F172A] flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-[#2563EB]" />
          <span>The 5 Must-Know Questions:</span>
        </h3>
        <QuestionsCardDeck cards={mustKnowCards} onSelectSection={onSelectSection} />
      </div>
    </div>
  );
}
