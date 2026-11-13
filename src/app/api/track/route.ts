import { NextResponse } from "next/server";
import { recordPageView } from "@/lib/admin/analytics";
import { checkSharedRateLimit, TRACK_RATE_LIMIT, trackRateLimitStore } from "@/lib/api/sharedRateLimit";
import { getClientIpFromRequest, checkRateLimit, getSupabaseAdminClient } from "@/lib/ai/serviceHandler";
import { extractToken } from "@/lib/admin/auth";

import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";
import { withRouteSpan } from "@/lib/monitoring/tracing";

import { createLogger } from "@/lib/observability/logger";

const baseLog = createLogger({ context: { route: "/api/track" } });

export const runtime = "edge";

const MAX_TRACK_PAYLOAD_BYTES = 16384; // 16 KB size cap

const ALLOWED_METRIC_NAMES = new Set(["LCP", "INP", "CLS", "TTFB", "FCP"]);

// Funnel stages (signup -> onboard -> apply). Must stay identical to the
// CHECK constraint in supabase/migrations/20261106e_funnel_events.sql;
// scripts/test-funnel-events.ts asserts parity.
const ALLOWED_FUNNEL_EVENTS = new Set([
  "signup_started",
  "signup_completed",
  "onboarding_started",
  "onboarding_completed",
  "apply_started",
  "apply_completed",
]);

const MAX_FUNNEL_METADATA_BYTES = 2048;

