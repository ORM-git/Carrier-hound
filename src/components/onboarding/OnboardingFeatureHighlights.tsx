"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  ExternalLink,
  MapPin,
  Briefcase,
  Building2,
  Check,
} from "lucide-react";

export interface FeatureSlide {
  id: string;
  badge: string;
  title: string;
  description: string;
  illustration: React.ReactNode;
}

export interface OnboardingFeatureHighlightsProps {
  className?: string;
  autoAdvanceMs?: number;
  initialSlideIndex?: number;
}

/**
 * Slide 1 Illustration: Original CM search-and-card diagram.
 * Honest search by job title and company using the real search field.
 */
function SearchAndCardIllustration() {
  return (
    <div
      aria-hidden="true"
      className="w-full max-w-sm mx-auto bg-zinc-50/90 dark:bg-zinc-800/60 rounded-2xl p-4 border border-zinc-200/80 dark:border-zinc-700/60 shadow-xs flex flex-col gap-3"
    >
      {/* Real search bar simulation */}
      <div className="flex items-center gap-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl px-3 py-2 shadow-2xs">
        <Search className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0" />
        <span className="h-3 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
        <span className="ml-auto text-[10px] font-semibold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/80 px-2 py-0.5 rounded-md border border-blue-100 dark:border-blue-900/60">
          Search
        </span>
      </div>

      {/* Genuine CM Job Card */}
      <div className="bg-white dark:bg-zinc-900 rounded-xl p-3 border border-zinc-200/70 dark:border-zinc-700/70 shadow-2xs space-y-2 text-left">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center font-bold text-xs flex-shrink-0 shadow-2xs">
              CM
            </div>
            <div className="space-y-1.5">
              <div className="h-3 w-36 rounded bg-zinc-200 dark:bg-zinc-700" />
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                <Building2 className="w-3 h-3" />
                <div className="h-2.5 w-20 rounded bg-zinc-200 dark:bg-zinc-700" />
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-md bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-100 dark:border-blue-900/50">
            <MapPin className="w-2.5 h-2.5" />
            Remote
          </span>
          <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
            <Briefcase className="w-2.5 h-2.5" />
            Full-time
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Slide 2 Illustration: Matching filter chips and small job card.
 * Authentic location, job type and work-model filters using real labels.
 */
function FiltersAndCardIllustration() {
  return (
    <div
      aria-hidden="true"
      className="w-full max-w-sm mx-auto bg-zinc-50/90 dark:bg-zinc-800/60 rounded-2xl p-4 border border-zinc-200/80 dark:border-zinc-700/60 shadow-xs flex flex-col gap-3"
    >
      {/* Real filter chips row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-blue-600 text-white shadow-2xs">
          <Check className="w-3 h-3 stroke-[3]" />
          Remote
        </span>
        <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-blue-50 dark:bg-blue-950/80 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
          <Check className="w-3 h-3 stroke-[3]" />
          Full-time
        </span>
        <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
          United States
        </span>
      </div>

      {/* Filtered result card */}
      <div className="bg-white dark:bg-zinc-900 rounded-xl p-3 border border-zinc-200/70 dark:border-zinc-700/70 shadow-2xs space-y-2 text-left">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-blue-600" />
          <span className="text-[11px] font-semibold text-blue-700 dark:text-blue-300">
            Matches selected filters
          </span>
        </div>
        <div>
          <p className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
            Backend Systems Engineer
          </p>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            DataFlow · Remote, United States · Full-time
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Slide 3 Illustration: Compact listing details with requirements and Apply button.
 * Review listed requirements before using the existing Apply action.
 */
function ListingDetailsIllustration() {
  return (
    <div
      aria-hidden="true"
      className="w-full max-w-sm mx-auto bg-zinc-50/90 dark:bg-zinc-800/60 rounded-2xl p-4 border border-zinc-200/80 dark:border-zinc-700/60 shadow-xs flex flex-col gap-2.5 text-left"
    >
      <div className="flex items-center justify-between pb-1 border-b border-zinc-200/70 dark:border-zinc-700/70">
        <div>
          <p className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
            Staff Frontend Engineer
          </p>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Acme Platform
          </p>
        </div>
        {/* Existing Apply action representation (NOT a navigable link) */}
        <div className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-blue-600 text-white text-xs font-semibold shadow-2xs select-none">
          <span>Apply</span>
          <ExternalLink className="w-3 h-3" />
        </div>
      </div>

      {/* Listed requirements preview */}
      <div className="space-y-1.5 pt-1">
        <p className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-300">
          Listed Requirements:
        </p>
        <ul className="text-[11px] text-zinc-600 dark:text-zinc-400 space-y-1">
          <li className="flex items-start gap-1.5">
            <span className="text-blue-600 dark:text-blue-400 font-bold">•</span>
            <span>4+ years TypeScript & modern React web architecture</span>
          </li>
          <li className="flex items-start gap-1.5">
            <span className="text-blue-600 dark:text-blue-400 font-bold">•</span>
            <span>Experience with web performance, testing & accessibility</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

export const FEATURE_HIGHLIGHTS_SLIDES: FeatureSlide[] = [
  {
    id: "find-roles",
    badge: "Search",
    title: "Find roles faster",
    description: "Search job titles and companies using the real search field.",
    illustration: <SearchAndCardIllustration />,
  },
  {
    id: "narrow-search",
    badge: "Filters",
    title: "Narrow your search",
    description: "Location, job type and work-model filters using their real labels.",
    illustration: <FiltersAndCardIllustration />,
  },
  {
    id: "review-details",
    badge: "Details",
    title: "Review the details",
    description: "Open a job and read its listed requirements before using the existing Apply action.",
    illustration: <ListingDetailsIllustration />,
  },
];

/**
 * OnboardingFeatureHighlights
 *
 * An isolated presentational carousel displaying three listing-only platform features.
 * Adheres to CM brand standards, accessibility guidelines, prefers-reduced-motion,
 * hover/focus pause, and layout stability.
 */
export default function OnboardingFeatureHighlights({
  className = "",
  autoAdvanceMs = 5000,
  initialSlideIndex = 0,
}: OnboardingFeatureHighlightsProps) {
  const [currentSlide, setCurrentSlide] = useState(
    Math.max(0, Math.min(initialSlideIndex, FEATURE_HIGHLIGHTS_SLIDES.length - 1))
  );
  const [isPausedByUser, setIsPausedByUser] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check prefers-reduced-motion
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);

    const listener = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", listener);
      return () => mediaQuery.removeEventListener("change", listener);
    } else if (mediaQuery.addListener) {
      mediaQuery.addListener(listener);
      return () => mediaQuery.removeListener(listener);
    }
  }, []);

  const totalSlides = FEATURE_HIGHLIGHTS_SLIDES.length;

  const goToSlide = useCallback(
    (index: number) => {
      setCurrentSlide((index + totalSlides) % totalSlides);
    },
    [totalSlides]
  );

  const nextSlide = useCallback(() => {
    goToSlide(currentSlide + 1);
  }, [currentSlide, goToSlide]);

  const prevSlide = useCallback(() => {
    goToSlide(currentSlide - 1);
  }, [currentSlide, goToSlide]);

  // Document visibility detection: pause rotation when tab is hidden
  const [isDocumentHidden, setIsDocumentHidden] = useState(false);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => {
      setIsDocumentHidden(document.hidden);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // Auto-advance timer management
  const shouldAutoAdvance =
    !isPausedByUser &&
    !isHovered &&
    !isFocused &&
    !isDocumentHidden &&
    !prefersReducedMotion &&
    autoAdvanceMs > 0;

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (shouldAutoAdvance) {
      timerRef.current = setInterval(() => {
        nextSlide();
      }, autoAdvanceMs);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [shouldAutoAdvance, nextSlide, autoAdvanceMs]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      prevSlide();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      nextSlide();
    }
  };

  const activeSlide = FEATURE_HIGHLIGHTS_SLIDES[currentSlide];

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onFocus={() => setIsFocused(true)}
      onBlur={(e) => {
        if (!containerRef.current?.contains(e.relatedTarget as Node)) {
          setIsFocused(false);
        }
      }}
      className="w-full"
    >
      <div
        ref={containerRef}
        role="region"
        aria-roledescription="carousel"
        aria-label="Platform feature highlights"
        className={`w-full max-w-3xl lg:max-w-4xl mx-auto bg-white dark:bg-zinc-900 border border-zinc-200/90 dark:border-zinc-800 rounded-3xl p-5 sm:p-7 md:p-8 shadow-sm transition-all duration-200 ${className}`}
      >
      {/* Top bar with slide badge and accessible play/pause control */}
      <div className="flex items-center justify-between gap-3 mb-4 sm:mb-6">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold tracking-wide uppercase bg-blue-50 dark:bg-blue-950/80 text-blue-700 dark:text-blue-300 border border-blue-200/60 dark:border-blue-900/60">
          {activeSlide.badge}
        </span>

        <div className="flex items-center gap-1.5 text-zinc-400 dark:text-zinc-500">
          <span className="text-xs font-medium mr-1" aria-hidden="true">
            {currentSlide + 1} of {totalSlides}
          </span>
          <button
            type="button"
            onClick={() => setIsPausedByUser((prev) => !prev)}
            aria-label={
              isPausedByUser || prefersReducedMotion
                ? "Resume automatic slide rotation"
                : "Pause automatic slide rotation"
            }
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            {isPausedByUser || prefersReducedMotion ? (
              <Play className="w-3.5 h-3.5" />
            ) : (
              <Pause className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Main slide content area (fixed minimum height to guarantee layout stability) */}
      <div
        role="group"
        aria-roledescription="slide"
        aria-label={`Slide ${currentSlide + 1} of ${totalSlides}: ${activeSlide.title}`}
        className="min-h-[220px] sm:min-h-[200px] md:min-h-[190px] grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-8 items-center"
      >
        {/* Left: Text side */}
        <div className="md:col-span-6 flex flex-col justify-center text-left space-y-2.5">
          <h4 className="text-lg sm:text-xl md:text-2xl font-bold text-zinc-900 dark:text-zinc-100 tracking-tight leading-snug">
            {activeSlide.title}
          </h4>
          <p className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed max-w-md">
            {activeSlide.description}
          </p>
        </div>

        {/* Right: Illustration side */}
        <div className="md:col-span-6 flex items-center justify-center w-full">
          {activeSlide.illustration}
        </div>
      </div>

      {/* Bottom controls: Prev/Next buttons & Pagination dots */}
      <div className="mt-6 pt-4 border-t border-zinc-100 dark:border-zinc-800/80 flex items-center justify-between gap-4">
        {/* Previous button */}
        <button
          type="button"
          onClick={prevSlide}
          aria-label="Previous highlight"
          className="p-2 rounded-xl text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <ChevronLeft className="w-4 h-4 sm:w-5 sm:h-5" />
        </button>

        {/* Accessible Pagination dots */}
        <div
          role="tablist"
          aria-label="Slide dots"
          className="flex items-center gap-2"
        >
          {FEATURE_HIGHLIGHTS_SLIDES.map((slide, idx) => {
            const isSelected = idx === currentSlide;
            return (
              <button
                key={slide.id}
                role="tab"
                type="button"
                aria-selected={isSelected}
                aria-label={`Go to slide ${idx + 1}: ${slide.title}`}
                onClick={() => goToSlide(idx)}
                onKeyDown={handleKeyDown}
                className={`transition-all duration-200 rounded-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  isSelected
                    ? "w-6 h-2 bg-blue-600 dark:bg-blue-500"
                    : "w-2 h-2 bg-zinc-300 dark:bg-zinc-700 hover:bg-zinc-400 dark:hover:bg-zinc-600"
                }`}
              />
            );
          })}
        </div>

        {/* Next button */}
        <button
          type="button"
          onClick={nextSlide}
          aria-label="Next highlight"
          className="p-2 rounded-xl text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <ChevronRight className="w-4 h-4 sm:w-5 sm:h-5" />
        </button>
      </div>
    </div>
    </div>
  );
}
