"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { COOKIE_CONSENT_EVENT } from "@/components/CookieNotice";
import { readCookieConsent } from "@/lib/analytics/cookieConsent";
import { captureAttribution } from "@/lib/analytics/utm";

/**
 * Lightweight, non-blocking, fire-and-forget page view tracker.
 * Gated strictly behind user consent (cm_cookie_notice).
 * Zero external libraries, zero layout shift, fail-safe.
 */
export default function PageViewTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const lastTracked = useRef<string>("");

  useEffect(() => {
    if (!pathname) return;
    if (pathname.startsWith("/_next") || pathname.startsWith("/api/")) return;

    const queryString = searchParams?.toString();
    const fullPath = queryString ? `${pathname}?${queryString}` : pathname;

    if (lastTracked.current === fullPath) return;
    lastTracked.current = fullPath;

    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("careermonke_route_changed"));
    }

    const track = () => {
      try {
        if (typeof window !== "undefined") {
          if (!readCookieConsent()) {
            // Strictly gate pageview analytics behind user consent
            return;
          }
          // First-touch UTM / referrer capture (sessionStorage only, nothing
          // leaves the device; consumed by future attribution-aware payloads).
          captureAttribution(pathname);
        }

        let userId: string | null = null;

        if (typeof window !== "undefined") {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith("sb-") && key.includes("-auth-token")) {
              try {
                const parsed = JSON.parse(localStorage.getItem(key) || "{}");
                if (parsed?.user?.id) {
                  userId = parsed.user.id;
                  break;
                }
              } catch (_) {}
            }
          }
        }

        const payload = {
          path: fullPath,
          referrer: typeof document !== "undefined" ? document.referrer : null,
          userId,
        };

        const bodyString = JSON.stringify(payload);

        if (typeof navigator !== "undefined" && navigator.sendBeacon) {
          const blob = new Blob([bodyString], { type: "application/json" });
          if (navigator.sendBeacon("/api/track", blob)) return;
        }

        fetch("/api/track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyString,
          keepalive: true,
        }).catch(() => {});
      } catch (_) {
        // Fail silently
      }
    };

    if (typeof window !== "undefined") {
      if ("requestIdleCallback" in window) {
        (window as any).requestIdleCallback(track, { timeout: 1500 });
      } else {
        setTimeout(track, 100);
      }
    }

    // Listen for consent granted event to track immediately once acknowledged
    const onConsentGranted = () => {
      track();
    };

    if (typeof window !== "undefined") {
      window.addEventListener(COOKIE_CONSENT_EVENT, onConsentGranted);
    }

    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener(COOKIE_CONSENT_EVENT, onConsentGranted);
      }
    };
  }, [pathname, searchParams]);

  return null;
}
