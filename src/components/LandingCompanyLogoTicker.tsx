"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";

export interface CompanyTickerJobItem {
  company: string;
  title: string;
  posted_at: string;
  logo_url: string | null;
}

export interface LandingCompanyLogoTickerProps {
  initialJobs?: CompanyTickerJobItem[];
}

export function formatRelativeTime(dateString: string | number | Date): string {
  const date = new Date(dateString);
  const timeMs = date.getTime();
  if (isNaN(timeMs)) return "recently";

  const diffMs = Date.now() - timeMs;
  if (diffMs < 0) return "just now";

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

interface CompanyTickerCardProps {
  job: CompanyTickerJobItem;
  isDuplicate?: boolean;
}

function CompanyTickerCard({ job, isDuplicate = false }: CompanyTickerCardProps) {
  const [imgError, setImgError] = useState(false);
  const cleanCompany = (job.company || "").trim();
  const letter = cleanCompany.charAt(0).toUpperCase() || "?";
  const relativeTime = job.posted_at ? formatRelativeTime(job.posted_at) : null;

  return (
    <Link
      href="/early-access"
      tabIndex={isDuplicate ? -1 : undefined}
      aria-label={`${job.title} at ${job.company}`}
      className="group flex items-center gap-3 w-[260px] md:w-auto md:min-w-[280px] max-w-[360px] h-[64px] px-3.5 py-2 rounded-[14px] bg-white border border-slate-200/90 shadow-2xs hover:border-blue-400 hover:shadow-xs transition-all shrink-0 select-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
    >
      {/* 12px rounded company logo tile */}
      <div className="w-11 h-11 min-w-[44px] min-h-[44px] rounded-[12px] bg-blue-50/70 border border-blue-100 flex items-center justify-center overflow-hidden shrink-0 transition-transform group-hover:scale-105">
        {job.logo_url && !imgError ? (
          <img
            src={job.logo_url}
            alt={`${job.company} logo`}
            referrerPolicy="no-referrer"
            className="w-full h-full object-contain p-1 rounded-[12px]"
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <span className="text-[#2563EB] font-bold text-base select-none leading-none">
            {letter}
          </span>
        )}
      </div>

      {/* Company name · Job Title */}
      <div className="flex flex-col justify-center min-w-0 pr-1">
        <div className="text-[13px] md:text-sm font-semibold text-slate-900 truncate">
          <span className="font-bold text-slate-950">{job.company}</span>
          <span className="mx-1.5 text-slate-400 select-none">·</span>
          <span className="text-slate-600 font-normal">{job.title}</span>
        </div>
        {relativeTime && (
          <span className="text-[11px] text-slate-400 mt-0.5 font-normal">
            {relativeTime}
          </span>
        )}
      </div>
    </Link>
  );
}

export default function LandingCompanyLogoTicker({ initialJobs }: LandingCompanyLogoTickerProps) {
  const [jobs, setJobs] = useState<CompanyTickerJobItem[] | null>(
    initialJobs && initialJobs.length > 0 ? initialJobs : null
  );

  useEffect(() => {
    if (initialJobs && initialJobs.length > 0) {
      setJobs(initialJobs);
      return;
    }

    let isMounted = true;
    async function loadTicker() {
      try {
        const res = await fetch("/api/ticker?limit=30&distinct=1");
        if (!res.ok) {
          if (isMounted) setJobs(null);
          return;
        }
        const data = await res.json();
        const list: CompanyTickerJobItem[] = Array.isArray(data) ? data : data?.jobs || [];
        if (isMounted) {
          if (list && list.length > 0) {
            setJobs(list);
          } else {
            setJobs(null);
          }
        }
      } catch {
        if (isMounted) {
          setJobs(null);
        }
      }
    }

    loadTicker();
    return () => {
      isMounted = false;
    };
  }, [initialJobs]);

  // If the jobs source is unavailable at build/runtime or empty, render nothing (no empty box)
  if (!jobs || jobs.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Jobs from companies like these"
      className="py-10 md:py-12 bg-slate-50/60 border-b border-slate-200/80 overflow-hidden"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 mb-6 text-center">
        <h2 className="text-xl sm:text-2xl md:text-3xl font-bold text-[#090E34] tracking-tight">
          Jobs from companies like these
        </h2>
      </div>

      {/* Marquee Wrapper with pause-on-hover & pause-on-focus */}
      <div className="cm-logo-ticker-container relative w-full overflow-hidden select-none">
        {/* Left/Right subtle fade gradients */}
        <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-12 md:w-28 bg-gradient-to-r from-slate-50/90 to-transparent z-10" />
        <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-12 md:w-28 bg-gradient-to-l from-slate-50/90 to-transparent z-10" />

        <div className="cm-logo-ticker-track flex">
          {/* Original Interactive Track */}
          <div className="cm-logo-ticker-list flex items-center gap-4 pr-4 shrink-0">
            {jobs.map((job, idx) => (
              <CompanyTickerCard key={`orig-${job.company}-${idx}`} job={job} />
            ))}
          </div>

          {/* Duplicated Track for Seamless Loop (aria-hidden and no focus) */}
          <div
            aria-hidden="true"
            className="cm-logo-ticker-list cm-marquee-duplicate flex items-center gap-4 pr-4 shrink-0"
          >
            {jobs.map((job, idx) => (
              <CompanyTickerCard key={`dup-${job.company}-${idx}`} job={job} isDuplicate />
            ))}
          </div>
        </div>
      </div>

      <style dangerouslySetInnerHTML={{
        __html: `
        @keyframes cmCompanyMarquee {
          0% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(-50%);
          }
        }
        .cm-logo-ticker-track {
          width: max-content;
          animation: cmCompanyMarquee 45s linear infinite;
        }
        .cm-logo-ticker-container:hover .cm-logo-ticker-track,
        .cm-logo-ticker-container:focus-within .cm-logo-ticker-track {
          animation-play-state: paused;
        }
        @media (prefers-reduced-motion: reduce) {
          .cm-logo-ticker-track {
            animation: none !important;
            transform: none !important;
            width: 100% !important;
            flex-wrap: wrap !important;
            justify-content: center !important;
            gap: 16px;
            padding-left: 16px;
            padding-right: 16px;
          }
          .cm-marquee-duplicate {
            display: none !important;
          }
        }
      `}} />
    </section>
  );
}
