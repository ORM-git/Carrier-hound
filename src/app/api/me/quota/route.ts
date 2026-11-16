import { NextResponse } from "next/server";

import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";

import { createLogger } from "@/lib/observability/logger";

const baseLog = createLogger({ context: { route: "/api/me/quota" } });

export const runtime = "edge";

export async function GET(req: Request) {
  const log = baseLog.child({ requestId: req?.headers.get("x-request-id") ?? "unknown" });
  try {
    // Launch scope gate: AI usage quota is Coming Soon
    log.info("quota gated: coming soon", { status: 503 });
    return NextResponse.json(
      { error: "This feature is coming soon.", code: "FEATURE_COMING_SOON" },
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, no-cache, no-store, must-revalidate",
        },
      }
    );
  } catch (err: any) {
    log.error("request error", { error: err?.message || String(err) });
    reportRequestErrorToSentry(req, err);
    return NextResponse.json(
      { error: "Failed to retrieve quota status" },
      { status: 500 }
    );
  }
}
