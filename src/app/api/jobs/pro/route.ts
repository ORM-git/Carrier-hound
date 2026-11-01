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

// GET: Unlocks a single job by id or returns filtered jobs for a verified Pro subscriber
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

    // Fetch user preferences for preferred currency (convert only when explicitly set, not default 'USD')
    let userSalaryCurrency: string | undefined;

    try {
      const { data: prefs } = await supabaseAdmin
        .from("user_preferences")
        .select("salary_currency")
        .eq("user_id", authCheck.user.id)
        .maybeSingle();

      if (prefs?.salary_currency && prefs.salary_currency.trim().toUpperCase() !== "USD") {
        userSalaryCurrency = prefs.salary_currency.trim().toUpperCase();
      }
    } catch {}

    const preferredCurrency = searchParams.get("currency") || userSalaryCurrency || undefined;

    if (!id) {
      if (countryCodeParam) {
        const code = sanitizeSearchQuery(countryCodeParam).toUpperCase().trim();
        let query = supabaseAdmin
          .from("jobs")
          .select("id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, country_code, posted_at, first_seen_at, status, is_active")
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

        const rawJobs = jobs || [];

        const formattedJobs = rawJobs.map((j: any) => {
          const originalSalary = formatSalary(j.salary_min, j.salary_max, j.currency, j.salary_period) || j.salary_text || null;
          const displaySalary = preferredCurrency
            ? (formatSalary(j.salary_min, j.salary_max, j.currency, j.salary_period, { displayCurrency: preferredCurrency }) || j.salary_text || null)
            : originalSalary;
          return {
            ...j,
            country: j.country_code || j.country || "",
            salary_text: displaySalary || originalSalary || "",
            salary_display: displaySalary,
            salary_original: originalSalary,
          };
        });

        return NextResponse.json({ jobs: formattedJobs, isPro: true });
      }

      return NextResponse.json({ error: "Missing required query parameter: id" }, { status: 400 });
    }

    const { data: job, error }: any = await (supabaseAdmin as any)
      .from("jobs")
      .select("id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, country_code, posted_at, first_seen_at, status, is_active")
      .eq("id", id)
      .maybeSingle();

    if (error || !job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const row: any = job;
    const originalSalary = formatSalary(row.salary_min, job.salary_max, job.currency, job.salary_period) || job.salary_text || null;
    const displaySalary = preferredCurrency
      ? (formatSalary(row.salary_min, job.salary_max, job.currency, job.salary_period, { displayCurrency: preferredCurrency }) || job.salary_text || null)
      : originalSalary;
    const isInactive = Boolean(row.is_active === false || row.status === "expired" || row.status === "closed");
    const formattedJob = {
      ...job,
      country: job.country_code || job.country || "",
      salary_text: displaySalary || originalSalary || "",
      salary_display: displaySalary,
      salary_original: originalSalary,
      isExpired: isInactive,
      is_expired: isInactive,
      status: isInactive ? "expired" : (row.status || "active"),
      apply_url: isInactive ? "" : job.apply_url,
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
    const { ids, currency: bodyCurrency } = body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { error: "Missing required parameter 'ids' (non-empty string array)" },
        { status: 400 }
      );
    }

    const supabaseAdmin = getSupabaseAdmin();

    // Fetch user preferences for preferred currency (convert only when explicitly set, not default 'USD')
    let userSalaryCurrency: string | undefined;

    try {
      const { data: prefs } = await supabaseAdmin
        .from("user_preferences")
        .select("salary_currency")
        .eq("user_id", authCheck.user.id)
        .maybeSingle();

      if (prefs?.salary_currency && prefs.salary_currency.trim().toUpperCase() !== "USD") {
        userSalaryCurrency = prefs.salary_currency.trim().toUpperCase();
      }
    } catch {}

    const { searchParams } = new URL(req.url);
    const preferredCurrency = searchParams.get("currency") || bodyCurrency || userSalaryCurrency || undefined;

    const { data: jobs, error }: any = await (supabaseAdmin as any)
      .from("jobs")
      .select("id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, country_code, posted_at, first_seen_at, status, is_active")
      .in("id", ids.slice(0, 100));

    if (error) {
      return NextResponse.json({ error: "Failed to retrieve unlocked jobs" }, { status: 500 });
    }

    const rawJobs = jobs || [];

    const formattedJobs = rawJobs.map((j: any) => {
      const originalSalary = formatSalary(j.salary_min, j.salary_max, j.currency, j.salary_period) || j.salary_text || null;
      const displaySalary = preferredCurrency
        ? (formatSalary(j.salary_min, j.salary_max, j.currency, j.salary_period, { displayCurrency: preferredCurrency }) || j.salary_text || null)
        : originalSalary;
      return {
        ...j,
        country: j.country_code || j.country || "",
        salary_text: displaySalary || originalSalary || "",
        salary_display: displaySalary,
        salary_original: originalSalary,
      };
    });

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
