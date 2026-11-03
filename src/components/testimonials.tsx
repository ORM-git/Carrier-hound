"use client";

import React, { useEffect, useRef, useState, useLayoutEffect } from "react";
import Image from "next/image";
import { getLandingCards, LandingCard } from "@/data/landingCards";

export interface TestimonialsProps {
  direction?: "left" | "right";
}

export const Testimonials = ({ direction = "left" }: TestimonialsProps = {}) => {
  const cards = getLandingCards();

  const containerRef = useRef<HTMLElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const sequenceRef = useRef<HTMLDivElement | null>(null);

  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isInView, setIsInView] = useState(true);
  const [isReducedMotion, setIsReducedMotion] = useState(false);

  // 1. Detect prefers-reduced-motion
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setIsReducedMotion(mediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsReducedMotion(e.matches);
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // 2. Off-screen pause with IntersectionObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        setIsInView(!!entries[0]?.isIntersecting);
      },
      { rootMargin: "100px" }
    );
    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  // 3. Seamless wrap calculation: sequence width + computed boundary gap
  const updateLoopDimensions = () => {
    if (!sequenceRef.current || !trackRef.current) return;
    const seqWidth = sequenceRef.current.getBoundingClientRect().width;
    const computedGap =
      parseFloat(window.getComputedStyle(trackRef.current).gap) || 20;
    const loopDistance = Math.round(seqWidth + computedGap);
    const speed = 40; // 40px/s (calm speed in 35-45px/s specified)
    const duration = (loopDistance / speed).toFixed(2);

    trackRef.current.style.setProperty("--loop-distance", `${loopDistance}px`);
    trackRef.current.style.setProperty("--loop-duration", `${duration}s`);
  };

  useLayoutEffect(() => {
    updateLoopDimensions();

    const seq = sequenceRef.current;
    if (!seq || typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(() => {
      updateLoopDimensions();
    });
    ro.observe(seq);

    window.addEventListener("resize", updateLoopDimensions);

    // Also recalculate after web fonts load
    if (typeof document !== "undefined" && (document as any).fonts?.ready) {
      (document as any).fonts.ready.then(updateLoopDimensions);
    }

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", updateLoopDimensions);
    };
  }, []);

  // True when user hovers over any testimonial, focuses within, or section is off-screen
  const isAnimationPaused = isHovered || isFocused || !isInView;

  // Render single testimonial card
  const renderCard = (card: LandingCard, isDuplicate: boolean, index: number) => (
    <article
      key={isDuplicate ? `dup-${card.id}-${index}` : card.id}
      data-testid={isDuplicate ? undefined : "testimonial-card"}
      aria-hidden={isDuplicate ? true : undefined}
      tabIndex={isDuplicate ? -1 : undefined}
      className="bg-white border border-slate-200/90 rounded-tr-[28px] rounded-br-[28px] rounded-bl-[28px] rounded-tl-md p-6 sm:p-7 flex flex-col justify-between w-[82vw] xs:w-[330px] sm:w-[350px] shrink-0 text-left select-none shadow-2xs hover:border-slate-300 transition-colors"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onTouchStart={() => setIsHovered(true)}
      onTouchEnd={() => setIsHovered(false)}
    >
      <div>
        {/* Large decorative quotation mark icon */}
        <svg
          className="w-8 h-8 text-blue-500/25 fill-blue-500/15 mb-3.5 shrink-0"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M14.017 21v-7.391c0-5.704 3.731-9.57 8.983-10.609l.995 2.151c-2.432.917-3.995 3.638-3.995 5.849h4v10h-9.983zm-14.017 0v-7.391c0-5.704 3.748-9.57 9-10.609l.996 2.151c-2.433.917-3.996 3.638-3.996 5.849h3.983v10h-9.983z" />
        </svg>

        {/* Readable body text (never truncated) */}
        <p className="text-[14px] sm:text-[15px] text-slate-700 leading-relaxed font-normal">
          &ldquo;{card.body}&rdquo;
        </p>
      </div>

      {/* Testimonial footer row: avatar, author name, location */}
      <div className="flex items-center pt-4 mt-5 border-t border-slate-100 gap-3 min-w-0">
        {card.avatar ? (
          <Image
            src={card.avatar}
            alt={isDuplicate ? "" : card.authorName}
            width={40}
            height={40}
            className="w-10 h-10 rounded-full object-cover border border-slate-200 shrink-0"
            tabIndex={-1}
          />
        ) : (
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-white text-xs shrink-0 select-none ${card.avatarBg || "bg-blue-600"}`}
            aria-hidden="true"
          >
            <span>{card.initials}</span>
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-[#0F172A] leading-tight truncate">
            {card.authorName}
          </div>
          <div className="text-xs text-slate-500 font-medium truncate mt-0.5">
            {card.location}
          </div>
        </div>
      </div>
    </article>
  );

  return (
    <section
      ref={containerRef}
      data-testid="landing-testimonials-section"
      aria-label="Candidate Testimonials"
      className="py-16 sm:py-20 lg:py-24 relative overflow-hidden bg-white"
    >
      {/* Scoped CSS animation for subpixel smooth translation with instant hover pause */}
      <style>{`
        @keyframes cmTestimonialsRunner {
          from {
            transform: translate3d(0, 0, 0);
          }
          to {
            transform: translate3d(calc(-1 * var(--loop-distance, 4440px)), 0, 0);
          }
        }
        @keyframes cmTestimonialsRunnerReverse {
          from {
            transform: translate3d(calc(-1 * var(--loop-distance, 4440px)), 0, 0);
          }
          to {
            transform: translate3d(0, 0, 0);
          }
        }
        .cm-testimonials-active-track {
          animation: cmTestimonialsRunner var(--loop-duration, 111s) linear infinite;
        }
        .cm-testimonials-active-track.direction-right {
          animation-name: cmTestimonialsRunnerReverse;
        }
        .cm-testimonials-active-track:hover,
        .cm-testimonials-active-track:focus-within,
        .cm-testimonials-active-track.is-paused {
          animation-play-state: paused !important;
        }
      `}</style>

      <div className="max-w-[1320px] mx-auto px-4 sm:px-6">
        {/* Centered Heading Stack */}
        <div className="text-center max-w-3xl mx-auto mb-10 sm:mb-12">
          <div className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full text-xs font-semibold tracking-wider uppercase bg-blue-50/80 text-blue-700 border border-blue-200/80 shadow-2xs mb-3">
            <span>Candidate Stories</span>
          </div>
          <h2 className="text-3xl font-semibold tracking-tight text-[#142033] sm:text-4xl lg:whitespace-nowrap">
            Feedback from early access users
          </h2>
          <p className="mt-2 text-sm sm:text-base text-gray-600 font-normal">
            What job seekers are saying about finding direct company roles
          </p>
        </div>
      </div>

      {/* Runner Row Container */}
      <div
        className={`relative w-full overflow-hidden ${
          isReducedMotion ? "overflow-x-auto scrollbar-thin px-4 sm:px-6" : ""
        }`}
        tabIndex={isReducedMotion ? 0 : undefined}
        role={isReducedMotion ? "region" : undefined}
        aria-label={
          isReducedMotion
            ? "Testimonials row. Use arrow keys or scroll to navigate cards."
            : undefined
        }
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onTouchStart={() => setIsHovered(true)}
        onTouchEnd={() => setIsHovered(false)}
        onFocus={() => setIsFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setIsFocused(false);
          }
        }}
      >
        {/* Subtle edge fades (delicate so readable text is never obscured) */}
        {!isReducedMotion && (
          <>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-0 w-8 sm:w-16 bg-gradient-to-r from-white to-transparent z-10"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 w-8 sm:w-16 bg-gradient-to-l from-white to-transparent z-10"
            />
          </>
        )}

        {/* Continuous Horizontal Track */}
        <div
          ref={trackRef}
          data-testid="testimonials-runner-track"
          className={`flex gap-4 sm:gap-5 w-max items-stretch will-change-transform py-2 ${
            !isReducedMotion
              ? `cm-testimonials-active-track ${direction === "right" ? "direction-right" : ""}`
              : ""
          } ${isAnimationPaused ? "is-paused" : ""}`}
        >
          {/* Primary Sequence: Original, Accessible */}
          <div
            ref={sequenceRef}
            className="flex gap-4 sm:gap-5 items-stretch shrink-0"
          >
            {cards.map((card, idx) => renderCard(card, false, idx))}
          </div>

          {/* Secondary Sequence: Seamless Visual Duplicate */}
          {!isReducedMotion && (
            <div
              aria-hidden="true"
              inert={true as any}
              className="flex gap-4 sm:gap-5 items-stretch shrink-0"
            >
              {cards.map((card, idx) => renderCard(card, true, idx))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

export default Testimonials;
