"use client";

import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import BrandIcon from "@/components/BrandIcon";
import { X, Sparkles, Check } from "lucide-react";
import {
  CanonicalExperienceLevel,
  CANONICAL_EXPERIENCE_LEVELS,
  EXPERIENCE_LEVEL_LABELS,
  parseExperienceLevels,
} from "@/lib/jobs/experienceLevels";

export interface FirstJobsWelcomeProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (selectedLevels: CanonicalExperienceLevel[]) => void;
  recommendedCount?: number | null;
  // True when recommendedCount is a verified lower bound (full ranked pool), not the
  // domain-wide total: the copy then says "at least N".
  recommendedCountIsLowerBound?: boolean;
  initialLevels?: string | null;
  savedExperienceLevel?: string | null;
}

export default function FirstJobsWelcome({
  isOpen,
  onClose,
  onConfirm,
  recommendedCount,
  recommendedCountIsLowerBound,
  initialLevels,
  savedExperienceLevel,
}: FirstJobsWelcomeProps) {
  // Preselect only explicitly saved/current-filter choices
  const [selectedLevels, setSelectedLevels] = useState<CanonicalExperienceLevel[]>(() => {
    const fromFilter = parseExperienceLevels(initialLevels);
    if (fromFilter.length > 0) return fromFilter;
    const fromSaved = parseExperienceLevels(savedExperienceLevel);
    if (fromSaved.length > 0) return fromSaved;
    return [];
  });

  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);

  // Sync state if initialLevels change while open
  useEffect(() => {
    if (isOpen) {
      const parsed = parseExperienceLevels(initialLevels);
      if (parsed.length > 0) {
        setSelectedLevels(parsed);
      }
    }
  }, [isOpen, initialLevels]);

  // Body scroll lock & focus management
  useEffect(() => {
    if (!isOpen) return;

    previouslyFocusedElementRef.current = document.activeElement as HTMLElement | null;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Background inert: every other top-level body child, restored on close.
    const portalRoot = dialogRef.current?.closest("[data-first-jobs-welcome]") ?? null;
    const inerted = Array.from(document.body.children).filter(
      (el) => el !== portalRoot && !el.hasAttribute("inert")
    );
    inerted.forEach((el) => el.setAttribute("inert", ""));

    // Focus the modal container
    const timer = setTimeout(() => {
      dialogRef.current?.focus();
    }, 50);

    return () => {
      clearTimeout(timer);
      inerted.forEach((el) => el.removeAttribute("inert"));
      document.body.style.overflow = originalOverflow;
      if (previouslyFocusedElementRef.current?.focus) {
        previouslyFocusedElementRef.current.focus();
      }
    };
  }, [isOpen]);

  // Global keyboard navigation & focus trap
  useEffect(() => {
    if (!isOpen) return;

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key === "Tab" && dialogRef.current) {
        const focusableElements = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusableElements.length === 0) return;

        const first = focusableElements[0];
        const last = focusableElements[focusableElements.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [isOpen, onClose]);

  const toggleLevel = (level: CanonicalExperienceLevel) => {
    setSelectedLevels((prev) =>
      prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level]
    );
  };

  const handleConfirm = () => {
    onConfirm(selectedLevels);
  };

  if (!isOpen) return null;

  const hasCount = typeof recommendedCount === "number" && recommendedCount > 0;
  const title = hasCount
    ? recommendedCountIsLowerBound
      ? `Welcome! We found at least ${recommendedCount} roles in your current recommendations.`
      : `Welcome! We found ${recommendedCount} roles in your current recommendations.`
    : "Your job preferences are ready";

  const suggestedCanonical = savedExperienceLevel
    ? parseExperienceLevels(savedExperienceLevel)[0]
    : null;

  return createPortal(
    <div
      data-first-jobs-welcome=""
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-jobs-welcome-title"
        aria-describedby="first-jobs-welcome-desc"
        tabIndex={-1}
        className="relative w-full max-w-lg bg-white rounded-2xl sm:rounded-3xl shadow-2xl border border-slate-200/80 p-6 sm:p-8 outline-none animate-in zoom-in-95 duration-200"
      >
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close welcome dialog"
          className="absolute top-4 right-4 sm:top-5 sm:right-5 p-2 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Brand Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center p-1.5 shadow-2xs">
            <BrandIcon className="w-6 h-6" />
          </div>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200/60">
            <Sparkles className="w-3.5 h-3.5" />
            Personalized Feed Ready
          </span>
        </div>

        {/* Title & Scope description */}
        <h2
          id="first-jobs-welcome-title"
          className="text-lg sm:text-xl font-bold text-slate-900 leading-snug mb-2"
        >
          {title}
        </h2>

        <p
          id="first-jobs-welcome-desc"
          className="text-xs sm:text-sm text-slate-600 leading-relaxed mb-6"
        >
          {hasCount
            ? "Here is your current recommendation set based on your onboarding preferences. Select the experience levels you want to see, or view all matching roles."
            : "We have configured your recommendation feed. Filter by your target seniority levels below, or see all roles matching your profile."}
        </p>

        {/* Two-column Experience Checkbox Row Pattern */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2.5">
            <label className="text-xs font-bold text-slate-900 uppercase tracking-wider">
              Experience Level
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedLevels([])}
                className="text-[11px] font-semibold text-slate-500 hover:text-slate-800 hover:underline cursor-pointer"
              >
                Clear all
              </button>
              <span className="text-slate-300">|</span>
              <button
                type="button"
                onClick={() => setSelectedLevels([...CANONICAL_EXPERIENCE_LEVELS])}
                className="text-[11px] font-semibold text-blue-600 hover:text-blue-800 hover:underline cursor-pointer"
              >
                Select all
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {CANONICAL_EXPERIENCE_LEVELS.map((level) => {
              const isChecked = selectedLevels.includes(level);
              const isSuggested = suggestedCanonical === level;
              const label = EXPERIENCE_LEVEL_LABELS[level];

              return (
                <label
                  key={level}
                  className={`flex items-center justify-between p-3 rounded-xl border text-xs font-semibold cursor-pointer transition-all select-none ${
                    isChecked
                      ? "bg-blue-50/80 border-blue-300 text-blue-900 shadow-2xs"
                      : "bg-slate-50/60 border-slate-200 text-slate-700 hover:bg-slate-100/70"
                  }`}
                >
                  <div className="flex items-center gap-2.5 truncate">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleLevel(level)}
                      className="w-4 h-4 rounded text-blue-600 border-slate-300 focus:ring-blue-500 cursor-pointer"
                    />
                    <span className="truncate">{label}</span>
                  </div>
                  {isSuggested && (
                    <span className="ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-emerald-100 text-emerald-800 shrink-0">
                      Suggested
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex flex-col-reverse sm:flex-row items-center justify-between gap-3 pt-4 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="w-full sm:w-auto px-4 py-2.5 text-xs sm:text-sm font-semibold text-slate-600 hover:text-slate-900 transition-colors cursor-pointer text-center"
          >
            Skip for now & See Jobs
          </button>

          <button
            type="button"
            onClick={handleConfirm}
            className="w-full sm:w-auto px-6 py-2.5 rounded-full text-xs sm:text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-sm hover:shadow transition-all flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Check className="w-4 h-4" />
            <span>Confirm & See Jobs</span>
          </button>
        </div>
      </div>
    </div>
  ,
    document.body
  );
}
