import { NextResponse } from "next/server";
import { noteOtpRequest, getRequestIp } from "@/lib/security/authMonitor";
import { checkSharedRateLimit } from "@/lib/api/sharedRateLimit";

export const runtime = "edge";

const MAX_PAYLOAD_BYTES = 4096;
/** Abuse guard for the monitor endpoint itself. */
const MONITOR_ROUTE_LIMIT = { max: 30, windowSeconds: 600 };

const ALLOWED_EVENTS = new Set(["otp_request"]);

/**
 * Receives client-reported auth telemetry (currently: magic-link OTP
 * requests) and feeds the credential-stuffing monitor. Always 204 - reveals
 * nothing about accounts, thresholds, or whether an alert fired.
 */
export async function POST(req: Request) {
  try {
    const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
    if (!Number.isNaN(contentLength) && contentLength > MAX_PAYLOAD_BYTES) {
      return new NextResponse(null, { status: 204 });
    }

    const ip = getRequestIp(req);
    const guard = await checkSharedRateLimit(
      `ato:event:ip:${ip}`,
      MONITOR_ROUTE_LIMIT.max,
      MONITOR_ROUTE_LIMIT.windowSeconds,
      undefined,
      { failClosed: true }
    );
    if (!guard.allowed) {
      return new NextResponse(null, { status: 204 });
    }

    const body = (await req.json().catch(() => null)) as { event?: string; email?: string } | null;
    if (!body || typeof body.event !== "string" || !ALLOWED_EVENTS.has(body.event)) {
      return new NextResponse(null, { status: 204 });
    }

    const email = typeof body.email === "string" && body.email.length <= 320 ? body.email : null;
    await noteOtpRequest(req, email);
  } catch {
    // Telemetry endpoint: never fail loudly, never leak.
  }
  return new NextResponse(null, { status: 204 });
}
