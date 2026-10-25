import { handleAiRequest } from "@/lib/ai/serviceHandler";
import { getRequestContext } from "@cloudflare/next-on-pages";

export const runtime = "edge";

export async function POST(req: Request) {
  let cfEnv: Record<string, any> | undefined;
  let reqContextStatus = "unknown";
  try {
    const ctx = getRequestContext();
    if (ctx?.env) {
      cfEnv = ctx.env as Record<string, any>;
      reqContextStatus = "returned_with_env";
    } else {
      reqContextStatus = "returned_without_env";
    }
  } catch (err: any) {
    reqContextStatus = `threw_${err?.name || "Error"}`;
  }

  const hasCtxGroqKey = Boolean(cfEnv?.GROQ_API_KEY);
  const hasCtxRoleKey = Boolean(cfEnv?.SUPABASE_SERVICE_ROLE_KEY);
  const hasProcGroqKey = typeof process !== "undefined" && Boolean(process.env?.GROQ_API_KEY);
  const hasProcRoleKey = typeof process !== "undefined" && Boolean(process.env?.SUPABASE_SERVICE_ROLE_KEY);

  console.log(
    `[AI Route Runtime] getRequestContext: ${reqContextStatus}, ctx.env exists: ${Boolean(cfEnv)}, ctx has GROQ_API_KEY: ${hasCtxGroqKey}, ctx has SUPABASE_SERVICE_ROLE_KEY: ${hasCtxRoleKey}, proc has GROQ_API_KEY: ${hasProcGroqKey}, proc has SUPABASE_SERVICE_ROLE_KEY: ${hasProcRoleKey}`
  );
  return handleAiRequest(req, { env: cfEnv });
}
