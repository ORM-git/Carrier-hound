import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getPlanQuota } from "@/lib/billing/quota";

import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";

import { createLogger } from "@/lib/observability/logger";

const baseLog = createLogger({ context: { route: "/api/me/quota" } });

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
  // Launch scope gate: AI usage quota is Coming Soon
  return NextResponse.json(
    { error: "This feature is coming soon.", code: "FEATURE_COMING_SOON" },
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
      },
    }
  );
}
