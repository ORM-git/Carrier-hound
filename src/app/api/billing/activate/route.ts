import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { UserTier } from "@/lib/billing/types";

export const runtime = "edge";

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

// In-memory rate limiting for activation attempts (10 requests per 60s per user/IP)
const activationRateLimitStore = new Map<string, RateLimitBucket>();

function checkActivationRateLimit(key: string): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 10;
  const bucket = activationRateLimitStore.get(key);

  if (!bucket || bucket.resetAt < now) {
    activationRateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }

  if (bucket.count >= maxRequests) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  bucket.count++;
  return { allowed: true, retryAfter: 0 };
}

/**
 * POST /api/billing/activate
 * 
 * Simple Server-Backed Launch Access Tier Selection Endpoint
 * 
 * OWNER DECISION & SPECIFICATION:
 * - Every signed-in user may choose Listings or AI and use actual features free for now.
 * - Payment will be enabled in a future release.
 * - AI tier includes listings; Listings tier receives no scores or AI.
 * 
 * SECURITY CONTROLS:
 * 1. Derives user ID strictly from the verified session (JWT / Bearer token), NEVER from the request body.
 * 2. Only 'listings' or 'ai' are accepted as valid tier selections.
 * 3. Idempotent tier selection: users may switch between supported tiers at any time.
 * 4. Fails closed with 403 LAUNCH_POLICY_DISABLED if the server launch policy is disabled or unconfigured.
 * 5. Fails closed with 403 LAUNCH_ACCESS_REVOKED if the account has been individually revoked for abuse.
 * 6. Fails closed with 503 STORAGE_UNAVAILABLE if the storage table is not yet migrated.
 * 7. Rate-limited to prevent abuse.
 * 8. Access source is labeled 'launch_access', NOT a paid subscription or payment success.
 */
export async function POST(req: Request) {
  try {
    // 1. Authenticate Session
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Authentication required to select a launch access tier", code: "AUTH_REQUIRED" },
        { status: 401 }
      );
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      "https://szakevhxhwpeskidvtfs.supabase.co";
    const anonKey =
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_ANON_KEY;

    if (!anonKey) {
      return NextResponse.json(
        {
          error: "Missing required environment variable: NEXT_PUBLIC_SUPABASE_ANON_KEY",
          missingVariable: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
          code: "MISSING_ENV_CONFIG",
        },
        { status: 500 }
      );
    }

    const supabaseAuthClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
    });

    const {
      data: { user },
      error: userError,
    } = await supabaseAuthClient.auth.getUser(token);

    if (userError || !user) {
      return NextResponse.json(
        { error: "Invalid or expired user session", code: "INVALID_SESSION" },
        { status: 401 }
      );
    }

    // Rate limit keyed by verified user ID
    const rl = checkActivationRateLimit(user.id);
    if (!rl.allowed) {
      return NextResponse.json(
        {
          error: "Too many tier selection requests. Please wait before retrying.",
          code: "RATE_LIMITED",
          retryAfter: rl.retryAfter,
        },
        {
          status: 429,
          headers: { "Retry-After": String(rl.retryAfter) },
        }
      );
    }

    // 2. Parse & Validate Request Payload
    // CRITICAL: Ignore any user_id / userId in body; derive solely from verified session
    const body = await req.json().catch(() => ({}));
    const requestedTier = body?.tier;

    if (requestedTier !== "listings" && requestedTier !== "ai") {
      return NextResponse.json(
        {
          error: "Invalid tier selection. Allowed values are 'listings' or 'ai'.",
          code: "INVALID_TIER",
        },
        { status: 400 }
      );
    }

    const tier: UserTier = requestedTier;

    // 3. Resolve Admin / Service Role Client
    const serviceRoleKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY;

    if (!serviceRoleKey) {
      return NextResponse.json(
        {
          error: "Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY",
          missingVariable: "SUPABASE_SERVICE_ROLE_KEY",
          code: "MISSING_ENV_CONFIG",
        },
        { status: 503 }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    // 4. Server-Side Policy Check (launch_policy)
    const { data: policy, error: policyError } = await supabaseAdmin
      .from("launch_policy")
      .select("is_enabled, allow_ai, allow_listings")
      .limit(1)
      .maybeSingle();

    if (policyError || !policy || !policy.is_enabled) {
      return NextResponse.json(
        {
          error: "Launch access is currently disabled or pending database policy deployment.",
          code: "LAUNCH_POLICY_DISABLED",
          status: "disabled",
          missingPrerequisites: ["LAUNCH_POLICY_TABLE"],
        },
        { status: 403 }
      );
    }

    if (tier === "ai" && policy.allow_ai === false) {
      return NextResponse.json(
        {
          error: "The AI access tier is currently disabled by launch policy.",
          code: "AI_TIER_DISABLED",
        },
        { status: 403 }
      );
    }

    if (tier === "listings" && policy.allow_listings === false) {
      return NextResponse.json(
        {
          error: "The Listings access tier is currently disabled by launch policy.",
          code: "LISTINGS_TIER_DISABLED",
        },
        { status: 403 }
      );
    }

    // 5. Individual Revocation Check for Abuse
    const { data: existingAccess, error: accessCheckError } = await supabaseAdmin
      .from("user_launch_access")
      .select("id, tier, revoked_at, revocation_reason")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!accessCheckError && existingAccess?.revoked_at) {
      return NextResponse.json(
        {
          error: "Launch access has been revoked for this account.",
          code: "LAUNCH_ACCESS_REVOKED",
          revokedAt: existingAccess.revoked_at,
          revocationReason: existingAccess.revocation_reason || "Revoked by administrator",
        },
        { status: 403 }
      );
    }

    // 6. Idempotent Server-Side Storage of Selection
    const { error: upsertError } = await supabaseAdmin
      .from("user_launch_access")
      .upsert(
        {
          user_id: user.id,
          tier: tier,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

    if (upsertError) {
      return NextResponse.json(
        {
          error: "Launch access storage is unavailable or pending database migration.",
          code: "STORAGE_UNAVAILABLE",
          missingPrerequisites: ["USER_LAUNCH_ACCESS_TABLE"],
        },
        { status: 503 }
      );
    }

    // 7. Success Response
    // Labeled strictly as launch_access, NOT paid subscription / payment success
    return NextResponse.json({
      success: true,
      tier,
      canAccessListings: true,
      canAccessScores: tier === "ai",
      canAccessAi: tier === "ai",
      isPro: true,
      status: "none", // Explicitly not a paid subscription
      accessSource: "launch_access",
      planName: tier === "ai" ? "Launch Access (AI Tier)" : "Launch Access (Listings Tier)",
      message: "Launch access tier selected successfully.",
    });
  } catch (err: any) {
    console.error("[Billing Activate] Error processing tier selection:", err);
    return NextResponse.json(
      { error: "Failed to process launch tier selection", details: err?.message },
      { status: 500 }
    );
  }
}
