import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * App routes that strictly require an authenticated Supabase session.
 * Any guest or expired session accessing these will be redirected to /login with ?returnTo=...
 */
export const PROTECTED_ROUTES: readonly string[] = [
  "/dashboard",
  "/jobs",
  "/resume",
  "/tracker",
  "/profile",
  "/radar",
  "/pricing",
  "/settings",
  "/applications",
  "/job-search",
  "/job-detail",
  "/onboarding",
];

/**
 * Guest-facing routes that must stay public and return HTTP 200 without redirection.
 */
export const PUBLIC_ROUTES: readonly string[] = [
  "/",
  "/remote",
  "/worldwide",
  "/login",
  "/signup",
  "/privacy",
  "/privacy-policy",
  "/terms-and-conditions",
];

export function isProtectedRoute(pathname: string): boolean {
  return PROTECTED_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );
}

export function isPublicRoute(pathname: string): boolean {
  if (pathname === "/") return true;
  if (pathname.startsWith("/remote")) return true;
  if (pathname.startsWith("/auth")) return true;
  if (pathname.startsWith("/api")) return true;
  if (pathname.startsWith("/_next")) return true;
  if (pathname.startsWith("/.netlify")) return true;
  return PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );
}

function isStaticAssetPath(pathname: string): boolean {
  if (
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/data/ne_110m_land.json"
  ) {
    return true;
  }
  return /\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|css|js|map|woff|woff2|ttf|eot|webmanifest)$/i.test(
    pathname
  );
}

function isEarlyAccessAllowedPath(pathname: string): boolean {
  if (pathname === "/") return true;
  if (pathname === "/early-access" || pathname.startsWith("/early-access/")) return true;
  if (
    pathname === "/api/early-access" ||
    pathname.startsWith("/api/early-access/") ||
    pathname === "/.netlify/functions/early-access"
  ) {
    return true;
  }
  // Health check stays public for guests
  if (pathname === "/api/health" || pathname.startsWith("/api/health/")) {
    return true;
  }
  // Legal pages stay public for guests
  if (
    pathname === "/privacy" ||
    pathname.startsWith("/privacy/") ||
    pathname === "/privacy-policy" ||
    pathname.startsWith("/privacy-policy/") ||
    pathname === "/terms-and-conditions" ||
    pathname.startsWith("/terms-and-conditions/")
  ) {
    return true;
  }
  // Hidden path for owner/admin and test accounts (only reachable by typing URL directly)
  if (pathname === "/login" || pathname.startsWith("/auth/")) return true;
  return false;
}

/**
 * Parse comma-separated allowlist from EARLY_ACCESS_ALLOWED_EMAILS (lowercase compare).
 * Never hardcodes any email. If env is empty/unset, returns an empty Set.
 */
