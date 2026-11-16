import { NextResponse } from "next/server";
import { measureRouteBudget } from "@/lib/api/routeBudget";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { checkRequiredEnv } from "@/lib/api/envCheck";
import { getClientIpFromRequest, checkRateLimit } from "@/lib/ai/serviceHandler";
import {
  checkSharedRateLimit,
  STATS_RATE_LIMIT,
  statsRateLimitStore,
} from "@/lib/api/sharedRateLimit";
import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";
import { withRouteSpan } from "@/lib/monitoring/tracing";
import { computeWeakEtag, notModifiedResponse } from "@/lib/api/etag";

import { createLogger } from "@/lib/observability/logger";
import { singleFlight } from "@/lib/cache/singleFlight";

const baseLog = createLogger({ context: { route: "/api/stats" } });

export const runtime = "edge";

let cachedStatsAdminClient: SupabaseClient | null = null;
let cachedStatsAdminKey = "";
const STATS_CACHE_TTL_MS = 60_000;
let cachedRecentCount: { value: number; expiresAt: number } | null = null;
let cachedCorpusCounts: { totalActive: number; companyCount: number; expiresAt: number } | null = null;

function getSupabaseAdmin(): SupabaseClient {
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

  const cacheKey = `${supabaseUrl}::${serviceKey}`;
  if (cachedStatsAdminClient && cachedStatsAdminKey === cacheKey && process.env.NODE_ENV !== "test") {
    return cachedStatsAdminClient;
  }
  const client = createClient(supabaseUrl!, serviceKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  cachedStatsAdminClient = client;
  cachedStatsAdminKey = cacheKey;
  return client;
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
  const log = baseLog.child({ requestId: req?.headers.get("x-request-id") ?? "unknown" });
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
              Vary: "Authorization",
            },
          }
        );
      }
    }

    const supabase = getSupabaseAdmin();
    const authHeader = req?.headers?.get("authorization") || req?.headers?.get("Authorization");

    let isAuthenticated = false;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.replace("Bearer ", "").trim();
      try {
        const {
          data: { user },
          error: userErr,
        } = await supabase.auth.getUser(token);

        if (user && !userErr) {
          isAuthenticated = true;
        }
      } catch (authErr) {
        log.warn("Token verification error", { error: String(authErr) });
      }
    }

    // 1. Jobs posted/created today (UTC midnight to now) - required for public UI
    let recentJobs: number | null = null;
    let recentErr: any = null;
    if (process.env.NODE_ENV !== "test" && cachedRecentCount && cachedRecentCount.expiresAt > Date.now()) {
      recentJobs = cachedRecentCount.value;
    } else {
      const todayMidnight = new Date();
      todayMidnight.setUTCHours(0, 0, 0, 0);
      const res = await singleFlight("stats:recentJobs", async () =>
        supabase
          .from("jobs_public")
          .select("id", { count: "exact", head: true })
          .eq("is_active", true)
          .eq("status", "active")
          .gte("created_at", todayMidnight.toISOString())
      );
      recentJobs = res.count;
      recentErr = res.error;
      if (!recentErr && process.env.NODE_ENV !== "test") {
        cachedRecentCount = { value: recentJobs ?? 0, expiresAt: Date.now() + STATS_CACHE_TTL_MS };
      }
    }

    if (recentErr) {
      return NextResponse.json(
        { error: "Service unavailable" },
        {
          status: 503,
          headers: {
            "Cache-Control": "no-store",
            Vary: "Authorization",
          },
        }
      );
    }

    // Anonymous: return ONLY fields the public UI needs
    // (jobsToday, updatedAt). Strictly DO NOT expose totalJobs, companiesScanned,
    // activeJobs, or companies (zero aggregate job counts).
    if (!isAuthenticated) {
      // Identical body for every anonymous caller: safe for weak ETag / 304.
      const publicStats = {
        jobsToday: recentJobs ?? 0,
        updatedAt: new Date().toISOString(),
      };
      // Edge-cacheable ONLY when the request carries no Authorization header at
      // all: any Authorization header, valid or invalid, keeps the response
      // no-store so an authed context never poisons the shared cache. The TTL
      // values are chosen defaults (rank 42 review decision), not measured.
      const publicHeaders = {
        "Cache-Control": authHeader
          ? "no-store"
          : "public, s-maxage=60, stale-while-revalidate=300",
        Vary: "Authorization",
      };
      const etag = await computeWeakEtag(publicStats);
      const notModified = notModifiedResponse(req, etag, publicHeaders);
      if (notModified) return notModified;
      return NextResponse.json(publicStats, {
        headers: { ...publicHeaders, ETag: etag },
      });
    }

    // 2. Authenticated + approved callers: return full corpus metrics
    let totalActive: number | null = null;
    let companyCount: number | null = null;
    if (process.env.NODE_ENV !== "test" && cachedCorpusCounts && cachedCorpusCounts.expiresAt > Date.now()) {
      totalActive = cachedCorpusCounts.totalActive;
      companyCount = cachedCorpusCounts.companyCount;
    } else {
      const [activeRes, companyRes] = await singleFlight("stats:corpusCounts", async () =>
        Promise.all([
          supabase
            .from("jobs_public")
            .select("id", { count: "exact", head: true })
            .eq("is_active", true)
            .eq("status", "active"),
          supabase
            .from("companies")
            .select("id", { count: "exact", head: true }),
        ])
      );

      if (activeRes.error || companyRes.error) {
        return NextResponse.json(
          { error: "Service unavailable" },
          {
            status: 503,
            headers: {
              "Cache-Control": "no-store",
              Vary: "Authorization",
            },
          }
        );
      }
      totalActive = activeRes.count;
      companyCount = companyRes.count;
      if (process.env.NODE_ENV !== "test") {
        cachedCorpusCounts = {
          totalActive: totalActive ?? 0,
          companyCount: companyCount ?? 0,
          expiresAt: Date.now() + STATS_CACHE_TTL_MS,
        };
      }
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
          "Cache-Control": "no-store",
          Vary: "Authorization",
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
    reportRequestErrorToSentry(req, err);
    return NextResponse.json(
      {
        error: "temporarily unavailable",
      },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store",
          Vary: "Authorization",
        },
      }
    );
  }
}

export async function GET(req: Request) {
  return withRouteSpan("/api/stats", req, () =>
    measureRouteBudget("/api/stats", () => getHandler(req))
  );
}
