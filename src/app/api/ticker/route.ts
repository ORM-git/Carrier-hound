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

    // Query up to 20 active jobs ordered by posted_at desc with optional foreign company logo
    const { data, error } = await supabase
      .from("jobs")
      .select("company, title, posted_at, created_at, companies(logo_url)")
      .eq("status", "active")
      .eq("is_active", true)
      .order("posted_at", { ascending: false, nullsFirst: false })
      .limit(20);

    let rows: any[] | null = (data as any) || null;

    if (error) {
      // If error was caused by relation embedding in certain environments, attempt fallback query without foreign relation
      const fallback = await supabase
        .from("jobs")
        .select("company, title, posted_at, created_at")
        .eq("status", "active")
        .eq("is_active", true)
        .order("posted_at", { ascending: false, nullsFirst: false })
        .limit(20);

      if (fallback.error || !fallback.data) {
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
      rows = fallback.data as any;
    }

    if (!rows) {
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

    // Strictly map to company + title + posted_at + logo_url only (max 20 rows, NO other fields)
    const tickerItems: TickerJobItem[] = rows.slice(0, 20).map((row: any) => {
      let logoUrl: string | null = null;
      if (row.companies) {
        if (Array.isArray(row.companies) && row.companies.length > 0) {
          logoUrl = row.companies[0]?.logo_url || null;
        } else if (typeof row.companies === "object" && row.companies.logo_url) {
          logoUrl = row.companies.logo_url;
        }
      } else if (row.logo_url) {
        logoUrl = row.logo_url;
      }

      return {
        company: String(row.company || "").trim(),
        title: String(row.title || "").trim(),
        posted_at: row.posted_at || row.created_at || new Date().toISOString(),
        logo_url: logoUrl || null,
      };
    });

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
