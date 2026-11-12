import { handleAiRequest } from "@/lib/ai/serviceHandler";
import { measureRouteBudget } from "@/lib/api/routeBudget";
import { createLogger } from "@/lib/observability/logger";
import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { NextResponse } from "next/server";

export const runtime = "edge";

const log = createLogger({ context: { module: "api:ai" } });

async function postHandler(req: Request) {
  let cfEnv: Record<string, any> | undefined;
  try {
    const ctx = getRequestContext();
    if (ctx?.env) {
      cfEnv = ctx.env as Record<string, any>;
    }
  } catch {}

  return handleAiRequest(req, { env: cfEnv });
}

export async function POST(req: Request) {
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
