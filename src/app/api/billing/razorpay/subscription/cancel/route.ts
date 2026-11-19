import { handleSubscriptionCancellation } from "@/lib/billing/subscriptionCancellation";
import { createLogger } from "@/lib/observability/logger";

const baseLog = createLogger({ context: { route: "/api/billing/razorpay/subscription/cancel" } });

export const runtime = "edge";

async function getCloudflareEnv(deps?: any): Promise<Record<string, any> | undefined> {
  if (deps?.cfEnv) return deps.cfEnv;
  if (deps?.env) return deps.env;
  try {
    const mod = await import("@cloudflare/next-on-pages").catch(() => null);
    const ctx = mod?.getRequestContext?.();
    if (ctx?.env) {
      return ctx.env as Record<string, any>;
    }
  } catch {}
  try {
    const cfContext = (globalThis as any)[Symbol.for("__cloudflare-request-context__")];
    if (cfContext?.env) {
      return cfContext.env as Record<string, any>;
    }
  } catch {}
  return undefined;
}

export async function POST(req: Request) {
  const log = baseLog.child({ requestId: req?.headers.get("x-request-id") ?? "unknown" });
  const deps = (req as any).__testDeps || {};
  const cfEnv = await getCloudflareEnv(deps);
  return await handleSubscriptionCancellation(req, deps, cfEnv, log);
}
