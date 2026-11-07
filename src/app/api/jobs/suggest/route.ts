import { NextResponse } from "next/server";
import { measureRouteBudget } from "@/lib/api/routeBudget";
import { createClient } from "@supabase/supabase-js";
import { checkRequiredEnv } from "@/lib/api/envCheck";
import { getClientIpFromRequest, checkRateLimit } from "@/lib/ai/serviceHandler";
import { checkSharedRateLimit } from "@/lib/api/sharedRateLimit";

import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { route: "/api/jobs/suggest" } });

export const runtime = "edge";

/**
 * GET /api/jobs/suggest (Backend row "Autocomplete / Prefix Search").
 *
 * Public, read-only prefix suggestions over job TITLES only. Queries the
 * jobs_public view (the same masked surface anonymous search uses), so no
 * paid fields (company, salary, description, apply URL) can ever appear.
 * Not wired to any frontend surface yet - no visible change.
 *
 * The accompanying migration 20261106k (pg_trgm + GIN index on
 * public.jobs(title)) is a performance enabler only: prefix ilike works
 * with or without it, so this endpoint is safe before the migration is
 * applied.
 */

// Chosen defaults (labeled per owner rule): bounded to keep the endpoint
// cheap and the payload small.
const MIN_QUERY_LEN = 2;
const MAX_QUERY_LEN = 40;
const SUGGESTION_COUNT = 10;
const CANDIDATE_ROWS = 50; // over-fetch before case-insensitive dedupe
const SUGGEST_RATE_LIMIT = { maxRequests: 60, windowSeconds: 60 };
const suggestRateLimitStore = new Map<string, { count: number; resetAt: number }>();

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  const missing = checkRequiredEnv(
    {
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    },
    "API /jobs/suggest"
  );
  if (missing) {
    throw new Error(JSON.stringify(missing));
  }

  return createClient(supabaseUrl!, serviceKey!, {
    auth: { persistSession: false },
  });
}

/** Escapes ilike metacharacters so user input is matched literally. */
function escapeIlike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function getHandler(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();

  if (q.length < MIN_QUERY_LEN || q.length > MAX_QUERY_LEN) {
    return NextResponse.json(
      { error: "Query must be 2-40 characters." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const clientIp = getClientIpFromRequest(req);
  const ipLimit = await checkSharedRateLimit(
    `suggest:ip:${clientIp}`,
    SUGGEST_RATE_LIMIT.maxRequests,
    SUGGEST_RATE_LIMIT.windowSeconds,
    () =>
      checkRateLimit(
        clientIp,
        suggestRateLimitStore,
        SUGGEST_RATE_LIMIT.maxRequests,
        SUGGEST_RATE_LIMIT.windowSeconds * 1000
      )
  );
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please try again shortly.", retryAfter: ipLimit.retryAfter },
      {
        status: 429,
        headers: { "Retry-After": String(ipLimit.retryAfter), "Cache-Control": "no-store" },
      }
    );
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("jobs_public")
      .select("title")
      .ilike("title", `${escapeIlike(q)}%`)
      .order("posted_at", { ascending: false, nullsFirst: false })
      .limit(CANDIDATE_ROWS);

    if (error) {
      log.warn("query failed", { error: error.message });
      return NextResponse.json(
        { error: "Suggestions unavailable." },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }

    const seen = new Set<string>();
    const suggestions: string[] = [];
    for (const row of data || []) {
      const title = typeof row.title === "string" ? row.title.trim() : "";
      if (!title) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push(title);
      if (suggestions.length >= SUGGESTION_COUNT) break;
    }

    return NextResponse.json(
      { suggestions },
      { status: 200, headers: { "Cache-Control": "public, max-age=60" } }
    );
  } catch (err: any) {
    log.warn("unexpected failure", { error: err?.message || String(err) });
    return NextResponse.json(
      { error: "Suggestions unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function GET(req: Request) {
  return measureRouteBudget("/api/jobs/suggest", () => getHandler(req));
}
