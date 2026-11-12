import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { isVerifiedAdminUser } from "@/lib/admin/constants";
import { isCrossSiteMutation } from "@/lib/security/sameOrigin";
import { exceedsGlobalBodyCap } from "@/lib/security/bodySize";
import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "middleware" } });

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
  "/pricing",
  "/about",
  "/privacy",
  "/privacy-policy",
  "/terms-and-conditions",
  "/refund-policy",
  "/contact",
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
    pathname === "/about" ||
    pathname.startsWith("/about/") ||
    pathname === "/privacy" ||
    pathname.startsWith("/privacy/") ||
    pathname === "/privacy-policy" ||
    pathname.startsWith("/privacy-policy/") ||
    pathname === "/terms-and-conditions" ||
    pathname.startsWith("/terms-and-conditions/") ||
    pathname === "/refund-policy" ||
    pathname.startsWith("/refund-policy/") ||
    pathname === "/contact" ||
    pathname.startsWith("/contact/")
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

export interface EarlyAccessCacheEntry {
  approved: boolean;
  cachedAt: number;
}

export interface EarlyAccessApprovalVerdict {
  approved: boolean;
  shouldSignOut: boolean;
}

// In-memory per-email TTL cache (60s TTL, 5-minute grace window for lookup errors)
const earlyAccessApprovalCache = new Map<string, EarlyAccessCacheEntry>();
const EARLY_ACCESS_CACHE_TTL_MS = 60 * 1000;
const EARLY_ACCESS_GRACE_WINDOW_MS = 5 * 60 * 1000;

export function _clearEarlyAccessCacheForTesting(): void {
  earlyAccessApprovalCache.clear();
}

export function _getEarlyAccessCacheForTesting(): Map<string, EarlyAccessCacheEntry> {
  return earlyAccessApprovalCache;
}

async function queryEarlyAccessApprovalFromDb(
  normalizedEmail: string
): Promise<{ status: "definitive"; approved: boolean } | { status: "error"; error: any }> {
  // 1. Test-mode mock client support (strictly gated by NODE_ENV === "test")
  if (process.env.NODE_ENV === "test" && (globalThis as any).__mockSupabaseClient) {
    try {
      const mockClient = (globalThis as any).__mockSupabaseClient;
      if (typeof mockClient.from === "function") {
        const { data, error } = await mockClient
          .from("early_access_approved")
          .select("approved")
          .eq("email", normalizedEmail)
          .maybeSingle();

        if (error) {
          return { status: "error", error };
        }
        return { status: "definitive", approved: data?.approved === true };
      }
    } catch (err) {
      return { status: "error", error: err };
    }
  }

  // 2. Live server-side query with service role
  const supabaseUrl =
    getServerEnv("NEXT_PUBLIC_SUPABASE_URL") || getServerEnv("SUPABASE_URL");
  const serviceKey =
    getServerEnv("SUPABASE_SERVICE_ROLE_KEY") || getServerEnv("SUPABASE_SERVICE_KEY");

  if (!supabaseUrl || !serviceKey) {
    return {
      status: "error",
      error: new Error("Missing required Supabase service role environment variables"),
    };
  }

  try {
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });
    const { data, error } = await adminClient
      .from("early_access_approved")
      .select("approved")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (error) {
      return { status: "error", error };
    }
    return { status: "definitive", approved: data?.approved === true };
  } catch (err) {
    return { status: "error", error: err };
  }
}

/**
 * Server-side early access approval check:
 * 1. Respects existing EARLY_ACCESS_ALLOWED_EMAILS allowlist first (no DB hit).
 * 2. In-memory per-email TTL cache (60s) around approval verdicts.
 * 3. Error hygiene: a definitive "not approved" bounces and signs out;
 *    a lookup ERROR never signs the user out - serves last-known-good within 5m grace,
 *    or bounces to /early-access without signing out if there is no cached verdict.
 */
