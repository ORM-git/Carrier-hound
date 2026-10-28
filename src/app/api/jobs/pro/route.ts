import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";
import { formatSalary } from "@/lib/salary/parser";
import { verifyUserNotBanned } from "@/lib/admin/auth";
import { COUNTRY_CODE_TO_NAME, getCountryFilterClause } from "@/lib/countries";
import { sanitizeSearchQuery } from "@/lib/api/jobs";

import { checkRequiredEnv } from "@/lib/api/envCheck";

export const runtime = "edge";

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  const missing = checkRequiredEnv(
    {
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    },
    "API /jobs/pro"
  );
  if (missing) {
    throw new Error(JSON.stringify(missing));
  }

  return createClient(supabaseUrl, serviceKey!, {
    auth: { persistSession: false },
  });
}

async function verifyProUser(req: Request) {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { error: "Missing or invalid authorization token", status: 401, user: null };
  }

  const token = authHeader.replace("Bearer ", "").trim();
  const supabaseAdmin = getSupabaseAdmin();

  const {
    data: { user },
    error: userError,
  } = await supabaseAdmin.auth.getUser(token);

  if (userError || !user) {
    return { error: "Invalid or expired session. Please sign in again.", status: 401, user: null };
  }

  // Ban check (fails closed on lookup error)
  const banCheck = await verifyUserNotBanned(supabaseAdmin, user.id, user.user_metadata);
  if (banCheck.isBlocked) {
    return {
      error: banCheck.error || "Account suspended. Access revoked by administrator.",
      status: banCheck.isServiceUnavailable ? 503 : 403,
      user: null,
      isPro: false,
    };
  }

  // Server-managed subscription check — ONLY source of truth
  const entitlement = await getServerEntitlement(user.id);
  if (!entitlement.isPro) {
    return {
      error: "Pro subscription required to access full job details.",
      status: 403,
      user,
      isPro: false,
    };
  }

  return { error: null, status: 200, user, isPro: true };
}

// GET: Unlocks a single job by id for a verified Pro subscriber
export async function GET(req: Request) {
  try {
    const authCheck = await verifyProUser(req);
    if (authCheck.error || !authCheck.user) {
      return NextResponse.json(
        { error: authCheck.error, isPro: false },
        { status: authCheck.status }
      );
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    const countryCodeParam = searchParams.get("country_code") || searchParams.get("country");

    const supabaseAdmin = getSupabaseAdmin();

    if (!id) {
      if (countryCodeParam) {
        const code = sanitizeSearchQuery(countryCodeParam).toUpperCase().trim();
        let query = supabaseAdmin
          .from("jobs")
          .select("id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, country_code, posted_at, first_seen_at")
          .eq("status", "active")
          .eq("is_active", true);

        const orClause = getCountryFilterClause(code);
        if (orClause) {
          query = query.or(orClause);
        } else {
          query = query.eq("country_code", code);
        }

        const { data: jobs, error } = await query.order("posted_at", { ascending: false, nullsFirst: false }).limit(50);
        if (error) {
          return NextResponse.json({ error: "Failed to query jobs" }, { status: 500 });
        }

        const formattedJobs = (jobs || []).map((j: any) => ({
          ...j,
          country: j.country_code || j.country || "",
          salary_text: formatSalary(j.salary_min, j.salary_max, j.currency, j.salary_period) || j.salary_text,
        }));

        return NextResponse.json({ jobs: formattedJobs, isPro: true });
      }

      return NextResponse.json({ error: "Missing required query parameter: id" }, { status: 400 });
    }

    const { data: job, error } = await supabaseAdmin
      .from("jobs")
      .select("id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, country_code, posted_at, first_seen_at")
      .eq("id", id)
      .maybeSingle();

    if (error || !job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const formattedSalary = formatSalary(job.salary_min, job.salary_max, job.currency, job.salary_period) || job.salary_text;
    const formattedJob = {
      ...job,
      country: job.country_code || job.country || "",
      salary_text: formattedSalary,
    };

    return NextResponse.json({ job: formattedJob, isPro: true });
  } catch (err: any) {
    try {
      const parsed = JSON.parse(err?.message);
      if (parsed.missingVariable) {
        return NextResponse.json(parsed, { status: 500 });
      }
    } catch {}
    console.error("[API /jobs/pro GET error]:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST: Unlocks a list of jobs by IDs for a verified Pro subscriber
export async function POST(req: Request) {
  try {
    const authCheck = await verifyProUser(req);
    if (authCheck.error || !authCheck.user) {
      return NextResponse.json(
        { error: authCheck.error, isPro: false },
        { status: authCheck.status }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { ids } = body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { error: "Missing required parameter 'ids' (non-empty string array)" },
        { status: 400 }
      );
    }

    const supabaseAdmin = getSupabaseAdmin();
    const { data: jobs, error } = await supabaseAdmin
      .from("jobs")
      .select("id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, country_code, posted_at, first_seen_at")
      .in("id", ids.slice(0, 100));

    if (error) {
      return NextResponse.json({ error: "Failed to retrieve unlocked jobs" }, { status: 500 });
    }

    const formattedJobs = (jobs || []).map((j: any) => ({
      ...j,
      country: j.country_code || j.country || "",
      salary_text: formatSalary(j.salary_min, j.salary_max, j.currency, j.salary_period) || j.salary_text,
    }));

    return NextResponse.json({ jobs: formattedJobs, isPro: true });
  } catch (err: any) {
    try {
      const parsed = JSON.parse(err?.message);
      if (parsed.missingVariable) {
        return NextResponse.json(parsed, { status: 500 });
      }
    } catch {}
    console.error("[API /jobs/pro POST error]:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
