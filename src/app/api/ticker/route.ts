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
export const revalidate = 600;

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

  return {
    supabase: createClient(supabaseUrl!, serviceKey!, {
      auth: { persistSession: false },
    }),
    supabaseUrl: supabaseUrl!,
  };
}

export interface TickerJobItem {
  company: string;
  title: string;
  posted_at: string;
  logo_url: string | null;
}

/**
 * Validates that logo_url strictly points to the project storage host under /company-logos/.
 * Rejects external logos, javascript: schemes, or other buckets.
 */
function sanitizeLogoUrl(rawLogoUrl: string | null | undefined, supabaseUrl?: string): string | null {
  if (!rawLogoUrl || typeof rawLogoUrl !== "string") return null;
  try {
    const parsed = new URL(rawLogoUrl);
    if (supabaseUrl) {
      try {
        const expectedHost = new URL(supabaseUrl).host;
        if (parsed.host !== expectedHost && !parsed.host.endsWith(".supabase.co")) {
          return null;
        }
      } catch {
        if (!parsed.host.endsWith(".supabase.co")) {
          return null;
        }
      }
    } else {
      if (!parsed.host.endsWith(".supabase.co")) {
        return null;
      }
    }

    if (!parsed.pathname.includes("/company-logos/")) {
      return null;
    }
    return rawLogoUrl;
  } catch {
    return null;
  }
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
 * Matches companies by company_id where available, with case-insensitive name fallback.
 * Returns logo_url only if it points to the project storage host under /company-logos/.
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

    const { supabase, supabaseUrl } = getSupabaseAdmin();

    const url = req?.url ? new URL(req.url) : null;
    const isDistinct = url?.searchParams.get("distinct") === "1" || url?.searchParams.get("distinct") === "true";
    const rawLimit = url?.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 20;
    const TARGET_ITEMS = isDistinct
      ? Math.min(30, Math.max(1, isNaN(rawLimit) ? 30 : rawLimit))
      : Math.min(20, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit));
    const MAX_PER_COMPANY = isDistinct ? 1 : 2;
    const PAGE_SIZE = 100;
    const MAX_CANDIDATE_ROWS = 500;
    const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000; // 5 minutes
    const nowMs = Date.now();

    const selectedRows: Array<{
      company: string;
      cleanCompany: string;
      company_id?: string | null;
      title: string;
      rawTimestamp: string;
    }> = [];
    const companyCounts = new Map<string, number>();
    const seenJobKeys = new Set<string>();

    let offset = 0;
    while (selectedRows.length < TARGET_ITEMS && offset < MAX_CANDIDATE_ROWS) {
      const from = offset;
      const to = Math.min(offset + PAGE_SIZE - 1, MAX_CANDIDATE_ROWS - 1);

      const { data: pageRows, error: jobsError } = await supabase
        .from("jobs")
        .select("id, company, company_id, title, posted_at, created_at")
        .eq("status", "active")
        .eq("is_active", true)
        .order("posted_at", { ascending: false, nullsFirst: false })
        .range(from, to);

      if (jobsError || !pageRows) {
        if (selectedRows.length === 0 && offset === 0) {
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
        break;
      }

      if (pageRows.length === 0) {
        break;
      }

      let newRowsInBatch = 0;
      for (const row of pageRows) {
        const rowKey = row.id ? String(row.id) : `${row.company}-${row.title}-${row.posted_at || row.created_at}`;
        if (seenJobKeys.has(rowKey)) {
          continue;
        }
        seenJobKeys.add(rowKey);
        newRowsInBatch++;

        if (selectedRows.length >= TARGET_ITEMS) {
          break;
        }

        const rawTimestamp = row.posted_at || row.created_at;
        if (!rawTimestamp) {
          continue;
        }

        const timeMs = new Date(rawTimestamp).getTime();
        if (isNaN(timeMs)) {
          continue;
        }

        if (timeMs > nowMs + MAX_FUTURE_SKEW_MS) {
          continue;
        }

        const cleanCompany = String(row.company || "").trim();
        const compKey = cleanCompany.toLowerCase();

        if (compKey) {
          const count = companyCounts.get(compKey) || 0;
          if (count >= MAX_PER_COMPANY) {
            continue;
          }
          companyCounts.set(compKey, count + 1);
        }

        selectedRows.push({
          company: row.company,
          cleanCompany,
          company_id: row.company_id,
          title: row.title,
          rawTimestamp,
        });
      }

      if (newRowsInBatch === 0) {
        break;
      }

      if (pageRows.length < (to - from + 1)) {
        break;
      }

      offset += pageRows.length;
    }

    // 2. Collect company_ids and distinct company names for the selected rows
    const companyIds = Array.from(
      new Set(
        selectedRows
          .map((r) => (r.company_id ? String(r.company_id).trim() : ""))
          .filter(Boolean)
      )
    );

    const distinctCompanyNames = Array.from(
      new Set(
        selectedRows
          .map((r) => r.cleanCompany)
          .filter(Boolean)
      )
    );

    const idToLogo = new Map<string, string>();
    const nameToLogo = new Map<string, string>();

    // 2a. Match by company_id where available
    if (companyIds.length > 0) {
      const { data: idData, error: idError } = await supabase
        .from("companies")
        .select("id, name, logo_url")
        .in("id", companyIds);

      if (idError) {
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

      if (idData) {
        for (const c of idData) {
          const validLogo = sanitizeLogoUrl(c.logo_url, supabaseUrl);
          if (validLogo) {
            idToLogo.set(String(c.id), validLogo);
            if (c.name) {
              nameToLogo.set(String(c.name).trim().toLowerCase(), validLogo);
            }
          }
        }
      }
    }

    // 2b. Match by name case variants for companies without company_id or not yet matched
    if (distinctCompanyNames.length > 0) {
      const searchNames = new Set<string>();
      for (const name of distinctCompanyNames) {
        searchNames.add(name);
        searchNames.add(name.toLowerCase());
        searchNames.add(name.toUpperCase());
        searchNames.add(name.charAt(0).toUpperCase() + name.slice(1).toLowerCase());
      }

      const { data: nameData, error: nameError } = await supabase
        .from("companies")
        .select("id, name, logo_url")
        .in("name", Array.from(searchNames));

      if (nameError) {
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

      if (nameData) {
        for (const c of nameData) {
          const validLogo = sanitizeLogoUrl(c.logo_url, supabaseUrl);
          if (validLogo) {
            if (c.id && !idToLogo.has(String(c.id))) {
              idToLogo.set(String(c.id), validLogo);
            }
            if (c.name) {
              nameToLogo.set(String(c.name).trim().toLowerCase(), validLogo);
            }
          }
        }
      }
    }

    const tickerItems: TickerJobItem[] = [];

    for (const row of selectedRows) {
      const compId = row.company_id ? String(row.company_id).trim() : "";
      const cleanCompany = row.cleanCompany;

      let resolvedLogo: string | null = null;
      if (compId && idToLogo.has(compId)) {
        resolvedLogo = idToLogo.get(compId)!;
      } else if (cleanCompany && nameToLogo.has(cleanCompany.toLowerCase())) {
        resolvedLogo = nameToLogo.get(cleanCompany.toLowerCase())!;
      }

      tickerItems.push({
        company: cleanCompany,
        title: String(row.title || "").trim(),
        posted_at: new Date(row.rawTimestamp).toISOString(),
        logo_url: resolvedLogo,
      });
    }

    const cacheHeader = isDistinct
      ? "public, max-age=600, s-maxage=600, stale-while-revalidate=600"
      : "public, max-age=60, s-maxage=60, stale-while-revalidate=120";

    return NextResponse.json(tickerItems, {
      headers: {
        "Cache-Control": cacheHeader,
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
