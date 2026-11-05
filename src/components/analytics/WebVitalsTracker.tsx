"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useReportWebVitals } from "next/web-vitals";
import { COOKIE_CONSENT_KEY, COOKIE_CONSENT_EVENT } from "@/components/CookieNotice";

/**
 * Supported Core Web Vitals and key page performance metrics.
 */
export const TRACKED_METRICS = new Set(["LCP", "INP", "CLS", "TTFB", "FCP"]);

export interface WebVitalsPayload {
  eventType: "web-vitals";
  path: string;
  metric: {
    id: string;
    name: string;
    value: number;
    rating: string;
    navigationType: string;
  };
}

/**
 * Sanitizes a route path for web vitals analytics:
 * - Strips all query parameters (?...) and hash fragments (#...)
 * - Normalizes empty or missing paths to "/"
 * - Replaces dynamic IDs (UUIDs, numeric IDs, hex hashes, job IDs) with "[id]"
 * - Ensures strictly no PII or unique entity IDs are transmitted
 */
export function sanitizeWebVitalsPath(rawPath: string | null | undefined): string {
  if (!rawPath || typeof rawPath !== "string") return "/";

  // Strip query string and hash fragments
  let clean = rawPath.split("?")[0].split("#")[0].trim();
  if (!clean.startsWith("/")) clean = "/" + clean;

  const segments = clean.split("/").filter(Boolean);
  if (segments.length === 0) return "/";

  const sanitizedSegments = segments.map((seg, idx) => {
    // Under /jobs/<id> (unless subpage is 'detail')
    if (idx === 1 && segments[0] === "jobs" && seg !== "detail") {
      return "[id]";
    }
    // Standard UUID
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(seg)) {
      return "[id]";
    }
    // Numeric ID (e.g. 12345)
    if (/^\d+$/.test(seg)) {
      return "[id]";
    }
    // Hex ID / ObjectId / Hash (16+ hex characters)
    if (/^[0-9a-fA-F]{16,}$/.test(seg)) {
      return "[id]";
    }
    // Prefixed entity IDs: job_123, usr_abc, etc.
    if (/^(job|usr|user|item|sub|ord|cm|app)[-_][0-9a-zA-Z]+$/i.test(seg)) {
      return "[id]";
    }
    return seg;
  });

  return "/" + sanitizedSegments.join("/");
}

/**
 * Returns whether user cookie consent has been granted.
 */
export function hasCookieConsent(): boolean {
  try {
    if (typeof localStorage !== "undefined") {
      return Boolean(localStorage.getItem(COOKIE_CONSENT_KEY));
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Dispatches the web vitals payload via sendBeacon with fetch keepalive fallback.
 * Strictly first-party, non-blocking, fail-safe.
 */
export function sendWebVitalsPayload(payload: WebVitalsPayload): boolean {
  try {
    const bodyString = JSON.stringify(payload);

    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = typeof Blob !== "undefined" ? new Blob([bodyString], { type: "application/json" }) : bodyString;
      if (navigator.sendBeacon("/api/track", blob as any)) {
        return true;
      }
    }

    if (typeof fetch !== "undefined") {
      fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyString,
        keepalive: true,
      }).catch(() => {});
      return true;
    }
  } catch {
    // Fail silently
  }
  return false;
}

/**
 * Real-user Core Web Vitals (CWV) client component.
 * Mounted in root layout, captures LCP, INP, CLS, TTFB, and FCP.
 * Strictly consent-gated, 100% first-party, zero PII, zero query strings.
 */
export default function WebVitalsTracker() {
  const pathname = usePathname();
  const pathnameRef = useRef<string | null>(pathname);
  const pendingQueue = useRef<WebVitalsPayload[]>([]);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  // Listen for consent grant to flush any metrics captured before consent
  useEffect(() => {
    const onConsentUpdated = () => {
      if (!hasCookieConsent()) return;
      if (pendingQueue.current.length > 0) {
        const queue = [...pendingQueue.current];
        pendingQueue.current = [];
        for (const item of queue) {
          sendWebVitalsPayload(item);
        }
      }
    };

    if (typeof window !== "undefined") {
      // Flush if consent is already active on mount
      if (hasCookieConsent() && pendingQueue.current.length > 0) {
        onConsentUpdated();
      }
      window.addEventListener(COOKIE_CONSENT_EVENT, onConsentUpdated);
    }

    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener(COOKIE_CONSENT_EVENT, onConsentUpdated);
      }
    };
  }, []);

  useReportWebVitals((metric) => {
    try {
      if (!metric || !TRACKED_METRICS.has(metric.name)) return;

      const currentPath =
        pathnameRef.current || (typeof window !== "undefined" ? window.location.pathname : "/");
      const sanitizedPath = sanitizeWebVitalsPath(currentPath);

      const payload: WebVitalsPayload = {
        eventType: "web-vitals",
        path: sanitizedPath,
        metric: {
          id: metric.id || `wv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: metric.name,
          value: typeof metric.value === "number" ? Math.round(metric.value * 100) / 100 : 0,
          rating: (metric as any).rating || "good",
          navigationType: (metric as any).navigationType || "navigate",
        },
      };

      // Strictly gate dispatch behind cookie consent: no events before consent
      if (!hasCookieConsent()) {
        if (pendingQueue.current.length < 25) {
          pendingQueue.current.push(payload);
        }
        return;
      }

      sendWebVitalsPayload(payload);
    } catch {
      // Fail silently
    }
  });

  return null;
}
