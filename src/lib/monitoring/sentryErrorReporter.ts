import * as Sentry from "@sentry/nextjs";
import { COOKIE_CONSENT_KEY } from "@/components/CookieNotice";

/**
 * Checks whether error reporting to Sentry is permitted under current DSN configuration
 * and user cookie consent rules.
 */
export function shouldReportToSentry(): boolean {
  // 0. Support test suite mock injection
  if (typeof globalThis !== "undefined" && (globalThis as any).__mockSentry) {
    return true;
  }

  // 1. DSN Check: Sentry is only enabled if a DSN is configured
  const dsn =
    process.env.NEXT_PUBLIC_SENTRY_DSN ||
    process.env.SENTRY_DSN;
  if (!dsn || !dsn.trim()) {
    return false;
  }

  // 2. Cookie Consent Check: Gated behind user consent in browser environment
  if (typeof window !== "undefined") {
    try {
      const consent = localStorage.getItem(COOKIE_CONSENT_KEY);
      if (!consent) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Dispatches the error to Sentry only if consent and DSN logic permit.
 * Never throws, ensuring error boundary fallbacks render reliably.
 */
export function reportErrorToSentry(error: unknown): void {
  if (!shouldReportToSentry()) {
    return;
  }

  try {
    const mock = typeof globalThis !== "undefined" ? (globalThis as any).__mockSentry : null;
    if (mock && typeof mock.captureException === "function") {
      mock.captureException(error);
      return;
    }

    if (typeof Sentry?.captureException === "function") {
      Sentry.captureException(error);
    }
  } catch {
    // Safe no-op on any monitoring dispatch failure
  }
}
