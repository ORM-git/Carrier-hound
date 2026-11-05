import { NextResponse } from "next/server";
import { recordPageView } from "@/lib/admin/analytics";
import { checkSharedRateLimit, TRACK_RATE_LIMIT, trackRateLimitStore } from "@/lib/api/sharedRateLimit";
import { getClientIpFromRequest, checkRateLimit, getSupabaseAdminClient } from "@/lib/ai/serviceHandler";
import { extractToken } from "@/lib/admin/auth";

export const runtime = "edge";


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
  try {
    const isLegacy =
      process.env.NODE_ENV === "test" &&
      process.env.__CAREERMONKE_LEGACY_RATE_LIMIT === "true";

    const clientIp = getClientIpFromRequest(req);

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

    const body = await req.json().catch(() => ({}));
    const { path, referrer, eventType, metric } = body;

    // Handle Core Web Vitals telemetry events
    if (eventType === "web-vitals") {
      if (
        !path ||
        typeof path !== "string" ||
        !path.startsWith("/") ||
        path.length > 200 ||
        path.includes("?") ||
        path.includes("#")
      ) {
        return NextResponse.json({ ok: false, error: "Invalid path" }, { status: 400 });
      }

      if (!metric || typeof metric !== "object") {
        return NextResponse.json({ ok: false, error: "Invalid metric" }, { status: 400 });
      }

      const { name, value, rating, navigationType } = metric;
      const allowedMetrics = ["LCP", "INP", "CLS", "TTFB", "FCP"];
      if (!name || typeof name !== "string" || !allowedMetrics.includes(name)) {
        return NextResponse.json({ ok: false, error: "Invalid metric name" }, { status: 400 });
      }

      if (typeof value !== "number" || !Number.isFinite(value)) {
        return NextResponse.json({ ok: false, error: "Invalid metric value" }, { status: 400 });
      }

      if (rating && (typeof rating !== "string" || rating.length > 50)) {
        return NextResponse.json({ ok: false, error: "Invalid rating" }, { status: 400 });
      }

      if (navigationType && (typeof navigationType !== "string" || navigationType.length > 50)) {
        return NextResponse.json({ ok: false, error: "Invalid navigationType" }, { status: 400 });
      }

      return NextResponse.json({ ok: true, eventType: "web-vitals" });
    }

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
  } catch (err: any) {
    // Fail silently to never break client page experience
    return NextResponse.json({ ok: true, fallback: true });
  }
}
