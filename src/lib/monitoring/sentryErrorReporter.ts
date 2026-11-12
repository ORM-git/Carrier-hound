import * as Sentry from "@sentry/nextjs";
import { readCookieConsent } from "@/lib/analytics/cookieConsent";

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

  // 2. Cookie Consent Check: gated behind the shared versioned consent reader
  if (typeof window !== "undefined" && !readCookieConsent()) {
    return false;
  }

  return true;
}

/** Same well-formedness rule as the middleware request-id assignment. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface ReportErrorOptions {
  /** Correlates the Sentry event with the request that produced it. */
  requestId?: string;
}

/**
 * Dispatches the error to Sentry only if consent and DSN logic permit.
 * Never throws, ensuring error boundary fallbacks render reliably.
 * When a well-formed request id is provided the event is tagged with it
 * (`request_id`), so Sentry issues join up with edge logs that carry the
 * same x-request-id.
 */
export function reportErrorToSentry(error: unknown, options?: ReportErrorOptions): void {
  if (!shouldReportToSentry()) {
    return;
  }

  const requestId =
    options?.requestId && REQUEST_ID_PATTERN.test(options.requestId)
      ? options.requestId
      : undefined;

  try {
    const mock = typeof globalThis !== "undefined" ? (globalThis as any).__mockSentry : null;
    if (mock && typeof mock.captureException === "function") {
      mock.captureException(error, requestId ? { requestId } : undefined);
      return;
    }

    if (typeof Sentry?.captureException === "function") {
      if (requestId && typeof Sentry?.withScope === "function") {
        Sentry.withScope((scope) => {
          scope.setTag("request_id", requestId);
          Sentry.captureException(error);
        });
        return;
      }
      Sentry.captureException(error);
    }
  } catch {
    // Safe no-op on any monitoring dispatch failure
  }
}

/**
 * Server-side convenience: reports an error thrown while handling a request,
 * tagging it with the middleware-assigned x-request-id when present. The
 * request id never comes from the error itself and is pattern-validated
 * before tagging.
 */
export function reportRequestErrorToSentry(request: Request, error: unknown): void {
  try {
    const requestId =
      request?.headers && typeof request.headers.get === "function"
        ? request.headers.get("x-request-id") ?? undefined
        : undefined;
    reportErrorToSentry(error, { requestId });
  } catch {
    // Safe no-op
  }
}
