import { NextResponse } from "next/server";
import { measureRouteBudget } from "@/lib/api/routeBudget";
import { createClient } from "@supabase/supabase-js";
import { checkRequiredEnv } from "@/lib/api/envCheck";
import { getClientIpFromRequest, checkRateLimit } from "@/lib/ai/serviceHandler";
import {
  checkSharedRateLimit,
  STATS_RATE_LIMIT,
  statsRateLimitStore,
} from "@/lib/api/sharedRateLimit";
import { isUserApproved } from "@/lib/auth/approval";
import { computeWeakEtag, notModifiedResponse } from "@/lib/api/etag";

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
 * - Anonymous callers: ONLY fields the public UI needs (jobsToday, updatedAt).
 *   Strictly DO NOT expose totalJobs, companiesScanned, activeJobs, or companies
 *   (zero aggregate platform corpus exposure).
 * - Authenticated + approved callers: Complete live corpus metrics.
 * - Authenticated + unapproved callers: 403 Early access only.
 */
async function getHandler(req: Request) {
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
    const authHeader = req?.headers?.get("authorization") || req?.headers?.get("Authorization");

    let isAuthenticated = false;
    let isApproved = false;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.replace("Bearer ", "").trim();
      try {
        const {
          data: { user },
          error: userErr,
        } = await supabase.auth.getUser(token);

        if (user && !userErr) {
          isAuthenticated = true;
          isApproved = await isUserApproved(supabase, user);
          if (!isApproved) {
            return NextResponse.json(
              {
                error: "Early access only",
                message: "Invite-only access: your account is pending approval.",
              },
              {
                status: 403,
                headers: {
                  "Cache-Control": "no-store",
                },
              }
            );
          }
        }
      } catch (authErr) {
        console.warn("[API /stats] Token verification error:", authErr);
      }
    }

    // 1. Jobs posted/created today (UTC midnight to now) - required for public UI
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

    // Anonymous or unapproved: return ONLY fields the public UI needs
    // (jobsToday, updatedAt). Strictly DO NOT expose totalJobs, companiesScanned,
    // activeJobs, or companies (zero aggregate job counts).
    if (!isAuthenticated || !isApproved) {
      // Identical body for every anonymous caller: safe for weak ETag / 304.
      const publicStats = {
        jobsToday: recentJobs ?? 0,
        updatedAt: new Date().toISOString(),
      };
      const publicHeaders = {
        "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
      };
      const etag = await computeWeakEtag(publicStats);
      const notModified = notModifiedResponse(req, etag, publicHeaders);
      if (notModified) return notModified;
      return NextResponse.json(publicStats, {
        headers: { ...publicHeaders, ETag: etag },
      });
    }

    // 2. Authenticated + approved callers: return full corpus metrics
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

    return NextResponse.json(
      {
        activeJobs: totalActive ?? 0,
        companies: companyCount ?? 0,
        jobsToday: recentJobs ?? 0,
        totalJobs: totalActive ?? 0,
        companiesScanned: companyCount ?? 0,
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

export async function GET(req: Request) {
  return measureRouteBudget("/api/stats", () => getHandler(req));
}
