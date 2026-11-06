"use client";

import React, { useState } from "react";
import { cn } from "@/lib/utils";
import {
  TestimonialCard,
  TestimonialAuthor,
} from "@/components/ui/testimonial-card";

export interface TestimonialItem {
  author: TestimonialAuthor;
  text: string;
}

export interface TestimonialsWithMarqueeProps {
  title?: string;
  description?: string;
  testimonials: TestimonialItem[];
  className?: string;
}

export function TestimonialsWithMarquee({
  title = "Loved by job seekers everywhere",
  description = "Thousands of people found their dream job through us - here's what they say.",
  testimonials,
  className,
}: TestimonialsWithMarqueeProps) {
  const [paused, setPaused] = useState(false);
  const playState = paused ? "[animation-play-state:paused]" : "";
  return (
    <section className={cn("py-16 sm:py-20 lg:py-24 relative overflow-hidden bg-background", className)}>
      <div className="max-w-container mx-auto px-4 sm:px-6">
        {/* Header */}
        <div className="text-center max-w-2xl mx-auto mb-10 sm:mb-12">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            {title}
          </h2>
          <p className="mt-3 text-sm sm:text-base text-muted-foreground">
            {description}
          </p>
        </div>

        {/* Marquee Wrapper with edge fade gradients on sm+ */}
        <div className="group relative w-full overflow-hidden">
          {/* Left edge gradient fade */}
          <div className="pointer-events-none absolute inset-y-0 left-0 hidden w-24 sm:w-36 bg-gradient-to-r from-background to-transparent sm:block z-10" />

          {/* Right edge gradient fade */}
          <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-24 sm:w-36 bg-gradient-to-l from-background to-transparent sm:block z-10" />

          {/* Marquee Track: pauses on hover, on reduced-motion, or via the pause button */}
          <div className="group flex overflow-hidden py-4 [--gap:1.25rem] [--duration:35s] [gap:var(--gap)] flex-row max-w-full">
            <div
              className={cn(
                "flex shrink-0 justify-around [gap:var(--gap)] animate-marquee flex-row group-hover:[animation-play-state:paused] motion-reduce:[animation-play-state:paused]",
                playState
              )}
            >
              {testimonials.map((item, i) => (
                <TestimonialCard
                  key={`track1-${i}`}
                  author={item.author}
                  text={item.text}
                />
              ))}
            </div>

            <div
              className={cn(
                "flex shrink-0 justify-around [gap:var(--gap)] animate-marquee flex-row group-hover:[animation-play-state:paused] motion-reduce:[animation-play-state:paused]",
                playState
              )}
              aria-hidden="true"
            >
              {testimonials.map((item, i) => (
                <TestimonialCard
                  key={`track2-${i}`}
                  author={item.author}
                  text={item.text}
                />
              ))}
            </div>
          </div>

          {/* WCAG 2.2.2 pause control: visible on hover/focus, always keyboard reachable */}
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
            aria-label={paused ? "Play testimonials carousel" : "Pause testimonials carousel"}
            className="absolute bottom-2 right-2 z-20 rounded-full border border-slate-200 bg-white/90 px-3 py-1 text-xs font-medium text-slate-600 shadow-sm opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 transition-opacity"
          >
            {paused ? "Play" : "Pause"}
          </button>
        </div>
      </div>
    </section>
  );
}

export default TestimonialsWithMarquee;
