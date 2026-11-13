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

let testSdkOverride: TracingSdk | null = null;

/**
 * For testing only: overrides the tracing SDK seam in explicit test environments.
 * Strictly throws in non-test environments to prevent module-global mutation in production.
 */
export function setTracingSdkForTesting(mockSdk?: TracingSdk | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "setTracingSdkForTesting is restricted to explicit test environments"
    );
  }
  testSdkOverride = mockSdk || null;
}

/**
 * Core route span execution engine.
 *
 * Truly fail-open:
 * - When ENABLE_SERVER_TRACING is not "true" (default OFF), it directly invokes fn().
 * - When enabled, it captures the handler promise immediately upon invocation,
 *   guaranteeing exactly-once execution even if the handler is in flight when the SDK
 *   crashes or throws synchronously.
 * - All telemetry operations (continueTrace, startSpan, setAttributes, setStatus)
 *   are isolated in try/catch blocks.
 * - Always returns the original handler response or rethrows the original business error,
 *   even if the SDK fails before, during, or after the callback.
 */
async function executeRouteSpan<T>(
  sdk: TracingSdk,
  route: string,
  req: Request,
  fn: () => Promise<T>,
  options: RouteSpanOptions = {}
): Promise<T> {
  if (!isServerTracingEnabled()) {
    return await fn();
  }

  // Memoize the handler PROMISE immediately before calling fn so that
  // in-flight executions cannot be re-triggered.
  let handlerPromise: Promise<T> | undefined;

  const invokeHandlerOnce = (): Promise<T> => {
    if (!handlerPromise) {
      handlerPromise = (async () => {
        return await fn();
      })();
      // Attach an inert rejection handler to prevent unhandledRejection events in Node.js
      // if telemetry throws or swallows the callback promise before it is awaited at the end.
      handlerPromise.catch(() => {});
    }
    return handlerPromise;
  };

  try {
    const method = req?.method || "GET";
    const spanName = `${method} ${route}`;
    const op = options.op || "http.server";

    const sentryTrace = req?.headers?.get?.("sentry-trace") || undefined;
    const baggage = req?.headers?.get?.("baggage") || undefined;
    const requestId = req?.headers?.get?.("x-request-id") || undefined;

    let cbCalled = false;
    const guardedCb = async (span?: any): Promise<void> => {
      if (cbCalled) return;
      cbCalled = true;

      let res: T;
      try {
        res = await invokeHandlerOnce();
      } catch (_businessErr) {
        try {
          if (span && typeof (span as any).setStatus === "function") {
            (span as any).setStatus({ code: 2, message: "internal_error" });
          }
        } catch {
          // Isolate setStatus failure
        }
        // Do not rethrow out of the telemetry callback:
        // If the SDK threw synchronously or discarded the callback promise,
        // rethrowing here causes an unhandled promise rejection.
        // The original business error is naturally surfaced when handlerPromise
        // is awaited at the end of executeRouteSpan.
        return;
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
    };

    const runSpan = async (): Promise<void> => {
      if (typeof sdk.startSpan !== "function") {
        await invokeHandlerOnce().catch(() => {});
        return;
      }

      try {
        await sdk.startSpan(
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
            await guardedCb(span);
          }
        );
      } catch {
        // Isolate startSpan setup or finalization failure
      }
    };

    let continueTraceInvokedCb = false;
    const continueTraceCb = async (): Promise<void> => {
      continueTraceInvokedCb = true;
      await runSpan();
    };

    try {
      if (sentryTrace && typeof sdk.continueTrace === "function") {
        await sdk.continueTrace({ sentryTrace, baggage }, continueTraceCb);
      } else {
        await continueTraceCb();
      }
    } catch {
      // Isolate continueTrace setup or finalization failure
    }

    // If continueTrace failed before invoking its callback, ensure span runs
    if (!continueTraceInvokedCb) {
      try {
        await runSpan();
      } catch {
        // Isolate fallback runSpan failure
      }
    }
  } catch {
    // Isolate overall telemetry setup failure
  }

  // Always await and return the exact same memoized handler promise.
  // Guarantees fn() was started (if not already), runs exactly once,
  // and surfaces original response or original business error.
  return await invokeHandlerOnce();
}

/**
 * Factory seam for creating an isolated route span runner bound to an explicit TracingSdk.
 * Does not mutate module-global state.
 */
export function createRouteSpanRunner(customSdk?: TracingSdk) {
  return async function withCustomRouteSpan<T>(
    route: string,
    req: Request,
    fn: () => Promise<T>,
    options: RouteSpanOptions = {}
  ): Promise<T> {
    const sdk = customSdk || testSdkOverride || Sentry;
    return await executeRouteSpan(sdk, route, req, fn, options);
  };
}

/**
 * Production route span wrapper bound permanently to Sentry (or testSdkOverride in test context).
 */
export const withRouteSpan = createRouteSpanRunner();
