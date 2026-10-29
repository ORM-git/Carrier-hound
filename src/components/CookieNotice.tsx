"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export const COOKIE_CONSENT_KEY = "cm_cookie_notice";
export const COOKIE_CONSENT_EVENT = "cm_cookie_consent_updated";

/**
 * Custom hook to obtain the live rendered height of the CookieNotice banner.
 * Employs resize and custom event listeners to ensure layout offsets (bottom nav, mobile apply bar)
 * remain dynamically and precisely positioned without manual refresh or hardcoding.
 */
export function useCookieNoticeHeight(): number {
  const [height, setHeight] = useState<number>(0);

  useEffect(() => {
    const updateHeight = () => {
      try {
        const acknowledged = localStorage.getItem(COOKIE_CONSENT_KEY);
        if (acknowledged) {
          setHeight(0);
          if (typeof document !== "undefined") {
            document.documentElement.style.setProperty("--cm-cookie-notice-height", "0px");
          }
          return;
        }

        const el = document.getElementById("cm-cookie-notice");
        if (el) {
          const rect = el.getBoundingClientRect();
          const measured = Math.round(rect.height);
          setHeight(measured);
          document.documentElement.style.setProperty("--cm-cookie-notice-height", `${measured}px`);
        } else {
          setHeight(0);
          document.documentElement.style.setProperty("--cm-cookie-notice-height", "0px");
        }
      } catch {
        setHeight(0);
      }
    };

    updateHeight();

    window.addEventListener(COOKIE_CONSENT_EVENT, updateHeight);
    window.addEventListener("resize", updateHeight);

    const observer = new MutationObserver(updateHeight);
    if (typeof document !== "undefined" && document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }

    return () => {
      window.removeEventListener(COOKIE_CONSENT_EVENT, updateHeight);
      window.removeEventListener("resize", updateHeight);
      observer.disconnect();
    };
  }, []);

  return height;
}

/**
 * Minimal fixed bottom cookie notice.
 * Uses the site's fonts and colors, small, dismissible, shown once.
 * Stored in localStorage key "cm_cookie_notice".
 * Zero layout shift, keyboard accessible, fully compliant with Lighthouse a11y.
 */
export default function CookieNotice() {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
    try {
      const acknowledged = localStorage.getItem(COOKIE_CONSENT_KEY);
      if (!acknowledged) {
        setVisible(true);
      } else {
        if (typeof document !== "undefined") {
          document.documentElement.style.setProperty("--cm-cookie-notice-height", "0px");
        }
      }
    } catch {
      setVisible(false);
    }
  }, []);

  // Live measurement of actual banner height
  useEffect(() => {
    if (!visible || !noticeRef.current) {
      if (typeof document !== "undefined") {
        document.documentElement.style.setProperty("--cm-cookie-notice-height", "0px");
      }
      return;
    }

    const updateMeasuredHeight = () => {
      if (noticeRef.current) {
        const measured = Math.round(noticeRef.current.getBoundingClientRect().height);
        document.documentElement.style.setProperty("--cm-cookie-notice-height", `${measured}px`);
        window.dispatchEvent(
          new CustomEvent(COOKIE_CONSENT_EVENT, { detail: { height: measured, visible: true } })
        );
      }
    };

    updateMeasuredHeight();
    window.addEventListener("resize", updateMeasuredHeight);

    return () => {
      window.removeEventListener("resize", updateMeasuredHeight);
    };
  }, [visible]);

  const handleDismiss = () => {
    try {
      localStorage.setItem(COOKIE_CONSENT_KEY, "true");
      if (typeof document !== "undefined") {
        document.documentElement.style.setProperty("--cm-cookie-notice-height", "0px");
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent(COOKIE_CONSENT_EVENT, { detail: { height: 0, visible: false } })
        );
      }
    } catch {}
    setVisible(false);
  };

  if (!mounted || !visible) {
    return null;
  }

  return (
    <div
      ref={noticeRef}
      id="cm-cookie-notice"
      role="region"
      aria-label="Cookie and privacy notice"
      className="fixed bottom-0 inset-x-0 z-50 bg-white/95 border-t border-[#E4E4E7] shadow-lg backdrop-blur-md animate-fadeIn pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]"
    >
      <div className="max-w-6xl mx-auto px-4 py-2.5 sm:py-3 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs sm:text-sm text-[#09090B]">
        <p className="leading-snug text-center sm:text-left text-[#4B5563]">
          We use only essential cookies for sign-in and anonymous error monitoring.{" "}
          {pathname === "/" ? (
            <Link
              href="/early-access"
              className="text-[#2563EB] hover:text-[#1D4ED8] font-semibold underline underline-offset-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 rounded-sm"
            >
              Learn more
            </Link>
          ) : (
            <Link
              href="/privacy"
              className="text-[#2563EB] hover:text-[#1D4ED8] font-semibold underline underline-offset-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 rounded-sm"
            >
              Learn more
            </Link>
          )}
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
