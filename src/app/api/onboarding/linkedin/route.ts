import { NextResponse } from "next/server";
import { getSupabaseAdminClient, getClientIpFromRequest } from "@/lib/ai/serviceHandler";
import { checkSharedRateLimit } from "@/lib/api/sharedRateLimit";
import { validateAndNormalizeLinkedInUrl } from "@/lib/onboarding/step2";
import { isOnboardingStep2Active } from "@/config/onboarding";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { route: "/api/onboarding/linkedin" } });

export const runtime = "edge";

export async function POST(req: Request) {
  // Check feature flag: fail-closed with 503 if disabled
  if (!isOnboardingStep2Active()) {
    return NextResponse.json(
      { error: "Feature is coming soon", code: "FEATURE_COMING_SOON" },
      { status: 503 }
    );
  }

  let cfEnv: Record<string, any> | undefined;
  try {
    const ctx = getRequestContext();
    if (ctx?.env) cfEnv = ctx.env as Record<string, any>;
  } catch {}

  // 1. Authenticate user
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized: Missing authentication token" }, { status: 401 });
  }

  const token = authHeader.replace("Bearer ", "").trim();
  const supabaseAdmin = getSupabaseAdminClient(cfEnv, true);

  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized: Invalid session" }, { status: 401 });
  }

  // 2. Rate limit: 30 requests per hour per user / IP
  const clientIp = getClientIpFromRequest(req);
  const rateLimitKey = `rate:onboarding:linkedin:${user.id}:${clientIp}`;
  const rateCheck = await checkSharedRateLimit(rateLimitKey, 30, 3600);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: "Too many updates. Please wait a few moments before trying again." },
      { status: 429 }
    );
  }

  // 3. Parse and validate JSON request
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body" }, { status: 400 });
  }

  const validation = validateAndNormalizeLinkedInUrl(body?.linkedinUrl);
  if (!validation.valid || !validation.normalizedUrl) {
    return NextResponse.json({ error: validation.error || "Invalid LinkedIn URL format" }, { status: 400 });
  }

  const normalizedUrl = validation.normalizedUrl;

  // 4. Save normalized URL to candidate_profiles and profiles
  try {
    const now = new Date().toISOString();

    // Upsert into candidate_profiles defensively
    await supabaseAdmin
      .from("candidate_profiles")
      .upsert(
        {
          user_id: user.id,
          linkedin_url: normalizedUrl,
          updated_at: now,
        },
        { onConflict: "user_id" }
      );

    // Also update public.profiles if present
    await supabaseAdmin
      .from("profiles")
      .update({ linkedin_url: normalizedUrl })
      .eq("user_id", user.id);

    log.info("Saved LinkedIn profile URL", { userId: user.id, domain: "linkedin.com" });

    return NextResponse.json({
      ok: true,
      linkedinUrl: normalizedUrl,
    });
  } catch (err: any) {
    log.error("Failed to persist LinkedIn URL", { userId: user.id, error: err?.message });
    return NextResponse.json(
      { error: "Failed to save LinkedIn profile. Please try again." },
      { status: 500 }
    );
  }
}
