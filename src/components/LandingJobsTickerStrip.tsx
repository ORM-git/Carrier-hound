"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { parseTickerResponse } from "@/lib/api/clientSchemas";

export interface TickerJobItem {
  company: string;
  title: string;
  posted_at: string;
  logo_url: string | null;
}

export interface LandingJobsTickerStripProps {
  initialJobs?: TickerJobItem[];
}

export function formatRelativeTime(dateString: string | number | Date): string {
  const date = new Date(dateString);
  const timeMs = date.getTime();
  if (isNaN(timeMs)) {
    return "just now";
  }

  const now = Date.now();
  const diffMs = now - timeMs;

  // Clamp future-dated times within 5 minutes in the future to "just now"
  if (diffMs < 0) {
    const futureSkewMs = -diffMs;
    if (futureSkewMs <= 5 * 60 * 1000) {
      return "just now";
    }
    return "just now";
  }

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMin < 1) {
    return "just now";
  }
  if (diffMin < 60) {
    return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  }
  if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  }
  return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}

interface TickerCardProps {
  job: TickerJobItem;
  keyPrefix?: string;
  index: number;
  isDuplicate?: boolean;
}

function TickerCard({ job, keyPrefix = "", index, isDuplicate = false }: TickerCardProps) {
  const cleanCompany = (job.company || "").trim();
  const letter = cleanCompany.charAt(0).toUpperCase() || "?";
  const relativeTime = formatRelativeTime(job.posted_at);

  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [job.logo_url]);

  return (
    <Link
      href="/jobs"
      aria-label={`${job.title} at ${job.company}`}
      tabIndex={isDuplicate ? -1 : undefined}
      className="ticker-card flex items-center shrink-0 h-9 md:h-12 gap-4 md:gap-3 mr-12 md:mr-16 group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-lg select-none"
    >
      {/* Logo square or neutral letter tile */}
      <div className="w-9 h-9 md:w-12 md:h-12 min-w-[36px] min-h-[36px] md:min-w-[48px] md:min-h-[48px] rounded-[7px] md:rounded-[10px] overflow-hidden bg-[#1F1F1F] border border-white/10 flex items-center justify-center shrink-0 transition-transform group-hover:scale-105">
        {job.logo_url && !imgError ? (
          <img
            src={job.logo_url}
            alt={`${job.company} logo`}
            referrerPolicy="no-referrer"
            className="w-full h-full object-contain p-1 rounded-[6px] md:rounded-[9px]"
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <span className="text-white text-xs md:text-base font-semibold leading-none select-none">
            {letter}
          </span>
        )}
      </div>

      {/* Text block: Line 1 (Company · Time), Line 2 (Title) */}
      <div className="flex flex-col justify-center min-w-0">
        <div className="flex items-center leading-tight text-[#A1A1AA]">
          <span className="text-[11px] md:text-[13px] font-medium text-[#D4D4D8] truncate max-w-[140px]">
            {job.company}
          </span>
          <span className="text-[#71717A] mx-1.5 text-[11px] md:text-[13px] select-none">·</span>
          <span className="text-[11px] md:text-[13px] font-normal text-[#A1A1AA] whitespace-nowrap">
            {relativeTime}
          </span>
        </div>
        <div className="text-[14px] md:text-[17px] font-bold text-white truncate max-w-[200px] sm:max-w-[280px] md:max-w-[340px] leading-snug mt-0.5 group-hover:text-blue-400 transition-colors">
          {job.title}
        </div>
      </div>
    </Link>
  );
}

