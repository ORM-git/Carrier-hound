import * as Sentry from "@sentry/nextjs";

/**
 * Checks whether server/edge distributed tracing is enabled via environment flag.
 * Default: false (OFF).
 *
 * NOTE: Evaluated from process.env only. Runtime dynamic resolution via Cloudflare
 * getRequestContext().env is unverified.
 */
export function isServerTracingEnabled(): boolean {
  return process.env.ENABLE_SERVER_TRACING === "true";
}

export interface RouteSpanOptions {
  op?: string;
  attributes?: Record<string, string | number | boolean | undefined>;
}

export interface TracingSdk {
  continueTrace?: (
    context: Parameters<typeof Sentry.continueTrace>[0],
    callback: () => any
  ) => any;
  startSpan?: (
    context: Parameters<typeof Sentry.startSpan>[0],
    callback: (span?: any) => any
  ) => any;
}

let activeSdk: TracingSdk = Sentry;

/**
 * For testing only: overrides the underlying tracing SDK seam.
 */
export function setTracingSdkForTesting(mockSdk?: TracingSdk | null): void {
  activeSdk = mockSdk || Sentry;
}

type HandlerOutcome<T> =
  | { kind: "success"; value: T }
  | { kind: "error"; error: unknown };

/**
 * Wraps an Edge API route handler in a manual Sentry trace span.
 *
 * Truly fail-open:
 * - When ENABLE_SERVER_TRACING is not "true" (default OFF), it directly invokes fn().
 * - When enabled, it captures the handler's outcome (result or error) exactly once.
 * - All telemetry work (continueTrace, startSpan, setAttributes, setStatus, span finalization)
 *   is strictly isolated in try/catch blocks.
 * - Always returns the original handler response or throws the original business error,
 *   even if the SDK fails before, during, or after the callback.
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

  let outcome: HandlerOutcome<T> | undefined;

  const invokeHandlerOnce = async (): Promise<T> => {
    if (outcome) {
      if (outcome.kind === "success") return outcome.value;
      throw outcome.error;
    }
    try {
      const res = await fn();
      outcome = { kind: "success", value: res };
      return res;
    } catch (err) {
      outcome = { kind: "error", error: err };
      throw err;
    }
  };

  try {
    const method = req?.method || "GET";
    const spanName = `${method} ${route}`;
    const op = options.op || "http.server";

    const sentryTrace = req?.headers?.get?.("sentry-trace") || undefined;
    const baggage = req?.headers?.get?.("baggage") || undefined;
    const requestId = req?.headers?.get?.("x-request-id") || undefined;

    const continueFn = (cb: () => Promise<void>): Promise<void> => {
      try {
        if (sentryTrace && typeof activeSdk.continueTrace === "function") {
          return activeSdk.continueTrace({ sentryTrace, baggage }, cb);
        }
      } catch {
        // Any failure in continueTrace setup is swallowed
      }
      return cb();
    };

    await continueFn(async () => {
      if (typeof activeSdk.startSpan !== "function") {
        await invokeHandlerOnce().catch(() => {});
        return;
      }

      try {
        await activeSdk.startSpan(
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
            let res: T;
            try {
              res = await invokeHandlerOnce();
            } catch (businessErr) {
              try {
                if (span && typeof (span as any).setStatus === "function") {
                  (span as any).setStatus({ code: 2, message: "internal_error" });
                }
              } catch {
                // Isolate setStatus failure
              }
              throw businessErr;
            }

            try {
              if (span && res && typeof (res as any).status === "number") {
                if (typeof (span as any).setAttributes === "function") {
                  (span as any).setAttributes({
                    "http.status_code": (res as any).status,
                  });
                } else if (typeof (span as any).setAttribute === "function") {
                  (span as any).setAttribute("http.status_code", (res as any).status);
                }
              }
            } catch {
              // Isolate setAttributes failure
            }

            return res;
          }
        );
      } catch {
        // Isolate startSpan finalization / callback rethrows
      }
    });
  } catch {
    // Isolate overall telemetry setup failure
  }

  // Ensure fn was invoked at least once (e.g. if SDK threw before callback)
  if (!outcome) {
    return await invokeHandlerOnce();
  }

  if (outcome.kind === "success") {
    return outcome.value;
  }
  throw outcome.error;
}
