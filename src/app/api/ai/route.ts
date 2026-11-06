import { handleAiRequest } from "@/lib/ai/serviceHandler";
import { measureRouteBudget } from "@/lib/api/routeBudget";
import { getRequestContext } from "@cloudflare/next-on-pages";

export const runtime = "edge";

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
  return measureRouteBudget("/api/ai", () => postHandler(req));
}
