"use client";

import { useEffect } from "react";
import { reportErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";

/**
 * Catches client errors that never reach a React error boundary - notably
 * hydration mismatches React recovers from or throws outside a boundary,
 * and unhandled promise rejections - and reports them through the same
 * consent-gated reporter the boundaries use. Errors caught by a boundary do
 * not propagate to window "error", so nothing is reported twice. A short
 * dedupe window prevents a broken page from flooding the reporter.
 * Renders nothing.
 */

const DEDUPE_WINDOW_MS = 10_000;
const recentFingerprints = new Map<string, number>();

function fingerprint(error: unknown): string {
  if (error instanceof Error) return `${error.name}:${error.message}`;
  return String(error);
}

function shouldSkipDuplicate(fp: string, now: number): boolean {
  const last = recentFingerprints.get(fp);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return true;
  recentFingerprints.set(fp, now);
  // Bound the map so a long-lived tab cannot grow it without limit.
  if (recentFingerprints.size > 100) {
    recentFingerprints.forEach((ts, key) => {
      if (now - ts >= DEDUPE_WINDOW_MS) recentFingerprints.delete(key);
    });
  }
  return false;
}

/** Exported for tests. */
export function reportClientError(error: unknown, now: number = Date.now()): void {
  if (shouldSkipDuplicate(fingerprint(error), now)) return;
  reportErrorToSentry(error);
}

export default function GlobalErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      reportClientError(event.error ?? event.message);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      reportClientError(event.reason ?? new Error("Unhandled promise rejection"));
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
