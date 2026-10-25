import { handleAiRequest } from "@/lib/ai/serviceHandler";

export const runtime = "edge";

export async function POST(req: Request) {
  let cfEnv: Record<string, any> | undefined;
  try {
    const cfContext = (globalThis as any)[Symbol.for("__cloudflare-request-context__")];
    if (cfContext?.env) {
      cfEnv = cfContext.env;
    }
  } catch {}
  return handleAiRequest(req, { env: cfEnv });
}
