/**
 * Same-origin guard for mutating API requests (Backend sheet rank 60 - CSRF).
 *
 * API routes authenticate with Bearer tokens, which classic CSRF cannot
 * attach, but middleware refreshes Supabase session cookies on every matched
 * request, so any present or future cookie-aware route needs an explicit
 * cross-site write barrier.
 *
 * Rules for non-GET/HEAD/OPTIONS requests to /api/*:
 *  - A PRESENT Origin header must match the request host AND scheme (an
 *    http Origin on an https request is still cross-site). Browsers always
 *    send Origin on cross-site POSTs, so cross-site form/fetch posts are
 *    rejected.
 *  - A request with NO Origin but a Sec-Fetch-Site: cross-site header that
 *    carries cookies is a browser cross-site request from a context that
 *    omits Origin (e.g. some navigations/redirects): rejected.
 *  - Any other Origin-less request (server-to-server webhooks, cron, curl,
 *    or same-origin fetch) passes through unchanged - it authenticates by
 *    signature or token, never by ambient cookie.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface SameOriginContext {
  secFetchSite?: string | null;
  hasCookies?: boolean;
  requestScheme?: string | null;
}

export function isCrossSiteMutation(
  method: string,
  pathname: string,
  origin: string | null,
  host: string | null,
  ctx: SameOriginContext = {},
): boolean {
  if (SAFE_METHODS.has((method || "").toUpperCase())) return false;
  if (!pathname.startsWith("/api/")) return false;
  if (!origin) {
    // No Origin: a cross-site browser request carrying ambient cookies is
    // still a CSRF vector; server-to-server traffic has no cookies.
    return ctx.secFetchSite === "cross-site" && ctx.hasCookies === true;
  }
  if (!host) return true; // cannot establish sameness: fail closed
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return true; // unparseable Origin on a mutation: fail closed
  }
  if (parsed.host.toLowerCase() !== host.toLowerCase()) return true;
  const scheme = (ctx.requestScheme || "").replace(/:$/, "").toLowerCase();
  if (scheme && parsed.protocol.replace(/:$/, "").toLowerCase() !== scheme) {
    return true; // scheme downgrade (http Origin on https request)
  }
  return false;
}
