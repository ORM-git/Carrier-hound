"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";

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
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMin < 1) {
    return "1 minute ago";
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
}

function TickerCard({ job, keyPrefix = "", index }: TickerCardProps) {
  const [imgError, setImgError] = useState(false);
  const letter = (job.company || "?").trim().charAt(0).toUpperCase() || "?";
  const relativeTime = formatRelativeTime(job.posted_at);

  return (
    <Link
      href="/early-access"
      aria-label={`${job.title} at ${job.company}`}
      className="ticker-card flex items-center shrink-0 h-9 md:h-12 gap-4 md:gap-3 mr-12 md:mr-16 group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-lg select-none"
    >
      {/* Logo square or neutral letter tile */}
      <div className="w-9 h-9 md:w-12 md:h-12 min-w-[36px] min-h-[36px] md:min-w-[48px] md:min-h-[48px] rounded-[7px] md:rounded-[10px] overflow-hidden bg-[#1F1F1F] border border-white/10 flex items-center justify-center shrink-0 transition-transform group-hover:scale-105">
        {job.logo_url && !imgError ? (
          <img
            src={job.logo_url}
            alt={`${job.company} logo`}
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
      <div className="flex flex-col justify-center">
        <div className="flex items-center text-white leading-tight">
          <span className="text-[13px] font-semibold text-white">
            {job.company}
          </span>
          <span className="text-white/60 mx-1.5 text-[11px] md:text-[13px] select-none">·</span>
          <span className="text-[11px] md:text-[13px] font-normal text-white">
            {relativeTime}
          </span>
        </div>
        <div className="text-[13px] md:text-[18px] font-semibold md:font-medium text-white truncate max-w-[200px] sm:max-w-[280px] md:max-w-[340px] leading-tight mt-0.5 group-hover:text-blue-400 transition-colors">
          {job.title}
        </div>
      </div>
    </Link>
  );
}

export default function LandingJobsTickerStrip({ initialJobs }: LandingJobsTickerStripProps) {
  const [jobs, setJobs] = useState<TickerJobItem[] | null>(initialJobs || null);
  const [loading, setLoading] = useState(!initialJobs);

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
        const list = Array.isArray(data) ? data : (data?.jobs || []);
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

  // If fewer than 5 real jobs, loading without initial data, or fetch failed: hide the whole strip
  if (!jobs || jobs.length < 5) {
    return null;
  }

  return (
    <section
      aria-label="Jobs just added"
      className="jobs-ticker-strip w-full overflow-hidden bg-black md:bg-[#0A0A0A] h-[100px] md:h-[144px] flex items-center relative z-20 border-y border-white/5"
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

        .ticker-track {
          display: flex;
          align-items: center;
          width: max-content;
          will-change: transform;
          animation: tickerMarquee 150s linear infinite;
        }

        @media (max-width: 767px) {
          .ticker-track {
            animation: tickerMarquee 100s linear infinite;
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
        className="ticker-track flex items-center shrink-0 w-max"
        data-testid="ticker-track"
      >
        {/* Set 1: Visible Desktop & Mobile */}
        <div className="flex items-center shrink-0">
          {jobs.map((job, idx) => (
            <TickerCard
              key={`set1-${idx}`}
              job={job}
              keyPrefix="set1"
              index={idx}
            />
          ))}
        </div>

        {/* Set 2: Visible Desktop & Mobile (Seamless loop at -50% translation) */}
        <div className="flex items-center shrink-0">
          {jobs.map((job, idx) => (
            <TickerCard
              key={`set2-${idx}`}
              job={job}
              keyPrefix="set2"
              index={idx}
            />
          ))}
        </div>

        {/* Set 3: Mobile only (renders 4x on mobile for seamless loop) */}
        <div className="flex md:hidden items-center shrink-0">
          {jobs.map((job, idx) => (
            <TickerCard
              key={`set3-${idx}`}
              job={job}
              keyPrefix="set3"
              index={idx}
            />
          ))}
        </div>

        {/* Set 4: Mobile only (renders 4x on mobile for seamless loop) */}
        <div className="flex md:hidden items-center shrink-0">
          {jobs.map((job, idx) => (
            <TickerCard
              key={`set4-${idx}`}
              job={job}
              keyPrefix="set4"
              index={idx}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
