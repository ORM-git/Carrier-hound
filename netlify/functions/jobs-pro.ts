import { createClient } from "@supabase/supabase-js";
import { formatSalary } from "../../src/lib/salary/parser";
import { verifyUserNotBanned } from "../../src/lib/admin/auth";
import { COUNTRY_CODE_TO_NAME, getCountryFilterClause } from "../../src/lib/countries";
import { sanitizeSearchQuery } from "../../src/lib/api/jobs";
import { normalizeUserCountries, applyEligibilityFilter } from "../../src/lib/jobs/eligibility";
import { safeLog } from "./_logger";

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

  // Check subscription table directly on server
  const { data: sub, error: subError } = await supabaseAdmin
    .from("subscriptions")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (subError || !sub) {
    return {
      error: "Pro subscription required to access full job details.",
      status: 403,
      user,
      isPro: false,
    };
  }

  const now = new Date();
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
  const graceEnd = sub.grace_period_end ? new Date(sub.grace_period_end) : null;

  const isGraceActive = sub.status === "in_grace_period" && graceEnd && graceEnd > now;
  const isActive = (sub.status === "active" || sub.status === "trialing") && (!periodEnd || periodEnd > now);

  if (!isActive && !isGraceActive) {
    return {
      error: "Subscription is expired or inactive.",
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

    // Fetch user preferences for eligibility filter and preferred currency
    let userLocations: string[] = [];
    let userSalaryCurrency: string | undefined;
    let userEligibilityPref = true;

    try {
      const { data: prefs } = await supabaseAdmin
        .from("user_preferences")
        .select("locations, eligibility_filter, salary_currency")
        .eq("user_id", authCheck.user.id)
        .maybeSingle();

      if (prefs) {
        userLocations = Array.isArray(prefs.locations) ? prefs.locations : [];
        userSalaryCurrency = prefs.salary_currency || undefined;
        userEligibilityPref = prefs.eligibility_filter !== false;
      }
    } catch {}

    if (event.httpMethod === "GET") {
      const id = event.queryStringParameters?.id;
      const countryCodeParam = event.queryStringParameters?.country_code || event.queryStringParameters?.country;
      const eligibilityParam = event.queryStringParameters?.eligibility;
      let isEligibilityActive = userEligibilityPref;
      if (eligibilityParam === "off") {
        isEligibilityActive = false;
        try {
          await supabaseAdmin.from("user_preferences").update({ eligibility_filter: false }).eq("user_id", authCheck.user.id);
        } catch {}
      } else if (eligibilityParam === "on") {
        isEligibilityActive = true;
        try {
          await supabaseAdmin.from("user_preferences").update({ eligibility_filter: true }).eq("user_id", authCheck.user.id);
        } catch {}
      }

      const preferredCurrency = event.queryStringParameters?.currency || userSalaryCurrency || undefined;

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
            return {
              statusCode: 500,
              headers,
              body: JSON.stringify({ error: "Failed to query jobs" }),
            };
          }

          let rawJobs = jobs || [];
          let appliedEligibility: { countries: string[]; filteredOut: number } | null = null;
          if (isEligibilityActive && userLocations.length > 0) {
            const filterRes = applyEligibilityFilter(rawJobs, userLocations, { filterEnabled: true });
            rawJobs = filterRes.eligibleJobs;
            appliedEligibility = filterRes.appliedEligibility;
          }

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

          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ jobs: formattedJobs, isPro: true, appliedEligibility }),
          };
        }

        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Missing required query parameter: id" }),
        };
      }

      const { data: job, error }: any = await (supabaseAdmin as any)
        .from("jobs")
        .select("id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, country_code, posted_at, first_seen_at, status, is_active")
        .eq("id", id)
        .maybeSingle();

      if (error || !job) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: "Job not found" }),
        };
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

      const { ids, eligibility: bodyEligibility, currency: bodyCurrency } = body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Missing 'ids' array" }),
        };
      }

      const eligibilityParam = event.queryStringParameters?.eligibility || bodyEligibility;
      let isEligibilityActive = userEligibilityPref;
      if (eligibilityParam === "off") {
        isEligibilityActive = false;
        try {
          await supabaseAdmin.from("user_preferences").update({ eligibility_filter: false }).eq("user_id", authCheck.user.id);
        } catch {}
      } else if (eligibilityParam === "on") {
        isEligibilityActive = true;
        try {
          await supabaseAdmin.from("user_preferences").update({ eligibility_filter: true }).eq("user_id", authCheck.user.id);
        } catch {}
      }

      const preferredCurrency = event.queryStringParameters?.currency || bodyCurrency || userSalaryCurrency || undefined;

      const { data: jobs, error }: any = await (supabaseAdmin as any)
        .from("jobs")
        .select("id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, country_code, posted_at, first_seen_at, status, is_active")
        .in("id", ids.slice(0, 100));

      if (error) {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: "Failed to retrieve unlocked jobs" }),
        };
      }

      let rawJobs = jobs || [];
      let appliedEligibility: { countries: string[]; filteredOut: number } | null = null;
      if (isEligibilityActive && userLocations.length > 0) {
        const filterRes = applyEligibilityFilter(rawJobs, userLocations, { filterEnabled: true });
        rawJobs = filterRes.eligibleJobs;
        appliedEligibility = filterRes.appliedEligibility;
      }

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

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ jobs: formattedJobs, isPro: true, appliedEligibility }),
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
