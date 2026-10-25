"use client";

import React, { useState } from "react";

interface CompanyLogoProps {
  company: string;
  applyUrl?: string;
  className?: string;
}

export default function CompanyLogo({
  company,
  applyUrl,
  className = "w-10 h-10",
}: CompanyLogoProps) {
  const [imgStage, setImgStage] = useState<"primary" | "secondary" | "fallback">("primary");

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

  if (!domain || imgStage === "fallback") {
    return (
      <div
        className={`rounded-xl bg-gradient-to-br ${gradient} text-white font-black flex items-center justify-center shrink-0 shadow-2xs select-none border border-white/20 ${className}`}
      >
        <span className="text-xs sm:text-xl font-bold leading-none">{initial}</span>
      </div>
    );
  }

  const primaryUrl = `https://unavatar.io/${domain}?fallback=false`;
  const secondaryUrl = `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${domain}&size=128`;
  const src = imgStage === "primary" ? primaryUrl : secondaryUrl;

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
          if (imgStage === "primary") {
            setImgStage("secondary");
          } else {
            setImgStage("fallback");
          }
        }}
      />
    </div>
  );
}
