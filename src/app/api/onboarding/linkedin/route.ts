import { NextResponse } from "next/server";
import { getSupabaseAdminClient, getClientIpFromRequest } from "@/lib/ai/serviceHandler";
import { checkSharedRateLimitStrict } from "@/lib/api/sharedRateLimit";
import { validateAndNormalizeLinkedInUrl } from "@/lib/onboarding/step2";
import { isOnboardingStep2EnabledServer } from "@/config/onboarding";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { route: "/api/onboarding/linkedin" } });

export const runtime = "edge";

const NO_STORE = "private, no-cache, no-store, must-revalidate";

function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": NO_STORE } });
}

/** Validates + normalizes a LinkedIn profile URL and saves it to auth user_metadata. No scraping. */
async function handle(req: Request): Promise<NextResponse> {
  let cfEnv: Record<string, any> | undefined;
  try {
    const ctx = getRequestContext();
    if (ctx?.env) cfEnv = ctx.env as Record<string, any>;
  } catch {}

  if (!isOnboardingStep2EnabledServer(cfEnv)) {
    return json({ error: "Feature is coming soon", code: "FEATURE_COMING_SOON" }, 503);
  }

  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ error: "Unauthorized: Missing authentication token" }, 401);
  }

  // Service role only: no anon-key fallback. Missing key => 503.
  let supabaseAdmin: any;
  try {
    supabaseAdmin = getSupabaseAdminClient(cfEnv);
  } catch (err: any) {
    log.error("Service role client unavailable", { error: err?.message });
    return json({ error: "Service unavailable" }, 503);
  }

  const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7).trim());
  const user = authData?.user;
  if (authError || !user) {
    return json({ error: "Unauthorized: Invalid session" }, 401);
  }

  const ip = getClientIpFromRequest(req);
  const [userLimit, ipLimit] = await Promise.all([
    checkSharedRateLimitStrict(`onboarding_linkedin:user:${user.id}`, 20, 3600, { env: cfEnv }),
    checkSharedRateLimitStrict(`onboarding_linkedin:ip:${ip}`, 60, 3600, { env: cfEnv }),
  ]);
  if (!userLimit.allowed || !ipLimit.allowed) {
    const retryAfter = Math.max(userLimit.retryAfter, ipLimit.retryAfter, 1);
    const res = json({ error: "Too many attempts. Please try again later." }, 429);
    res.headers.set("Retry-After", String(retryAfter));
    return res;
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON request body" }, 400);
  }

  const result = validateAndNormalizeLinkedInUrl(body?.linkedinUrl);
  if (!result.valid || !result.normalizedUrl) {
    return json({ error: result.error || "Invalid LinkedIn URL" }, 400);
  }

  // GoTrue merges top-level user_metadata keys, so this only sets linkedin_url.
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
    user_metadata: { linkedin_url: result.normalizedUrl },
  });
  if (updateError) {
    log.error("Failed to save LinkedIn URL to user_metadata", { userId: user.id, error: updateError.message });
    return json({ error: "Couldn't save your LinkedIn URL. Please try again." }, 500);
  }

  return json({ ok: true, linkedinUrl: result.normalizedUrl });
}

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (err: any) {
    log.error("Unhandled error saving LinkedIn URL", { error: err?.message || String(err) });
    return json({ error: "Couldn't save your LinkedIn URL. Please try again." }, 500);
  }
}
