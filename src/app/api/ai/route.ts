import { handleAiRequest } from "@/lib/ai/serviceHandler";
import { measureRouteBudget } from "@/lib/api/routeBudget";
import { createLogger } from "@/lib/observability/logger";
import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";
import { checkRequiredEnv } from "@/lib/api/envCheck";
import { NextResponse } from "next/server";

export const runtime = "edge";

const log = createLogger({ context: { module: "api:ai" } });

async function postHandler(req: Request) {
  let cfEnv: Record<string, any> | undefined;
  try {
    const mod = await import("@cloudflare/next-on-pages").catch(() => null);
    const ctx = mod?.getRequestContext?.();
    if (ctx?.env) {
      cfEnv = ctx.env as Record<string, any>;
    }
  } catch {}

  return handleAiRequest(req, { env: cfEnv });
}

export async function POST(req: Request) {
  // Launch scope gate: AI features are Coming Soon (evaluated before env checks so missing keys still return 503)
  return NextResponse.json(
    { error: "This feature is coming soon.", code: "FEATURE_COMING_SOON" },
    { status: 503, headers: { "Content-Type": "application/json" } }
  );
}

// Preserved for tracing policy and handler reference
async function _legacyPostHandler(req: Request) {
  try {
    return await measureRouteBudget("/api/ai", () => postHandler(req));
  } catch (err) {
    try {
      log.error("[API /api/ai] Unhandled error", { error: err });
    } catch {}
    reportRequestErrorToSentry(req, err);
    return NextResponse.json(
      { error: "Internal server error occurred." },
      { status: 500 }
    );
  }
}
