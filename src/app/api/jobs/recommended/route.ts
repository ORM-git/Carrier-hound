import { recommendationTiming } from "@/lib/jobs/recommendationTiming";
import { applyRequiredYears, EXCLUDED_SKILLS_RPC, parseExcludedSkillParams, excludedSkillsRpcReady, requiredYearsFromParams } from "@/lib/preferences/advancedFilters";
import { isRequiredYearsRangeActive } from "@/lib/jobs/requiredYears";
import { applyFeedConstraints, companyConstraintsActive, datePostedCutoff, feedConstraintsFromParams } from "@/lib/preferences/feedConstraints";
import { loadDisplayScoreAnswers, sharedDisplayScore } from "@/lib/jobs/displayScore";
import { NextResponse } from "next/server";
import { scoreInputRevision } from "@/lib/matcher/scoring";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";
import { formatSalary } from "@/lib/salary/parser";
import { getSupabaseAdminClient, getRuntimeEnv, getClientIpFromRequest, checkRateLimit } from "@/lib/ai/serviceHandler";
import { checkSharedRateLimit, SEARCH_RATE_LIMIT, searchRateLimitStore } from "@/lib/api/sharedRateLimit";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { capJobsPerCompany, buildCompanyGroupIdMap, COMPANY_GROUP_SECRET_ENV } from "@/lib/jobs/capping";
import { OnboardingAnswers, rankJobsByRecommendation, hasOnboardingAnswers, hasResumeSignals, buildRelevancePrefilter } from "@/lib/jobs/recommendations";
import { createLogger } from "@/lib/observability/logger";
import { getCountryFilterClause, normalizeUserCountries } from "@/lib/countries";
import { isOnboardingStep2EnabledServer } from "@/config/onboarding";
import { loadResumeProfileForRanking } from "@/lib/onboarding/resumeParse";
import { applyExperienceLevelQuery, parseExperienceLevels, EARLY_CAREER_OR_CLAUSE } from "@/lib/jobs/experienceLevels";
import { jobTypeOrClause, workModelOrClause } from "@/lib/jobs/jobFilters";
import { normalizeUserCountries as normalizeEligibleCountries } from "@/lib/jobs/eligibility";
import { VISIBLE_SOURCE_FILTER } from "@/lib/jobs/sourcePolicy";

const baseLog = createLogger({ context: { route: "/api/jobs/recommended" } });

export const runtime = "edge";

const RECOMMENDED_POOL_SIZE = 1000;

