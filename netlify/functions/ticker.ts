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

  const query = event?.queryStringParameters || {};
  const isDistinct = query.distinct === "1" || query.distinct === "true";
  const rawLimit = query.limit ? parseInt(query.limit, 10) : 20;
  const TARGET_ITEMS = isDistinct
    ? Math.min(30, Math.max(1, isNaN(rawLimit) ? 30 : rawLimit))
    : Math.min(20, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit));
  const MAX_PER_COMPANY = isDistinct ? 1 : 2;

  const cacheControl = isDistinct
    ? "public, max-age=600, s-maxage=600, stale-while-revalidate=600"
    : "public, max-age=60, s-maxage=60, stale-while-revalidate=120";

  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": cacheControl,
    ...buildCorsHeaders(event, CORS_OPTIONS),
  };

  try {
    const { supabase, supabaseUrl } = getSupabaseAdmin();

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
          return {
            statusCode: 503,
            headers: {
              ...headers,
              "Cache-Control": "no-store",
            },
            body: JSON.stringify({ error: "Service unavailable" }),
          };
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

    const tickerItems: Array<{
      company: string;
      title: string;
      posted_at: string;
      logo_url: string | null;
    }> = [];

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
