import { createClient } from "@supabase/supabase-js";

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl) {
    safeLog.error("[Netlify /stats] Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL");
    throw new Error(JSON.stringify({
      error: "Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL",
      missingVariable: "NEXT_PUBLIC_SUPABASE_URL",
    }));
  }

  if (!serviceKey) {
    safeLog.error("[Netlify /stats] Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY");
    throw new Error(JSON.stringify({
      error: "Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY",
      missingVariable: "SUPABASE_SERVICE_ROLE_KEY",
    }));
  }

  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}

import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { safeLog } from "./_logger";

const CORS_OPTIONS = {
  allowedMethods: "GET, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

export async function handler(event?: any) {
  const preflight = handleCorsPreflight(event, CORS_OPTIONS);
  if (preflight) return preflight;

  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
    ...buildCorsHeaders(event, CORS_OPTIONS),
  };

  try {
    const supabase = getSupabaseAdmin();
    const authHeader = event?.headers?.authorization || event?.headers?.Authorization;

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
        }
      } catch (authErr) {
        safeLog.warn("[Netlify /stats] Token verification error", authErr);
      }
    }

    // 1. Real jobs posted/created today (UTC midnight to now) - needed for public UI
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);
    const { count: recentJobs, error: recentErr } = await supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .eq("status", "active")
      .gte("created_at", todayMidnight.toISOString());

    if (recentErr) {
      return {
        statusCode: 503,
        headers: {
          ...headers,
          "Cache-Control": "no-store",
        },
        body: JSON.stringify({ error: "Service unavailable" }),
      };
    }

    // Anonymous caller: return ONLY fields the public UI needs
    // (jobsToday, updatedAt). Strictly DO NOT expose totalJobs, companiesScanned,
    // activeJobs, or companies (zero aggregate job counts).
    if (!isAuthenticated) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          jobsToday: recentJobs ?? 0,
          updatedAt: new Date().toISOString(),
        }),
      };
    }

    // 2. Authenticated + approved users: query and return complete corpus metrics
    const { count: totalActive, error: activeErr } = await supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .eq("status", "active");

    if (activeErr) {
      return {
        statusCode: 503,
        headers: {
          ...headers,
          "Cache-Control": "no-store",
        },
        body: JSON.stringify({ error: "Service unavailable" }),
      };
    }

    const { count: companyCount, error: companyErr } = await supabase
      .from("companies")
      .select("id", { count: "exact", head: true });

    if (companyErr) {
      return {
        statusCode: 503,
        headers: {
          ...headers,
          "Cache-Control": "no-store",
        },
        body: JSON.stringify({ error: "Service unavailable" }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        activeJobs: totalActive ?? 0,
        companies: companyCount ?? 0,
        jobsToday: recentJobs ?? 0,
        totalJobs: totalActive ?? 0,
        companiesScanned: companyCount ?? 0,
        updatedAt: new Date().toISOString(),
      }),
    };
  } catch (err: any) {
    safeLog.error("[Netlify /stats]", err);
    try {
      const parsed = JSON.parse(err?.message);
      if (parsed.missingVariable) {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify(parsed),
        };
      }
    } catch {}
    return {
      statusCode: 500,
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
