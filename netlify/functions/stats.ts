import { createClient } from "@supabase/supabase-js";

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing Supabase configuration");
  }

  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}

export async function handler() {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
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
        jobsToday: recentJobs ?? 0,
        totalJobs: totalActive ?? 0,
        companiesScanned: companyCount ?? 0,
        updatedAt: new Date().toISOString(),
      }),
    };
  } catch (err: any) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        jobsToday: 0,
        totalJobs: 0,
        companiesScanned: 0,
        error: err?.message,
      }),
    };
  }
}
