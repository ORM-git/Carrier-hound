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

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // 1. Skip static assets, internal next paths, and API endpoints
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/.netlify") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  // 2. If route is not protected, allow immediately (HTTP 200)
  if (!isProtectedRoute(pathname)) {
    return NextResponse.next();
  }

  // 3. For protected routes, check for a valid Supabase session
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  let hasValidSession = false;

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

      const { data, error } = await supabase.auth.getUser();
      if (!error && data?.user) {
        hasValidSession = true;
      }
    } catch {
      hasValidSession = false;
    }
  }

  // 4. Authenticated -> allow request
  if (hasValidSession) {
    return response;
  }

  // 5. Unauthenticated -> Redirect to /login with returnTo query param
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
