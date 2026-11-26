import { NextResponse } from "next/server";
import { getRuntimeEnv } from "@/lib/ai/serviceHandler";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { savedFeedConstraintsEnforcedFor } from "@/lib/preferences/feedConstraints";
import { computeAdvancedCapabilities } from "@/lib/preferences/advancedFilters";

export const runtime = "edge";
export const dynamic = "force-dynamic";

// What the server can apply to the feed right now. Booleans only: no env values, no account data.
export async function GET() {
  let cfEnv: Record<string, any> | undefined;
  try {
    const ctx = getRequestContext();
    if (ctx?.env) cfEnv = ctx.env as Record<string, any>;
  } catch {}
  const caps = computeAdvancedCapabilities({
    enforced: savedFeedConstraintsEnforcedFor(cfEnv),
    hasServiceKey: Boolean(getRuntimeEnv("SUPABASE_SERVICE_ROLE_KEY", cfEnv) || getRuntimeEnv("SUPABASE_SERVICE_KEY", cfEnv)),
    excludedSkillsRpcFlag: getRuntimeEnv("CM_EXCLUDED_SKILLS_RPC", cfEnv),
    preferredSkillsRankingFlag: getRuntimeEnv("CM_PREFERRED_SKILLS_RANKING", cfEnv),
  });
  return NextResponse.json(caps, { headers: { "Cache-Control": "no-store" } });
}
