import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";

export const runtime = "edge";

/**
 * GET /api/billing/status
 * 
 * Returns the verified entitlement status for the current session.
 * Reads server-managed database subscriptions or verified server-signed launch passes.
 */
export async function GET(req: Request) {
  try {
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json({
        tier: "none",
        canAccessListings: false,
        canAccessScores: false,
        canAccessAi: false,
        isPro: false,
        status: "none",
        planName: "Free Tier",
        inGracePeriod: false,
      });
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
      return NextResponse.json({
        tier: "none",
        canAccessListings: false,
        canAccessScores: false,
        canAccessAi: false,
        isPro: false,
        status: "none",
        planName: "Free Tier",
        inGracePeriod: false,
      });
    }

    const launchPass = req.headers.get("x-cm-launch-pass");
    const entitlement = await getServerEntitlement(user.id, {
      launchPass,
      headers: req.headers,
    });

    return NextResponse.json(entitlement);
  } catch (err: any) {
    console.error("[Billing Status] Error checking status:", err);
    return NextResponse.json({
      tier: "none",
      canAccessListings: false,
      canAccessScores: false,
      canAccessAi: false,
      isPro: false,
      status: "none",
      planName: "Free Tier",
      inGracePeriod: false,
    });
  }
}
