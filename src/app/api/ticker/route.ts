import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkRequiredEnv } from "@/lib/api/envCheck";
import { getClientIpFromRequest, checkRateLimit } from "@/lib/ai/serviceHandler";
import {
  checkSharedRateLimit,
  TICKER_RATE_LIMIT,
  tickerRateLimitStore,
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
    "API /ticker"
  );
  if (missing) {
    throw new Error(JSON.stringify(missing));
  }

  return createClient(supabaseUrl!, serviceKey!, {
    auth: { persistSession: false },
  });
}

export interface TickerJobItem {
  company: string;
  title: string;
  posted_at: string;
  logo_url: string | null;
}

/**
 * GET /api/ticker
 *
 * Public read-only endpoint returning max 20 rows of recent active jobs:
 * strictly company + title + posted_at + logo_url only.
 * No ids, emails, or apply links.
 * Cache 60s, no-store and 503 on error.
 * Drops rows without posted_at or created_at.
 * Clamps future-dated timestamps within 5 minutes; drops rows further in the future.
 * Merges self-hosted company logos from companies table via case-insensitive lookup.
 */
export async function GET(req: Request) {
  try {
    if (req) {
      const clientIp = getClientIpFromRequest(req);
      const ipLimit = await checkSharedRateLimit(
        `ticker:ip:${clientIp}`,
        TICKER_RATE_LIMIT.maxRequests,
        TICKER_RATE_LIMIT.windowSeconds,
        () =>
          checkRateLimit(
            clientIp,
            tickerRateLimitStore,
            TICKER_RATE_LIMIT.maxRequests,
            TICKER_RATE_LIMIT.windowSeconds * 1000
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

    // 1. Query recent active jobs (no FK embed)
    const { data: jobRows, error: jobsError } = await supabase
      .from("jobs")
      .select("company, title, posted_at, created_at")
      .eq("status", "active")
      .eq("is_active", true)
      .order("posted_at", { ascending: false, nullsFirst: false })
      .limit(50);

    if (jobsError || !jobRows) {
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

    // 2. Collect distinct company names and query companies for logo_url
    const distinctCompanies = Array.from(
      new Set(
        jobRows
          .map((r: any) => (r.company ? String(r.company).trim() : ""))
          .filter(Boolean)
      )
    );

    const logoMap = new Map<string, string>();

    if (distinctCompanies.length > 0) {
      const searchNames = new Set<string>();
      for (const name of distinctCompanies) {
        searchNames.add(name);
        searchNames.add(name.toLowerCase());
        searchNames.add(name.toUpperCase());
        searchNames.add(name.charAt(0).toUpperCase() + name.slice(1).toLowerCase());
      }

      const { data: companyData, error: companiesError } = await supabase
        .from("companies")
        .select("name, logo_url")
        .in("name", Array.from(searchNames));

      if (companiesError) {
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

      if (companyData) {
        for (const c of companyData) {
          if (c.name && c.logo_url) {
            logoMap.set(c.name.trim().toLowerCase(), c.logo_url);
          }
        }
      }
    }

    const nowMs = Date.now();
    const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000; // 5 minutes

    const tickerItems: TickerJobItem[] = [];

    for (const row of jobRows) {
      if (tickerItems.length >= 20) break;

      // Drop rows that have neither posted_at nor created_at instead of falling back to now()
      const rawTimestamp = row.posted_at || row.created_at;
      if (!rawTimestamp) {
        continue;
      }

      const timeMs = new Date(rawTimestamp).getTime();
      if (isNaN(timeMs)) {
        continue;
      }

      // Drop rows further than 5 minutes in the future
      if (timeMs > nowMs + MAX_FUTURE_SKEW_MS) {
        continue;
      }

      const cleanCompany = String(row.company || "").trim();
      const logoUrl = logoMap.get(cleanCompany.toLowerCase()) || null;

      tickerItems.push({
        company: cleanCompany,
        title: String(row.title || "").trim(),
        posted_at: new Date(rawTimestamp).toISOString(),
        logo_url: logoUrl,
      });
    }

    return NextResponse.json(tickerItems, {
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=120",
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        error: "temporarily unavailable",
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }
}
