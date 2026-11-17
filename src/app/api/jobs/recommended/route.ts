import { NextResponse } from "next/server";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";
import { formatSalary } from "@/lib/salary/parser";
import { getSupabaseAdminClient, getRuntimeEnv, getClientIpFromRequest, checkRateLimit } from "@/lib/ai/serviceHandler";
import { checkSharedRateLimit, SEARCH_RATE_LIMIT, searchRateLimitStore } from "@/lib/api/sharedRateLimit";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { capJobsPerCompany, buildCompanyGroupIdMap, COMPANY_GROUP_SECRET_ENV } from "@/lib/jobs/capping";
import { OnboardingAnswers, rankJobsByRecommendation, hasOnboardingAnswers } from "@/lib/jobs/recommendations";
import { createLogger } from "@/lib/observability/logger";

const baseLog = createLogger({ context: { route: "/api/jobs/recommended" } });

export const runtime = "edge";

function formatDate(dateStr?: string | null): string {
  if (!dateStr) return "Recently";
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffHours = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60));
    if (diffHours < 1) return "Just now";
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 30) return `${diffDays}d ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "Recently";
  }
}

/**
 * GET /api/jobs/recommended
 *
 * Personalized Recommended Jobs endpoint using onboarding answers only (no resume).
 * Enforces server-level Pro gating:
 * - Free users see the recommended list in the same masked listing format
 *   (company "Verified Employer", no salary, applyUrl "", description "", skills []).
 * - Pro users receive full unmasked job details.
 * - Detail, company, salary, and apply stay Pro only.
 * - Fallback when a user has no answers: latest jobs.
 */
export async function GET(req: Request) {
  const log = baseLog.child({ requestId: req?.headers.get("x-request-id") ?? "unknown" });
  try {
    const isLegacy =
      process.env.NODE_ENV === "test" &&
      process.env.__CAREERMONKE_LEGACY_RATE_LIMIT === "true";

    if (!isLegacy) {
      const clientIp = getClientIpFromRequest(req);
      const ipLimit = await checkSharedRateLimit(
        `recommended:ip:${clientIp}`,
        SEARCH_RATE_LIMIT.maxRequests,
        SEARCH_RATE_LIMIT.windowSeconds,
        () =>
          checkRateLimit(
            clientIp,
            searchRateLimitStore,
            SEARCH_RATE_LIMIT.maxRequests,
            SEARCH_RATE_LIMIT.windowSeconds * 1000
          )
      );

      if (!ipLimit.allowed) {
        return NextResponse.json(
          {
            error: "Rate limit exceeded. Please try again shortly.",
            retryAfter: ipLimit.retryAfter,
          },
          {
            status: 429,
            headers: {
              "Retry-After": String(ipLimit.retryAfter),
            },
          }
        );
      }
    }

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || "25", 10)));

    let cfEnv: Record<string, any> | undefined;
    try {
      const ctx = getRequestContext();
      if (ctx?.env) {
        cfEnv = ctx.env as Record<string, any>;
      }
    } catch {}

    const supabaseAdmin = getSupabaseAdminClient(cfEnv, true);
    const hasServiceKey = Boolean(
      getRuntimeEnv("SUPABASE_SERVICE_ROLE_KEY", cfEnv) ||
      getRuntimeEnv("SUPABASE_SERVICE_KEY", cfEnv)
    );
    const targetTable = hasServiceKey ? "jobs" : "jobs_public";

    // Check optional Pro entitlement and user preferences via Bearer token
    let isPro = false;
    let dbAnswers: OnboardingAnswers = {};

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ") && hasServiceKey) {
      const token = authHeader.replace("Bearer ", "").trim();
      try {
        const { data: { user } } = await supabaseAdmin.auth.getUser(token);
        if (user) {
          const entitlement = await getServerEntitlement(user.id);
          isPro = Boolean(entitlement.isPro);

          // Fetch user preferences for onboarding answers
          const { data: prefs } = await supabaseAdmin
            .from("user_preferences")
            .select("roles, experience_level, remote_preference, locations, employment_types, categories")
            .eq("user_id", user.id)
            .maybeSingle();

          if (prefs) {
            dbAnswers = {
              roles: Array.isArray(prefs.roles) ? prefs.roles : [],
              experienceLevel: prefs.experience_level || null,
              remotePreference: prefs.remote_preference || null,
              locations: Array.isArray(prefs.locations) ? prefs.locations : [],
              employmentTypes: Array.isArray(prefs.employment_types) ? prefs.employment_types : [],
              categories: Array.isArray(prefs.categories) ? prefs.categories : [],
            };
          }
        }
      } catch (authErr) {
        log.warn("Auth check failed in /api/jobs/recommended", { error: authErr });
      }
    }

    // Allow query params to supply or override onboarding answers (useful for guest preview and tests)
    const queryRoles = searchParams.get("roles") || searchParams.get("role") || "";
    const queryExperience = searchParams.get("experienceLevel") || searchParams.get("experience") || searchParams.get("level") || "";
    const queryRemote = searchParams.get("remotePreference") || searchParams.get("workModel") || "";
    const queryLocations = searchParams.get("locations") || searchParams.get("location") || "";
    const queryEmployment = searchParams.get("employmentTypes") || searchParams.get("jobType") || "";

    const answers: OnboardingAnswers = {
      roles: queryRoles ? queryRoles.split(",").map((s) => s.trim()).filter(Boolean) : (dbAnswers.roles || []),
      experienceLevel: queryExperience ? queryExperience.trim() : (dbAnswers.experienceLevel || null),
      remotePreference: queryRemote ? queryRemote.trim() : (dbAnswers.remotePreference || null),
      locations: queryLocations ? queryLocations.split(",").map((s) => s.trim()).filter(Boolean) : (dbAnswers.locations || []),
      employmentTypes: queryEmployment ? queryEmployment.split(",").map((s) => s.trim()).filter(Boolean) : (dbAnswers.employmentTypes || []),
      categories: dbAnswers.categories || [],
    };

    const isPersonalized = hasOnboardingAnswers(answers);

    // Query active candidate jobs from Supabase
    const selectCols = hasServiceKey
      ? "id, title, company, location, remote, remote_scope, remote_eligibility, job_type, salary_text, salary_min, salary_max, salary_period, currency, first_seen_at, last_seen_at, posted_at, created_at, status, is_active, category, country, country_code, apply_url, description, skills, logo_url, company_id"
      : "id, title, location, remote, remote_scope, remote_eligibility, job_type, first_seen_at, last_seen_at, posted_at, created_at, status, is_active, category, country, country_code";

    let query = supabaseAdmin
      .from(targetTable)
      .select(selectCols, { count: "exact" })
      .eq("status", "active");

    if (hasServiceKey) {
      query = query.eq("is_active", true);
    }

    // Fetch candidate pool (limit 250 for fast client-edge scoring)
    query = query
      .order("posted_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false })
      .limit(250);

    const { data: rawJobs, count, error } = await query;

    if (error) {
      log.error("Failed to query jobs for recommendations", { error: error.message || error });
      return NextResponse.json(
        { degraded: true, jobs: [], totalCount: 0, personalized: false, isPro },
        { status: 503 }
      );
    }

    let candidateJobs = rawJobs || [];

    // Rank jobs using deterministic TS scoring with fallback to latest jobs
    let rankedJobs = rankJobsByRecommendation(candidateJobs, isPersonalized ? answers : null);

    // Apply company capping (max 3 per company in visible list)
    rankedJobs = capJobsPerCompany(rankedJobs, 3, 30);

    const totalCount = count ?? rankedJobs.length;

    // Slice according to pagination
    const from = (page - 1) * pageSize;
    const to = from + pageSize;
    const paginatedJobs = rankedJobs.slice(from, to);

    // Build company group ID map for non-Pro responses to prevent company_id leakage
    let listGroupIds = new Map<string, string>();
    if (!(isPro && hasServiceKey)) {
      try {
        const secret = getRuntimeEnv(COMPANY_GROUP_SECRET_ENV, cfEnv) || process.env[COMPANY_GROUP_SECRET_ENV] || "default-secret-dev";
        listGroupIds = await buildCompanyGroupIdMap(paginatedJobs.map((r: any) => r.company_id), secret);
      } catch (groupErr: any) {
        log.error("Company group secret error in /api/jobs/recommended", { error: groupErr?.message || groupErr });
      }
    }

    // Format response according to entitlement (Masked for Free, Unmasked for Pro)
    const formattedJobs = paginatedJobs.map((row: any) => {
      const originalSalary = formatSalary(row.salary_min, row.salary_max, row.currency, row.salary_period) || row.salary_text || null;
      const displaySalary = originalSalary;

      if (isPro && hasServiceKey) {
        return {
          id: row.id,
          title: row.title || "Untitled Position",
          company: row.company || "Verified Employer",
          companyId: row.company_id || null,
          company_id: row.company_id || null,
          location: row.location || (row.remote ? "Remote (Worldwide)" : "Remote"),
          date: formatDate(row.posted_at || row.created_at || row.first_seen_at),
          salary: displaySalary || "",
          salary_display: displaySalary,
          salary_original: originalSalary,
          category: row.category || "engineering",
          remote: Boolean(row.remote),
          remoteScope: row.remote_scope || undefined,
          remoteEligibility: row.remote_eligibility || undefined,
          country: row.country_code || row.country || "",
          type: row.job_type === "internship" ? "Internship" : (row.job_type || "Full-time"),
          directSource: Boolean(row.verified ?? true),
          applyUrl: row.apply_url || "",
          description: row.description || "",
          skills: row.skills || [],
          postedAt: row.posted_at || row.created_at,
          logoUrl: row.logo_url || null,
          logo_url: row.logo_url || null,
          matchScore: typeof row.matchScore === "number" ? row.matchScore : (typeof row._matchScore === "number" ? row._matchScore : null),
        };
      }

      // Guest / Free masked format — ZERO paid data leakage
      return {
        id: row.id,
        title: row.title || "Untitled Position",
        company: "Verified Employer",
        companyGroupId: row.company_id ? listGroupIds.get(row.company_id) ?? null : null,
        location: row.location || (row.remote ? "Remote (Worldwide)" : "Remote"),
        date: formatDate(row.posted_at || row.created_at || row.first_seen_at),
        salary: "",
        salary_display: null,
        salary_original: null,
        category: row.category || "engineering",
        remote: Boolean(row.remote),
        remoteScope: row.remote_scope || undefined,
        remoteEligibility: row.remote_eligibility || undefined,
        country: row.country_code || row.country || "",
        type: row.job_type === "internship" ? "Internship" : (row.job_type || "Full-time"),
        directSource: Boolean(row.verified ?? true),
        applyUrl: "",
        description: "",
        skills: [],
        postedAt: row.posted_at || row.created_at,
        logoUrl: null,
        logo_url: null,
        matchScore: typeof row.matchScore === "number" ? row.matchScore : (typeof row._matchScore === "number" ? row._matchScore : null),
      };
    });

    return NextResponse.json({
      jobs: formattedJobs,
      totalCount,
      personalized: isPersonalized,
      isPro,
      page,
      pageSize,
    });
  } catch (err: any) {
    baseLog.error("Unhandled error in /api/jobs/recommended", { error: err?.message || err });
    return NextResponse.json(
      { error: "Failed to generate recommended jobs", jobs: [], totalCount: 0 },
      { status: 500 }
    );
  }
}
