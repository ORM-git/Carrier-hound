/**
 * Self-serve "log out everywhere" (Backend sheet rank 74 - Session
 * Revocation). signOut() only ever ended the CURRENT session; a user who
 * lost a device or suspects token theft had no way to revoke every other
 * session. This handler revokes all of the caller's sessions via the
 * admin API with scope "global" (GoTrue invalidates every refresh token
 * belonging to the JWT's owner; live access tokens expire within their
 * normal TTL).
 *
 * Auth: the caller's own Bearer access token - the same JWT is passed to
 * admin.signOut, which is what binds revocation to the caller's account.
 * Mirrors the export handler's envelope, rate limiting and fail modes.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkRequiredEnv } from "@/lib/api/envCheck";
import { checkSharedRateLimit } from "@/lib/api/sharedRateLimit";

function getSupabaseAdmin() {
  if (process.env.NODE_ENV === "test" && (globalThis as any).__mockSupabaseClient) {
    return (globalThis as any).__mockSupabaseClient;
  }

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  const missing = checkRequiredEnv(
    {
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    },
    "API /account/signout-all"
  );
  if (missing) {
    throw new Error(JSON.stringify(missing));
  }

  return createClient(supabaseUrl, serviceKey!, {
    auth: { persistSession: false },
  });
}

/** Chosen default: revocation is rare; 5/hour per user is generous. */
export const SIGNOUT_ALL_RATE_LIMIT = { maxRequests: 5, windowSeconds: 3600 } as const;

export interface SignoutAllRouteDeps {
  getSupabaseAdmin?: () => any;
  checkLimit?: typeof checkSharedRateLimit;
}

export async function handleSignoutAllRequest(
  req: Request,
  deps: SignoutAllRouteDeps = {}
) {
  try {
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { success: false, error: "Unauthorized. Missing or invalid authorization header." },
        { status: 401 }
      );
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const adminGetter = deps.getSupabaseAdmin || getSupabaseAdmin;
    const supabaseAdmin = adminGetter();

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return NextResponse.json(
        { success: false, error: "Invalid or expired session. Please sign in again." },
        { status: 401 }
      );
    }

    const check = deps.checkLimit ?? checkSharedRateLimit;
    const limit = await check(
      `account_signout_all:user:${user.id}`,
      SIGNOUT_ALL_RATE_LIMIT.maxRequests,
      SIGNOUT_ALL_RATE_LIMIT.windowSeconds
    );
    if (!limit.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: "Too many requests. Please try again later.",
          retryAfter: limit.retryAfter,
        },
        { status: 429 }
      );
    }

    const { error: signOutError } = await supabaseAdmin.auth.admin.signOut(token, "global");
    if (signOutError) {
      return NextResponse.json(
        { success: false, error: "Could not sign out everywhere right now. Please try again." },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || "Internal server error" },
      { status: 500 }
    );
  }
}
