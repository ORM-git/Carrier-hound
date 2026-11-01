"use client";

import React, { useState, useEffect, useRef } from "react";
import Image from "next/image";
import clsx from "clsx";
import { motion, useReducedMotion } from "motion/react";
import { X, Check, Sparkles } from "lucide-react";

export interface ComparisonItem {
  caption: string;
  image: string;
  imageAlt: string;
  loopAnimation?: "sad" | "happy";
}

export interface ComparisonRow {
  id: string;
  usual: ComparisonItem;
  monke: ComparisonItem;
}

export const COMPARISON_ROWS: ComparisonRow[] = [
  {
    id: "row-1",
    usual: {
      caption: "Scrolling the same feeds. Again.",
      image: "/mascot/row1-sad.png",
      imageAlt: "Monkey scrolling repetitive job feeds",
      loopAnimation: "sad",
    },
    monke: {
      caption: "Jobs straight from company career pages",
      image: "/mascot/row1-happy.png",
      imageAlt: "Monkey discovering jobs directly on company career pages",
      loopAnimation: "happy",
    },
  },
  {
    id: "row-2",
    usual: {
      caption: '"Posted 1h ago, 200 applicants"',
      image: "/images/comparison/row-2-usual.png",
      imageAlt: "Monkey buried under 200 applicants",
    },
    monke: {
      caption: "Employers you didn't know existed",
      image: "/images/comparison/row-2-monke.png",
      imageAlt: "Monkey discovering hidden employers",
    },
  },
  {
    id: "row-3",
    usual: {
      caption: "Rewriting your resume. Again.",
      image: "/images/comparison/row-3-usual.png",
      imageAlt: "Monkey rewriting resume again",
    },
    monke: {
      caption: "AI-refined resume",
      image: "/images/comparison/row-3-monke.png",
      imageAlt: "Monkey with AI-refined resume",
    },
  },
  {
    id: "row-4",
    usual: {
      caption: '"Am I even qualified?"',
      image: "/images/comparison/row-4-usual.png",
      imageAlt: "Monkey asking am I even qualified",
    },
    monke: {
      caption: "Resume score card",
      image: "/images/comparison/row-4-monke.png",
      imageAlt: "Monkey holding resume score card",
    },
  },
  {
    id: "row-5",
    usual: {
      caption: "Endless searching",
      image: "/images/comparison/row-5-usual.png",
      imageAlt: "Monkey running in endless search hamster wheel",
    },
    monke: {
      caption: "Worldwide roles, filter by country",
      image: "/images/comparison/row-5-monke.png",
      imageAlt: "Monkey viewing worldwide roles filtered by country",
    },
  },
];

/**
 * Clean placeholder shown when a monkey illustration file is not yet provided,
 * while loading, or if the asset fails to load.
 */
export function CardImagePlaceholder({ isMonke }: { isMonke?: boolean }) {
  return (
    <div
      data-testid="image-placeholder"
      className={clsx(
        "w-full h-full min-h-[85px] sm:min-h-[105px] flex flex-col items-center justify-center rounded-xl p-2 select-none transition-colors",
        isMonke
          ? "bg-neutral-50/70 border border-dashed border-neutral-200 text-neutral-400"
          : "bg-neutral-200/40 border border-dashed border-neutral-300 text-neutral-400"
      )}
      aria-label="Illustration placeholder"
    >
      <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-white/90 shadow-2xs flex items-center justify-center text-amber-500 mb-1">
        <Sparkles className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
      </div>
      <span className="text-[10px] font-medium tracking-tight text-neutral-400">
        Illustration
      </span>
    </div>
  );
}

/**
 * Robust image component that loads next/image with graceful placeholder fallback
 * and gentle GPU-friendly CSS animation loops when enabled by configuration.
 */
