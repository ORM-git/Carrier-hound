"use client";

import React, { useCallback, useState } from "react";

export interface CompanyLogoProps {
  company: string;
  applyUrl?: string;
  sourceUrl?: string;
  logoUrl?: string | null;
  /** Company website domain from companies.domain */
  domain?: string | null;
  className?: string;
}

const ATS_HOSTS = [
  "greenhouse.io",
  "ashbyhq.com",
  "lever.co",
  "workable.com",
  "smartrecruiters.com",
  "recruitee.com",
  "jobvite.com",
  "bamboohr.com",
  "rippling.com",
  "icims.com",
  "myworkdayjobs.com",
  "workday.com",
  "taleo.net",
  "successfactors.com",
  "breezy.hr",
  "applytojob.com",
  "pinpointhq.com",
  "careermonke.com",
  "netlify.app",
  "netlify.com",
  "localhost",
];

export function extractDomainFromUrl(urlStr?: string): string {
  if (!urlStr) return "";
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!hostname || hostname.length < 3 || !hostname.includes(".")) return "";

    const isAts = ATS_HOSTS.some(
      (ats) => hostname === ats || hostname.endsWith(`.${ats}`)
    );
    if (isAts) return "";

    return hostname;
  } catch {
    return "";
  }
}

// Logo URLs that failed this session (error, CSP block, cached failure or zero-size load). Kept for the
// page lifetime so a failed stored logo stays on the next candidate / letter tile, including on remount.
const failedLogoSrcs = new Set<string>();

export default function CompanyLogo({
  company,
  applyUrl,
  sourceUrl,
  logoUrl,
  domain: companyDomain,
  className = "w-10 h-10",
}: CompanyLogoProps) {
  const cleanCompany = (company || "").trim();
  const initial = cleanCompany ? cleanCompany.charAt(0).toUpperCase() : "?";

  // Domain: stored companies.domain first, then a non-ATS apply/source URL
  // ZERO name-slug guessing
  const domain =
    (companyDomain ? extractDomainFromUrl(`https://${companyDomain.trim()}`) : "") ||
    extractDomainFromUrl(applyUrl) ||
    extractDomainFromUrl(sourceUrl);
  const unavatarUrl = domain ? `https://unavatar.io/${domain}?fallback=false` : null;

  // Order: stored logo_url -> domain logo (unavatar) -> letter tile. The first candidate that has not
  // failed is shown; no reset effect, so a failure can never be raced back to a broken image.
  const candidates = [logoUrl, unavatarUrl].filter((u): u is string => Boolean(u));
  const [, bumpFailures] = useState(0);
  const src = candidates.find((u) => !failedLogoSrcs.has(u)) ?? null;
  const markFailed = useCallback((u: string) => {
    if (failedLogoSrcs.has(u)) return;
    failedLogoSrcs.add(u);
    bumpFailures((n) => n + 1);
  }, []);
  // Catches failures that happened before React attached onError (CSP block, cached failure).
  // shortcut: an SVG without intrinsic size also reports naturalWidth 0; resolver stores raster only.
  const checkImage = useCallback(
    (img: HTMLImageElement | null) => {
      if (img && img.complete && img.naturalWidth === 0 && src) markFailed(src);
    },
    [markFailed, src]
  );

  // Deterministic gradient for fallback
  const gradients = [
    "from-blue-600 to-indigo-600",
    "from-indigo-600 to-purple-600",
    "from-sky-600 to-cyan-600",
    "from-violet-600 to-pink-600",
    "from-blue-700 to-teal-600",
  ];
  const charCode = (cleanCompany.charCodeAt(0) || 0) + (cleanCompany.charCodeAt(1) || 0);
  const gradient = gradients[charCode % gradients.length];

  if (!src) {
    return (
      <div
        className={`rounded-xl bg-gradient-to-br ${gradient} text-white font-black flex items-center justify-center shrink-0 shadow-2xs select-none border border-white/20 ${className}`}
      >
        <span className="text-xs sm:text-xl font-bold leading-none">{initial}</span>
      </div>
    );
  }

  return (
    <div
      className={`rounded-xl overflow-hidden bg-white border border-slate-200/90 p-1 flex items-center justify-center shrink-0 shadow-2xs ${className}`}
    >
      <img
        key={src}
        ref={checkImage}
        src={src}
        alt={`${cleanCompany} logo`}
        className="w-full h-full object-contain rounded-lg"
        loading="lazy"
        onError={() => markFailed(src)}
        onLoad={(e) => {
          if (e.currentTarget.naturalWidth === 0) markFailed(src);
        }}
      />
    </div>
  );
}
