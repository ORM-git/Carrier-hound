"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";

export const COOKIE_CONSENT_KEY = "cm_cookie_notice";
export const COOKIE_CONSENT_EVENT = "cm_cookie_consent_updated";

/**
 * Minimal fixed bottom cookie notice.
 * Uses the site's fonts and colors, small, dismissible, shown once.
 * Stored in localStorage key "cm_cookie_notice".
 * Zero layout shift, keyboard accessible, fully compliant with Lighthouse a11y.
 */
export default function CookieNotice() {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      const acknowledged = localStorage.getItem(COOKIE_CONSENT_KEY);
      if (!acknowledged) {
        setVisible(true);
      }
    } catch {
      // In case localStorage is disabled or throws
      setVisible(false);
    }
  }, []);

  const handleDismiss = () => {
    try {
      localStorage.setItem(COOKIE_CONSENT_KEY, "true");
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(COOKIE_CONSENT_EVENT));
      }
    } catch {}
    setVisible(false);
  };

  if (!mounted || !visible) {
    return null;
  }

  return (
    <div
      role="region"
      aria-label="Cookie and privacy notice"
      className="fixed bottom-0 inset-x-0 z-50 bg-white/95 border-t border-[#E4E4E7] shadow-lg backdrop-blur-md animate-fadeIn"
    >
      <div className="max-w-6xl mx-auto px-4 py-2.5 sm:py-3 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs sm:text-sm text-[#09090B]">
        <p className="leading-snug text-center sm:text-left text-[#4B5563]">
          We use only essential cookies for sign-in and anonymous error monitoring.{" "}
          <Link
            href="/privacy"
            className="text-[#2563EB] hover:text-[#1D4ED8] font-semibold underline underline-offset-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 rounded-sm"
          >
            Learn more
          </Link>
        </p>

        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Accept essential cookies and close notice"
          className="shrink-0 px-4 py-1.5 min-h-[36px] bg-[#2563EB] hover:bg-[#1D4ED8] active:scale-[0.98] text-white font-bold text-xs rounded-xl shadow-xs transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          OK
        </button>
      </div>
    </div>
  );
}
