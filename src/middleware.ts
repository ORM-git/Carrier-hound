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
  if (pathname.startsWith("/_next") || pathname === "/favicon.ico") {
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
  // Hidden path for owner/admin and test accounts (only reachable by typing URL directly)
  if (pathname === "/login" || pathname.startsWith("/auth/")) return true;
  return false;
}

async function verifyAuthenticatedRequest(
  request: NextRequest
): Promise<{ hasValidSession: boolean; response: NextResponse }> {
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  // 1. Check x-admin-secret header for owner/admin API access
  const adminSecret = process.env.ADMIN_SECRET?.trim();
  const reqAdminSecret = request.headers.get("x-admin-secret")?.trim();
  if (adminSecret && reqAdminSecret && reqAdminSecret === adminSecret) {
    return { hasValidSession: true, response };
  }

  // 2. Test-mode mock client support (strictly gated by NODE_ENV === "test")
  if (process.env.NODE_ENV === "test" && (globalThis as any).__mockSupabaseClient?.auth?.getUser) {
    try {
      const authHeader =
        request.headers.get("authorization") || request.headers.get("Authorization") || "";
      const bearerToken = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : request.cookies.get("sb-access-token")?.value || "";
      if (bearerToken) {
        const { data, error } = await (globalThis as any).__mockSupabaseClient.auth.getUser(
          bearerToken
        );
        if (!error && data?.user) {
          return { hasValidSession: true, response };
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

      const authHeader =
        request.headers.get("authorization") || request.headers.get("Authorization") || "";
      if (authHeader.startsWith("Bearer ")) {
        const token = authHeader.slice(7).trim();
        const { data, error } = await supabase.auth.getUser(token);
        if (!error && data?.user) {
          return { hasValidSession: true, response };
        }
      }

      const { data, error } = await supabase.auth.getUser();
      if (!error && data?.user) {
        return { hasValidSession: true, response };
      }
    } catch {
      return { hasValidSession: false, response };
    }
  }

  return { hasValidSession: false, response };
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
    // 2. Allow /, /early-access, /api/early-access, and hidden /login (/auth/*) path
    if (isEarlyAccessAllowedPath(pathname)) {
      return NextResponse.next();
    }

    // 3. Allow authenticated owner/admin and test accounts who signed in via /login
    const { hasValidSession, response } = await verifyAuthenticatedRequest(request);
    if (hasValidSession) {
      return response;
    }

    // 4. Every API except /api/early-access returns HTTP 403 for unauthenticated guests
    if (pathname.startsWith("/api") || pathname.startsWith("/.netlify")) {
      return NextResponse.json(
        { error: "Early access only" },
        { status: 403 }
      );
    }

    // 5. Every other route (app, jobs, dashboard, resume, admin pages, etc.) redirects to /early-access
    const earlyAccessUrl = new URL("/early-access", request.url);
    return NextResponse.redirect(earlyAccessUrl);
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
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
