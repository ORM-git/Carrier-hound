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

  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}

const CORS_OPTIONS = {
  allowedMethods: "GET, OPTIONS",
  allowedHeaders: "Content-Type",
};

export async function handler(event?: any) {
  const preflight = handleCorsPreflight(event, CORS_OPTIONS);
  if (preflight) return preflight;

  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=120",
    ...buildCorsHeaders(event, CORS_OPTIONS),
  };

  try {
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from("jobs")
      .select("company, title, posted_at, created_at, companies(logo_url)")
      .eq("status", "active")
      .eq("is_active", true)
      .order("posted_at", { ascending: false, nullsFirst: false })
      .limit(20);

    let rows: any[] | null = (data as any) || null;

    if (error) {
      const fallback = await supabase
        .from("jobs")
        .select("company, title, posted_at, created_at")
        .eq("status", "active")
        .eq("is_active", true)
        .order("posted_at", { ascending: false, nullsFirst: false })
        .limit(20);

      if (fallback.error || !fallback.data) {
        return {
          statusCode: 503,
          headers: {
            ...headers,
            "Cache-Control": "no-store",
          },
          body: JSON.stringify({ error: "Service unavailable" }),
        };
      }
      rows = fallback.data as any;
    }

    if (!rows) {
      return {
        statusCode: 503,
        headers: {
          ...headers,
          "Cache-Control": "no-store",
        },
        body: JSON.stringify({ error: "Service unavailable" }),
      };
    }

    const tickerItems = rows.slice(0, 20).map((row: any) => {
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
