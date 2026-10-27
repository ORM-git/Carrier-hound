"use client";

import React, { useState, useEffect } from "react";
import {
  Check,
  RotateCcw,
  SkipForward,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  Sparkles,
  ExternalLink,
  FileText,
  CheckCircle2,
  Trophy,
  ArrowRight,
} from "lucide-react";
import type { InterviewCard } from "@/data/interviewPackFixture";

interface QuestionsCardDeckProps {
  cards: InterviewCard[];
  onFinish?: () => void;
  onSelectSection?: (section: string) => void;
}

export default function QuestionsCardDeck({
  cards,
  onFinish,
  onSelectSection,
}: QuestionsCardDeckProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [readyCardIds, setReadyCardIds] = useState<Set<string>>(new Set());
  const [practiceAgainIds, setPracticeAgainIds] = useState<Set<string>>(new Set());
  const [isExpanded, setIsExpanded] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);

  const activeCards = cards;
  const currentCard = activeCards[currentIndex];
  const totalCount = activeCards.length;

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isCompleted || !currentCard) return;
      if (e.key === "ArrowRight") {
        handleGotIt();
      } else if (e.key === "ArrowLeft") {
        handleSkip();
      } else if (e.key === "ArrowDown") {
        setIsExpanded(true);
      } else if (e.key === "ArrowUp") {
        setIsExpanded(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentIndex, isCompleted, currentCard, readyCardIds]);

  const advanceCard = () => {
    setIsExpanded(false);
    if (currentIndex + 1 < totalCount) {
      setCurrentIndex((prev) => prev + 1);
    } else {
      setIsCompleted(true);
      if (onFinish) onFinish();
    }
  };

  const handleGotIt = () => {
    if (!currentCard) return;
    setReadyCardIds((prev) => new Set(prev).add(currentCard.id));
    setPracticeAgainIds((prev) => {
      const next = new Set(prev);
      next.delete(currentCard.id);
      return next;
    });
    advanceCard();
  };

  const handlePracticeAgain = () => {
    if (!currentCard) return;
    setPracticeAgainIds((prev) => new Set(prev).add(currentCard.id));
    setReadyCardIds((prev) => {
      const next = new Set(prev);
      next.delete(currentCard.id);
      return next;
    });
    advanceCard();
  };

  const handleSkip = () => {
    advanceCard();
  };

  const handleRestart = () => {
    setCurrentIndex(0);
    setIsCompleted(false);
    setIsExpanded(false);
  };

  // Label chip styling
  const getLabelBadge = (label: InterviewCard["label"]) => {
    switch (label) {
      case "Confirmed":
        return "bg-emerald-50 text-emerald-800 border-emerald-300";
      case "Reported by candidates":
        return "bg-blue-50 text-blue-800 border-blue-300";
      case "Likely":
        return "bg-indigo-50 text-indigo-800 border-indigo-300";
      case "General practice":
        return "bg-amber-50 text-amber-800 border-amber-300";
      case "Unverified":
      default:
        return "bg-slate-100 text-slate-700 border-slate-300";
    }
  };

  // Completion screen
  if (isCompleted) {
    const readyCount = readyCardIds.size;
    const practiceCount = practiceAgainIds.size;

    return (
      <div className="bg-white rounded-2xl ring-1 ring-[#E2E8F0] shadow-xl p-8 sm:p-12 text-center max-w-2xl mx-auto space-y-8 animate-in fade-in duration-300">
        <div className="w-16 h-16 rounded-2xl bg-[#EFF6FF] border border-[#BFDBFE] text-[#2563EB] flex items-center justify-center mx-auto shadow-sm">
          <Trophy className="w-8 h-8" />
        </div>

        <div className="space-y-3">
          <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight">
            You are ready for this interview.
          </h2>
          <p className="text-[15px] sm:text-[16px] text-[#475569] leading-relaxed max-w-lg mx-auto">
            You reviewed {totalCount} high-probability questions. Take a deep breath: your answers are anchored in verified facts from your actual career.
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-4 max-w-md mx-auto">
          <div className="p-4 rounded-xl bg-[#F0FDF4] border border-[#BBF7D0] text-center space-y-1">
            <span className="text-2xl font-black text-[#15803D]">{readyCount}</span>
            <p className="text-xs font-bold text-[#166534] uppercase tracking-wider">Ready to Deliver</p>
          </div>
          <div className="p-4 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] text-center space-y-1">
            <span className="text-2xl font-black text-[#1D4ED8]">{practiceCount}</span>
            <p className="text-xs font-bold text-[#1E40AF] uppercase tracking-wider">To Review Again</p>
          </div>
        </div>

        {/* Action Row */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
          <button
            type="button"
            onClick={handleRestart}
            className="w-full sm:w-auto px-6 py-2.5 rounded-xl text-[15px] font-bold text-[#334155] bg-slate-100 hover:bg-slate-200 transition cursor-pointer flex items-center justify-center gap-2"
          >
            <RotateCcw className="w-4 h-4" />
            <span>Review Cards Again</span>
          </button>
          {onSelectSection && (
            <button
              type="button"
              onClick={() => onSelectSection("quiz")}
              className="w-full sm:w-auto px-6 py-2.5 rounded-xl text-[15px] font-bold text-white bg-[#2563EB] hover:bg-[#1D4ED8] transition shadow-md flex items-center justify-center gap-2 cursor-pointer"
            >
              <span>Test Knowledge (Quick Quiz)</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!currentCard) {
    return (
      <div className="p-12 text-center text-[#64748B]">
        No cards available for this selection.
      </div>
    );
  }

  const readyCount = readyCardIds.size;
  const isCardReady = readyCardIds.has(currentCard.id);
  const isCardPractice = practiceAgainIds.has(currentCard.id);

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Top Card Stepper Bar */}
      <div className="flex items-center justify-between gap-4 text-xs font-semibold text-[#64748B] flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-bold text-[#0F172A]">
            Card {currentIndex + 1} of {totalCount}
          </span>
          <span
            className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${getLabelBadge(
              currentCard.label
            )}`}
          >
            {currentCard.label}
          </span>
        </div>

        {/* Micro-Win Indicator */}
        <div className="flex items-center gap-2 bg-[#F0FDF4] border border-[#BBF7D0] px-3 py-1 rounded-full text-[#166534]">
          <CheckCircle2 className="w-3.5 h-3.5 text-[#16A34A]" />
          <span className="font-bold text-[12px]">{readyCount} of {totalCount} ready</span>
        </div>
      </div>

      {/* Main Flashcard Container */}
      <div
        tabIndex={0}
        aria-label={`Question card ${currentIndex + 1}: ${currentCard.question}`}
        className="bg-white rounded-2xl ring-1 ring-[#E2E8F0] shadow-lg p-6 sm:p-9 space-y-6 transition relative"
      >
        {/* Status Chip if card already completed in this session */}
        {isCardReady && (
          <div className="absolute top-4 right-4 bg-emerald-100 text-emerald-800 text-[11px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
            <Check className="w-3 h-3" />
            <span>Mastered</span>
          </div>
        )}
        {isCardPractice && (
          <div className="absolute top-4 right-4 bg-amber-100 text-amber-800 text-[11px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
            <RotateCcw className="w-3 h-3" />
            <span>Marked to Practice</span>
          </div>
        )}

        {/* Question Header */}
        <div className="space-y-2">
          <span className="text-[12px] font-bold text-[#2563EB] uppercase tracking-wider">
            Predicted Question
          </span>
          <h2 className="text-xl sm:text-2xl font-bold text-[#0F172A] leading-snug">
            {currentCard.question}
          </h2>
        </div>

        {/* Section 1: Why They Ask (1-line psychology) */}
        <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#475569] block">
            Why they ask this (Psychological intent)
          </span>
          <p className="text-[15px] font-medium text-[#1E293B] leading-relaxed">
            {currentCard.whyTheyAsk}
          </p>
        </div>

        {/* Section 2: Your Answer Draft (40-60 words concise draft) */}
        <div className="space-y-3 pt-1">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-bold text-[#0F172A] uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-[#2563EB]" />
              <span>Your Answer Draft (40–60 words)</span>
            </span>
            <span className="text-[11px] font-semibold text-[#64748B]">
              ~45s spoken delivery
            </span>
          </div>

          <div className="p-4 sm:p-5 rounded-xl bg-[#EFF6FF]/60 border border-[#BFDBFE] text-[15px] sm:text-[16px] text-[#0F172A] leading-[26px] font-medium">
            &ldquo;{currentCard.answerDraft}&rdquo;
          </div>

          {/* Resume Bullet Source Citation */}
          <div className="flex items-start gap-2 p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-xs text-[#475569]">
            <FileText className="w-4 h-4 text-[#2563EB] shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <span className="font-bold text-[#1E293B]">
                Grounded in your resume:
              </span>{" "}
              <span className="text-[#334155]">
                {currentCard.resumeBulletSource.role} @ {currentCard.resumeBulletSource.company}
              </span>{" "}
              — &ldquo;{currentCard.resumeBulletSource.bullet}&rdquo;
            </div>
          </div>
        </div>

        {/* Expandable Deeper Breakdown */}
        {currentCard.expandedAnswer && (
          <div className="pt-2 border-t border-[#E2E8F0]">
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              className="w-full flex items-center justify-between text-xs font-bold text-[#2563EB] hover:text-[#1D4ED8] transition py-1 cursor-pointer"
            >
              <span>{isExpanded ? "Collapse deep framework" : "Read deeper (full structured framework)"}</span>
              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {isExpanded && (
              <div className="mt-3 p-4 rounded-xl bg-slate-50 border border-slate-200 text-[14px] sm:text-[15px] text-[#334155] leading-relaxed animate-in fade-in duration-200">
                <p className="font-semibold text-[#0F172A] mb-1">In-Depth Framework Breakdown:</p>
                <p>{currentCard.expandedAnswer}</p>
              </div>
            )}
          </div>
        )}

        {/* Source citation */}
        <div className="flex items-center justify-between text-xs text-[#64748B] pt-2 border-t border-[#E2E8F0] flex-wrap gap-2">
          <div className="flex items-center gap-1.5">
            <span>Verified source:</span>
            <a
              href={currentCard.source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[#2563EB] hover:underline inline-flex items-center gap-1"
            >
              <span>{currentCard.source.title}</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <span className="font-semibold text-slate-400">
            {currentCard.source.date}
          </span>
        </div>
      </div>

      {/* Button Action Bar: Got It / Practice Again / Skip */}
      <div className="grid grid-cols-3 gap-3 max-w-xl mx-auto pt-2">
        <button
          type="button"
          onClick={handleSkip}
          className="py-3 px-4 rounded-xl border border-[#CBD5E1] bg-white hover:bg-slate-50 text-[#475569] font-bold text-[14px] sm:text-[15px] transition flex items-center justify-center gap-1.5 cursor-pointer shadow-2xs"
        >
          <SkipForward className="w-4 h-4" />
          <span>Skip</span>
        </button>

        <button
          type="button"
          onClick={handlePracticeAgain}
          className="py-3 px-4 rounded-xl border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 font-bold text-[14px] sm:text-[15px] transition flex items-center justify-center gap-1.5 cursor-pointer shadow-2xs"
        >
          <RotateCcw className="w-4 h-4" />
          <span>Practice again</span>
        </button>

        <button
          type="button"
          onClick={handleGotIt}
          className="py-3 px-4 rounded-xl border border-emerald-500 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[14px] sm:text-[15px] transition flex items-center justify-center gap-1.5 cursor-pointer shadow-md"
        >
          <Check className="w-4 h-4" />
          <span>Got it!</span>
        </button>
      </div>

      {/* Keyboard Shortcuts Hint */}
      <p className="text-center text-[12px] text-slate-400">
        Keyboard: Press <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border text-slate-600 font-mono">→</kbd> for Got It, <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border text-slate-600 font-mono">←</kbd> to Skip, <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border text-slate-600 font-mono">↓</kbd> to expand.
      </p>
    </div>
  );
}
