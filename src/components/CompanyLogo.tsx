"use client";

import React, { useState, useEffect } from "react";

export interface CompanyLogoProps {
  company: string;
  applyUrl?: string;
  logoUrl?: string | null;
  className?: string;
}

export default function CompanyLogo({
  company,
  applyUrl,
  logoUrl,
  className = "w-10 h-10",
}: CompanyLogoProps) {
  const cleanCompany = (company || "").trim();
  const initial = cleanCompany ? cleanCompany.charAt(0).toUpperCase() : "?";

  // Derive domain from applyUrl or company name
  let domain = "";
  if (applyUrl) {
    try {
      const u = new URL(applyUrl);
      const host = u.hostname.toLowerCase();
      if (host.includes("ashbyhq.com") || host.includes("greenhouse.io") || host.includes("lever.co")) {
        const parts = u.pathname.split("/").filter(Boolean);
        if (parts[0]) {
          domain = `${parts[0].toLowerCase().replace(/[^a-z0-9]/g, "")}.com`;
        }
      } else if (!host.includes("careermonke") && !host.includes("netlify")) {
        domain = host.replace(/^www\./, "");
      }
    } catch {}
  }

  if (!domain && cleanCompany) {
    const slug = cleanCompany
      .toLowerCase()
      .replace(/\b(inc|llc|corp|corporation|technologies|technology|tech|ltd|co|group|holdings|labs)\b/gi, "")
      .trim()
      .replace(/[^a-z0-9]/g, "");
    if (slug) {
      domain = `${slug}.com`;
    }
  }

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
