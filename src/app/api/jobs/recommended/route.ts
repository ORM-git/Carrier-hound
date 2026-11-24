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
import { normalizeUserCountries as normalizeEligibleCountries } from "@/lib/jobs/eligibility";

const baseLog = createLogger({ context: { route: "/api/jobs/recommended" } });

export const runtime = "edge";

const RECOMMENDED_POOL_SIZE = 1000;

// Keyset continuation cursors are opaque to the client: "k:<posted_at>|<id>" marks the
// position strictly after a raw row in the (posted_at desc, id desc) stream order.
// "null" encodes a row whose posted_at is NULL (such rows sort last in the stream).
function encodeContinuationCursor(row: { posted_at?: string | null; id: string }): string {
  return `k:${row.posted_at ?? "null"}|${row.id}`;
}

function parseContinuationCursor(raw: string): { posted_at: string | null; id: string } | null {
  if (!raw.startsWith("k:")) return null;
  const sep = raw.lastIndexOf("|");
  if (sep <= 2 || sep === raw.length - 1) return null;
  const posted = raw.slice(2, sep);
  return { posted_at: posted === "null" ? null : posted, id: raw.slice(sep + 1) };
}

// Ranked pool keyset ("p:<score>|<time>|<id>"): a value-based position in the ranked pool
// order (score desc, time desc, id desc; time = posted_at || created_at || first_seen_at).
// Combined with poolAnchor (an immutable raw-key upper bound captured when the stream
// starts) this is stable under insertions and deletions of rows whose score inputs did not
// change: inserts can neither shift pool slices nor displace unseen pool-tail rows out of
// the bounded window, and deleted rows simply vanish without moving the position. A row
// whose score inputs genuinely mutate mid-stream can move; the client de-duplicates repeats
// by id and a fresh load converges. That is the stream contract - not a snapshot claim.
function jobStreamTime(row: any): string {
  return row.posted_at || row.created_at || row.first_seen_at || "";
}
function jobStreamScore(row: any): number {
  return row.matchScore ?? row._matchScore ?? 0;
}
function encodePoolCursor(row: any): string {
  return `p:${jobStreamScore(row)}|${jobStreamTime(row)}|${row.id}`;
}
function parsePoolCursor(raw: string): { score: number; time: string; id: string } | null {
  if (!raw.startsWith("p:")) return null;
  const parts = raw.slice(2).split("|");
  if (parts.length !== 3) return null;
  const score = Number(parts[0]);
  if (!Number.isFinite(score) || parts[2].length === 0) return null;
  return { score, time: parts[1], id: parts[2] };
}
function poolAnchorFilter(anchor: { posted_at: string | null; id: string }): string {
  // Inclusive immutable upper bound: the pool never includes rows newer than the anchor.
  return anchor.posted_at
    ? `posted_at.lt.${anchor.posted_at},and(posted_at.eq.${anchor.posted_at},id.lte.${anchor.id}),posted_at.is.null`
    : "posted_at.is.null";
}
function poolFloorFilter(floor: { posted_at: string | null; id: string }): string {
  // Inclusive immutable lower bound: the frozen pool window never includes rows older
  // than the floor row captured when the stream started. Together with the anchor this
  // freezes pool membership: deletions shrink the window but nothing refills it, and the
  // beyond-pool continuation always starts strictly after this immutable floor value.
  return floor.posted_at
    ? `posted_at.gt.${floor.posted_at},and(posted_at.eq.${floor.posted_at},id.gte.${floor.id})`
    : `posted_at.not.is.null,and(posted_at.is.null,id.gte.${floor.id})`;
}
// Terminal completeness sweep ("s:<posted_at>|<id>", "s:top" from the window head): after
// ranked pool paging exhausts, the frozen window is scanned once more in raw order. The
// client's id-dedupe renders only rows the ranked stream omitted (score inputs that moved
// mid-stream, backdated inserts), so no eligible row is silently lost without a refresh.
function encodeSweepCursor(row: { posted_at: string | null; id: string } | null): string {
  return row ? `s:${row.posted_at ?? "null"}|${row.id}` : "s:top";
}
function parseSweepCursor(raw: string): { after: { posted_at: string | null; id: string } | null } | null {
  if (!raw.startsWith("s:")) return null;
  if (raw === "s:top") return { after: null };
  const sep = raw.lastIndexOf("|");
  if (sep <= 2 || sep === raw.length - 1) return null;
  const posted = raw.slice(2, sep);
  return { after: { posted_at: posted === "null" ? null : posted, id: raw.slice(sep + 1) } };
}

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

    // Query active candidate jobs from Supabase
    const selectCols = hasServiceKey
      ? "id, title, company, location, remote, remote_scope, remote_eligibility, job_type, salary_text, salary_min, salary_max, salary_period, currency, first_seen_at, last_seen_at, posted_at, created_at, status, is_active, category, country, country_code, apply_url, description, skills, logo_url, company_id, companies(logo_url, domain)"
      : "id, title, location, remote, remote_scope, remote_eligibility, job_type, first_seen_at, last_seen_at, posted_at, created_at, status, is_active, category, country, country_code";

    let query = supabaseAdmin
      .from(targetTable)
      .select(selectCols, { count: "exact" })
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
    if (jobTypeParam && jobTypeParam.trim() && jobTypeParam.toLowerCase() !== "all") {
      const jt = jobTypeParam.trim().toLowerCase();
      if (jt.includes("full")) {
        query = query.or("job_type.ilike.%full%,job_type.eq.full-time,job_type.eq.full_time");
      } else if (jt.includes("contract")) {
        query = query.or("job_type.ilike.%contract%,job_type.eq.contractor");
      } else if (jt.includes("part")) {
        query = query.ilike("job_type", "%part%");
      } else if (jt.includes("intern")) {
        query = query.or("job_type.ilike.%intern%,job_type.eq.internship");
      } else {
        query = query.ilike("job_type", "%" + sanitizeSearchQuery(jobTypeParam) + "%");
      }
    }

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
    if (workModelParam && workModelParam.trim() && workModelParam.toLowerCase() !== "all") {
      const wmTokens = workModelParam.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
      const orParts: string[] = [];
      for (const wm of wmTokens) {
        if (wm === "remote") orParts.push("remote.eq.true", "location.ilike.%remote%");
        else if (wm === "hybrid") orParts.push("location.ilike.%hybrid%", "remote_scope.eq.hybrid");
        else if (wm === "onsite") orParts.push("remote.eq.false", "location.ilike.%onsite%");
      }
      if (orParts.length > 0) {
        query = query.or(orParts.join(","));
      }
    }

    // 9. Date posted hard filter
    if (dateParam && dateParam.trim() && dateParam.toLowerCase() !== "all") {
      const dp = dateParam.trim().toLowerCase();
      const ms =
        dp === "24h" || dp.includes("24")
          ? 24 * 60 * 60 * 1000
          : dp === "7d" || dp.includes("week")
          ? 7 * 24 * 60 * 60 * 1000
          : dp === "30d" || dp.includes("month")
          ? 30 * 24 * 60 * 60 * 1000
          : 0;
      if (ms > 0) {
        const cutoff = new Date(Date.now() - ms).toISOString();
        query = query.gte("posted_at", cutoff);
      }
    }

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

    // The legacy numeric page parameter is echoed in responses but never used for
    // positioning: pool slices advance by ranked keyset cursors (see below).

    let paginatedJobs: any[] = [];
    let totalCount = 0;
    let hasNextPage = false;
    let nextCursor: string | null = null;
    let isContinuationResponse = false;
    let totalIsLowerBound = false;

    const hasResume = hasResumeSignals(answers.resumeProfile);

    // Beyond-pool continuation uses a KEYSET cursor ("k:<posted_at>|<id>") over the same
    // relevance-filtered query ordered by (posted_at desc, id desc). A keyset stays correct
    // when rows are inserted or deleted between requests - the next chunk always starts
    // strictly after the last raw row the stream consumed, so no unseen row is ever skipped
    // and no seen row repeats. (Rows inserted after the stream started sort before the key
    // and surface on the next fresh load, matching the pool's snapshot semantics.)
    const rawCursorParam = searchParams.get("cursor") || "";
    const poolCursor = parsePoolCursor(rawCursorParam);
    const sweepCursor = poolCursor === null ? parseSweepCursor(rawCursorParam) : null;
    const cursorKey = poolCursor === null && sweepCursor === null ? parseContinuationCursor(rawCursorParam) : null;
    // Immutable raw-key window bounds captured by the client when the stream starts and
    // echoed verbatim on every later request. The anchor keeps later inserts out of the
    // pool; the floor freezes membership at the bottom and fixes where the beyond-pool
    // continuation starts, even after deletions shrink the pool below 1000 rows.
    const poolAnchor = parseContinuationCursor(searchParams.get("poolAnchor") || "");
    const poolFloor = parseContinuationCursor(searchParams.get("poolFloor") || "");
    // Response bounds: echo the request's bounds verbatim once the stream has them; only
    // the first pool response computes them. Beyond-pool ("k:") chunks carry no bounds.
    let responseAnchor: string | null = poolAnchor ? encodeContinuationCursor(poolAnchor) : null;
    let responseFloor: string | null = poolFloor ? encodeContinuationCursor(poolFloor) : null;

    // Use a fixed candidate set per request (fixed pool size, not growing with page)
    // with deterministic tie-breaks (score desc, posted_at desc, id).
    // Bounded candidate pool ensures zero duplicates and zero skips between adjacent pages.
    query = query
      .order("posted_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false });

    // Raw-order scans power two phases: the terminal completeness sweep ("s", bounded
    // below by the immutable floor) and the beyond-pool continuation ("k", unbounded).
    // Both scan raw rows in (posted_at desc, id desc) order in page-sized slices; each
    // slice is scored and ranked independently and the per-company cap (max 3 per company,
    // reorder-only, nothing dropped) applies within the slice. This is deliberately NOT
    // equivalent to one globally ranked list: within the 1000-row pool the whole pool is
    // ranked together; beyond it, recency-ordered slices trade cross-slice ranking for
    // completeness (every matching job is eventually served) and bounded work per request.
    const runRawScan = async (
      after: { posted_at: string | null; id: string } | null,
      floor: { posted_at: string | null; id: string } | null,
      phase: "s" | "k"
    ) => {
      if (after) {
        const keyFilter = after.posted_at
          // Null posted_at rows sort after every dated row in the stream, so they belong
          // to the region strictly after any dated key.
          ? `posted_at.lt.${after.posted_at},and(posted_at.eq.${after.posted_at},id.lt.${after.id}),posted_at.is.null`
          : `and(posted_at.is.null,id.lt.${after.id})`;
        query = query.or(keyFilter);
      }
      if (floor) query = query.or(poolFloorFilter(floor));
      // One bounded scan per request: up to RECOMMENDED_POOL_SIZE raw rows, walked in
      // page-sized slices until a slice yields qualifying jobs. A request never returns an
      // empty non-terminal page unless the whole scan budget filtered out (extreme edge);
      // then the client auto-continues via the continuation flag below.
      const { data: rawJobs, error } = await query.limit(RECOMMENDED_POOL_SIZE);
      if (error) {
        log.error("Failed to query continuation jobs for recommendations", { error: error.message || error });
        return NextResponse.json(
          { error: "Database service unavailable", jobs: [], totalCount: 0 },
          { status: 503 }
        );
      }
      const rows = rawJobs || [];
      // More rows remain when the scan hit its budget or when already-fetched rows beyond
      // the served slice were not consumed yet.
      let consumed = 0;
      paginatedJobs = [];
      while (consumed < rows.length) {
        const chunk = rows.slice(consumed, consumed + pageSize);
        consumed += chunk.length;
        const rankedJobs = isPersonalized || hasResume
          ? rankJobsByRecommendation(chunk, answers)
          : rankJobsByRecommendation(chunk, null);
        const qualifyingJobs = isPersonalized
          ? rankedJobs.filter((job) => (job.matchScore ?? job._matchScore ?? 0) > 0)
          : rankedJobs;
        paginatedJobs = capJobsPerCompany(qualifyingJobs, 3, pageSize);
        if (paginatedJobs.length > 0) break;
      }
      const scanHasMore = consumed < rows.length || rows.length === RECOMMENDED_POOL_SIZE;
      const lastRawRow = consumed > 0 ? rows[consumed - 1] : null;
      if (phase === "s") {
        if (scanHasMore && lastRawRow) {
          hasNextPage = true;
          nextCursor = encodeSweepCursor(lastRawRow);
        } else if (floor) {
          // The frozen window is fully swept: the stream continues strictly after the
          // immutable floor value, exactly where the original pool ended.
          hasNextPage = true;
          nextCursor = encodeContinuationCursor(floor);
        } else {
          hasNextPage = false;
          nextCursor = null;
        }
      } else {
        hasNextPage = scanHasMore;
        nextCursor = scanHasMore && lastRawRow ? encodeContinuationCursor(lastRawRow) : null;
        // Beyond-pool chunks are raw keyset scans; the window bounds no longer apply.
        responseAnchor = null;
        responseFloor = null;
      }
      isContinuationResponse = true;
      totalIsLowerBound = true;
      // totalCount stays 0 on scan chunks: the domain-wide total is not verified
      // here and a chunk count must never be presented as one. The client keeps its last
      // known total (marked as a lower bound) and relies on hasNextPage for continuation.
      return null;
    };

    if (cursorKey !== null) {
      const failure = await runRawScan(cursorKey, null, "k");
      if (failure) return failure;
    } else if (sweepCursor !== null) {
      const failure = await runRawScan(sweepCursor.after, poolFloor, "s");
      if (failure) return failure;
    } else {
      if (poolAnchor) query = query.or(poolAnchorFilter(poolAnchor));
      if (poolFloor) query = query.or(poolFloorFilter(poolFloor));
      query = query.range(0, RECOMMENDED_POOL_SIZE - 1);

      const { data: rawJobs, error } = await query;

      if (error) {
        log.error("Failed to query candidate jobs for recommendations", { error: error.message || error });
        return NextResponse.json(
          { error: "Database service unavailable", jobs: [], totalCount: 0 },
          { status: 503 }
        );
      }

      const candidateJobs = rawJobs || [];
      const firstPoolFull = candidateJobs.length === RECOMMENDED_POOL_SIZE;
      // Frozen window bounds: computed only on the stream's first pool response, echoed
      // verbatim afterwards (see responseAnchor/responseFloor above).
      if (!responseAnchor && candidateJobs.length > 0) responseAnchor = encodeContinuationCursor(candidateJobs[0]);
      const streamFloor =
        poolFloor ??
        (firstPoolFull
          ? {
              posted_at: candidateJobs[candidateJobs.length - 1].posted_at ?? null,
              id: String(candidateJobs[candidateJobs.length - 1].id),
            }
          : null);
      if (!responseFloor && streamFloor) responseFloor = encodeContinuationCursor(streamFloor);
      const rankedJobs = isPersonalized || hasResume
        ? rankJobsByRecommendation(candidateJobs, answers)
        : rankJobsByRecommendation(candidateJobs, null);

      // Drop rows with matchScore <= 0 (ineligible under saved preferences or not relevant to the user's role).
      // A saved "remote" preference is additive and is handled in ranking.
      const qualifyingJobs = isPersonalized
        ? rankedJobs.filter((job) => (job.matchScore ?? job._matchScore ?? 0) > 0)
        : rankedJobs;

      totalCount = qualifyingJobs.length; // Honestly reports the bounded pool total after exclusions

      // Pool slices are value-based ranked keysets over the anchored pool (see helpers):
      // stable under insertions (anchor) and deletions (value predicate) for rows whose
      // score inputs did not change. The legacy numeric page parameter is intentionally
      // not used for positioning: it drifts under mutation.
      const remaining = poolCursor
        ? qualifyingJobs.filter((job) => {
            const s = jobStreamScore(job);
            if (s !== poolCursor.score) return s < poolCursor.score;
            const t = jobStreamTime(job);
            if (t !== poolCursor.time) return t < poolCursor.time;
            return String(job.id) < poolCursor.id;
          })
        : qualifyingJobs;

      const slice = remaining.slice(0, pageSize);
      // Per-slice employer diversity: reorder-only within the served slice. It never drops
      // rows, so completeness is preserved and the keyset never skips a deferred row. It is
      // NOT a hard cap: a slice full of one employer serves that employer the full slice.
      paginatedJobs = capJobsPerCompany(slice, 3, pageSize);

      // The stream continues while more frozen-window rows remain. When ranked paging
      // exhausts the window, the stream hands out a terminal sweep cursor ("s:top"): the
      // sweep rescans the SAME frozen window in raw order (unbounded above, so rows whose
      // raw keys moved above the anchor mid-stream are still reached), and the client's
      // id-dedupe swallows rows already served. After the sweep, a stream whose first pool
      // came back full continues strictly after the immutable floor value.
      // Phase transitions are cursor-handed (never in-request) so every scan runs on a
      // clean query without the pool's own bounds.
      if (firstPoolFull) totalIsLowerBound = true;
      if (remaining.length > pageSize) {
        hasNextPage = true;
        nextCursor = encodePoolCursor(slice[slice.length - 1]);
      } else if (streamFloor || responseAnchor) {
        hasNextPage = true;
        nextCursor = encodeSweepCursor(null);
        if (slice.length === 0) {
          // Ranked exhaustion with nothing left to serve: a continuation-marked empty
          // page; the client auto-chains onto the sweep.
          isContinuationResponse = true;
        }
      } else {
        hasNextPage = false;
        nextCursor = null;
      }
    }

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
        return NextResponse.json(
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
          companyDomain: row.companies?.domain || null,
          logoUrl: row.logo_url || row.companies?.logo_url || null,
          logo_url: row.logo_url || row.companies?.logo_url || null,
          matchScore: sharedDisplayScore(row, displayAnswers || (isPersonalized || hasResumeSignals(answers.resumeProfile) ? answers : null), isPro),
          scoreRevision: scoreInputRevision(row, true),
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
        matchScore: sharedDisplayScore(row, displayAnswers || (isPersonalized || hasResumeSignals(answers.resumeProfile) ? answers : null), isPro),
        scoreRevision: scoreInputRevision(row, false),
      };
    });

    return NextResponse.json({
      jobs: formattedJobs,
      totalCount,
      personalized: isPersonalized || hasResume,
      isPro,
      page,
      pageSize,
      hasNextPage,
      nextCursor,
      // continuation: true marks beyond-pool chunks (pool responses omit it). The client
      // auto-continues ONLY on an empty page that carries this flag; the pinned
      // pause-on-empty behavior for pool pages is unchanged.
      continuation: isContinuationResponse,
      // totalIsLowerBound: true means totalCount is a verified lower bound (a full pool or
      // known-served rows), never the verified domain-wide total.
      totalIsLowerBound,
      // poolAnchor / poolFloor: immutable raw-key window bounds pinning the pool for this
      // stream. The client echoes them verbatim on every subsequent request; beyond-pool
      // ("k:") chunks return null for both.
      poolAnchor: responseAnchor,
      poolFloor: responseFloor,
    });
  } catch (err: any) {
    baseLog.error("Unhandled error in /api/jobs/recommended", { error: err?.message || err });
    return NextResponse.json(
      { error: "Failed to generate recommended jobs", jobs: [], totalCount: 0 },
      { status: 500 }
    );
  }
}
