"use client";

import React, { useState } from "react";
import { CheckCircle2, HelpCircle, XCircle, RotateCcw, Award } from "lucide-react";
import type { QuizQuestion } from "@/data/interviewPackFixture";

interface QuickQuizSectionProps {
  quiz: QuizQuestion[];
}

export default function QuickQuizSection({ quiz }: QuickQuizSectionProps) {
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, number>>({});
  const [showResults, setShowResults] = useState(false);

  const handleSelectOption = (questionId: string, optionIdx: number) => {
    if (showResults) return;
    setSelectedAnswers((prev) => ({
      ...prev,
      [questionId]: optionIdx,
    }));
  };

  const handleGrade = () => {
    setShowResults(true);
  };

  const handleReset = () => {
    setSelectedAnswers({});
    setShowResults(false);
  };

  const answeredCount = Object.keys(selectedAnswers).length;
  const isComplete = answeredCount === quiz.length;

  const score = quiz.reduce((acc, q) => {
    if (selectedAnswers[q.id] === q.correctIndex) return acc + 1;
    return acc;
  }, 0);

  return (
    <div className="space-y-8 max-w-4xl">
      {/* Title */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#2563EB]">
          <HelpCircle className="w-4 h-4" />
          <span>Section 7 · Rapid Knowledge Check</span>
        </div>
        <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight">
          Quick Quiz: Test Your Interview Readiness
        </h2>
        <p className="text-[15px] sm:text-[16px] text-[#475569] leading-relaxed">
          4 multiple-choice flash scenarios testing systems fundamentals, timing rules, and interview psychology.
        </p>
      </div>

      {/* Score Banner when completed */}
      {showResults && (
        <div className="p-6 rounded-2xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-between gap-4 flex-wrap animate-in fade-in duration-300">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-[#2563EB] text-white flex items-center justify-center font-black text-xl shadow-xs">
              {score}/{quiz.length}
            </div>
            <div>
              <h3 className="text-lg font-bold text-[#0F172A]">
                {score === quiz.length
                  ? "Perfect Score! You are completely dialed in."
                  : score >= 3
                  ? "Strong performance! Review the explanations below."
                  : "Good practice run! Re-read the explanations to lock in concepts."}
              </h3>
              <p className="text-xs text-[#64748B]">
                Immediate feedback with verified technical and behavioral rationale.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleReset}
            className="px-4 py-2 rounded-xl border border-[#CBD5E1] bg-white hover:bg-slate-50 text-xs font-bold text-[#334155] flex items-center gap-1.5 transition cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Retake Quiz</span>
          </button>
        </div>
      )}

      {/* Quiz Questions List */}
      <div className="space-y-6">
        {quiz.map((q, qIdx) => {
          const selectedIdx = selectedAnswers[q.id];
          const isAnswered = selectedIdx !== undefined;

          return (
            <div
              key={q.id}
              className="p-6 rounded-2xl bg-white ring-1 ring-[#E2E8F0] shadow-xs space-y-4"
            >
              <div className="space-y-1">
                <span className="text-xs font-bold text-[#2563EB] uppercase tracking-wider">
                  Question {qIdx + 1}
                </span>
                <h3 className="text-[17px] font-bold text-[#0F172A] leading-snug">
                  {q.question}
                </h3>
              </div>

              {/* Options */}
              <div className="space-y-2.5" role="radiogroup" aria-label={q.question}>
                {q.options.map((opt, optIdx) => {
                  const isSelected = selectedIdx === optIdx;
                  const isCorrect = q.correctIndex === optIdx;

                  let borderClass = "border-[#E2E8F0] bg-white hover:border-[#93C5FD] hover:bg-slate-50";
                  if (isSelected && !showResults) {
                    borderClass = "border-[#2563EB] bg-[#EFF6FF] ring-1 ring-[#2563EB]";
                  } else if (showResults) {
                    if (isCorrect) {
                      borderClass = "border-emerald-500 bg-emerald-50 text-emerald-950 font-semibold";
                    } else if (isSelected && !isCorrect) {
                      borderClass = "border-rose-400 bg-rose-50 text-rose-950";
                    }
                  }

                  return (
                    <button
                      key={optIdx}
                      type="button"
                      disabled={showResults}
                      onClick={() => handleSelectOption(q.id, optIdx)}
                      className={`w-full text-left p-3.5 rounded-xl border transition flex items-start gap-3 cursor-pointer ${borderClass}`}
                    >
                      <div className="w-5 h-5 rounded-full border border-slate-300 flex items-center justify-center shrink-0 mt-0.5 text-xs font-bold">
                        {showResults && isCorrect ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                        ) : showResults && isSelected && !isCorrect ? (
                          <XCircle className="w-4 h-4 text-rose-600" />
                        ) : (
                          String.fromCharCode(65 + optIdx)
                        )}
                      </div>
                      <span className="text-[15px] leading-relaxed flex-1">{opt}</span>
                    </button>
                  );
                })}
              </div>

              {/* Explanation (after grade) */}
              {showResults && (
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs sm:text-[14px] leading-relaxed text-[#334155] animate-in fade-in duration-200">
                  <strong className="text-[#0F172A] block mb-0.5 font-bold">
                    Explanation & Strategy:
                  </strong>
                  {q.explanation}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Grade Action Bar */}
      {!showResults && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-[#64748B] font-semibold">
            {answeredCount} of {quiz.length} answered
          </span>
          <button
            type="button"
            disabled={!isComplete}
            onClick={handleGrade}
            className={`px-6 py-2.5 rounded-xl text-[15px] font-bold transition shadow-md flex items-center gap-2 ${
              isComplete
                ? "bg-[#2563EB] hover:bg-[#1D4ED8] text-white cursor-pointer"
                : "bg-slate-200 text-slate-400 cursor-not-allowed"
            }`}
          >
            <span>Submit Answers & Grade</span>
          </button>
        </div>
      )}
    </div>
  );
}