export async function checkEarlyAccessApproval(
  email: string
): Promise<EarlyAccessApprovalVerdict> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return { approved: false, shouldSignOut: true };
  }

  // 1. Respect existing EARLY_ACCESS_ALLOWED_EMAILS allowlist first
  if (getAllowedEarlyAccessEmails().has(normalized)) {
    return { approved: true, shouldSignOut: false };
  }

  const now = Date.now();
  const cached = earlyAccessApprovalCache.get(normalized);

  // 2. Fresh in-memory TTL cache hit (within 60s)
  if (cached && now - cached.cachedAt < EARLY_ACCESS_CACHE_TTL_MS) {
    return {
      approved: cached.approved,
      shouldSignOut: !cached.approved,
    };
  }

  // 3. Query early_access_approved table
  const result = await queryEarlyAccessApprovalFromDb(normalized);

  if (result.status === "definitive") {
    earlyAccessApprovalCache.set(normalized, {
      approved: result.approved,
      cachedAt: now,
    });
    return {
      approved: result.approved,
      shouldSignOut: !result.approved,
    };
  }

  // 4. Lookup ERROR handling:
  // Must NEVER sign the user out.
  // Check if we have a last-known-good verdict within 5-minute grace window:
  if (cached && now - cached.cachedAt <= EARLY_ACCESS_GRACE_WINDOW_MS) {
    if (cached.approved) {
      log.warn(
        `[middleware] approval query error for ${normalized}; serving cached approved verdict within 5m grace window.`
      );
      return { approved: true, shouldSignOut: false };
    }
    // Cached unapproved within grace window; bounce but do NOT sign out on transient error
    return { approved: false, shouldSignOut: false };
  }

  // No cached verdict (or past grace window): bounce to /early-access without signing out (session stays intact)
  log.warn(
    `[middleware] approval query error for ${normalized} with no cached verdict; bouncing without sign-out`,
    { error: result.error?.message || String(result.error) }
  );
  return { approved: false, shouldSignOut: false };
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

/**
 * Constant-time string comparison preventing timing oracles.
 * Always compares every character without early exit.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Computes a fixed-length SHA-256 hex digest using Web Crypto.
 */
async function computeSha256Hex(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
/**
 * Restricts early-access bypass to an explicit allowlist of read-only, non-personal API paths.
 * Excludes all admin routes/APIs and any personal or protected routes.
 */
export function isEarlyAccessSecretBypassAllowed(request: NextRequest): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }
  const { pathname } = request.nextUrl;
  if (isAdminRouteOrApi(pathname)) {
    return false;
  }
  if (
    pathname === "/api/health" ||
    pathname.startsWith("/api/health/") ||
    pathname === "/api/ticker" ||
    pathname === "/.netlify/functions/ticker" ||
    pathname === "/api/jobs/search" ||
    pathname === "/.netlify/functions/jobs-search"
  ) {
    return true;
  }
  return false;
}

/**
 * Validates x-admin-secret header against ADMIN_SECRET using SHA-256 digest
 * and constant-time comparison. Disabled if ADMIN_SECRET is unset or empty.
 */
export async function isValidAdminSecret(request: NextRequest): Promise<boolean> {
  const adminSecret = getServerEnv("ADMIN_SECRET");
  const reqAdminSecret = request.headers.get("x-admin-secret")?.trim();
  if (!adminSecret || !reqAdminSecret) {
    return false;
  }
  try {
    const [reqDigest, adminDigest] = await Promise.all([
      computeSha256Hex(reqAdminSecret),
      computeSha256Hex(adminSecret),
    ]);
    return constantTimeEqual(reqDigest, adminDigest);
  } catch {
    return false;
  }
}

