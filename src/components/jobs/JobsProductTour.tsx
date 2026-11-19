"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import BrandIcon from "@/components/BrandIcon";
import { X, ChevronRight, ChevronLeft, Check } from "lucide-react";

export interface TourStepDefinition {
  id: string;
  anchorSelector: string;
  title: string;
  description: string;
}

export const TOUR_STEPS: TourStepDefinition[] = [
  {
    id: "filters",
    anchorSelector: '[data-tour="tour-filters"]',
    title: "Adjust Your Job Preferences",
    description: "Narrow the list anytime by location, job type, work model and experience level.",
  },
  {
    id: "facts",
    anchorSelector: '[data-tour="tour-job-facts"]',
    title: "Job Information",
    description: "Each card lists the location, work model, job type and when it was posted.",
  },
  {
    id: "details",
    anchorSelector: '[data-tour="tour-job-details"]',
    title: "View Job Details",
    description: "Click a listing to open its full details and listed requirements.",
  },
  {
    id: "apply",
    anchorSelector: '[data-tour="tour-job-apply"]',
    title: "Apply",
    description: "Apply opens the employer's application. On the Free plan, Apply shows the Pro upgrade first.",
  },
];

export interface JobsProductTourProps {
  isActive: boolean;
  onComplete: () => void;
  onExit: () => void;
}

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export default function JobsProductTour({
  isActive,
  onComplete,
  onExit,
}: JobsProductTourProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Helper to determine if element is visible and connected
  const isElementVisible = useCallback((el: Element | null): boolean => {
    if (!el || !el.isConnected) return false;
    if (typeof window !== "undefined" && window.getComputedStyle) {
      try {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
      } catch {}
    }
    if ("offsetParent" in el && (el as HTMLElement).offsetParent === null) {
      const isFixed =
        typeof window !== "undefined" &&
        window.getComputedStyle &&
        window.getComputedStyle(el).position === "fixed";
      const isJsdom =
        typeof navigator !== "undefined" && navigator.userAgent.includes("jsdom");
      if (!isFixed && !isJsdom) {
        return false;
      }
    }
    return true;
  }, []);

  // The same anchor can exist on a hidden mobile control and a visible desktop one: use the first visible.
  const findVisibleTarget = useCallback(
    (selector: string): HTMLElement | null => {
      if (typeof document === "undefined") return null;
      return (Array.from(document.querySelectorAll(selector)) as HTMLElement[]).find((el) => isElementVisible(el)) ?? null;
    },
    [isElementVisible]
  );

  // Find valid visible targets
  const getVisibleSteps = useCallback(() => {
    if (typeof document === "undefined") return [];
    return TOUR_STEPS.filter((step) => findVisibleTarget(step.anchorSelector) !== null);
  }, [findVisibleTarget]);

  const [availableSteps, setAvailableSteps] = useState<TourStepDefinition[]>([]);

  useEffect(() => {
    if (!isActive) return;
    const visible = getVisibleSteps();
    setAvailableSteps(visible);
    if (visible.length === 0) {
      onComplete();
    }
  }, [isActive, getVisibleSteps, onComplete]);

  // Capture previous focus on activate
  useEffect(() => {
    if (isActive) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
    } else {
      if (previousFocusRef.current?.focus) {
        previousFocusRef.current.focus();
      }
    }
  }, [isActive]);

  const activeStep = availableSteps[currentStepIndex];

  // Update target rect with viewport awareness
  const updateTargetPosition = useCallback(() => {
    if (!isActive || !activeStep) {
      setTargetRect(null);
      return;
    }

    const el = findVisibleTarget(activeStep.anchorSelector);
    if (!el || !isElementVisible(el)) {
      // Step disappeared: move to next or complete
      if (currentStepIndex < availableSteps.length - 1) {
        setCurrentStepIndex((prev) => prev + 1);
      } else {
        onComplete();
      }
      return;
    }

    // Scroll into view if needed
    const rect = el.getBoundingClientRect();
    const inViewport =
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.right <= (window.innerWidth || document.documentElement.clientWidth);

    if (!inViewport && el.scrollIntoView) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    const updated = el.getBoundingClientRect();
    setTargetRect({
      top: updated.top || 100,
      left: updated.left || 40,
      width: Math.max(updated.width || 0, 120),
      height: Math.max(updated.height || 0, 40),
    });
  }, [isActive, activeStep, currentStepIndex, availableSteps.length, onComplete, isElementVisible, findVisibleTarget]);

  // Listen to resize, scroll, zoom
  useEffect(() => {
    if (!isActive) return;
    updateTargetPosition();

    let animationFrameId: number;
    const handleScrollOrResize = () => {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = requestAnimationFrame(() => {
        updateTargetPosition();
      });
    };

    window.addEventListener("scroll", handleScrollOrResize, { passive: true });
    window.addEventListener("resize", handleScrollOrResize, { passive: true });

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener("scroll", handleScrollOrResize);
      window.removeEventListener("resize", handleScrollOrResize);
    };
  }, [isActive, updateTargetPosition]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isActive) return;

      if (e.key === "Escape") {
        e.preventDefault();
        onExit();
        return;
      }

      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (currentStepIndex < availableSteps.length - 1) {
          setCurrentStepIndex((p) => p + 1);
        } else {
          onComplete();
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (currentStepIndex > 0) {
          setCurrentStepIndex((p) => p - 1);
        }
      }
    },
    [isActive, currentStepIndex, availableSteps.length, onExit, onComplete]
  );

  useEffect(() => {
    if (!isActive) return;
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isActive, handleKeyDown]);

  if (!isActive || !activeStep || !targetRect) return null;

  const isLastStep = currentStepIndex >= availableSteps.length - 1;
  const padding = 6;

  // Viewport-aware card position calculation
  const cardWidth = Math.min(360, window.innerWidth - 32);
  const cardHeight = 220; // approximate estimate
  const spaceBelow = window.innerHeight - (targetRect.top + targetRect.height + padding);
  const placeAbove = spaceBelow < cardHeight && targetRect.top > cardHeight;

  let cardTop = placeAbove
    ? Math.max(16, targetRect.top - cardHeight - 12)
    : targetRect.top + targetRect.height + padding + 12;

  let cardLeft = targetRect.left;
  if (cardLeft + cardWidth > window.innerWidth - 16) {
    cardLeft = window.innerWidth - cardWidth - 16;
  }
  if (cardLeft < 16) cardLeft = 16;

  return (
    <div
      role="dialog"
      aria-label="Guided Product Tour"
      aria-modal="true"
      className="fixed inset-0 z-50 pointer-events-auto"
    >
      {/* Target spotlight cutout */}
      <div
        className="fixed rounded-xl transition-all duration-300 ease-out pointer-events-none"
        style={{
          top: `${Math.max(0, targetRect.top - padding)}px`,
          left: `${Math.max(0, targetRect.left - padding)}px`,
          width: `${targetRect.width + padding * 2}px`,
          height: `${targetRect.height + padding * 2}px`,
          boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.7)",
          border: "2px solid #3B82F6",
        }}
      />

      {/* Tour Card */}
      <div
        ref={cardRef}
        role="region"
        aria-live="polite"
        className="fixed z-50 bg-white rounded-2xl shadow-2xl border border-slate-200/90 p-5 w-full transition-all duration-300 ease-out"
        style={{
          width: `${cardWidth}px`,
          top: `${cardTop}px`,
          left: `${cardLeft}px`,
        }}
      >
        {/* Card Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-blue-50 border border-blue-100 flex items-center justify-center p-0.5">
              <BrandIcon className="w-4 h-4" />
            </div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-blue-600">
              Quick Tour • {currentStepIndex + 1} of {availableSteps.length}
            </span>
          </div>

          <button
            type="button"
            onClick={onExit}
            aria-label="Exit tour"
            className="p-1 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Step Title & Copy */}
        <h3 className="text-sm font-bold text-slate-900 mb-1.5 leading-snug">
          {activeStep.title}
        </h3>
        <p className="text-xs text-slate-600 leading-relaxed mb-4">
          {activeStep.description}
        </p>

        {/* Navigation Actions */}
        <div className="flex items-center justify-between pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onExit}
            className="text-xs font-semibold text-slate-500 hover:text-slate-800 transition-colors cursor-pointer"
          >
            Exit
          </button>

          <div className="flex items-center gap-2">
            {currentStepIndex > 0 && (
              <button
                type="button"
                onClick={() => setCurrentStepIndex((p) => p - 1)}
                className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors flex items-center gap-1 cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                if (isLastStep) {
                  onComplete();
                } else {
                  setCurrentStepIndex((p) => p + 1);
                }
              }}
              className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-xs hover:shadow transition-colors flex items-center gap-1 cursor-pointer"
            >
              <span>{isLastStep ? "Done" : "Next"}</span>
              {isLastStep ? <Check className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
