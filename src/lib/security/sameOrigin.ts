/**
 * Same-origin guard for mutating API requests (Backend sheet rank 60 - CSRF).
 *
 * API routes authenticate with Bearer tokens, which classic CSRF cannot
 * attach, but middleware refreshes Supabase session cookies on every matched
 * request, so any present or future cookie-aware route needs an explicit
 * cross-site write barrier.
 *
 * Rule: for non-GET/HEAD/OPTIONS requests to /api/*, a PRESENT Origin header
 * must match the request host. Browsers always send Origin on cross-site
 * POSTs, so cross-site form/fetch posts are rejected. Requests with no
 * Origin header (server-to-server webhooks, cron, curl) carry no browser
 * cookies and are passed through unchanged - they authenticate by signature
 * or token, never by ambient cookie.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isCrossSiteMutation(
  method: string,
  pathname: string,
  origin: string | null,
  host: string | null,
): boolean {
  if (SAFE_METHODS.has((method || "").toUpperCase())) return false;
  if (!pathname.startsWith("/api/")) return false;
  if (!origin) return false; // no Origin: not a browser cross-site POST
  if (!host) return true; // cannot establish sameness: fail closed
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true; // unparseable Origin on a mutation: fail closed
  }
  return originHost.toLowerCase() !== host.toLowerCase();
}
