import { createClient as createAdminSupabaseClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";
import { noteAdminAuthFailure } from "../security/authMonitor";
import { isLockedOut, recordFailureAndMaybeLock } from "../security/progressiveLockout";
import { getRequestIp } from "../security/authMonitor";
import {
  ADMIN_EMAIL,
  ADMIN_EMAIL_LIST,
  getAdminEmailSet,
  isEmailInAdminList,
  isUserEmailVerified,
  isVerifiedAdminUser,
} from "./constants";

import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "admin/auth" } });

export {
  ADMIN_EMAIL,
  ADMIN_EMAIL_LIST,
  getAdminEmailSet,
  isEmailInAdminList,
  isUserEmailVerified,
  isVerifiedAdminUser,
};

/**
 * Returns a server-side Supabase admin client using the service role key.
 */
export function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!serviceKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for admin operations");
  }

  return createAdminSupabaseClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}

/**
 * Extracts a token from Authorization header or Cookie header.
 */
export function extractToken(req?: Request): string | null {
  if (!req) return null;

  // 1. Check Authorization Bearer header
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.replace("Bearer ", "").trim();
  }

  // 2. Check Cookie header for Supabase session token
  const cookieHeader = req.headers.get("cookie");
  if (cookieHeader) {
    const cookiePairs = cookieHeader.split(";").map((c) => c.trim());

    // Check for combined or chunked sb-*-auth-token cookies
    const chunkMap: { [key: number]: string } = {};
    let singleVal: string | null = null;

    for (const c of cookiePairs) {
      const eqIdx = c.indexOf("=");
      if (eqIdx === -1) continue;
      const key = c.slice(0, eqIdx);
      const val = c.slice(eqIdx + 1);

      if (key.startsWith("sb-") && key.includes("-auth-token")) {
        const chunkMatch = key.match(/-auth-token\.(\d+)$/);
        if (chunkMatch) {
          chunkMap[parseInt(chunkMatch[1], 10)] = val;
        } else {
          singleVal = val;
        }
      }
    }

    let fullVal = singleVal;
    if (!fullVal && Object.keys(chunkMap).length > 0) {
      const sortedKeys = Object.keys(chunkMap).map(Number).sort((a, b) => a - b);
      fullVal = sortedKeys.map((k) => chunkMap[k]).join("");
    }

    if (fullVal) {
      try {
        const decoded = decodeURIComponent(fullVal);
        let payloadStr = decoded;
        if (payloadStr.startsWith("base64-")) {
          const b64 = payloadStr.slice(7);
          payloadStr = Buffer.from(b64, "base64url").toString("utf-8");
        }
        if (payloadStr.startsWith("[") || payloadStr.startsWith("{")) {
          const parsed = JSON.parse(payloadStr);
          const token = parsed?.access_token || (Array.isArray(parsed) ? parsed[0] : null);
          if (token) return token;
        }
        return payloadStr;
      } catch (_) {
        return fullVal;
      }
    }
  }

  return null;
}

/**
 * Verifies if the request is authorized as a verified Admin:
 * - Signed-in user's email must be in the admin list (case-insensitive)
 * - Signed-in user's email must be verified (email_confirmed_at / confirmed_at)
 */
export async function verifyAdminSession(req?: Request): Promise<{
  isAdmin: boolean;
  user: User | null;
  error?: string;
}> {
  try {
    const adminClient = getSupabaseAdmin();
    const token = extractToken(req);

    // Progressive lockout (Backend sheet rank 68): an IP whose failed
    // admin verifications tripped a lockout step is denied before any
    // token work. Fail-open internally - store outage never locks out.
    const lock = await isLockedOut("admin", getRequestIp(req));
    if (lock.locked) {
      return { isAdmin: false, user: null, error: "Forbidden: Verified admin access required." };
    }

    if (token) {
      const {
        data: { user },
        error,
      } = await adminClient.auth.getUser(token);
      if (!error && user && isVerifiedAdminUser(user)) {
        return { isAdmin: true, user };
      }
    }

    // ATO monitoring: count failed admin verifications. This is awaited,
    // fully caught internally, and does not change the auth decision.
    await noteAdminAuthFailure(req, token);
    // Progressive lockout counter (rank 68): records this failure and
    // escalates when a step trips. Also awaited, fail-open internally.
    await recordFailureAndMaybeLock("admin", getRequestIp(req));

    return { isAdmin: false, user: null, error: "Forbidden: Verified admin access required." };
  } catch (err: any) {
    return { isAdmin: false, user: null, error: err?.message || "Internal auth check failure" };
  }
}

export interface BanCheckResult {
  isBlocked: boolean;
  isServiceUnavailable?: boolean;
  error?: string;
}

/**
 * Cheap ban verification helper that checks the exact sources written by the admin ban action:
 * 1. user_metadata.is_blocked (0 DB round trips if userMetadata provided)
 * 2. blocked_users indexed table (1 cheap indexed lookup)
 * Fails closed on database or network error (returns isServiceUnavailable: true).
 */
export async function verifyUserNotBanned(
  supabaseAdmin: any,
  userId: string,
  userMetadata?: any
): Promise<BanCheckResult> {
  if (!userId) return { isBlocked: false };

  // 1. In-memory check on user_metadata (0 DB round trips)
  if (userMetadata?.is_blocked === true) {
    return {
      isBlocked: true,
      error: "Account suspended. Access revoked by administrator.",
    };
  }

  // 2. Cheap single-row indexed lookup on blocked_users table (1 DB round trip)
  try {
    const { data: blockedRow, error } = await supabaseAdmin
      .from("blocked_users")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      log.warn("[Ban Check] Database error checking blocked_users; failing closed:", { error: error });
      return {
        isBlocked: true,
        isServiceUnavailable: true,
        error: "Security verification service is temporarily unavailable. Please try again shortly.",
      };
    }

    if (blockedRow) {
      return {
        isBlocked: true,
        error: "Account suspended. Access revoked by administrator.",
      };
    }

    return { isBlocked: false };
  } catch (err: any) {
    log.warn("[Ban Check] Network or database exception; failing closed:", { error: err });
    return {
      isBlocked: true,
      isServiceUnavailable: true,
      error: "Security verification service is temporarily unavailable. Please try again shortly.",
    };
  }
}

/**
 * Checks whether a given user is blocked or banned.
 * Fails closed (returns true) on error to prevent unauthorized access.
 */
export async function isUserBlocked(userId: string, customAdmin?: any): Promise<boolean> {
  if (!userId) return false;

  try {
    const admin = customAdmin || getSupabaseAdmin();
    const result = await verifyUserNotBanned(admin, userId);
    return result.isBlocked;
  } catch (err) {
    log.warn("[Ban Check] Error checking isUserBlocked; failing closed:", { error: err });
    return true;
  }
}
