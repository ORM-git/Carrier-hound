import { NextResponse } from "next/server";
import { getRuntimeEnv } from "@/lib/ai/serviceHandler";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { savedFeedConstraintsEnforcedFor } from "@/lib/preferences/feedConstraints";
import { getSupabaseAdminClient } from "@/lib/ai/serviceHandler";
import { probeRequiredYearsColumns } from "@/lib/jobs/yearsReadiness";
import { computeAdvancedCapabilities } from "@/lib/preferences/advancedFilters";

// Edge routes are never prerendered, so no `dynamic` export (it is rejected by the static-export CI build).
export const runtime = "edge";

// What the server can apply to the feed right now. Booleans only: no env values, no account data.
export async function GET() {
  let cfEnv: Record<string, any> | undefined;
  try {
    const ctx = getRequestContext();
    if (ctx?.env) cfEnv = ctx.env as Record<string, any>;
  } catch {}
  const enforced = savedFeedConstraintsEnforcedFor(cfEnv);
  const hasServiceKey = Boolean(getRuntimeEnv("SUPABASE_SERVICE_ROLE_KEY", cfEnv) || getRuntimeEnv("SUPABASE_SERVICE_KEY", cfEnv));
  let requiredYearsQueryable = false;
  if (enforced && hasServiceKey) {
    try {
      requiredYearsQueryable = await probeRequiredYearsColumns(getSupabaseAdminClient(cfEnv, false) as any);
    } catch {
      requiredYearsQueryable = false;
    }
  }
  const caps = computeAdvancedCapabilities({
    enforced,
    hasServiceKey,
    excludedSkillsRpcFlag: getRuntimeEnv("CM_EXCLUDED_SKILLS_RPC", cfEnv),
    preferredSkillsRankingFlag: getRuntimeEnv("CM_PREFERRED_SKILLS_RANKING", cfEnv),
    requiredYearsQueryable,
  });
  return NextResponse.json(caps, { headers: { "Cache-Control": "no-store" } });
}
