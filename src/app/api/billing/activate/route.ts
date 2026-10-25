import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { signLaunchPass, LAUNCH_DURATION_MS } from "@/lib/billing/launchPass";
import { UserTier } from "@/lib/billing/types";

export const runtime = "edge";

/**
 * POST /api/billing/activate
 * 
 * Server-backed activation endpoint for launch access with customer payments OFF.
 * Requires an authenticated user session (Bearer token).
 * Fails closed with 401 for anonymous / public callers.
 * Issues a cryptographically signed HMAC launch pass token without modifying database subscription rows.
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
      process.env.SUPABASE_ANON_KEY ||
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.dummy";

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

    let body: { tier?: UserTier } = {};
    try {
      body = await req.json();
    } catch {
      // default to listings
    }

    const requestedTier: UserTier =
      body.tier === "ai" ? "ai" : "listings";

    // Sign a launch pass token for this authenticated user
    const { token: launchToken, expiresAt } = await signLaunchPass(
      user.id,
      requestedTier,
      LAUNCH_DURATION_MS
    );

    const response = NextResponse.json({
      success: true,
      tier: requestedTier,
      token: launchToken,
      expiresAt,
      status: "active",
      planName: requestedTier === "ai" ? "Launch AI Pass" : "Launch Listings Pass",
      canAccessListings: true,
      canAccessScores: requestedTier === "ai",
      canAccessAi: requestedTier === "ai",
      isPro: true,
    });

    // Set HttpOnly cookie for seamless session persistence
    response.cookies.set("cm_launch_pass", launchToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(LAUNCH_DURATION_MS / 1000),
    });

    return response;
  } catch (err: any) {
    console.error("[Billing Activate] Error activating launch tier:", err);
    return NextResponse.json(
      { error: "Failed to activate launch tier", details: err?.message },
      { status: 500 }
    );
  }
}
