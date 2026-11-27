"use client";

import React, { useCallback, useEffect, useState } from "react";

export interface CompanyLogoProps {
  company: string;
  applyUrl?: string;
  sourceUrl?: string;
  logoUrl?: string | null;
  /** Stored companies.logo_url; tried before the job-level logoUrl. */
  companyLogoUrl?: string | null;
  /** Company website domain from companies.domain */
  domain?: string | null;
  className?: string;
  /** Locked (free/guest) job: render a neutral silhouette built only from constants, so no company
   * name, initial, logo URL or alt text reaches the DOM or the network. */
  locked?: boolean;
  /** Locked tiles only: an opaque job id that picks one of the fixed masked gradients so a feed is not one flat
   * colour. Never pass company-derived text. Without it the tile uses the first gradient. */
  maskSeed?: string | number | null;
  /** Opt-in approved palette for job-list tiles only; other surfaces keep their palette. */
  maskedPalette?: "default" | "job-list-preview";
  /** Called when no logo candidate is left to show (none supplied, or every one failed to load). */
  onUnresolved?: () => void;
}

// Masked-company tile palette. Constants only: the pick depends on the opaque job id, never on the hidden employer.
export const MASKED_TILE_GRADIENTS = [
  "from-blue-600 to-indigo-700",
  "from-violet-500 to-fuchsia-500",
  "from-teal-500 to-cyan-600",
  "from-indigo-500 to-purple-600",
  "from-sky-500 to-blue-700",
  "from-emerald-500 to-teal-600",
];

// Exact .t1 through .t8 backgrounds from the approved company preview. No fog/letters added.
export const JOB_LIST_MASKED_GRADIENTS = ["linear-gradient(160deg,#8ec5fc,#4a7de0)", "linear-gradient(160deg,#f6d365,#e0653a)", "linear-gradient(160deg,#a8e063,#3f9d4f)", "linear-gradient(160deg,#fbc2eb,#a64ac9)", "linear-gradient(160deg,#89f7fe,#3a8fd9)", "linear-gradient(160deg,#fda085,#d4456f)", "linear-gradient(160deg,#cfd9ff,#5d6ee0)", "linear-gradient(160deg,#ffe29f,#e08a2e)"] as const;

export function maskedTileIndex(seed: string | number | null | undefined, count = MASKED_TILE_GRADIENTS.length): number {
  const text = seed === null || seed === undefined ? "" : String(seed);
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % count;
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
  // Aggregator platforms: an apply/source URL on one of these is never the employer's site,
  // so it must never become the fallback logo domain (would render the platform's own brand mark).
  "linkedin.com",
  "indeed.com",
  "naukri.com",
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

// Logo URLs that failed (error, CSP block, cached failure or zero-size load) -> when. A failed URL stays on the
// next candidate / letter tile, including on remount, until the TTL passes; then one remount may retry it, so a
// transient network failure is not a page-lifetime trap and a broken URL is retried at most once per TTL.
export const FAILED_LOGO_TTL_MS = 10 * 60 * 1000;
const failedLogoSrcs = new Map<string, number>();
const hasFailed = (u: string) => {
  const at = failedLogoSrcs.get(u);
  if (at === undefined) return false;
  if (Date.now() - at < FAILED_LOGO_TTL_MS) return true;
  failedLogoSrcs.delete(u);
  return false;
};

export default function CompanyLogo({
  company,
  applyUrl,
  sourceUrl,
  logoUrl,
  companyLogoUrl,
  domain: companyDomain,
  className = "w-10 h-10",
  locked = false,
  maskSeed = null,
  maskedPalette = "default",
  onUnresolved,
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

  // Order: stored company logo (resolver-validated, self-hosted, same for every job of the employer and what the
  // detail page shows) -> job-level logo_url (ingest-supplied, may be a CSP-blocked host) -> domain logo (unavatar)
  // -> letter tile. The first candidate that has not failed is shown; no reset effect, so a failure can never be
  // raced back to a broken image.
  const candidates = [companyLogoUrl, logoUrl, unavatarUrl].filter((u): u is string => Boolean(u));
  const [, bumpFailures] = useState(0);
  const src = candidates.find((u) => !hasFailed(u)) ?? null;
  // Always re-render this instance: another instance may already have recorded the same URL as failed.
  const markFailed = useCallback((u: string) => {
    failedLogoSrcs.set(u, Date.now());
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

  const unresolved = !locked && !src;
  useEffect(() => {
    if (unresolved) onUnresolved?.();
  }, [unresolved, onUnresolved]);

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

  if (locked) {
    return (
      <div
        data-testid="company-logo-locked"
        aria-hidden="true"
        style={maskedPalette === "job-list-preview" ? { backgroundImage: JOB_LIST_MASKED_GRADIENTS[maskedTileIndex(maskSeed, JOB_LIST_MASKED_GRADIENTS.length)] } : undefined}
        className={`rounded-xl bg-gradient-to-br ${MASKED_TILE_GRADIENTS[maskedTileIndex(maskSeed)]} shrink-0 select-none ${className}`}
      />
    );
  }

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
