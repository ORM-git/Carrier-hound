import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { isVerifiedAdminUser } from "@/lib/admin/constants";

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

export function isAdminRouteOrApi(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/api/admin" ||
    pathname.startsWith("/api/admin/")
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

function isLegalPath(pathname: string): boolean {
  return (
    pathname === "/privacy" ||
    pathname.startsWith("/privacy/") ||
    pathname === "/privacy-policy" ||
    pathname.startsWith("/privacy-policy/") ||
    pathname === "/terms-and-conditions" ||
    pathname.startsWith("/terms-and-conditions/")
  );
}

/**
 * Server-side environment variable reader supporting Node/Next.js and Cloudflare Pages Edge isolates.
 */
function getServerEnv(key: string): string | undefined {
  if (
    typeof process !== "undefined" &&
    process?.env &&
    typeof process.env[key] === "string" &&
    process.env[key]!.trim()
  ) {
    return process.env[key]!.trim();
  }
  try {
    const cfContext = (globalThis as any)[Symbol.for("__cloudflare-request-context__")];
    if (cfContext?.env && typeof cfContext.env[key] === "string" && cfContext.env[key].trim()) {
      return cfContext.env[key].trim();
    }
  } catch {}
  try {
    const cfEnv = (globalThis as any)[Symbol.for("__cloudflare-env__")];
    if (cfEnv && typeof cfEnv[key] === "string" && cfEnv[key].trim()) {
      return cfEnv[key].trim();
    }
  } catch {}
  return undefined;
}

/**
 * Parse comma-separated allowlist from EARLY_ACCESS_ALLOWED_EMAILS (lowercase compare).
 * Never hardcodes any email. If env is empty/unset, returns an empty Set.
 */
function getAllowedEarlyAccessEmails(): Set<string> {
  const raw = getServerEnv("EARLY_ACCESS_ALLOWED_EMAILS") || "";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Rule 5: Google login only, no magic links.
 * Allows when the user has a linked Google identity (identities[].provider === "google",
 * app_metadata.providers includes "google", or app_metadata.provider === "google")
 * AND user.email_confirmed_at is set.
 * Email-only accounts with no Google identity stay blocked.
 */
function isGoogleProvider(user: any): boolean {
  if (!user) return false;

  const isEmailConfirmed =
    typeof user.email_confirmed_at === "string" &&
    user.email_confirmed_at.trim().length > 0;
  if (!isEmailConfirmed) {
    return false;
  }

  const hasGoogleIdentity =
    Array.isArray(user.identities) &&
    user.identities.some((id: any) => id?.provider === "google");

  const hasGoogleInProviders =
    Array.isArray(user.app_metadata?.providers) &&
    user.app_metadata.providers.includes("google");

  const hasGoogleProvider = user.app_metadata?.provider === "google";

  return Boolean(hasGoogleIdentity || hasGoogleInProviders || hasGoogleProvider);
}

/**
 * Server-side early access approval check:
 * 1. EARLY_ACCESS_ALLOWED_EMAILS allowlist (case-insensitive).
 * 2. early_access_approved table lookup (service role only, case-insensitive, fail-closed).
 */
async function checkEarlyAccessApproval(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return false;
  }

  // 1. Check in-memory / env allowlist
  if (getAllowedEarlyAccessEmails().has(normalized)) {
    return true;
  }

  // 2. Test-mode mock client support (strictly gated by NODE_ENV === "test")
  if (process.env.NODE_ENV === "test" && (globalThis as any).__mockSupabaseClient) {
    try {
      const mockClient = (globalThis as any).__mockSupabaseClient;
      if (typeof mockClient.from === "function") {
        const { data, error } = await mockClient
          .from("early_access_approved")
          .select("approved")
          .eq("email", normalized)
          .maybeSingle();

        if (error) {
          // Rule 4: Fail closed on DB error
          return false;
        }
        return data?.approved === true;
      }
    } catch {
      // Fail closed
      return false;
    }
  }

  // 3. Live server-side query with service role (fail-closed)
  const supabaseUrl =
    getServerEnv("NEXT_PUBLIC_SUPABASE_URL") || getServerEnv("SUPABASE_URL");
  const serviceKey =
    getServerEnv("SUPABASE_SERVICE_ROLE_KEY") || getServerEnv("SUPABASE_SERVICE_KEY");

  if (!supabaseUrl || !serviceKey) {
    // Fail closed if secrets missing
    return false;
  }

  try {
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });
    const { data, error } = await adminClient
      .from("early_access_approved")
      .select("approved")
      .eq("email", normalized)
      .maybeSingle();

    if (error) {
      // Rule 4: Fail closed on DB error
      return false;
    }
    return data?.approved === true;
  } catch {
    // Fail closed
    return false;
  }
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
  isVerifiedAdmin: boolean;
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

  // 1. Check x-admin-secret header for non-admin early-access API checks
  const adminSecret = getServerEnv("ADMIN_SECRET");
  const reqAdminSecret = request.headers.get("x-admin-secret")?.trim();
  if (
    adminSecret &&
    reqAdminSecret &&
    reqAdminSecret === adminSecret &&
    !isAdminRouteOrApi(request.nextUrl.pathname)
  ) {
    return {
      hasValidSession: true,
      isAllowedEarlyAccess: true,
      isVerifiedAdmin: false,
      signedOutNonAllowedUser: false,
      response,
    };
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
        const mockAuth = (globalThis as any).__mockSupabaseClient.auth;
        const { data, error } = await mockAuth.getUser(bearerToken);
        if (!error && data?.user) {
          const userEmail = String(data.user.email || "").trim().toLowerCase();
          const verifiedAdmin = isVerifiedAdminUser(data.user);

          // Rule 5: Google login only, no magic links
          if (!isGoogleProvider(data.user)) {
            if (typeof mockAuth.signOut === "function") {
              await mockAuth.signOut().catch(() => {});
            }
            return {
              hasValidSession: true,
              isAllowedEarlyAccess: false,
              isVerifiedAdmin: false,
              signedOutNonAllowedUser: true,
              response,
            };
          }

          const isApproved = await checkEarlyAccessApproval(userEmail);
          if (isApproved) {
            return {
              hasValidSession: true,
              isAllowedEarlyAccess: true,
              isVerifiedAdmin: verifiedAdmin,
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
            isVerifiedAdmin: verifiedAdmin,
            signedOutNonAllowedUser: true,
            response,
          };
        }
      }
    } catch {}
  }

  // 3. Real Supabase session verification
  const supabaseUrl = getServerEnv("NEXT_PUBLIC_SUPABASE_URL") || getServerEnv("SUPABASE_URL");
  const supabaseAnonKey = getServerEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

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

      let verifiedUser: any = null;

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
        const verifiedAdmin = isVerifiedAdminUser(verifiedUser);

        // Rule 5: Google login only, no magic links
        if (!isGoogleProvider(verifiedUser)) {
          await supabase.auth.signOut().catch(() => {});
          return {
            hasValidSession: true,
            isAllowedEarlyAccess: false,
            isVerifiedAdmin: false,
            signedOutNonAllowedUser: true,
            response,
          };
        }

        const isApproved = await checkEarlyAccessApproval(userEmail);
        if (isApproved) {
          return {
            hasValidSession: true,
            isAllowedEarlyAccess: true,
            isVerifiedAdmin: verifiedAdmin,
            signedOutNonAllowedUser: false,
            response,
          };
        }

        // Signed-in user is NOT approved -> sign out
        await supabase.auth.signOut().catch(() => {});
        return {
          hasValidSession: true,
          isAllowedEarlyAccess: false,
          isVerifiedAdmin: verifiedAdmin,
          signedOutNonAllowedUser: true,
          response,
        };
      }
    } catch {
      return {
        hasValidSession: false,
        isAllowedEarlyAccess: false,
        isVerifiedAdmin: false,
        signedOutNonAllowedUser: false,
        response,
      };
    }
  }

  return {
    hasValidSession: false,
    isAllowedEarlyAccess: false,
    isVerifiedAdmin: false,
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

  // 2. Server-side Admin Route & API Gate:
  // Signed-in user's email must be in the admin list AND email must be verified; otherwise 403.
  if (isAdminRouteOrApi(pathname)) {
    const { hasValidSession, isVerifiedAdmin } = await verifyAuthenticatedRequest(request);
    if (!hasValidSession || !isVerifiedAdmin) {
      return NextResponse.json(
        { error: "Forbidden: Admin access only." },
        { status: 403 }
      );
    }
    return NextResponse.next({
      request: {
        headers: request.headers,
      },
    });
  }

  // Legacy unlock flag strictly gated to NODE_ENV === "test" for negative control & legacy auth-guard tests
  const isLegacyUnlock =
    process.env.NODE_ENV === "test" &&
    process.env.__CAREERMONKE_LEGACY_EARLY_ACCESS_UNLOCK === "true";

  if (isLegacyUnlock) {
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

  // ── Early Access Gate (Default Mode) ──

  // Exact public endpoints (no broad wildcards)
  if (pathname === "/api/health" || pathname.startsWith("/api/health/")) {
    return NextResponse.next();
  }

  if (
    request.method === "GET" &&
    (pathname === "/api/stats" || pathname === "/.netlify/functions/stats")
  ) {
    return NextResponse.next();
  }

  if (
    pathname === "/api/early-access" ||
    pathname.startsWith("/api/early-access/") ||
    pathname === "/.netlify/functions/early-access"
  ) {
    return NextResponse.next();
  }

  if (isLegalPath(pathname)) {
    return NextResponse.next();
  }

  // Server-side authentication and early-access approval check
  const { hasValidSession, isAllowedEarlyAccess, signedOutNonAllowedUser, response } =
    await verifyAuthenticatedRequest(request);

  // 1. Logged-in + approved = straight to the dashboard (skip the early-access page)
  if (hasValidSession && isAllowedEarlyAccess) {
    if (
      pathname === "/early-access" ||
      pathname.startsWith("/early-access/") ||
      pathname === "/" ||
      pathname === "/login" ||
      pathname === "/auth/callback"
    ) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    return response;
  }

  // 2. Logged-in + not approved = early-access page
  if (hasValidSession && !isAllowedEarlyAccess) {
    if (pathname === "/early-access" || pathname.startsWith("/early-access/")) {
      return NextResponse.next();
    }
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
    const earlyAccessUrl = new URL("/early-access", request.url);
    const redirectRes = NextResponse.redirect(earlyAccessUrl);
    if (signedOutNonAllowedUser) {
      clearAuthCookiesOnResponse(request, redirectRes);
    }
    return redirectRes;
  }

  // 3. Logged-out = existing behaviour
  if (
    pathname === "/" ||
    pathname === "/early-access" ||
    pathname.startsWith("/early-access/") ||
    pathname === "/login" ||
    pathname === "/auth/callback"
  ) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api") || pathname.startsWith("/.netlify")) {
    return NextResponse.json(
      { error: "Early access only" },
      { status: 403 }
    );
  }

  const earlyAccessUrl = new URL("/early-access", request.url);
  return NextResponse.redirect(earlyAccessUrl);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|data/ne_110m_land\\.json|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
