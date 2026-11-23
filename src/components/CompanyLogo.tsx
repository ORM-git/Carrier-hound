"use client";

import React, { useCallback, useState } from "react";
import { eligibleLogoUrl } from "@/lib/companies/logoEligibility";
import { LOGO_SAMPLE_PX, logoVisibility } from "@/lib/companies/logoVisibility";

export interface CompanyLogoProps {
  company: string;
  applyUrl?: string;
  sourceUrl?: string;
  /** Rendered only when it is an eligible hosted company-logos URL (see logoEligibility.ts). */
  logoUrl?: string | null;
  /** Verified company domain (kept for callers; never used to fetch third-party images). */
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

// Logo URLs that failed this session (error, CSP block, cached failure, zero-size or unreadable load). Kept for
// the page lifetime so a failed URL stays on initials on remount; a repaired logo has a new content-hashed URL,
// so an old failure never blocks the next version.
const failedLogoSrcs = new Set<string>();
// URLs already measured readable this session: remounts (ticker copies, list re-renders) skip the pixel check.
const readableLogoSrcs = new Set<string>();

const LETTER_OR_DIGIT = new RegExp("[\\p{L}\\p{N}]", "u"); // constructor: the app targets ES5 for regex literals
/** First letter or digit of the company name, upper-cased; "?" when there is none. Deterministic. */
export function companyInitial(company: string | null | undefined): string {
  return (company || "").match(LETTER_OR_DIGIT)?.[0]?.toUpperCase() ?? "?";
}

/**
 * True unless the loaded image is measurably unreadable on our light tiles (transparent, all-white, faint).
 * Uses the same rule as the repair worker (logoVisibility.ts). If pixels can't be read (no canvas), the
 * worker's pre-upload check stands.
 */
function readableOnTile(img: HTMLImageElement): boolean {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = LOGO_SAMPLE_PX;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return true;
    const k = Math.min(LOGO_SAMPLE_PX / img.naturalWidth, LOGO_SAMPLE_PX / img.naturalHeight);
    const w = img.naturalWidth * k, h = img.naturalHeight * k;
    ctx.drawImage(img, (LOGO_SAMPLE_PX - w) / 2, (LOGO_SAMPLE_PX - h) / 2, w, h);
    return logoVisibility(ctx.getImageData(0, 0, LOGO_SAMPLE_PX, LOGO_SAMPLE_PX).data, LOGO_SAMPLE_PX, LOGO_SAMPLE_PX).ok;
  } catch {
    return true;
  }
}

/**
 * Shared display contract for every company avatar (cards, detail, Radar, landing ticker): render the
 * initials first and keep them until an eligible hosted logo has loaded with a real size and measured
 * readable. `imgProps` is null when there is nothing to load; `shown` is true once the logo may replace
 * the initials.
 */
export function useVerifiedLogo(logoUrl: string | null | undefined) {
  const hosted = eligibleLogoUrl(logoUrl);
  const [, bump] = useState(0);
  const [readySrc, setReadySrc] = useState<string | null>(null);
  const src = hosted && !failedLogoSrcs.has(hosted) ? hosted : null;
  // Always re-render this instance: another instance may already have recorded the same URL as failed.
  const fail = useCallback((u: string) => {
    failedLogoSrcs.add(u);
    bump((n) => n + 1);
  }, []);
  const settle = useCallback(
    (img: HTMLImageElement) => {
      if (!src) return;
      if (img.naturalWidth === 0 || img.naturalHeight === 0) return fail(src);
      if (!readableLogoSrcs.has(src) && !readableOnTile(img)) return fail(src);
      readableLogoSrcs.add(src);
      setReadySrc(src);
    },
    [fail, src]
  );
  // Catches loads/failures that finished before React attached its handlers (static HTML, CSP block, cache).
  const ref = useCallback((img: HTMLImageElement | null) => {
    if (img && img.complete) settle(img);
  }, [settle]);
  const imgProps = src
    ? {
        src,
        ref,
        // anonymous CORS so the pixel check can read the hosted bytes (Supabase public objects allow it);
        // if CORS ever fails the load errors and initials stay, never an empty tile.
        crossOrigin: "anonymous" as const,
        onError: () => fail(src),
        onLoad: (e: React.SyntheticEvent<HTMLImageElement>) => settle(e.currentTarget),
      }
    : null;
  return { imgProps, shown: src !== null && readySrc === src };
}

export default function CompanyLogo({
  company,
  logoUrl,
  className = "w-10 h-10",
}: CompanyLogoProps) {
  const cleanCompany = (company || "").trim();
  const initial = companyInitial(cleanCompany);

  // Company-logo contract: only an eligible hosted logo is ever rendered; otherwise the stable initials
  // tile. No client-side favicon/unavatar/ATS fallbacks, so a card can never show a broken or vendor image.
  const { imgProps, shown } = useVerifiedLogo(logoUrl);

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

  // One box for every state (same classes, same size): the initials layer covers it until the logo is ready.
  return (
    <div
      className={`relative rounded-xl overflow-hidden bg-slate-50 border border-slate-200/90 p-1 flex items-center justify-center shrink-0 shadow-2xs ${className}`}
    >
      {imgProps && (
        <img
          key={imgProps.src}
          {...imgProps}
          alt={`${cleanCompany} logo`}
          className={`w-full h-full object-contain rounded-lg ${shown ? "" : "opacity-0"}`}
          loading="lazy"
        />
      )}
      {!shown && (
        <div
          aria-hidden={imgProps ? true : undefined}
          className={`absolute inset-0 bg-gradient-to-br ${gradient} text-white flex items-center justify-center select-none`}
          style={{ containerType: "size" }}
        >
          {/* Scales with the tile (24px detail chip .. 72px card), so initials are never clipped. */}
          <span className="font-bold leading-none" style={{ fontSize: "min(45cqmin, 1.25rem)" }}>
            {initial}
          </span>
        </div>
      )}
    </div>
  );
}
