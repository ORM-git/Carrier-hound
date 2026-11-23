import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/ai/serviceHandler";
import { checkAccountOnboardingCompleted } from "@/lib/auth/onboarding";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { route: "/api/account/status" } });

export const runtime = "edge";

const CACHE_CONTROL_HEADER = "private, no-cache, no-store, must-revalidate";

function jsonResponse(data: any, status: number = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": CACHE_CONTROL_HEADER,
    },
  });
}

function isMissingTombstoneTable(err: any): boolean {
  if (!err) return false;
  const msg = String(err.message || "").toLowerCase();
  return (
    err.code === "42P01" ||
    err.code === "PGRST204" ||
    err.code === "PGRST205" ||
    msg.includes("does not exist") ||
    msg.includes("relation")
  );
}

export async function GET(req: Request) {
  let cfEnv: Record<string, any> | undefined;
  try {
    const ctx = getRequestContext();
    if (ctx?.env) {
      cfEnv = ctx.env as Record<string, any>;
    }
  } catch {}

  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "Unauthorized: Missing authentication token" }, 401);
  }

  const token = authHeader.replace("Bearer ", "").trim();
  let supabaseAdmin: any;
  try {
    supabaseAdmin = getSupabaseAdminClient(cfEnv, true);
  } catch (err: any) {
    log.error("Database service unavailable in /api/account/status", { error: err?.message || err });
    return jsonResponse({ error: "Database service unavailable" }, 503);
  }

  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    return jsonResponse({ error: "Unauthorized: Invalid session" }, 401);
  }

  const userId = user.id;

  // 1. Inspect deletion marker under server authority (service_role)
  try {
    const { data: tombstone, error: tombstoneErr } = await supabaseAdmin
      .from("deleted_account_tombstones")
      .select("user_id, created_at, deletion_completed_at")
      .eq("user_id", userId)
      .is("purged_at", null)
      .maybeSingle();

    if (tombstoneErr && !isMissingTombstoneTable(tombstoneErr)) {
      log.error("Failed to query deleted_account_tombstones under server authority", {
        code: tombstoneErr.code,
        message: tombstoneErr.message,
      });
      return jsonResponse({ error: "Service temporarily unavailable" }, 503);
    }

    if (tombstone) {
      return jsonResponse({
        onboardingCompleted: false,
        deletionPending: true,
        accountState: "deletion_pending",
      });
    }
  } catch (err: any) {
    log.error("Unexpected error verifying tombstone state", { error: err?.message || err });
    return jsonResponse({ error: "Service temporarily unavailable" }, 503);
  }

  // 2. Evaluate onboarding completion
  const completed = await checkAccountOnboardingCompleted(supabaseAdmin, userId);

  return jsonResponse({
    onboardingCompleted: completed,
    deletionPending: false,
    accountState: "active",
  });
}
