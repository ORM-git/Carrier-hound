import { createClient } from "@supabase/supabase-js";
import { formatSalary } from "../../src/lib/salary/parser";
import { verifyUserNotBanned } from "../../src/lib/admin/auth";
import { safeLog } from "./_logger";
import { getServerEntitlement } from "../../src/lib/billing/serverEntitlement";

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl) {
    safeLog.error("[Netlify /jobs-pro] Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL");
    throw new Error(JSON.stringify({
      error: "Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL",
      missingVariable: "NEXT_PUBLIC_SUPABASE_URL",
    }));
  }

  if (!serviceKey) {
    safeLog.error("[Netlify /jobs-pro] Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY");
    throw new Error(JSON.stringify({
      error: "Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY",
      missingVariable: "SUPABASE_SERVICE_ROLE_KEY",
    }));
  }

  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}

async function verifyProUser(event: any) {
  const authHeader = event.headers.authorization || event.headers.Authorization;
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

  // Check subscription table or valid launch pass on server
  const entitlement = await getServerEntitlement(user.id, { headers: event.headers });
  if (!entitlement.canAccessListings) {
    return {
      error: "Pro subscription required to access full job details.",
      status: 403,
      user,
      isPro: false,
    };
  }

  return { error: null, status: 200, user, isPro: true };
}

import { buildCorsHeaders, handleCorsPreflight } from "./_cors";

const CORS_OPTIONS = {
  allowedMethods: "GET, POST, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

export async function handler(event: any) {
  const preflight = handleCorsPreflight(event, CORS_OPTIONS);
  if (preflight) return preflight;

  const headers = {
    "Content-Type": "application/json",
    ...buildCorsHeaders(event, CORS_OPTIONS),
  };


  try {
    const authCheck = await verifyProUser(event);
    if (authCheck.error || !authCheck.user) {
      return {
        statusCode: authCheck.status,
        headers,
        body: JSON.stringify({ error: authCheck.error, isPro: false }),
      };
    }

    const supabaseAdmin = getSupabaseAdmin();

    if (event.httpMethod === "GET") {
      const id = event.queryStringParameters?.id;
      if (!id) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Missing required query parameter: id" }),
        };
      }

      const { data: job, error } = await supabaseAdmin
        .from("jobs")
        .select("id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, posted_at, first_seen_at")
        .eq("id", id)
        .maybeSingle();

      if (error || !job) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: "Job not found" }),
        };
      }

      const formattedSalary = formatSalary(job.salary_min, job.salary_max, job.currency, job.salary_period) || job.salary_text;
      const formattedJob = {
        ...job,
        salary_text: formattedSalary,
      };

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ job: formattedJob, isPro: true }),
      };
    }

    if (event.httpMethod === "POST") {
      let body: any = {};
      try {
        body = JSON.parse(event.body || "{}");
      } catch (err) {
        safeLog.warn("[Netlify /jobs-pro] Request body parse error", err);
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Invalid JSON body" }),
        };
      }

      const { ids } = body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Missing 'ids' array" }),
        };
      }

      const { data: jobs, error } = await supabaseAdmin
        .from("jobs")
        .select("id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, posted_at, first_seen_at")
        .in("id", ids.slice(0, 100));

      if (error) {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: "Failed to retrieve unlocked jobs" }),
        };
      }

      const formattedJobs = (jobs || []).map((j: any) => ({
        ...j,
        salary_text: formatSalary(j.salary_min, j.salary_max, j.currency, j.salary_period) || j.salary_text,
      }));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ jobs: formattedJobs, isPro: true }),
      };
    }

    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  } catch (err: any) {
    safeLog.error("[Netlify /jobs-pro]", err);
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
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
