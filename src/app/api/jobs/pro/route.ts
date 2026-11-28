import { leanProListFields } from "@/lib/jobs/leanList";
import { loadDisplayScoreAnswers, sharedDisplayScore } from "@/lib/jobs/displayScore";
import { NextResponse } from "next/server";
import { scoreInputRevision } from "@/lib/matcher/scoring";
import { createClient } from "@supabase/supabase-js";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";
import { formatSalary } from "@/lib/salary/parser";
import { verifyUserNotBanned } from "@/lib/admin/auth";
import { getCountryFilterClause } from "@/lib/countries";
import { sanitizeSearchQuery } from "@/lib/api/jobs";
import { detectCompanyCategory, detectRoleCategory, extractTopKeywords } from "@/lib/jobs/highVolumeEnrichment";

import { checkRequiredEnv } from "@/lib/api/envCheck";

import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";
import { withRouteSpan } from "@/lib/monitoring/tracing";

import { createLogger } from "@/lib/observability/logger";
import { evaluateCompanyProfileFreshness } from "@/lib/company-profile/enrichment";
import { isEligibleCompanyJob, sanitizeCompanyProfile, type CompanyProfile } from "@/lib/company-profile/types";
import { VISIBLE_SOURCE_FILTER } from "@/lib/jobs/sourcePolicy";

const baseLog = createLogger({ context: { route: "/api/jobs/pro" } });

export const runtime = "edge";

