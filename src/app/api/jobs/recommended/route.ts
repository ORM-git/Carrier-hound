import { recommendationTiming } from "@/lib/jobs/recommendationTiming";
import { applyBrowseFilters, browseFiltersActive, isBrowseFilterError, parseBrowseFilters, resolveBrowseFxRates, salaryFxReport } from "@/lib/jobs/browseFilters";
import { NextResponse } from "next/server";
import { getClientIpFromRequest, checkRateLimit } from "@/lib/ai/serviceHandler";
import { checkSharedRateLimit, SEARCH_RATE_LIMIT, searchRateLimitStore } from "@/lib/api/sharedRateLimit";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { capJobsPerCompany } from "@/lib/jobs/capping";
import { rankJobsByRecommendation } from "@/lib/jobs/recommendations";
import { createLogger } from "@/lib/observability/logger";
import { VISIBLE_SOURCE_FILTER } from "@/lib/jobs/sourcePolicy";
import { applyRecommendedFilters, baseCandidateQuery, formatRecommendedJobs, PRO_HYDRATE_COLS, resolveRecommendedRequest } from "@/lib/jobs/recommendedRequest";

const baseLog = createLogger({ context: { route: "/api/jobs/recommended" } });

export const runtime = "edge";

const RECOMMENDED_POOL_SIZE = 1000;

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

    const r = await resolveRecommendedRequest(req, searchParams, cfEnv, log);
    const { supabaseAdmin, hasServiceKey, isPro, answers, displayAnswers, isPersonalized, hasResume, selectCols } = r;

    // No count: nothing reads it, and an exact count over the filtered table is extra DB work on every request.
    const filtered = applyRecommendedFilters(baseCandidateQuery(r, selectCols), searchParams, answers, hasServiceKey);
    // Company constraints need the jobs.company column: without it, fail rather than silently broaden.
    if (!filtered) {
      return respond({ error: "Company preferences unavailable", jobs: [], totalCount: 0 }, { status: 503 });
    }
    let query = filtered;

    // 9c. Transient browse filters (#796): invalid input is a 400; they need the jobs table (role_category, salary).
    const browse = parseBrowseFilters(searchParams);
    if (isBrowseFilterError(browse)) return respond(browse, { status: 400 });
    if (browseFiltersActive(browse) && !hasServiceKey) {
      return respond({ error: "Browse filters unavailable", jobs: [], totalCount: 0 }, { status: 503 });
    }
    // One rate table per response; a salary-filtered continuation evaluates on page 1's pinned rates.
    const fxRates = resolveBrowseFxRates(browse, page > 1);
    if (isBrowseFilterError(fxRates)) return respond(fxRates, { status: 400 });
    query = applyBrowseFilters(query, browse, fxRates);

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

    let formattedJobs: any[];
    try {
      formattedJobs = await formatRecommendedJobs(paginatedJobs, { isPro, hasServiceKey, cfEnv, displayAnswers, isPersonalized, answers, scoredAt });
    } catch (groupErr: any) {
      log.error("Company group secret unavailable; refusing non-Pro response in /api/jobs/recommended", {
        error: groupErr?.message || groupErr,
      });
      return respond(
        { error: "Database service unavailable", jobs: [], totalCount: 0 },
        { status: 503 }
      );
    }

    return respond({
      jobs: formattedJobs,
      totalCount,
      personalized: isPersonalized || hasResume,
      isPro,
      page,
      pageSize,
      salaryFx: salaryFxReport(browse, fxRates),
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
