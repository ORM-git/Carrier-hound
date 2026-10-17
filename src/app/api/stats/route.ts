import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "edge";

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

/**
 * GET /api/stats
 * 
 * Computes strictly real counts from active jobs and companies:
 * - totalJobs: Real exact active jobs from jobs_public
 * - companiesScanned: Real count from companies table
 * - jobsToday: Real count of jobs created/ingested today (UTC midnight to now)
 * ZERO invented activity numbers, zero fake multipliers, and zero fabricated fallbacks.
 */
export async function GET() {
  try {
    const supabase = getSupabaseAdmin();

    // 1. Total active jobs
    const { count: totalActive } = await supabase
      .from("jobs_public")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .eq("status", "active");

    // 2. Total companies registered
    const { count: companyCount } = await supabase
      .from("companies")
      .select("id", { count: "exact", head: true });

    // 3. Jobs posted/created today (UTC midnight to now)
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);
    const { count: recentJobs } = await supabase
      .from("jobs_public")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .eq("status", "active")
      .gte("created_at", todayMidnight.toISOString());

    const totalJobs = totalActive ?? 0;
    const companiesScanned = companyCount ?? 0;
    // Strictly real count computed from database
    const jobsToday = recentJobs ?? 0;

    return NextResponse.json(
      {
        jobsToday,
        totalJobs,
        companiesScanned,
        updatedAt: new Date().toISOString(),
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
        },
      }
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        jobsToday: 0,
        totalJobs: 0,
        companiesScanned: 0,
        updatedAt: new Date().toISOString(),
        error: err?.message,
      },
      { status: 500 }
    );
  }
}
