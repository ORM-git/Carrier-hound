import { createClient } from "@supabase/supabase-js";

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

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
  allowedHeaders: "Content-Type",
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

    // 1. Real active jobs count
    const { count: totalActive } = await supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .eq("status", "active");

    // 2. Real companies count from companies table
    const { count: companyCount } = await supabase
      .from("companies")
      .select("id", { count: "exact", head: true });

    // 3. Real jobs posted/created today (UTC midnight to now)
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);
    const { count: recentJobs } = await supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .eq("status", "active")
      .gte("created_at", todayMidnight.toISOString());

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
      headers,
      body: JSON.stringify({
        activeJobs: 0,
        companies: 0,
        jobsToday: 0,
        totalJobs: 0,
        companiesScanned: 0,
        error: err?.message,
      }),
    };
  }
}