async function verifyAuthenticatedRequest(
  request: NextRequest
): Promise<AuthVerificationResult> {
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  // 1. Test-mode mock client support (strictly gated by NODE_ENV === "test")
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

          const verdict = await checkEarlyAccessApproval(userEmail);
          if (verdict.approved) {
            return {
              hasValidSession: true,
              isAllowedEarlyAccess: true,
              isVerifiedAdmin: verifiedAdmin,
              signedOutNonAllowedUser: false,
              response,
            };
          }

          if (verdict.shouldSignOut && typeof mockAuth.signOut === "function") {
            await mockAuth.signOut().catch(() => {});
          }
          return {
            hasValidSession: true,
            isAllowedEarlyAccess: false,
            isVerifiedAdmin: verifiedAdmin,
            signedOutNonAllowedUser: verdict.shouldSignOut,
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

        const verdict = await checkEarlyAccessApproval(userEmail);
        if (verdict.approved) {
          return {
            hasValidSession: true,
            isAllowedEarlyAccess: true,
            isVerifiedAdmin: verifiedAdmin,
            signedOutNonAllowedUser: false,
            response,
          };
        }

        // Signed-in user is definitively NOT approved -> sign out
        if (verdict.shouldSignOut) {
          await supabase.auth.signOut().catch(() => {});
        }
        return {
          hasValidSession: true,
          isAllowedEarlyAccess: false,
          isVerifiedAdmin: verifiedAdmin,
          signedOutNonAllowedUser: verdict.shouldSignOut,
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

async function middlewareImpl(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // 1. Always allow static assets and internal _next paths
  if (isStaticAssetPath(pathname)) {
    return NextResponse.next();
  }

  // 1b. CSRF same-origin barrier (Backend sheet rank 60): reject mutating
  // /api requests whose Origin header names a different host. Browsers always
  // send Origin on cross-site POSTs; Origin-less requests (webhooks, cron,
  // server-to-server) carry no ambient cookies and pass through unchanged.
  if (
    isCrossSiteMutation(request.method, pathname, request.headers.get("origin"), request.headers.get("host"), {
      secFetchSite: request.headers.get("sec-fetch-site"),
      hasCookies: request.headers.has("cookie"),
      requestScheme: request.nextUrl.protocol,
    })
  ) {
    return new NextResponse(null, { status: 403 });
  }

  // 1c. Global body-size precheck (Backend sheet rank 71): reject mutating
  // /api requests whose Content-Length exceeds the global cap. Chunked
  // requests (no Content-Length) pass through to route-level caps.
  if (exceedsGlobalBodyCap(request.method, pathname, request.headers.get("content-length"))) {
    return new NextResponse(null, { status: 413 });
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
    request.method === "GET" &&
    (pathname === "/api/ticker" || pathname === "/.netlify/functions/ticker")
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

  if (
    isLegalPath(pathname) ||
    pathname === "/pricing" ||
    pathname.startsWith("/pricing/")
  ) {
    return NextResponse.next();
  }

  // Scoped smoke-test early-access bypass for read-only non-personal APIs
  if (isEarlyAccessSecretBypassAllowed(request) && (await isValidAdminSecret(request))) {
    return NextResponse.next({
      request: {
        headers: request.headers,
      },
    });
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
    pathname === "/auth/callback" ||
    pathname === "/pricing" ||
    pathname.startsWith("/pricing/")
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

// ============================================================================
// Correlation / request IDs (audit BE #25)
// Every request gets an x-request-id: a well-formed inbound id is honored
// (so edge logs and client error reports join up), anything else is replaced
// with a fresh UUID. The id is set on the request headers handed to route
// handlers and echoed on the response.
// ============================================================================
export const REQUEST_ID_HEADER = "x-request-id";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function resolveRequestId(request: NextRequest): string {
  const incoming = request.headers.get(REQUEST_ID_HEADER);
  if (incoming && REQUEST_ID_PATTERN.test(incoming)) {
    return incoming;
  }
  return crypto.randomUUID();
}

export async function middleware(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const response = await middlewareImpl(request);

  // Propagate x-request-id to downstream route handlers via Next.js / next-on-pages
  // middleware override headers instead of `new NextRequest(request, { headers })`,
  // because constructing a new NextRequest clones/consumes the incoming Request body
  // in Cloudflare Workers and causes @cloudflare/next-on-pages's `new Request(url, request)`
  // to throw an uncaught TypeError (error code 1101) on POST/PUT/PATCH/DELETE.
  if (response.headers.get("x-middleware-next") === "1") {
    const scopedHeaders = new Headers(request.headers);
    scopedHeaders.set(REQUEST_ID_HEADER, requestId);
    const existingOverrides = response.headers.get("x-middleware-override-headers");
    const overrideKeys = new Set(
      existingOverrides
        ? existingOverrides
            .split(",")
            .map((key) => key.trim().toLowerCase())
            .filter(Boolean)
        : []
    );
    overrideKeys.add(REQUEST_ID_HEADER);
    response.headers.set("x-middleware-override-headers", Array.from(overrideKeys).join(","));
    response.headers.set(
      `x-middleware-request-${REQUEST_ID_HEADER}`,
      scopedHeaders.get(REQUEST_ID_HEADER) ?? requestId
    );
  }

  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}
