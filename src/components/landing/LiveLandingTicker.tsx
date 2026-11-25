"use client";

import React, { useEffect, useState } from "react";
import { parseTickerResponse, TickerItemParsed } from "@/lib/api/clientSchemas";
import { formatRelativeTime } from "@/components/LandingJobsTickerStrip";

export const TICKER_REFRESH_MS = 5 * 60 * 1000;

export function safeTickerLogo(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname.endsWith(".supabase.co") &&
      !url.username && !url.password && url.pathname.includes("/company-logos/") ? url.href : null;
  } catch { return null; }
}

function Logo({ job }: { job: TickerItemParsed }) {
  const src = safeTickerLogo(job.logo_url);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setLoaded(false); setFailed(false); }, [src]);
  return <span className="ls-logo" style={{ position: "relative", overflow: "hidden", flexShrink: 0, backgroundColor: loaded ? "#fff" : undefined }}>
    {!loaded && <span>{job.company.trim()[0]?.toUpperCase() || "?"}</span>}
    {/* Stored third-party images need direct load/error signals for the visible letter fallback. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {src && !failed && <img src={src} alt={`${job.company} logo`} referrerPolicy="no-referrer"
      onLoad={(event) => { if (event.currentTarget.naturalWidth > 0) setLoaded(true); else setFailed(true); }}
      onError={() => { setFailed(true); setLoaded(false); }}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", padding: 4, opacity: loaded ? 1 : 0 }} />}
  </span>;
}

/** Live content only, within the owner's unchanged .ls strip layout. No invented fallback jobs. */
export default function LiveLandingTicker() {
  const [jobs, setJobs] = useState<TickerItemParsed[]>([]);
  const [, tick] = useState(0);
  useEffect(() => {
    let stopped = false;
    let pending = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (stopped || pending || document.visibilityState === "hidden") return;
      pending = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 10000);
      try {
        const response = await fetch("/api/ticker", { cache: "no-cache", signal: controller.signal });
        if (!response.ok) throw new Error("Ticker unavailable");
        const rows = parseTickerResponse(await response.json()).filter(job =>
          job.company.trim() && job.title.trim() && Number.isFinite(Date.parse(job.posted_at)) && Date.parse(job.posted_at) <= Date.now() + 300000
        ).slice(0, 20);
        if (!stopped) setJobs(rows.length >= 5 ? rows : []);
      } catch {
        // An outage hides stale rows instead of presenting yesterday's jobs as current.
        if (!stopped) setJobs([]);
      } finally {
        clearTimeout(timeout);
        pending = false;
      }
    };
    void load();
    const timer = window.setInterval(() => { tick(value => value + 1); void load(); }, TICKER_REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === "visible") { tick(value => value + 1); void load(); } };
    document.addEventListener("visibilitychange", onVisible);
    return () => { stopped = true; controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  if (jobs.length < 5) return null;
  return <div className="ls-track">{[false, true].map(duplicate =>
    <div className="ls-set" key={String(duplicate)} aria-hidden={duplicate || undefined}>
      {jobs.map((job, index) => <a className="ls-card" href="/jobs" key={`${job.company}-${job.title}-${index}`} tabIndex={duplicate ? -1 : undefined}>
        <Logo job={job} />
        <span className="ls-txt"><span className="ls-meta"><b>{job.company}</b> · {formatRelativeTime(job.posted_at)}</span><span className="ls-title">{job.title}</span></span>
      </a>)}
    </div>
  )}</div>;
}
