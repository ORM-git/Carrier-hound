import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { SIGNING_SECRET_ENV_NAME } from "@/lib/billing/launchPass";
import { UserTier } from "@/lib/billing/types";

export const runtime = "edge";

/**
 * POST /api/billing/activate
 * 
 * Server-backed activation endpoint for launch access.
 * 
 * SECURITY CONTROLS:
 * 1. Requires an authenticated user session (Bearer JWT). Anonymous / unauthenticated callers fail closed (401).
 * 2. Requires dedicated LAUNCH_PASS_SECRET. Missing secret fails closed (503). Zero dummy/fallback keys.
 * 3. Enforces Owner Eligibility Policy: Self-activation is BLOCKED pending an owner-approved eligibility
 *    policy and database registry schema. No open, unapproved, repeated grants.
 * 4. Existing paid subscribers remain active and verified via Supabase subscriptions table.
 */
export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Authentication required to activate launch access", code: "AUTH_REQUIRED" },
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

    const supabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
    });

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return NextResponse.json(
        { error: "Invalid or expired user session", code: "INVALID_SESSION" },
        { status: 401 }
      );
    }

    // Check dedicated signing secret existence (never log its value or length)
    const signingSecret =
      process.env[SIGNING_SECRET_ENV_NAME] ||
      (typeof process !== "undefined" && process?.env?.[SIGNING_SECRET_ENV_NAME]);
    if (!signingSecret) {
      return NextResponse.json(
        {
          error: `Missing required launch pass signing secret: ${SIGNING_SECRET_ENV_NAME}`,
          missingVariable: SIGNING_SECRET_ENV_NAME,
          code: "MISSING_SIGNING_SECRET",
        },
        { status: 503 }
      );
    }

    // STOP UNAPPROVED OPEN GRANTS:
    // Self-activation is blocked pending owner-approved eligibility policy and server-side registry.
    // Unapproved audience, duration, and renewal rules are strictly prevented.
    return NextResponse.json(
      {
        error:
          "Launch access self-activation is blocked pending owner-approved eligibility policy and server registry schema.",
        code: "ACTIVATION_BLOCKED_PENDING_POLICY",
        status: "blocked",
        missingPrerequisites: [
          "OWNER_ELIGIBILITY_POLICY",
          "LAUNCH_PASS_REGISTRY_TABLE",
        ],
      },
      { status: 403 }
    );
  } catch (err: any) {
    console.error("[Billing Activate] Error processing activation request:", err);
    return NextResponse.json(
      { error: "Failed to process activation request", details: err?.message },
      { status: 500 }
    );
  }
}
