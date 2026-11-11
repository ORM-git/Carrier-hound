import { NextResponse } from "next/server";

/**
 * Uniform Error Response Builder (Backend sheet rank 72: Uniform Error Shape).
 *
 * Implements the canonical error response contract defined in docs/error-shape.md:
 * - Every 4xx/5xx JSON response body is an object whose first key is `error` (a human-safe string).
 * - Sanctioned optional extra keys:
 *   - `code`: machine-readable error code for client branching.
 *   - `retryAfter`: seconds until retry for 429 rate limits.
 *   - `ok`: literal `false` for endpoints whose success shape is `{ ok: true, ... }`.
 * - Forbids arbitrary or unsanctioned keys in the error body.
 */

export interface ErrorResponseOptions {
  code?: string;
  retryAfter?: number;
  ok?: false;
  headers?: Record<string, string> | Headers;
}

export interface CanonicalErrorBody {
  error: string;
  code?: string;
  retryAfter?: number;
  ok?: false;
}

/**
 * Validates and constructs a canonical NextResponse for 4xx/5xx errors.
 */
export function createErrorResponse(
  status: number,
  error: string,
  options: ErrorResponseOptions = {}
): NextResponse {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new TypeError(`createErrorResponse requires an HTTP error status code (400-599), received ${status}`);
  }

  if (typeof error !== "string" || error.trim().length === 0) {
    throw new TypeError("createErrorResponse requires a non-empty string error message");
  }

  const { code, retryAfter, ok, headers: customHeaders } = options;

  if (ok !== undefined && ok !== false) {
    throw new TypeError("createErrorResponse only accepts ok: false when the ok flag is specified");
  }

  if (code !== undefined && (typeof code !== "string" || code.trim().length === 0)) {
    throw new TypeError("createErrorResponse code must be a non-empty string if provided");
  }

  if (retryAfter !== undefined) {
    if (!Number.isInteger(retryAfter) || retryAfter < 0) {
      throw new TypeError("createErrorResponse retryAfter must be a non-negative integer if provided");
    }
  }

  // Guaranteed canonical key order: error is always first
  const body: CanonicalErrorBody = {
    error: error.trim(),
  };

  if (code !== undefined) {
    body.code = code.trim();
  }

  if (retryAfter !== undefined) {
    body.retryAfter = retryAfter;
  }

  if (ok === false) {
    body.ok = false;
  }

  const responseHeaders = new Headers(customHeaders);
  if (!responseHeaders.has("Content-Type")) {
    responseHeaders.set("Content-Type", "application/json");
  }

  if (retryAfter !== undefined && !responseHeaders.has("Retry-After")) {
    responseHeaders.set("Retry-After", String(retryAfter));
  }

  return NextResponse.json(body, {
    status,
    headers: responseHeaders,
  });
}

export function badRequest(error: string, options?: Omit<ErrorResponseOptions, "ok">): NextResponse {
  return createErrorResponse(400, error, options);
}

export function unauthorized(
  error = "Missing or invalid authorization token",
  options?: Omit<ErrorResponseOptions, "ok">
): NextResponse {
  return createErrorResponse(401, error, options);
}

export function forbidden(
  error = "Forbidden",
  options?: Omit<ErrorResponseOptions, "ok">
): NextResponse {
  return createErrorResponse(403, error, options);
}

export function notFound(
  error = "Resource not found",
  options?: Omit<ErrorResponseOptions, "ok">
): NextResponse {
  return createErrorResponse(404, error, options);
}

export function rateLimited(
  error = "Too many requests. Please try again later.",
  retryAfter?: number,
  options?: Omit<ErrorResponseOptions, "retryAfter">
): NextResponse {
  return createErrorResponse(429, error, { ...options, retryAfter });
}

export function internalError(
  error = "Internal server error",
  options?: Omit<ErrorResponseOptions, "ok">
): NextResponse {
  return createErrorResponse(500, error, options);
}

export function serviceUnavailable(
  error = "Service temporarily unavailable",
  options?: Omit<ErrorResponseOptions, "ok">
): NextResponse {
  return createErrorResponse(503, error, options);
}