function sanitizeSearchQuery(input: string): string {
  if (!input) return "";
  return input
    .replace(/[%_(),"'`;\\$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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
 * Personalized Recommended Jobs endpoint using onboarding answers, plus the parsed onboarding
 * resume / LinkedIn PDF (soft boost, Step 2 flag on) when the user has one.
 * Enforces server-level Pro gating:
 * - Free users see the recommended list in the same masked listing format
 *   (company "Verified Employer", no salary, applyUrl "", description "", skills []).
 * - Pro users receive full unmasked job details.
 * - Detail, company, salary, and apply stay Pro only.
 * - Fallback when a user has no answers: latest jobs.
 */
export async function GET(req: Request) {
  const timing = recommendationTiming(req.headers.get("cf-ray"));
  let responseStatus = 500;
  const respond = (body: any, init?: ResponseInit) => {
    responseStatus = init?.status ?? 200;
    const response = NextResponse.json(body, init);
    response.headers.set("X-CM-Request-ID", timing.requestId);
    return response;
  };
  const log = baseLog.child({ requestId: timing.requestId });
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
        return respond(
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
    const rawPage = parseInt(searchParams.get("page") || "1", 10);
    const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

    const rawPageSize = parseInt(searchParams.get("pageSize") || "25", 10);
    const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1 ? Math.min(100, Math.floor(rawPageSize)) : 25;

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
    let displayAnswers: OnboardingAnswers | null = null;

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ") && hasServiceKey) {
      const token = authHeader.replace("Bearer ", "").trim();
      try {
        const { data: { user } } = await supabaseAdmin.auth.getUser(token);
        if (user) {
          const entitlement = await getServerEntitlement(user.id);
          isPro = Boolean(entitlement.isPro);
          displayAnswers = await loadDisplayScoreAnswers(supabaseAdmin, user.id, cfEnv);

          // Fetch user preferences for onboarding answers
          const { data: prefs } = await supabaseAdmin
            .from("user_preferences")
            .select("roles, experience_level, remote_preference, locations, employment_types, categories, min_salary, salary_currency")
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
              minSalary: prefs.min_salary != null ? Number(prefs.min_salary) : null,
              salaryCurrency: prefs.salary_currency || null,
              country: (prefs as any).country || (Array.isArray(prefs.locations) && prefs.locations.length > 0 ? normalizeUserCountries(prefs.locations).names[0] : null) || null,
              countryCode: (prefs as any).country_code || (Array.isArray(prefs.locations) && prefs.locations.length > 0 ? normalizeUserCountries(prefs.locations).codes[0] : null) || null,
            };
          }

          // Parsed onboarding resume / LinkedIn PDF: soft ranking boost, behind the Step 2 flag.
          // Read server-side for this user only; null on any error, so ranking never breaks.
          if (isOnboardingStep2EnabledServer(cfEnv)) {
            dbAnswers.resumeProfile = await loadResumeProfileForRanking(supabaseAdmin, user.id);
          }
          // Preferred skills: ranking only. ONE read per request (the display answers above), reused for ordering so a
          // transient second-read failure cannot split rank from display. Free: skills are a paid scoring input, so
          // no boost (and nothing derived from hidden skills reorders the feed).
          dbAnswers.preferredSkills = isPro ? (displayAnswers?.preferredSkills ?? []) : [];
        }
      } catch (authErr) {
        log.warn("Auth check failed in /api/jobs/recommended", { error: authErr });
      }
    }

    // Allow query params to supply or override onboarding answers (useful for guest preview and tests)
    const queryRoles = searchParams.get("roles") || searchParams.get("role") || "";
    // A multi-level Level filter (e.g. "entry,senior") is a feed filter only; it never replaces the
    // single stored experienceLevel used for scoring. A legacy single-level value keeps its old role.
    const levelForScoring = parseExperienceLevels(searchParams.get("level")).length === 1 ? searchParams.get("level") : "";
    const queryExperience = searchParams.get("experienceLevel") || searchParams.get("experience") || levelForScoring || "";
    const queryRemote = searchParams.get("remotePreference") || searchParams.get("workModel") || "";
    const queryLocations = searchParams.get("locations") || searchParams.get("location") || "";
    const queryEmployment = searchParams.get("employmentTypes") || searchParams.get("jobType") || "";
    const queryMinSalary = searchParams.get("minSalary") || searchParams.get("salaryMin") || searchParams.get("salary_min") || "";
    const querySalaryCurrency = searchParams.get("salaryCurrency") || searchParams.get("salary_currency") || "";
    const queryCountry = searchParams.get("country") || "";
    const queryCountryCode = searchParams.get("countryCode") || searchParams.get("country_code") || "";

    const answers: OnboardingAnswers = {
      roles: queryRoles ? queryRoles.split(",").map((s) => s.trim()).filter(Boolean) : (dbAnswers.roles || []),
      experienceLevel: queryExperience ? queryExperience.trim() : (dbAnswers.experienceLevel || null),
      remotePreference: queryRemote ? queryRemote.trim() : (dbAnswers.remotePreference || null),
      locations: queryLocations ? queryLocations.split(",").map((s) => s.trim()).filter(Boolean) : (dbAnswers.locations || []),
      employmentTypes: queryEmployment ? queryEmployment.split(",").map((s) => s.trim()).filter(Boolean) : (dbAnswers.employmentTypes || []),
      categories: dbAnswers.categories || [],
      minSalary: queryMinSalary ? Number(queryMinSalary) : (dbAnswers.minSalary ?? null),
      salaryCurrency: querySalaryCurrency || dbAnswers.salaryCurrency || "USD",
      country: queryCountry || dbAnswers.country || null,
      countryCode: queryCountryCode || dbAnswers.countryCode || null,
      resumeProfile: dbAnswers.resumeProfile ?? null,
      preferredSkills: dbAnswers.preferredSkills ?? [],
    };

    const isPersonalized = hasOnboardingAnswers(answers);

    // Read EXPLICIT feed filter parameters to apply as HARD filters before ranking. Saved onboarding
    // preferences (experienceLevel, remotePreference, countryCode, locations) arrive under their own
    // names and only rank; they never activate a hard filter.
    const categoryParam = searchParams.get("category") || "";
    const remoteOnly = searchParams.get("remoteOnly") === "true";
    const countryCodeParam = searchParams.get("country_code") || "";
    const locationParam = searchParams.get("location") || "";
    const jobTypeParam = searchParams.get("jobType") || "";
    const levelParam = searchParams.get("level") || "";
    const workModelParam = searchParams.get("workModel") || "";
    const dateParam = searchParams.get("datePosted") || searchParams.get("date") || "";
    const experienceParam = searchParams.get("experience") || searchParams.get("exp") || "";
    const salaryMinParam = searchParams.get("salaryMin") || searchParams.get("salary_min") || "";
    const sourceTypeParam = searchParams.get("sourceType") || searchParams.get("source_type") || "";
    const companyParam = searchParams.get("company") || "";
    const searchParam = searchParams.get("q") || searchParams.get("search") || "";

    // Candidate columns: only what ranking, capping and the Free card read. status/is_active/last_seen_at are
    // filtered in SQL, never read here. Pro-only payload columns are hydrated for the returned page only.
    const hasResume = hasResumeSignals(answers.resumeProfile);
    const selectCols = hasServiceKey
      ? "id, title, company, company_id, location, remote, remote_scope, remote_eligibility, job_type, salary_text, salary_min, salary_max, salary_period, currency, first_seen_at, posted_at, created_at, category, country, country_code" +
        (hasResume ? ", description, skills" : isPro && (answers.preferredSkills?.length ?? 0) > 0 ? ", skills" : "") // resume matching (and Pro preferred skills) read them
      : "id, title, location, remote, remote_scope, remote_eligibility, job_type, first_seen_at, last_seen_at, posted_at, created_at, status, is_active, category, country, country_code";
    const PRO_HYDRATE_COLS = "id, apply_url, description, skills, logo_url, companies(logo_url, domain)";

    // No count: nothing reads it, and an exact count over the filtered table is extra DB work on every request.
    // Excluded skills: decided in the database (RPC) before paging. Needs the service key, the applied RPC and the
    // owner readiness flag; otherwise fail rather than silently broaden a personalized feed.
    const excludedParse = parseExcludedSkillParams(searchParams);
    if (!excludedParse.ok) {
      return respond({ error: "Invalid excluded skills", jobs: [], totalCount: 0 }, { status: 400 });
    }
    const excludedSkillKeys = excludedParse.keys;
    if (excludedSkillKeys.length && (!hasServiceKey || !excludedSkillsRpcReady(getRuntimeEnv("CM_EXCLUDED_SKILLS_RPC", cfEnv)))) {
      return respond({ error: "Skill preferences unavailable", jobs: [], totalCount: 0 }, { status: 503 });
    }
    let query = (excludedSkillKeys.length
      ? (supabaseAdmin as any).rpc(EXCLUDED_SKILLS_RPC, { p_excluded: excludedSkillKeys })
      : supabaseAdmin.from(targetTable))
      .select(selectCols).or(VISIBLE_SOURCE_FILTER)
      .eq("status", "active");

    if (hasServiceKey) {
      query = query.eq("is_active", true);
    }

    // Apply HARD filters before ranking:
    // 1. Category hard filter
    if (categoryParam && categoryParam !== "all") {
      const c = sanitizeSearchQuery(categoryParam).toLowerCase().trim();
      if (c === "trending") {
        query = query.in("category", ["ai", "engineering", "devops"]);
      } else if (c === "tech") {
        query = query.in("category", ["engineering", "devops", "ai", "software"]);
      } else if (c === "ai" || c === "ai-ml" || c === "ai-machine-learning" || c === "machine-learning") {
        query = query.or("category.eq.ai,category.eq.ai-ml,title.ilike.%machine learning%,title.ilike.%deep learning%,title.ilike.%llm%,title.ilike.%nlp%,title.imatch.\\yAI\\y,title.ilike.ai %,title.ilike.% ai %,title.ilike.% ai,title.ilike.ai");
      } else if (c === "data" || c === "data-analytics" || c === "data-science") {
        query = query.or("category.eq.data,category.eq.data-analytics,title.ilike.%data %,title.ilike.%analytics%,title.ilike.%database%");
      } else if (c === "engineering" || c === "software") {
        query = query.in("category", ["engineering", "software"]);
      } else if (c === "internships") {
        query = query.or("job_type.eq.internship,title.ilike.%internship%,title.ilike.%internships%,title.ilike.% intern %,title.ilike.intern %,title.ilike.% intern,title.ilike.%-intern%,title.ilike.%(intern)%,title.ilike.%co-op%,title.ilike.%coop%");
      } else if (c === "remote") {
        query = query.eq("remote", true);
      } else if (c === "fresher") {
        query = query.or("title.ilike.%junior%,title.ilike.%entry%,title.ilike.%associate%,title.ilike.%internship%,title.ilike.% intern %,job_type.eq.internship");
      } else if (c === "operations") {
        query = query.or("category.eq.operations,title.ilike.%operation%,title.ilike.%ops%");
      } else if (c === "cyber-security") {
        query = query.or("category.eq.cyber-security,title.ilike.%security%,title.ilike.%cyber%");
      } else if (c === "customer-support") {
        query = query.or("category.eq.customer-support,title.ilike.%support%,title.ilike.%customer%,title.ilike.%success%");
      } else if (c === "legal") {
        query = query.or("category.eq.legal,title.ilike.%legal%,title.ilike.%compliance%");
      } else if (c === "healthcare") {
        query = query.or("category.eq.healthcare,title.ilike.%health%,title.ilike.%clinical%");
      } else {
        query = query.or(`category.ilike.%${c}%,title.ilike.%${c}%`);
      }
    }

    // 2. Remote only hard filter
    if (remoteOnly) {
      query = query.eq("remote", true);
    }

    // 3. Country code hard filter
    if (countryCodeParam && countryCodeParam.trim() && countryCodeParam.toLowerCase() !== "all") {
      const code = sanitizeSearchQuery(countryCodeParam).toUpperCase().trim();
      if (code) {
        const orClause = getCountryFilterClause(code);
        if (orClause) {
          query = query.or(orClause);
        } else {
          query = query.eq("country_code", code);
        }
      }
    } else {
      // Saved countries are a preference, not a country-only restriction: pre-select the eligible superset
      // (those countries + remote/worldwide roles). isJobEligible in ranking then drops remote roles
      // restricted to other countries, so restricted jobs are never widened in.
      const savedCodes = normalizeEligibleCountries(
        [...(answers.locations || []), answers.country || "", answers.countryCode || ""].filter(Boolean)
      ).codes;
      const countryClauses = savedCodes.map((c) => getCountryFilterClause(c)).filter(Boolean);
      if (countryClauses.length > 0) {
        query = query.or(
          [...countryClauses, "remote.eq.true", "remote_scope.eq.worldwide", "remote_eligibility.eq.worldwide", "location.ilike.%remote%", "location.ilike.%worldwide%"].join(",")
        );
      }
    }

    // 4. Location hard filter
    if (locationParam && locationParam.trim() && locationParam.toLowerCase() !== "all") {
      const loc = sanitizeSearchQuery(locationParam);
      if (loc.toLowerCase() === "remote") {
        query = query.or("remote.eq.true,location.ilike.%remote%");
      } else if (loc) {
        query = query.ilike("location", "%" + loc + "%");
      }
    }

    // 5. Job type hard filter
    const jobTypeClause = jobTypeOrClause(jobTypeParam);
    if (jobTypeClause) query = query.or(jobTypeClause);

    // 6. Level hard filter
    if (levelParam && levelParam.trim() && levelParam.toLowerCase() !== "all") {
      query = applyExperienceLevelQuery(query, levelParam);
    }

    // 7. Experience hard filter
    if (experienceParam && experienceParam.trim() && experienceParam.toLowerCase() !== "all" && experienceParam.toLowerCase() !== "all experience") {
      const exp = experienceParam.trim().toLowerCase();
      if (exp.includes("8") || exp.includes("lead") || exp.includes("staff") || exp.includes("principal")) {
        query = query.or("title.ilike.%staff%,title.ilike.%principal%,title.ilike.%lead%");
      } else if (exp.includes("3-5") || exp.includes("3 to 5") || exp.includes("mid")) {
        query = query
          .not("title", "ilike", "%senior%")
          .not("title", "ilike", "%sr.%")
          .not("title", "ilike", "%staff%")
          .not("title", "ilike", "%principal%")
          .not("title", "ilike", "%lead%")
          .not("title", "ilike", "%junior%")
          .not("title", "ilike", "%entry%");
      } else if (exp.includes("1-3") || exp.includes("1 to 3") || exp.includes("entry") || exp.includes("junior") || exp.includes("intern")) {
        query = query
          .or(EARLY_CAREER_OR_CLAUSE)
          .not("title", "ilike", "%senior%")
          .not("title", "ilike", "%sr.%")
          .not("title", "ilike", "%staff%")
          .not("title", "ilike", "%principal%")
          .not("title", "ilike", "%lead%");
      } else if (exp.includes("5") || exp.includes("senior") || exp.includes("sr")) {
        query = query.or("title.ilike.%senior%,title.ilike.%sr.%");
      }
    }

    // 8. Work model hard filter
    const workModelClause = workModelOrClause(workModelParam);
    if (workModelClause) query = query.or(workModelClause);

    // 9. Date posted hard filter
    // 24h / 3d / 7d / 30d. A NULL posted_at (unknown source date) never passes an active window.
    const postedCutoff = datePostedCutoff(dateParam);
    if (postedCutoff) query = query.gte("posted_at", postedCutoff);

    // 9b. Saved feed constraints (Preferences sheet), AND-ed with everything else, before the pool range.
    // Company constraints need the jobs.company column: without it, fail rather than silently broaden.
    const feedConstraints = feedConstraintsFromParams(searchParams);
    if (companyConstraintsActive(feedConstraints) && !hasServiceKey) {
      return respond({ error: "Company preferences unavailable", jobs: [], totalCount: 0 }, { status: 503 });
    }
    query = applyFeedConstraints(query, feedConstraints);
    // Required years: needs the jobs min/max_experience_years columns (not on jobs_public): fail rather than broaden.
    const requiredYears = requiredYearsFromParams(searchParams);
    if (isRequiredYearsRangeActive(requiredYears) && !hasServiceKey) {
      return respond({ error: "Experience-years preferences unavailable", jobs: [], totalCount: 0 }, { status: 503 });
    }
    query = applyRequiredYears(query, requiredYears);

    // 10. Company hard filter (server-side, jobs table only)
    if (companyParam && companyParam.trim() && companyParam.toLowerCase() !== "all") {
      if (hasServiceKey) {
        const cleanComp = sanitizeSearchQuery(companyParam).trim();
        if (cleanComp) {
          query = query.or(`company.ilike.%${cleanComp}%,company_slug.ilike.%${cleanComp.toLowerCase()}%`);
        }
      }
    }

    // 11. Salary min hard filter (server-side, jobs table only)
    if (salaryMinParam) {
      if (hasServiceKey) {
        const minVal = parseInt(salaryMinParam, 10);
        if (!isNaN(minVal) && minVal > 0) {
          query = query.not("salary_min", "is", null).gte("salary_min", minVal);
        }
      }
    }

    // 12. Source type hard filter (server-side, jobs table only)
    if (sourceTypeParam && sourceTypeParam.trim() && sourceTypeParam.toLowerCase() !== "all") {
      if (hasServiceKey) {
        const st = sanitizeSearchQuery(sourceTypeParam).toLowerCase().trim();
        if (st === "ats") {
          query = query.or("source_type.eq.ats,source.ilike.%board%,source.ilike.%greenhouse%,source.ilike.%lever%,source.ilike.%ashby%");
        } else if (st === "direct") {
          query = query.or("source_type.eq.direct,source_type.eq.ats");
        } else if (st === "aggregator") {
          query = query.or("source_type.eq.aggregator,source_type.eq.feed,source_type.eq.api");
        } else if (st) {
          query = query.eq("source_type", st);
        }
      }
    }

    // 13. Search query hard filter
    if (searchParam && searchParam.trim()) {
      const cleanSearch = sanitizeSearchQuery(searchParam).trim();
      if (cleanSearch) {
        if (hasServiceKey) {
          query = query.or(`title.ilike.%${cleanSearch}%,company.ilike.%${cleanSearch}%,description.ilike.%${cleanSearch}%`);
        } else {
          query = query.ilike("title", `%${cleanSearch}%`);
        }
      }
    }

    // 14. Relevance pre-filter: only jobs whose title (or trusted category) can match the user's target role,
    // field or skills enter the pool, so the pool is the latest RECOMMENDED_POOL_SIZE *relevant* jobs rather
    // than the latest jobs overall. The relevance gate in the shared scorer then decides per job.
    const relevancePrefilter = buildRelevancePrefilter(answers);
    if (relevancePrefilter) {
      query = query.or(relevancePrefilter.orClause);
    }

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let paginatedJobs: any[] = [];
    let totalCount = 0;

    // Use a fixed candidate set per request (fixed pool size, not growing with page)
    // with deterministic tie-breaks (score desc, posted_at desc, id).
    // Bounded candidate pool ensures zero duplicates and zero skips between adjacent pages.
    query = query
      .order("posted_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false })
      .range(0, RECOMMENDED_POOL_SIZE - 1);

    timing.begin("db");
    const { data: rawJobs, error } = await query;
    timing.rows("candidateRows", rawJobs?.length ?? 0);

    if (error) {
      log.error("Failed to query candidate jobs for recommendations", { error: error.message || error });
      return respond(
        { error: "Database service unavailable", jobs: [], totalCount: 0 },
        { status: 503 }
      );
    }

    timing.begin("scoring");
    // One reference instant per response: every score and revision below is computed at it.
    const scoredAt = Date.now();
    const candidateJobs = rawJobs || [];
    const rankedJobs = isPersonalized || hasResume
      ? rankJobsByRecommendation(candidateJobs, answers, scoredAt)
      : rankJobsByRecommendation(candidateJobs, null, scoredAt);

    // Drop rows with matchScore <= 0 (ineligible under saved preferences or not relevant to the user's role).
    // A saved "remote" preference is additive and is handled in ranking.
    const qualifyingJobs = isPersonalized
      ? rankedJobs.filter((job) => (job.matchScore ?? job._matchScore ?? 0) > 0)
      : rankedJobs;

    const cappedJobs = capJobsPerCompany(qualifyingJobs, 3, 30);
    totalCount = cappedJobs.length; // Honestly reports the bounded pool total after exclusions
    paginatedJobs = cappedJobs.slice(from, to + 1);

    // Pro cards, details and the paid display score need the wide columns; fetch them for the returned rows only.
    if (isPro && hasServiceKey && paginatedJobs.length > 0) {
      timing.begin("hydrate");
      const { data: details, error: detailError } = await supabaseAdmin
        .from("jobs")
        .select(PRO_HYDRATE_COLS).or(VISIBLE_SOURCE_FILTER)
        .in("id", paginatedJobs.map((row: any) => row.id))
        // Same eligibility as the candidate query: a job that went inactive after it was ranked is not returned.
        .eq("status", "active")
        .eq("is_active", true);
      if (detailError) {
        log.error("Failed to load details for recommended jobs", { error: detailError.message || detailError });
        return respond(
          { error: "Database service unavailable", jobs: [], totalCount: 0 },
          { status: 503 }
        );
      }
      const byId = new Map<string, any>((details || []).map((d: any) => [d.id, d]));
      // A row missing here was deleted or went inactive after ranking: leave it out, keep the rest in order.
      paginatedJobs = paginatedJobs.filter((row: any) => byId.has(row.id)).map((row: any) => ({ ...row, ...byId.get(row.id), id: row.id }));
    }

    timing.rows("rankedRows", cappedJobs.length);
    timing.rows("returnedRows", paginatedJobs.length);
    timing.begin("format");

    // Build company group ID map for non-Pro responses to prevent company_id leakage
    // Fails closed with 503 if HMAC secret is missing or unavailable
    let listGroupIds = new Map<string, string>();
    if (!(isPro && hasServiceKey)) {
      try {
        const secret = getRuntimeEnv(COMPANY_GROUP_SECRET_ENV, cfEnv) || process.env[COMPANY_GROUP_SECRET_ENV];
        listGroupIds = await buildCompanyGroupIdMap(paginatedJobs.map((r: any) => r.company_id), secret);
      } catch (groupErr: any) {
        log.error("Company group secret unavailable; refusing non-Pro response in /api/jobs/recommended", {
          error: groupErr?.message || groupErr,
        });
        return respond(
          { error: "Database service unavailable", jobs: [], totalCount: 0 },
          { status: 503 }
        );
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
          firstSeenAt: row.first_seen_at ?? null,
          companyDomain: row.companies?.domain || null,
          companyLogoUrl: row.companies?.logo_url || null,
          logoUrl: row.logo_url || row.companies?.logo_url || null,
          logo_url: row.logo_url || row.companies?.logo_url || null,
          matchScore: sharedDisplayScore(row, displayAnswers || (isPersonalized || hasResumeSignals(answers.resumeProfile) ? answers : null), isPro, scoredAt),
          scoreRevision: scoreInputRevision(row, true, scoredAt),
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
        firstSeenAt: row.first_seen_at ?? null,
        logoUrl: null,
        logo_url: null,
        matchScore: sharedDisplayScore(row, displayAnswers || (isPersonalized || hasResumeSignals(answers.resumeProfile) ? answers : null), isPro, scoredAt),
        scoreRevision: scoreInputRevision(row, false, scoredAt),
      };
    });

    return respond({
      jobs: formattedJobs,
      totalCount,
      personalized: isPersonalized || hasResume,
      isPro,
      page,
      pageSize,
    });
  } catch (err: any) {
    baseLog.error("Unhandled error in /api/jobs/recommended", { error: err?.message || err });
    return respond(
      { error: "Failed to generate recommended jobs", jobs: [], totalCount: 0 },
      { status: 500 }
    );
  } finally {
    timing.finish(responseStatus);
  }
}