/** Cloudflare bindings (the only place server flags live there), same as the feed routes. Undefined outside Cloudflare. */
async function getCfEnv(): Promise<Record<string, any> | undefined> {
  try {
    // Loaded lazily: the package only works inside the Cloudflare runtime, and importing it must never break the route.
    const { getRequestContext } = await import("@cloudflare/next-on-pages");
    const ctx = getRequestContext();
    return ctx?.env ? (ctx.env as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

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

function resolveDescription(jobDescription: any, descriptionText: any): string {
  if (typeof jobDescription === "string" && jobDescription.trim().length > 0) {
    return jobDescription;
  }
  if (typeof descriptionText === "string" && descriptionText.trim().length > 0) {
    return descriptionText;
  }
  return "";
}

async function loadJobDescriptionsMap(supabaseAdmin: any, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const validIds = Array.from(new Set(ids.filter(Boolean)));
  if (validIds.length === 0) return map;

  try {
    const { data: descRows } = await (supabaseAdmin as any)
      .from("job_descriptions")
      .select("job_id, description_text")
      .in("job_id", validIds);

    if (Array.isArray(descRows)) {
      for (const row of descRows) {
        if (row?.job_id && typeof row.description_text === "string") {
          map.set(row.job_id, row.description_text);
        }
      }
    }
  } catch {}

  return map;
}

async function loadCompanyProfiles(supabaseAdmin: any, jobs: any[], currentJobId?: string) {
  const companyIds = Array.from(new Set(jobs.map((job) => job?.company_id).filter((id): id is string => typeof id === "string" && id.length > 0)));
  if (!companyIds.length) return new Map<string, CompanyProfile>();
  const [factsResult, leadersResult, newsResult, refreshResult] = await Promise.all([
    supabaseAdmin.from("company_profile_facts").select("company_id,fact_key,fact_value,source_url,source_kind,retrieved_at,observed_at,fact_status,conflict_value,conflict_source_url,conflict_source_kind,conflict_retrieved_at,conflict_observed_at").in("company_id", companyIds),
    supabaseAdmin.from("company_profile_leadership").select("id,company_id,name,role,role_as_of,source_url,retrieved_at").in("company_id", companyIds).order("role_as_of", { ascending: false, nullsFirst: false }).limit(120),
    supabaseAdmin.from("company_profile_news").select("id,company_id,headline,published_at,source_url,excerpt,retrieved_at").in("company_id", companyIds).order("published_at", { ascending: false }).limit(80),
    supabaseAdmin.from("company_profile_refresh_state").select("company_id,status,last_attempted_at,last_succeeded_at,next_refresh_at,last_error").in("company_id", companyIds),
  ]);
  const jobsByCompany = new Map<string, CompanyProfile["jobs"]>();
  if (currentJobId && companyIds.length === 1) {
    const companyId = companyIds[0];
    try {
      const { data: sameCompanyJobs, error } = await supabaseAdmin.from("jobs")
        .select("id,company_id,status,is_active,title,company,location,posted_at,companies(logo_url)").or(VISIBLE_SOURCE_FILTER)
        .eq("company_id", companyId).eq("status", "active").eq("is_active", true).neq("id", currentJobId)
        .order("posted_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).limit(5);
      jobsByCompany.set(companyId, error ? { status: "error", jobs: [] } : {
        status: "ready",
        jobs: (sameCompanyJobs || []).filter((job: any) => isEligibleCompanyJob(job, companyId, currentJobId)).slice(0, 5).map((job: any) => ({ id: job.id, title: job.title || "Untitled Position", company: job.company || "", location: job.location || "", postedAt: job.posted_at || null, logoUrl: job.companies?.logo_url || null })),
      });
    } catch {
      jobsByCompany.set(companyId, { status: "error", jobs: [] });
    }
  }
  const result = new Map<string, CompanyProfile>();
  for (const companyId of companyIds) {
    const facts: Record<string, any> = {};
    for (const row of factsResult.data || []) if (row.company_id === companyId) facts[row.fact_key] = { value: row.fact_value, sourceUrl: row.source_url, sourceKind: row.source_kind, retrievedAt: row.retrieved_at, observedAt: row.observed_at, status: row.fact_status, conflict: row.conflict_value ? { value: row.conflict_value, sourceUrl: row.conflict_source_url, sourceKind: row.conflict_source_kind, retrievedAt: row.conflict_retrieved_at, observedAt: row.conflict_observed_at } : null };
    const leaderRows = (leadersResult.data || []).filter((row: any) => row.company_id === companyId);
    const newsRows = (newsResult.data || []).filter((row: any) => row.company_id === companyId);
    const leadership = leaderRows.slice(0, 12).map((row: any) => ({ id: row.id, name: row.name, role: row.role, roleAsOf: row.role_as_of, sourceUrl: row.source_url, retrievedAt: row.retrieved_at }));
    const news = newsRows.slice(0, 8).map((row: any) => ({ id: row.id, headline: row.headline, publishedAt: row.published_at, sourceUrl: row.source_url, excerpt: row.excerpt }));
    const jobs = jobsByCompany.get(companyId) || { status: "unknown" as const, jobs: [] };
    const refreshState = (refreshResult.data || []).find((row: any) => row.company_id === companyId);
    const freshness = evaluateCompanyProfileFreshness({ now: new Date().toISOString(), state: refreshState, facts: Object.fromEntries(Object.entries(facts).map(([key, fact]: [string, any]) => [key, { retrievedAt: fact.retrievedAt, status: fact.status }])), leadership: leaderRows.map((row: any) => ({ retrievedAt: row.retrieved_at })), news: newsRows.map((row: any) => ({ publishedAt: row.published_at, retrievedAt: row.retrieved_at })) });
    result.set(companyId, sanitizeCompanyProfile({ companyId, facts, leadership, news, jobs, freshness: freshness.status })!);
  }
  return result;
}


// GET: Unlocks a single job by id or returns filtered jobs for a verified Pro subscriber
export async function GET(req: Request) {
  return withRouteSpan("/api/jobs/pro", req, async () => {
    const log = baseLog.child({ requestId: req?.headers.get("x-request-id") ?? "unknown" });
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
    const displayAnswers = await loadDisplayScoreAnswers(supabaseAdmin, authCheck.user.id, await getCfEnv());
    // One reference instant per response: every score and revision below is computed at it.
    const scoredAt = Date.now();

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
          .select("id, company_id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, country_code, posted_at, first_seen_at, status, is_active, role_category, top_keywords, is_remote, logo_url, companies(name, logo_url, category, canonical_domain, domain)").or(VISIBLE_SOURCE_FILTER)
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
        const descMap = await loadJobDescriptionsMap(supabaseAdmin, rawJobs.map((j: any) => j.id));
        const profileMap = await loadCompanyProfiles(supabaseAdmin, rawJobs);

        const formattedJobs = rawJobs.map((j: any) => {
          const originalSalary = formatSalary(j.salary_min, j.salary_max, j.currency, j.salary_period) || j.salary_text || null;
          const displaySalary = preferredCurrency
            ? (formatSalary(j.salary_min, j.salary_max, j.currency, j.salary_period, { displayCurrency: preferredCurrency }) || j.salary_text || null)
            : originalSalary;
          const resolvedDesc = resolveDescription(j.description, descMap.get(j.id));
          return {
            ...j,
            companyProfile: j.company_id ? profileMap.get(j.company_id) || null : null,
            description: resolvedDesc,
            scoreRevision: scoreInputRevision(j, true, scoredAt),
            matchScore: sharedDisplayScore(j, displayAnswers, true, scoredAt),
            role_category: j.role_category || detectRoleCategory(j.title, j.category, j.skills),
            top_keywords: Array.isArray(j.top_keywords) && j.top_keywords.length > 0
              ? j.top_keywords.slice(0, 8)
              : extractTopKeywords(j.title, resolvedDesc, j.skills, 8),
            is_remote: Boolean(j.is_remote ?? j.remote),
            company_category: j.companies?.category || detectCompanyCategory(j.company, null, null, j.country_code),
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
      .select("id, company_id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, country_code, posted_at, first_seen_at, status, is_active, role_category, top_keywords, is_remote, logo_url, companies(name, logo_url, category, canonical_domain, domain)").or(VISIBLE_SOURCE_FILTER)
      .eq("id", id)
      .maybeSingle();

    if (error || !job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const descMap = await loadJobDescriptionsMap(supabaseAdmin, [job.id]);
    const profileMap = await loadCompanyProfiles(supabaseAdmin, [job], job.id);

    const row: any = job;
    const originalSalary = formatSalary(row.salary_min, job.salary_max, job.currency, job.salary_period) || job.salary_text || null;
    const displaySalary = preferredCurrency
      ? (formatSalary(row.salary_min, job.salary_max, job.currency, job.salary_period, { displayCurrency: preferredCurrency }) || job.salary_text || null)
      : originalSalary;
    const isInactive = Boolean(row.is_active === false || row.status === "expired" || row.status === "closed");
    const resolvedSingleDesc = resolveDescription(job.description, descMap.get(job.id));
    const formattedJob = {
      ...job,
      companyProfile: job.company_id ? profileMap.get(job.company_id) || null : null,
      description: resolvedSingleDesc,
      scoreRevision: scoreInputRevision(row, true, scoredAt),
      matchScore: sharedDisplayScore(row, displayAnswers, true, scoredAt),
      role_category: job.role_category || detectRoleCategory(job.title, job.category, job.skills),
      top_keywords: Array.isArray(job.top_keywords) && job.top_keywords.length > 0
        ? job.top_keywords.slice(0, 8)
        : extractTopKeywords(job.title, resolvedSingleDesc, job.skills, 8),
      is_remote: Boolean(job.is_remote ?? job.remote),
      company_category: job.companies?.category || detectCompanyCategory(job.company, null, null, job.country_code),
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
    log.error("GET error", { error: err?.message || String(err) });
    reportRequestErrorToSentry(req, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  });
}

// POST: Unlocks a list of jobs by IDs for a verified Pro subscriber
export async function POST(req: Request) {
  return withRouteSpan("/api/jobs/pro", req, async () => {
    const log = baseLog.child({ requestId: req?.headers.get("x-request-id") ?? "unknown" });
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
    // Lean batch (list feeds): leave the description out of each row and send the derived Experience buckets instead.
    // Default stays the full record. Single-job GET is always full.
    const leanBatch = body?.lean === true;

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { error: "Missing required parameter 'ids' (non-empty string array)" },
        { status: 400 }
      );
    }

    const supabaseAdmin = getSupabaseAdmin();
    const displayAnswers = await loadDisplayScoreAnswers(supabaseAdmin, authCheck.user.id, await getCfEnv());
    // One reference instant per response: every score and revision below is computed at it.
    const scoredAt = Date.now();

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
      .select("id, company_id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, country_code, posted_at, first_seen_at, status, is_active, role_category, top_keywords, is_remote, logo_url, companies(name, logo_url, category, canonical_domain, domain)").or(VISIBLE_SOURCE_FILTER)
      .in("id", ids.slice(0, 100));

    if (error) {
      return NextResponse.json({ error: "Failed to retrieve unlocked jobs" }, { status: 500 });
    }

    const rawJobs = jobs || [];
    const descMap = await loadJobDescriptionsMap(supabaseAdmin, rawJobs.map((j: any) => j.id));
    const profileMap = await loadCompanyProfiles(supabaseAdmin, rawJobs);

    const formattedJobs = rawJobs.map((j: any) => {
      const originalSalary = formatSalary(j.salary_min, j.salary_max, j.currency, j.salary_period) || j.salary_text || null;
      const displaySalary = preferredCurrency
        ? (formatSalary(j.salary_min, j.salary_max, j.currency, j.salary_period, { displayCurrency: preferredCurrency }) || j.salary_text || null)
        : originalSalary;
      const resolvedDesc = resolveDescription(j.description, descMap.get(j.id));
      return {
        ...j,
      companyProfile: j.company_id ? profileMap.get(j.company_id) || null : null,
        ...(leanBatch
          ? leanProListFields({ title: j.title, description: resolvedDesc, skills: j.skills, category: j.category })
          : { description: resolvedDesc }),
        scoreRevision: scoreInputRevision(j, true, scoredAt),
            matchScore: sharedDisplayScore(j, displayAnswers, true, scoredAt),
        role_category: j.role_category || detectRoleCategory(j.title, j.category, j.skills),
        top_keywords: Array.isArray(j.top_keywords) && j.top_keywords.length > 0
          ? j.top_keywords.slice(0, 8)
          : extractTopKeywords(j.title, resolvedDesc, j.skills, 8),
        is_remote: Boolean(j.is_remote ?? j.remote),
        company_category: j.companies?.category || detectCompanyCategory(j.company, null, null, j.country_code),
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
    log.error("POST error", { error: err?.message || String(err) });
    reportRequestErrorToSentry(req, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  });
}