async function sha256Hex16(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

async function getSessionUserId(req: Request): Promise<string | null> {
  try {
    const token = extractToken(req);
    if (!token) return null;

    const mockAdmin = (globalThis as any).__mockSupabaseClient;
    if (mockAdmin?.auth?.getUser) {
      const { data, error } = await mockAdmin.auth.getUser(token);
      if (!error && data?.user?.id) {
        return data.user.id;
      }
      return null;
    }

    const supabaseAdmin = getSupabaseAdminClient(undefined, true);
    if (!supabaseAdmin?.auth?.getUser) return null;

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user?.id) return null;
    return user.id;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  return withRouteSpan("/api/track", req, async () => {
    const log = baseLog.child({ requestId: req?.headers.get("x-request-id") ?? "unknown" });
    try {
    // 1. Size cap check via Content-Length header (if present)
    const contentLength = req.headers.get("content-length");
    if (contentLength) {
      const cl = parseInt(contentLength, 10);
      if (!Number.isNaN(cl) && cl > MAX_TRACK_PAYLOAD_BYTES) {
        return new NextResponse(null, { status: 204 });
      }
    }

    const isLegacy =
      process.env.NODE_ENV === "test" &&
      process.env.__CAREERMONKE_LEGACY_RATE_LIMIT === "true";

    const clientIp = getClientIpFromRequest(req);

    // 2. Shared rate limiting
    if (!isLegacy) {
      const ipLimit = await checkSharedRateLimit(
        `track:ip:${clientIp}`,
        TRACK_RATE_LIMIT.maxRequests,
        TRACK_RATE_LIMIT.windowSeconds,
        () =>
          checkRateLimit(
            clientIp,
            trackRateLimitStore,
            TRACK_RATE_LIMIT.maxRequests,
            TRACK_RATE_LIMIT.windowSeconds * 1000
          )
      );

      if (!ipLimit.allowed) {
        return NextResponse.json(
          {
            ok: false,
            error: "Rate limit exceeded. Please try again shortly.",
            retryAfter: ipLimit.retryAfter,
          },
          {
            status: 429,
            headers: {
              "Retry-After": String(ipLimit.retryAfter),
            },
          }
        );
      }
    }

    // 3. Read body text and enforce body size cap
    const rawBody = await req.text().catch(() => "");
    if (!rawBody) {
      return new NextResponse(null, { status: 204 });
    }

    const byteLength = new TextEncoder().encode(rawBody).length;
    if (byteLength > MAX_TRACK_PAYLOAD_BYTES) {
      return new NextResponse(null, { status: 204 });
    }

    let body: any = null;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new NextResponse(null, { status: 204 });
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return new NextResponse(null, { status: 204 });
    }

    const { eventType } = body;

    // 4. Handle Core Web Vitals telemetry events
    if (eventType === "web-vitals") {
      const route = body.route || body.path || body.metric?.route || body.metric?.path;

      if (
        !route ||
        typeof route !== "string" ||
        !route.startsWith("/") ||
        route.length > 200 ||
        route.includes("?") ||
        route.includes("#")
      ) {
        return new NextResponse(null, { status: 204 });
      }

      const metric = body.metric;
      const name = metric?.name || body.name;

      if (!name || typeof name !== "string" || !ALLOWED_METRIC_NAMES.has(name)) {
        return new NextResponse(null, { status: 204 });
      }

      const value = metric?.value !== undefined ? metric.value : body.value;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return new NextResponse(null, { status: 204 });
      }

      const rating = metric?.rating !== undefined ? metric.rating : body.rating;
      if (rating !== undefined && rating !== null) {
        if (typeof rating !== "string" || rating.length > 50) {
          return new NextResponse(null, { status: 204 });
        }
      }

      const navigationType =
        metric?.navigationType !== undefined
          ? metric.navigationType
          : body.navigationType !== undefined
          ? body.navigationType
          : metric?.navigation_type !== undefined
          ? metric.navigation_type
          : body.navigation_type;

      if (navigationType !== undefined && navigationType !== null) {
        if (typeof navigationType !== "string" || navigationType.length > 50) {
          return new NextResponse(null, { status: 204 });
        }
      }

      // Insert into web_vitals table via service role (strictly zero user identifiers)
      try {
        const mockAdmin = (globalThis as any).__mockSupabaseClient;
        const supabaseAdmin = mockAdmin || getSupabaseAdminClient(undefined, true);
        if (supabaseAdmin?.from) {
          const { error } = await supabaseAdmin.from("web_vitals").insert({
            name,
            value,
            rating: rating || null,
            route,
            navigation_type: navigationType || null,
            created_at: new Date().toISOString(),
          });
          if (error && error.code !== "PGRST205") {
            log.warn("web-vitals insert error", { error: error.message });
          }
        }
      } catch {
        // Fail silently
      }

      return NextResponse.json({ ok: true, eventType: "web-vitals" }, { status: 200 });
    }

    // 4b. Handle funnel events (signup -> onboard -> apply)
    // NOTE for the frontend emitter: fire these only behind the analytics
    // consent gate (same gate as the UTM capture) - no consent, no events.
    if (eventType === "funnel") {
      const funnelEvent = body.event;
      if (
        !funnelEvent ||
        typeof funnelEvent !== "string" ||
        !ALLOWED_FUNNEL_EVENTS.has(funnelEvent)
      ) {
        return new NextResponse(null, { status: 204 });
      }

      const funnelPath = body.path;
      if (funnelPath !== undefined && funnelPath !== null) {
        if (
          typeof funnelPath !== "string" ||
          !funnelPath.startsWith("/") ||
          funnelPath.length > 200 ||
          funnelPath.includes("?") ||
          funnelPath.includes("#")
        ) {
          return new NextResponse(null, { status: 204 });
        }
      }

      // Pseudonymous pre-signup id: random client token, capped, no PII.
      const anonymousId = body.anonymousId ?? body.anonymous_id;
      if (anonymousId !== undefined && anonymousId !== null) {
        if (typeof anonymousId !== "string" || anonymousId.length > 64) {
          return new NextResponse(null, { status: 204 });
        }
      }

      let funnelMetadata: Record<string, unknown> = {};
      if (body.metadata !== undefined && body.metadata !== null) {
        if (typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
          return new NextResponse(null, { status: 204 });
        }
        try {
          if (
            new TextEncoder().encode(JSON.stringify(body.metadata)).length >
            MAX_FUNNEL_METADATA_BYTES
          ) {
            return new NextResponse(null, { status: 204 });
          }
        } catch {
          return new NextResponse(null, { status: 204 });
        }
        funnelMetadata = body.metadata;
      }

      // Actor comes from the session only; a client-supplied user id is ignored.
      const sessionUserId = isLegacy
        ? body.userId || null
        : await getSessionUserId(req);
      const ipForHash =
        clientIp === "anonymous-client"
          ? req.headers.get("x-real-ip") || "127.0.0.1"
          : clientIp;
      const ipHash = await sha256Hex16(`${ipForHash}_careermonke_salt`);

      try {
        const mockAdmin = (globalThis as any).__mockSupabaseClient;
        const supabaseAdmin = mockAdmin || getSupabaseAdminClient(undefined, true);
        if (supabaseAdmin?.from) {
          const { error } = await supabaseAdmin.from("funnel_events").insert({
            event: funnelEvent,
            user_id: sessionUserId,
            anonymous_id: anonymousId || null,
            path: funnelPath || null,
            ip_hash: ipHash,
            metadata: funnelMetadata,
            created_at: new Date().toISOString(),
          });
          // PGRST205 = table missing until migration 20261106e is applied; stay silent.
          if (error && error.code !== "PGRST205") {
            log.warn("funnel insert error", { error: error.message });
          }
        }
      } catch {
        // Fail silently - analytics must never break the client flow.
      }

      return NextResponse.json({ ok: true, eventType: "funnel" }, { status: 200 });
    }

    // 5. Handle Standard Page View events
    const { path, referrer } = body;

    if (!path || typeof path !== "string" || !path.startsWith("/") || path.length > 200) {
      return NextResponse.json({ ok: false, error: "Invalid path" }, { status: 400 });
    }

    if (referrer !== undefined && referrer !== null) {
      if (typeof referrer !== "string" || referrer.length > 300) {
        return NextResponse.json({ ok: false, error: "Invalid referrer" }, { status: 400 });
      }
    }

    // In /api/track ignore any client-supplied userId from the body (derive from the session only)
    let sessionUserId: string | null = null;
    if (isLegacy) {
      sessionUserId = body.userId || null;
    } else {
      sessionUserId = await getSessionUserId(req);
    }

    const userAgent = req.headers.get("user-agent") || "";
    const ipForHash = clientIp === "anonymous-client" ? (req.headers.get("x-real-ip") || "127.0.0.1") : clientIp;
    const ipHash = await sha256Hex16(`${ipForHash}_careermonke_salt`);

    await recordPageView({
      path,
      referrer: referrer || null,
      userId: sessionUserId,
      ipHash,
      userAgent: userAgent ? userAgent.slice(0, 255) : null,
      createdAt: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true });
  } catch (_err) {
    // Fail silently to never break client page experience
    reportRequestErrorToSentry(req, _err);
    return NextResponse.json({ ok: true, fallback: true });
  }
  });
}
