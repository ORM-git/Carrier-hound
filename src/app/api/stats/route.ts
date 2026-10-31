import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkRequiredEnv } from "@/lib/api/envCheck";
import { getClientIpFromRequest, checkRateLimit } from "@/lib/ai/serviceHandler";
import {
  checkSharedRateLimit,
  STATS_RATE_LIMIT,
  statsRateLimitStore,
} from "@/lib/api/sharedRateLimit";

export const runtime = "edge";

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;

  const missing = checkRequiredEnv(
    {
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    },
    "API /stats"
  );
  if (missing) {
    throw new Error(JSON.stringify(missing));
  }

  return createClient(supabaseUrl!, serviceKey!, {
    auth: { persistSession: false },
  });
}

/**
 * GET /api/stats
 * 
 * Public read-only endpoint returning strictly real counts:
 * - activeJobs: Real exact active jobs from jobs_public
 * - companies: Real count from companies table
 * ZERO invented activity numbers, zero fake multipliers, and zero fabricated fallbacks.
 * Publicly accessible to signed-out visitors, rate limited, Cache-Control 5 min.
 */
export async function GET(req: Request) {
  try {
    if (req) {
      const clientIp = getClientIpFromRequest(req);
      const ipLimit = await checkSharedRateLimit(
        `stats:ip:${clientIp}`,
        STATS_RATE_LIMIT.maxRequests,
        STATS_RATE_LIMIT.windowSeconds,
        () =>
          checkRateLimit(
            clientIp,
            statsRateLimitStore,
            STATS_RATE_LIMIT.maxRequests,
            STATS_RATE_LIMIT.windowSeconds * 1000
          )
      );

      if (!ipLimit.allowed) {
        return NextResponse.json(
          {
            error: "Rate limit exceeded. Please try again shortly.",
            retryAfter: ipLimit.retryAfter,
          },
          {
            status: 429,
            headers: {
              "Retry-After": String(ipLimit.retryAfter),
              "Cache-Control": "no-store",
            },
          }
        );
      }
    }

    const supabase = getSupabaseAdmin();

    // 1. Total active jobs
    const { count: totalActive, error: activeErr } = await supabase
      .from("jobs_public")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .eq("status", "active");

    if (activeErr) {
      return NextResponse.json(
        { error: "Service unavailable" },
        {
          status: 503,
          headers: {
            "Cache-Control": "no-store",
          },
        }
      );
    }

    // 2. Total companies registered
    const { count: companyCount, error: companyErr } = await supabase
      .from("companies")
      .select("id", { count: "exact", head: true });

    if (companyErr) {
      return NextResponse.json(
        { error: "Service unavailable" },
        {
          status: 503,
          headers: {
            "Cache-Control": "no-store",
          },
        }
      );
    }

    // 3. Jobs posted/created today (UTC midnight to now)
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);
    const { count: recentJobs, error: recentErr } = await supabase
      .from("jobs_public")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .eq("status", "active")
      .gte("created_at", todayMidnight.toISOString());

    if (recentErr) {
      return NextResponse.json(
        { error: "Service unavailable" },
        {
          status: 503,
          headers: {
            "Cache-Control": "no-store",
          },
        }
      );
    }

    const activeJobs = totalActive ?? 0;
    const companies = companyCount ?? 0;
    const jobsToday = recentJobs ?? 0;

    return NextResponse.json(
      {
        activeJobs,
        companies,
        totalJobs: activeJobs,
        companiesScanned: companies,
        jobsToday,
        updatedAt: new Date().toISOString(),
      },
      {
        headers: {
          "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
        },
      }
    );
  } catch (err: any) {
    try {
      const parsed = JSON.parse(err?.message);
      if (parsed.missingVariable) {
        return NextResponse.json(parsed, { status: 500 });
      }
    } catch {}
    return NextResponse.json(
      {
        error: "temporarily unavailable",
      },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }
}
