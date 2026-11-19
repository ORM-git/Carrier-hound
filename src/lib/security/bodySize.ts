/**
 * Global request body-size precheck (Backend sheet rank 71 - Request Size
 * Limits). Individual routes cap their own payloads (e.g. /api/track at
 * 16 KB, AI fields via AI_FIELD_LENGTH_CAPS), but nothing bounded TOTAL
 * request size across all API routes, leaving every JSON parser exposed to
 * multi-megabyte bodies.
 *
 * This is a PRECHECK on the Content-Length header only: when the header is
 * absent (chunked transfer) or unparseable the request passes through and
 * route-level caps still apply. Chosen default cap: 1 MB - far above the
 * largest legitimate JSON payload (AI tailoring prompts are capped at
 * 12k chars per field, track payloads at 16 KB) and far below anything
 * useful for memory-exhaustion abuse.
 */
export const GLOBAL_API_BODY_CAP_BYTES = 1024 * 1024; // 1 MB (chosen default)

/**
 * Exact-path exceptions for upload routes that enforce their own, tighter
 * streaming cap. /api/onboarding/resume caps the file at 5 MB and the body at
 * 5 MB + 64 KB multipart framing (see src/lib/onboarding/step2Resume.ts).
 */
export const ROUTE_BODY_CAP_OVERRIDES: Readonly<Record<string, number>> = {
  "/api/onboarding/resume": 5 * 1024 * 1024 + 64 * 1024,
};

export function bodyCapForPath(pathname: string): number {
  return ROUTE_BODY_CAP_OVERRIDES[pathname] ?? GLOBAL_API_BODY_CAP_BYTES;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function exceedsGlobalBodyCap(
  method: string,
  pathname: string,
  contentLength: string | null,
  capBytes: number = bodyCapForPath(pathname),
): boolean {
  if (SAFE_METHODS.has((method || "").toUpperCase())) return false;
  if (!pathname.startsWith("/api/")) return false;
  if (!contentLength) return false;
  // Content-Length is decimal digits, not a parseInt numeric prefix. Keep
  // malformed headers on the documented pass-through path to route guards.
  const decimal = contentLength.trim();
  if (!/^\d+$/.test(decimal)) return false;
  // Overflow becomes Infinity, which still exceeds our finite cap. Do not
  // accidentally allow a syntactically valid giant declared length.
  return Number(decimal) > capBytes;
}
