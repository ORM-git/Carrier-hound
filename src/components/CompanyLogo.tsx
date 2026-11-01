"use client";

import React, { useState, useEffect } from "react";

export interface CompanyLogoProps {
  company: string;
  applyUrl?: string;
  sourceUrl?: string;
  logoUrl?: string | null;
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

export default function CompanyLogo({
  company,
  applyUrl,
  sourceUrl,
  logoUrl,
  className = "w-10 h-10",
}: CompanyLogoProps) {
  const cleanCompany = (company || "").trim();
  const initial = cleanCompany ? cleanCompany.charAt(0).toUpperCase() : "?";

  // Derive domain strictly from a real apply or source URL that is not an ATS host
  // ZERO name-slug guessing
  const domain = extractDomainFromUrl(applyUrl) || extractDomainFromUrl(sourceUrl);
  const unavatarUrl = domain ? `https://unavatar.io/${domain}?fallback=false` : null;

  // Stages: self-hosted (companies.logo_url) -> unavatar.io -> fallback (letter tile)
  const initialStage: "self-hosted" | "unavatar" | "fallback" = logoUrl
    ? "self-hosted"
    : unavatarUrl
    ? "unavatar"
    : "fallback";

  const [imgStage, setImgStage] = useState<"self-hosted" | "unavatar" | "fallback">(initialStage);

  useEffect(() => {
    setImgStage(logoUrl ? "self-hosted" : unavatarUrl ? "unavatar" : "fallback");
  }, [logoUrl, unavatarUrl]);

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

  if (imgStage === "fallback" || (!logoUrl && !domain)) {
    return (
      <div
        className={`rounded-xl bg-gradient-to-br ${gradient} text-white font-black flex items-center justify-center shrink-0 shadow-2xs select-none border border-white/20 ${className}`}
      >
        <span className="text-xs sm:text-xl font-bold leading-none">{initial}</span>
      </div>
    );
  }

  const src = imgStage === "self-hosted" && logoUrl ? logoUrl : unavatarUrl!;

  return (
    <div
      className={`rounded-xl overflow-hidden bg-white border border-slate-200/90 p-1 flex items-center justify-center shrink-0 shadow-2xs ${className}`}
    >
      <img
        src={src}
        alt={`${cleanCompany} logo`}
        className="w-full h-full object-contain rounded-lg"
        loading="lazy"
        onError={() => {
          if (imgStage === "self-hosted") {
            setImgStage(unavatarUrl ? "unavatar" : "fallback");
          } else {
            setImgStage("fallback");
          }
        }}
      />
    </div>
  );
}