function ComparisonCardImage({
  src,
  alt,
  isMonke,
  loopAnimation,
  isInView,
  shouldReduceMotion,
}: {
  src?: string;
  alt: string;
  isMonke?: boolean;
  loopAnimation?: "sad" | "happy";
  isInView?: boolean;
  shouldReduceMotion?: boolean | null;
}) {
  const [hasError, setHasError] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  if (!src || hasError) {
    return <CardImagePlaceholder isMonke={isMonke} />;
  }

  const isAnimated = Boolean(loopAnimation) && !shouldReduceMotion;
  const playState = isInView && isAnimated ? "running" : "paused";

  const imageElement = (
    <Image
      src={src}
      alt={alt}
      width={160}
      height={115}
      className={clsx(
        "max-h-[85px] sm:max-h-[105px] w-auto object-contain transition-opacity duration-300 select-none relative z-10",
        isLoaded ? "opacity-100" : "opacity-0"
      )}
      onLoad={() => setIsLoaded(true)}
      onError={() => setHasError(true)}
    />
  );

  let content = imageElement;

  if (loopAnimation === "sad") {
    content = (
      <div
        className="mascot-sad-nod flex items-center justify-center"
        style={{ animationPlayState: playState }}
      >
        <div
          className="mascot-sad-breathe flex items-center justify-center"
          style={{ animationPlayState: playState }}
        >
          {imageElement}
        </div>
      </div>
    );
  } else if (loopAnimation === "happy") {
    content = (
      <div
        className="mascot-happy-swing flex items-center justify-center"
        style={{ animationPlayState: playState }}
      >
        <div
          className="mascot-happy-bounce flex items-center justify-center"
          style={{ animationPlayState: playState }}
        >
          {imageElement}
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full min-h-[85px] sm:min-h-[105px] flex items-center justify-center">
      {!isLoaded && (
        <div className="absolute inset-0 flex items-center justify-center z-0">
          <CardImagePlaceholder isMonke={isMonke} />
        </div>
      )}
      {content}
    </div>
  );
}

/**
 * Individual comparison row with entrance motion and in-view loop detection.
 */
function ComparisonRowItem({
  row,
  index,
  shouldReduceMotion,
}: {
  row: ComparisonRow;
  index: number;
  shouldReduceMotion: boolean | null;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [isInView, setIsInView] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !rowRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsInView(entry.isIntersecting);
      },
      { threshold: 0.1 }
    );
    observer.observe(rowRef.current);
    return () => observer.disconnect();
  }, []);

  const staggerDelay = index * 0.08;

  return (
    <motion.div
      ref={rowRef}
      key={row.id}
      data-testid={`comparison-row-${index + 1}`}
      className="relative grid grid-cols-2 gap-2.5 sm:gap-3.5 items-stretch"
      initial={
        shouldReduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }
      }
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={
        shouldReduceMotion
          ? { duration: 0 }
          : {
              duration: 0.45,
              delay: staggerDelay,
              ease: [0.16, 1, 0.3, 1],
            }
      }
    >
      {/* Left Card (soft grey) */}
      <motion.div
        data-testid={`card-usual-${index + 1}`}
        className="flex-1 flex"
        initial={
          shouldReduceMotion ? { opacity: 1, x: 0 } : { opacity: 0, x: -28 }
        }
        whileInView={{ opacity: 1, x: 0 }}
        viewport={{ once: true, amount: 0.15 }}
        transition={
          shouldReduceMotion
            ? { duration: 0 }
            : {
                duration: 0.45,
                delay: staggerDelay,
                ease: [0.16, 1, 0.3, 1],
              }
        }
      >
        <div className="w-full flex flex-col justify-between items-center bg-[#F2F1F6] rounded-2xl sm:rounded-3xl p-3 sm:p-4 text-center min-h-[160px] sm:min-h-[185px]">
          <div className="w-full flex-1 flex items-center justify-center min-h-[85px] sm:min-h-[105px] relative mb-2 sm:mb-2.5">
            <ComparisonCardImage
              src={row.usual.image}
              alt={row.usual.imageAlt}
              isMonke={false}
              loopAnimation={row.usual.loopAnimation}
              isInView={isInView}
              shouldReduceMotion={shouldReduceMotion}
            />
          </div>
          <p className="text-[11px] sm:text-xs md:text-sm font-semibold text-neutral-700 leading-snug">
            {row.usual.caption}
          </p>
        </div>
      </motion.div>

      {/* Center VS Badge */}
      <motion.div
        data-testid={`vs-badge-${index + 1}`}
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-neutral-900 text-white flex items-center justify-center font-black text-[9px] sm:text-[11px] tracking-wider uppercase shadow-md select-none pointer-events-none"
        aria-hidden="true"
        initial={
          shouldReduceMotion
            ? { opacity: 1, scale: 1 }
            : { opacity: 0, scale: 0 }
        }
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true, amount: 0.15 }}
        transition={
          shouldReduceMotion
            ? { duration: 0 }
            : {
                type: "spring",
                stiffness: 420,
                damping: 22,
                delay: staggerDelay + 0.1,
              }
        }
      >
        VS
      </motion.div>

      {/* Right Card (white with dark border) */}
      <motion.div
        data-testid={`card-monke-${index + 1}`}
        className="flex-1 flex"
        initial={
          shouldReduceMotion ? { opacity: 1, x: 0 } : { opacity: 0, x: 28 }
        }
        whileInView={{ opacity: 1, x: 0 }}
        viewport={{ once: true, amount: 0.15 }}
        transition={
          shouldReduceMotion
            ? { duration: 0 }
            : {
                duration: 0.45,
                delay: staggerDelay,
                ease: [0.16, 1, 0.3, 1],
              }
        }
      >
        <div className="w-full flex flex-col justify-between items-center bg-white border-[1.5px] border-neutral-900 rounded-2xl sm:rounded-3xl p-3 sm:p-4 text-center min-h-[160px] sm:min-h-[185px] shadow-2xs">
          <div className="w-full flex-1 flex items-center justify-center min-h-[85px] sm:min-h-[105px] relative mb-2 sm:mb-2.5">
            <ComparisonCardImage
              src={row.monke.image}
              alt={row.monke.imageAlt}
              isMonke={true}
              loopAnimation={row.monke.loopAnimation}
              isInView={isInView}
              shouldReduceMotion={shouldReduceMotion}
            />
          </div>
          <p className="text-[11px] sm:text-xs md:text-sm font-bold text-neutral-900 leading-snug">
            {row.monke.caption}
          </p>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function LandingComparisonSection() {
  const shouldReduceMotion = useReducedMotion();

  return (
    <div className="w-full max-w-[480px] sm:max-w-xl mx-auto">
      {/* Embedded CSS Keyframes for GPU-accelerated mascot loops */}
      <style>{`
        @keyframes mascot-sad-nod {
          0% { transform: rotate(-2deg); }
          100% { transform: rotate(2deg); }
        }
        @keyframes mascot-sad-breathe {
          0% { transform: scale(1) translateY(0); }
          100% { transform: scale(1.02) translateY(2px); }
        }
        @keyframes mascot-happy-swing {
          0% { transform: rotate(-4deg); }
          100% { transform: rotate(4deg); }
        }
        @keyframes mascot-happy-bounce {
          0% { transform: translateY(0); }
          100% { transform: translateY(-6px); }
        }
        .mascot-sad-nod {
          transform-origin: bottom center;
          animation: mascot-sad-nod 4s ease-in-out infinite alternate;
          will-change: transform;
        }
        .mascot-sad-breathe {
          transform-origin: bottom center;
          animation: mascot-sad-breathe 3s ease-in-out infinite alternate;
          will-change: transform;
        }
        .mascot-happy-swing {
          transform-origin: top left;
          animation: mascot-happy-swing 2.4s ease-in-out infinite alternate;
          will-change: transform;
        }
        .mascot-happy-bounce {
          animation: mascot-happy-bounce 1.2s ease-in-out infinite alternate;
          will-change: transform;
        }
        @media (prefers-reduced-motion: reduce) {
          .mascot-sad-nod,
          .mascot-sad-breathe,
          .mascot-happy-swing,
          .mascot-happy-bounce {
            animation: none !important;
            transform: none !important;
          }
        }
      `}</style>

      {/* Title */}
      <div className="text-center mb-8 sm:mb-10">
        <h2 className="text-2xl sm:text-4xl md:text-[42px] font-extrabold text-[#09090B] tracking-tight leading-[1.15] max-w-md mx-auto">
          Tired of getting
          <span className="block">auto-rejected?</span>
        </h2>
      </div>

      {/* Two Column Headers */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3.5 mb-3 sm:mb-4">
        {/* Left header: The usual grind */}
        <div
          data-testid="header-usual"
          className="flex items-center justify-center gap-1.5 sm:gap-2 py-2 sm:py-2.5 px-2.5 sm:px-4 rounded-xl sm:rounded-2xl bg-[#F2F1F6] text-[#09090B] font-bold text-xs sm:text-sm shadow-2xs select-none"
        >
          <span className="w-4 h-4 sm:w-4.5 sm:h-4.5 rounded-md bg-rose-100 flex items-center justify-center flex-shrink-0 text-rose-600">
            <X className="w-3 h-3 stroke-[3]" />
          </span>
          <span className="truncate">The usual grind</span>
        </div>

        {/* Right header: The Monke way */}
        <div
          data-testid="header-monke"
          className="flex items-center justify-center gap-1.5 sm:gap-2 py-2 sm:py-2.5 px-2.5 sm:px-4 rounded-xl sm:rounded-2xl bg-white border-[1.5px] border-neutral-900 text-[#09090B] font-bold text-xs sm:text-sm shadow-2xs select-none"
        >
          <span className="w-4 h-4 sm:w-4.5 sm:h-4.5 rounded-md bg-emerald-100 flex items-center justify-center flex-shrink-0 text-emerald-600">
            <Check className="w-3 h-3 stroke-[3]" />
          </span>
          <span className="truncate">The Monke way</span>
        </div>
      </div>

      {/* 5 Rows with round VS badge */}
      <div className="flex flex-col gap-2.5 sm:gap-3.5">
        {COMPARISON_ROWS.map((row, index) => (
          <ComparisonRowItem
            key={row.id}
            row={row}
            index={index}
            shouldReduceMotion={shouldReduceMotion}
          />
        ))}
      </div>

      {/* Reference Footer: site brand and illustration label */}
      <div className="flex justify-between items-center text-xs text-neutral-400 mt-4 px-2 select-none">
        <span className="text-[11px] text-neutral-400 font-medium">careermonke.com</span>
        <span className="px-2 py-0.5 rounded-full bg-neutral-100 text-[10px] font-medium text-neutral-500 border border-neutral-200">
          Illustration
        </span>
      </div>
    </div>
  );
}
