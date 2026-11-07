import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getPlanQuota } from "@/lib/billing/quota";
import { isUserApproved } from "@/lib/auth/approval";

import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";

import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { route: "/api/me/quota" } });

export const runtime = "edge";

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing Supabase service role configuration");
  }

  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}

export async function GET(req: Request) {
  try {
    const authHeader =
      req.headers.get("authorization") || req.headers.get("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Missing or invalid authorization token" },
        { status: 401 }
      );
    }

    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) {
      return NextResponse.json(
        { error: "Missing or invalid authorization token" },
        { status: 401 }
      );
    }

    const supabaseAdmin = getSupabaseAdmin();
    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return NextResponse.json(
        { error: "Invalid user session token" },
        { status: 401 }
      );
    }

    const isApproved = await isUserApproved(supabaseAdmin, user);
    if (!isApproved) {
      return NextResponse.json(
        {
          error: "Early access only",
          message: "Invite-only access: your account is pending approval.",
        },
        { status: 403 }
      );
    }

    const quota = await getPlanQuota(user.id);

    return NextResponse.json(quota, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
      },
    });
  } catch (err: any) {
    log.error("request error", { error: err?.message || String(err) });
    reportRequestErrorToSentry(req, err);
    return NextResponse.json(
      { error: "Failed to retrieve quota status" },
      { status: 500 }
    );
  }
}
