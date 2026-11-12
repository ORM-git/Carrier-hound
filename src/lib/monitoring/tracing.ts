import * as Sentry from "@sentry/nextjs";

/**
 * Checks whether server/edge distributed tracing is enabled via environment flag.
 * Default: false (OFF).
 */
export function isServerTracingEnabled(): boolean {
  return process.env.ENABLE_SERVER_TRACING === "true";
}

export interface RouteSpanOptions {
  op?: string;
  attributes?: Record<string, string | number | boolean | undefined>;
}

/**
 * Wraps an Edge API route handler in a manual Sentry trace span.
 *
 * Provably compatible with @cloudflare/next-on-pages:
 * - When ENABLE_SERVER_TRACING is not "true" (default OFF), it directly invokes fn()
 *   with zero Sentry calls, zero async overhead, and zero behavior change.
 * - When enabled, it extracts incoming `sentry-trace` and `baggage` headers to continue
 *   the distributed trace from the client, starts a root or child span with op "http.server",
 *   records the HTTP response status code, and re-throws errors to the existing route catch blocks.
 * - Completely fail-open: any unexpected error in span creation is swallowed, executing fn() directly.
 */
export async function withRouteSpan<T>(
  route: string,
  req: Request,
  fn: () => Promise<T>,
  options: RouteSpanOptions = {}
): Promise<T> {
  if (!isServerTracingEnabled()) {
    return await fn();
  }

  // Support offline test suite mock injection
  if (typeof globalThis !== "undefined" && (globalThis as any).__mockTracing) {
    const mock = (globalThis as any).__mockTracing;
    return await mock.withRouteSpan(route, req, fn, options);
  }

  let fnCalled = false;
  try {
    const method = req?.method || "GET";
    const spanName = `${method} ${route}`;
    const op = options.op || "http.server";

    const sentryTrace = req?.headers?.get?.("sentry-trace") || undefined;
    const baggage = req?.headers?.get?.("baggage") || undefined;
    const requestId = req?.headers?.get?.("x-request-id") || undefined;

    const continueFn = (cb: () => Promise<T>) => {
      if (sentryTrace && typeof Sentry.continueTrace === "function") {
        return Sentry.continueTrace({ sentryTrace, baggage }, cb);
      }
      return cb();
    };

    return await continueFn(async () => {
      if (typeof Sentry.startSpan !== "function") {
        fnCalled = true;
        return await fn();
      }

      return await Sentry.startSpan(
        {
          name: spanName,
          op,
          attributes: {
            "http.route": route,
            "http.method": method,
            ...(requestId ? { request_id: requestId } : {}),
            ...(options.attributes || {}),
          },
        },
        async (span) => {
          fnCalled = true;
          try {
            const result = await fn();
            if (span && result && typeof (result as any).status === "number") {
              if (typeof (span as any).setAttributes === "function") {
                (span as any).setAttributes({
                  "http.status_code": (result as any).status,
                });
              } else if (typeof (span as any).setAttribute === "function") {
                (span as any).setAttribute("http.status_code", (result as any).status);
              }
            }
            return result;
          } catch (err) {
            if (span && typeof (span as any).setStatus === "function") {
              (span as any).setStatus({ code: 2, message: "internal_error" });
            }
            throw err;
          }
        }
      );
    });
  } catch (err) {
    if (fnCalled) {
      throw err;
    }
    // If tracing setup itself throws before fn() ran, fail open and execute fn()
    return await fn();
  }
}
