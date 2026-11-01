import { createClient } from "@supabase/supabase-js";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { safeLog } from "./_logger";

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl) {
    safeLog.error("[Netlify /ticker] Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL");
    throw new Error(JSON.stringify({
      error: "Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL",
      missingVariable: "NEXT_PUBLIC_SUPABASE_URL",
    }));
  }

  if (!serviceKey) {
    safeLog.error("[Netlify /ticker] Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY");
    throw new Error(JSON.stringify({
      error: "Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY",
      missingVariable: "SUPABASE_SERVICE_ROLE_KEY",
    }));
  }

  return {
    supabase: createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    }),
    supabaseUrl,
  };
}

const CORS_OPTIONS = {
  allowedMethods: "GET, OPTIONS",
  allowedHeaders: "Content-Type",
};

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

export async function handler(event?: any) {
  const preflight = handleCorsPreflight(event, CORS_OPTIONS);
  if (preflight) return preflight;

  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=120",
    ...buildCorsHeaders(event, CORS_OPTIONS),
  };

  try {
    const { supabase, supabaseUrl } = getSupabaseAdmin();

    // 1. Query recent active jobs (including company_id for direct UUID lookup)
    const { data: jobRows, error: jobsError } = await supabase
      .from("jobs")
      .select("company, company_id, title, posted_at, created_at")
      .eq("status", "active")
      .eq("is_active", true)
      .order("posted_at", { ascending: false, nullsFirst: false })
      .limit(100);

    if (jobsError || !jobRows) {
      return {
        statusCode: 503,
        headers: {
          ...headers,
          "Cache-Control": "no-store",
        },
        body: JSON.stringify({ error: "Service unavailable" }),
      };
    }

    // 2. Collect company_ids and distinct company names
    const companyIds = Array.from(
      new Set(
        jobRows
          .map((r: any) => (r.company_id ? String(r.company_id).trim() : ""))
          .filter(Boolean)
      )
    );

    const distinctCompanyNames = Array.from(
      new Set(
        jobRows
          .map((r: any) => (r.company ? String(r.company).trim() : ""))
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
        return {
          statusCode: 503,
          headers: {
            ...headers,
            "Cache-Control": "no-store",
          },
          body: JSON.stringify({ error: "Service unavailable" }),
        };
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
        return {
          statusCode: 503,
          headers: {
            ...headers,
            "Cache-Control": "no-store",
          },
          body: JSON.stringify({ error: "Service unavailable" }),
        };
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

    const nowMs = Date.now();
    const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000; // 5 minutes

    const tickerItems: Array<{
      company: string;
      title: string;
      posted_at: string;
      logo_url: string | null;
    }> = [];
    const companyCounts = new Map<string, number>();

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
      const compKey = cleanCompany.toLowerCase();

      // Cap jobs per company: max 2 per company in the ticker's 20
      if (compKey) {
        const count = companyCounts.get(compKey) || 0;
        if (count >= 2) {
          continue;
        }
      }

      const compId = row.company_id ? String(row.company_id).trim() : "";

      let resolvedLogo: string | null = null;
      if (compId && idToLogo.has(compId)) {
        resolvedLogo = idToLogo.get(compId)!;
      } else if (cleanCompany && nameToLogo.has(cleanCompany.toLowerCase())) {
        resolvedLogo = nameToLogo.get(cleanCompany.toLowerCase())!;
      }

      if (compKey) {
        companyCounts.set(compKey, (companyCounts.get(compKey) || 0) + 1);
      }

      tickerItems.push({
        company: cleanCompany,
        title: String(row.title || "").trim(),
        posted_at: new Date(rawTimestamp).toISOString(),
        logo_url: resolvedLogo,
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(tickerItems),
    };
  } catch (err: any) {
    safeLog.error("[Netlify /ticker]", err);
    return {
      statusCode: 503,
      headers: {
        ...headers,
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        error: "temporarily unavailable",
      }),
    };
  }
}