function getAllowedEarlyAccessEmails(): Set<string> {
  const raw = process.env.EARLY_ACCESS_ALLOWED_EMAILS || "";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

function clearAuthCookiesOnResponse(request: NextRequest, response: NextResponse): void {
  for (const cookie of request.cookies.getAll()) {
    if (
      cookie.name.startsWith("sb-") ||
      cookie.name.startsWith("supabase-") ||
      cookie.name === "sb-access-token" ||
      cookie.name === "sb-refresh-token"
    ) {
      response.cookies.delete(cookie.name);
    }
  }
  response.headers.set("x-early-access-signed-out", "1");
}

interface AuthVerificationResult {
  hasValidSession: boolean;
  isAllowedEarlyAccess: boolean;
  signedOutNonAllowedUser: boolean;
  response: NextResponse;
}

async function verifyAuthenticatedRequest(
  request: NextRequest
): Promise<AuthVerificationResult> {
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  // 1. Check x-admin-secret header for owner/admin API access (unchanged)
  const adminSecret = process.env.ADMIN_SECRET?.trim();
  const reqAdminSecret = request.headers.get("x-admin-secret")?.trim();
  if (adminSecret && reqAdminSecret && reqAdminSecret === adminSecret) {
    return {
      hasValidSession: true,
      isAllowedEarlyAccess: true,
      signedOutNonAllowedUser: false,
      response,
    };
  }

  const allowedEmails = getAllowedEarlyAccessEmails();

  // 2. Test-mode mock client support (strictly gated by NODE_ENV === "test")
  if (process.env.NODE_ENV === "test" && (globalThis as any).__mockSupabaseClient?.auth?.getUser) {
    try {
      const authHeader =
        request.headers.get("authorization") || request.headers.get("Authorization") || "";
      const bearerToken = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : request.cookies.get("sb-access-token")?.value || "";
      if (bearerToken) {
        const mockAuth = (globalThis as any).__mockSupabaseClient.auth;
        const { data, error } = await mockAuth.getUser(bearerToken);
        if (!error && data?.user) {
          const userEmail = String(data.user.email || "").trim().toLowerCase();
          if (userEmail && allowedEmails.has(userEmail)) {
            return {
              hasValidSession: true,
              isAllowedEarlyAccess: true,
              signedOutNonAllowedUser: false,
              response,
            };
          }
          if (typeof mockAuth.signOut === "function") {
            await mockAuth.signOut().catch(() => {});
          }
          return {
            hasValidSession: true,
            isAllowedEarlyAccess: false,
            signedOutNonAllowedUser: true,
            response,
          };
        }
      }
    } catch {}
  }

  // 3. Real Supabase session verification
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (supabaseUrl && supabaseAnonKey) {
    try {
      const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value)
            );
            response = NextResponse.next({
              request,
            });
            cookiesToSet.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, options)
            );
          },
        },
      });

      let verifiedUser: { email?: string | null } | null = null;

      const authHeader =
        request.headers.get("authorization") || request.headers.get("Authorization") || "";
      if (authHeader.startsWith("Bearer ")) {
        const token = authHeader.slice(7).trim();
        const { data, error } = await supabase.auth.getUser(token);
        if (!error && data?.user) {
          verifiedUser = data.user;
        }
      }

      if (!verifiedUser) {
        const { data, error } = await supabase.auth.getUser();
        if (!error && data?.user) {
          verifiedUser = data.user;
        }
      }

      if (verifiedUser) {
        const userEmail = String(verifiedUser.email || "").trim().toLowerCase();
        if (userEmail && allowedEmails.has(userEmail)) {
          return {
            hasValidSession: true,
            isAllowedEarlyAccess: true,
            signedOutNonAllowedUser: false,
            response,
          };
        }

        // Signed-in user is NOT in EARLY_ACCESS_ALLOWED_EMAILS -> sign out
        await supabase.auth.signOut().catch(() => {});
        return {
          hasValidSession: true,
          isAllowedEarlyAccess: false,
          signedOutNonAllowedUser: true,
          response,
        };
      }
    } catch {
      return {
        hasValidSession: false,
        isAllowedEarlyAccess: false,
        signedOutNonAllowedUser: false,
        response,
      };
    }
  }

  return {
    hasValidSession: false,
    isAllowedEarlyAccess: false,
    signedOutNonAllowedUser: false,
    response,
  };
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // 1. Always allow static assets and internal _next paths
  if (isStaticAssetPath(pathname)) {
    return NextResponse.next();
  }

  // Legacy unlock flag strictly gated to NODE_ENV === "test" for negative control & legacy auth-guard tests
  const isLegacyUnlock =
    process.env.NODE_ENV === "test" &&
    process.env.__CAREERMONKE_LEGACY_EARLY_ACCESS_UNLOCK === "true";

  if (!isLegacyUnlock) {
    // 2. Allow /, /early-access, /api/early-access, /api/health, legal pages, and hidden /login (/auth/*)
    if (isEarlyAccessAllowedPath(pathname)) {
      return NextResponse.next();
    }

    // 3. Verify session and check EARLY_ACCESS_ALLOWED_EMAILS allowlist (or x-admin-secret)
    const { isAllowedEarlyAccess, signedOutNonAllowedUser, response } =
      await verifyAuthenticatedRequest(request);
    if (isAllowedEarlyAccess) {
      return response;
    }

    // 4. Every API except /api/early-access and /api/health returns HTTP 403 for guests and non-allowed users
    if (pathname.startsWith("/api") || pathname.startsWith("/.netlify")) {
      const apiRes = NextResponse.json(
        { error: "Early access only" },
        { status: 403 }
      );
      if (signedOutNonAllowedUser) {
        clearAuthCookiesOnResponse(request, apiRes);
      }
      return apiRes;
    }

    // 5. Every other route redirects (307) to /early-access (and clears cookies if non-allowed user was signed out)
    const earlyAccessUrl = new URL("/early-access", request.url);
    const redirectRes = NextResponse.redirect(earlyAccessUrl);
    if (signedOutNonAllowedUser) {
      clearAuthCookiesOnResponse(request, redirectRes);
    }
    return redirectRes;
  }

  // ── Legacy mode (only reachable when NODE_ENV === "test" && __CAREERMONKE_LEGACY_EARLY_ACCESS_UNLOCK === "true") ──
  if (
    pathname.startsWith("/api") ||
    pathname.startsWith("/.netlify") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  if (!isProtectedRoute(pathname)) {
    return NextResponse.next();
  }

  const { hasValidSession, response } = await verifyAuthenticatedRequest(request);
  if (hasValidSession) {
    return response;
  }

  const returnTo = `${pathname}${search}`;
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("returnTo", returnTo);

  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files with extensions (.svg, .png, .jpg, .ico, etc.)
     */
    "/((?!_next/static|_next/image|favicon.ico|data/ne_110m_land\\.json|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