export default function LandingJobsTickerStrip({ initialJobs }: LandingJobsTickerStripProps) {
  const [jobs, setJobs] = useState<TickerJobItem[] | null>(initialJobs || null);
  const [loading, setLoading] = useState(!initialJobs);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialJobs && initialJobs.length > 0) {
      setJobs(initialJobs);
      setLoading(false);
      return;
    }

    let isMounted = true;
    async function loadTicker() {
      try {
        const res = await fetch("/api/ticker");
        if (!res.ok) {
          if (isMounted) setJobs(null);
          return;
        }
        const data = await res.json();
        const list = parseTickerResponse(data);
        if (isMounted) {
          if (list && list.length >= 5) {
            setJobs(list);
          } else {
            setJobs(null);
          }
        }
      } catch {
        if (isMounted) {
          setJobs(null);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    loadTicker();

    return () => {
      isMounted = false;
    };
  }, [initialJobs]);

  // Dynamically tune duration to ensure real scroll speed is exactly ~50px/s: duration = (scrollWidth / 2) / 50
  useEffect(() => {
    if (!jobs || jobs.length < 5 || !trackRef.current) return;

    const tuneDuration = () => {
      if (!trackRef.current) return;
      const scrollHalf = trackRef.current.scrollWidth / 2;
      if (scrollHalf > 0) {
        const calculatedSeconds = scrollHalf / 50;
        trackRef.current.style.animationDuration = `${calculatedSeconds.toFixed(2)}s`;
      }
    };

    tuneDuration();
    window.addEventListener("resize", tuneDuration);
    return () => window.removeEventListener("resize", tuneDuration);
  }, [jobs]);

  // If fewer than 5 real jobs, loading without initial data, or fetch failed: hide the whole strip
  if (!jobs || jobs.length < 5) {
    return null;
  }

  return (
    <section
      aria-label="Jobs just added"
      className="jobs-ticker-strip w-full overflow-hidden bg-black md:bg-[#0A0A0A] h-[84px] md:h-[104px] flex items-center relative z-20 border-y border-white/10"
    >
      <style>{`
        @keyframes tickerMarquee {
          0% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(-50%);
          }
        }

        .jobs-ticker-strip .ticker-card {
          color: inherit;
          text-decoration: none;
        }

        .ticker-track {
          display: flex;
          align-items: center;
          width: max-content;
          will-change: transform;
          animation: tickerMarquee 155s linear infinite;
        }

        .jobs-ticker-strip:hover .ticker-track,
        .jobs-ticker-strip:focus-within .ticker-track {
          animation-play-state: paused;
        }

        @media (max-width: 767px) {
          .ticker-track {
            animation: tickerMarquee 225s linear infinite;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .ticker-track {
            animation: none !important;
            transform: none !important;
          }
        }
      `}</style>

      {/* Track: flex row continuously translated from 0 to -50% */}
      <div
        ref={trackRef}
        className="ticker-track flex items-center shrink-0 w-max"
        data-testid="ticker-track"
      >
        {/* Set 1: Visible Desktop & Mobile (Primary, Accessible, Focusable) */}
        <div className="flex items-center shrink-0">
          {jobs.map((job, idx) => (
            <TickerCard
              key={`set1-${idx}`}
              job={job}
              keyPrefix="set1"
              index={idx}
              isDuplicate={false}
            />
          ))}
        </div>

        {/* Set 2: Duplicate Set (aria-hidden="true", links tabIndex={-1}) */}
        <div className="flex items-center shrink-0" aria-hidden="true">
          {jobs.map((job, idx) => (
            <TickerCard
              key={`set2-${idx}`}
              job={job}
              keyPrefix="set2"
              index={idx}
              isDuplicate={true}
            />
          ))}
        </div>

        {/* Set 3: Duplicate Set (Mobile only, aria-hidden="true", links tabIndex={-1}) */}
        <div className="flex md:hidden items-center shrink-0" aria-hidden="true">
          {jobs.map((job, idx) => (
            <TickerCard
              key={`set3-${idx}`}
              job={job}
              keyPrefix="set3"
              index={idx}
              isDuplicate={true}
            />
          ))}
        </div>

        {/* Set 4: Duplicate Set (Mobile only, aria-hidden="true", links tabIndex={-1}) */}
        <div className="flex md:hidden items-center shrink-0" aria-hidden="true">
          {jobs.map((job, idx) => (
            <TickerCard
              key={`set4-${idx}`}
              job={job}
              keyPrefix="set4"
              index={idx}
              isDuplicate={true}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
