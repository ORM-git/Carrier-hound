import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { evaluateReadiness, parseTimeoutMs } from "@/lib/health/readiness";

export const runtime = "edge";

const NO_CACHE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

const REQUIRED_ENV = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];

async function check() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  return evaluateReadiness({
    env: { NEXT_PUBLIC_SUPABASE_URL: supabaseUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey },
    requiredEnv: REQUIRED_ENV,
    timeoutMs: parseTimeoutMs(process.env.READINESS_TIMEOUT_MS),
    // Read-only: selects at most one row from the public jobs view with the anon key.
    probeDatabase: async () => {
      const supabase = createClient(supabaseUrl!, anonKey!, { auth: { persistSession: false } });
      const { error } = await supabase.from("jobs_public").select("id").limit(1);
      return !error;
    },
  });
}

// A call with no request is a build-time prerender, not a monitor. Do not probe the
// database from the build; report not ready without a network call.
const NOT_PROBED = { ready: false, checks: { env: "fail", database: "skipped" } } as const;

export async function GET(req: Request) {
  const result = req ? await check() : NOT_PROBED;
  return new NextResponse(
    JSON.stringify({ status: result.ready ? "ready" : "not_ready", checks: result.checks }),
    { status: result.ready ? 200 : 503, headers: NO_CACHE_HEADERS }
  );
}

export async function HEAD(req: Request) {
  const result = req ? await check() : NOT_PROBED;
  return new NextResponse(null, { status: result.ready ? 200 : 503, headers: NO_CACHE_HEADERS });
}
