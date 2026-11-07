import { NextResponse } from "next/server";
import { measureRouteBudget } from "@/lib/api/routeBudget";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";
import { formatSalary } from "@/lib/salary/parser";
import { getSupabaseAdminClient, getRuntimeEnv, getClientIpFromRequest, checkRateLimit } from "@/lib/ai/serviceHandler";
import { checkSharedRateLimit, SEARCH_RATE_LIMIT, searchRateLimitStore } from "@/lib/api/sharedRateLimit";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { getCountryFilterClause } from "@/lib/countries";
import { decodeCursor, encodeCursor } from "@/lib/pagination/cursor";
import { capJobsPerCompany } from "@/lib/jobs/capping";
import { normalizeUserCountries, applyEligibilityFilter, isJobEligible } from "@/lib/jobs/eligibility";
import { isUserApproved } from "@/lib/auth/approval";

import { reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter";

import { createLogger } from "@/lib/observability/logger";

const baseLog = createLogger({ context: { route: "/api/jobs/search" } });

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

function sanitizeSearchQuery(input: string): string {
  if (!input) return "";
  return input
    .replace(/[%_(),"'`;\\$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * GET /api/jobs/search
 * 
 * Safe server search endpoint for jobs corpus.
 * Searches title, company, location, category, and description across live active jobs.
 * Enforces server-level Pro gating:
 * - Guests and Free users receive preview-safe data (masked company, masked applyUrl, masked salary).
 * - Pro subscribers receive full unlocked job attributes.
 * Raw jobs table is NEVER exposed to anonymous clients directly.
 */

async function getHandler(req: Request) {
  const log = baseLog.child({ requestId: req?.headers.get("x-request-id") ?? "unknown" });
  try {
    const isLegacy =
      process.env.NODE_ENV === "test" &&
      process.env.__CAREERMONKE_LEGACY_RATE_LIMIT === "true";

    if (!isLegacy) {
      const clientIp = getClientIpFromRequest(req);
      const ipLimit = await checkSharedRateLimit(
        `search:ip:${clientIp}`,
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
    const rawInput = searchParams.get("q") || searchParams.get("search") || "";
    const rawQuery = isLegacy ? rawInput : rawInput.slice(0, 100);
    const category = searchParams.get("category") || "";
    const remoteOnly = searchParams.get("remoteOnly") === "true";
    const locationParam = searchParams.get("location") || "";
    const countryCodeParam = searchParams.get("country_code") || searchParams.get("country") || "";
    const levelParam = searchParams.get("level") || "";
    const jobTypeParam = searchParams.get("jobType") || "";
    const dateParam = searchParams.get("datePosted") || searchParams.get("date") || "";
    const workModelParam = searchParams.get("workModel") || "";
    const experienceParam = searchParams.get("experience") || searchParams.get("exp") || "";
    const salaryMinParam = searchParams.get("salaryMin") || searchParams.get("salary_min") || "";
    const sourceTypeParam = searchParams.get("sourceType") || searchParams.get("source_type") || "";
    const companyParam = searchParams.get("company") || "";
    const cursorParam = searchParams.get("cursor") || "";
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || "25", 10)));

    let cfEnv: Record<string, any> | undefined;
    try {
      const ctx = getRequestContext();
      if (ctx?.env) {
        cfEnv = ctx.env as Record<string, any>;
      }
    } catch {}

    const cleanQuery = isLegacy ? sanitizeSearchQuery(rawQuery) : sanitizeSearchQuery(rawQuery).slice(0, 100);
    const supabaseAdmin = getSupabaseAdminClient(cfEnv, true);

    const hasServiceKey = Boolean(
      getRuntimeEnv("SUPABASE_SERVICE_ROLE_KEY", cfEnv) ||
      getRuntimeEnv("SUPABASE_SERVICE_KEY", cfEnv)
    );
    const targetTable = hasServiceKey ? "jobs" : "jobs_public";

    // Check optional Pro entitlement and user preferences via Bearer token
    let isPro = false;
    let userId: string | null = null;
    let userLocations: string[] = [];
    let userSalaryCurrency: string | undefined;
    let userEligibilityPref = true;

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ") && hasServiceKey) {
      const token = authHeader.replace("Bearer ", "").trim();
      try {
        const { data: { user } } = await supabaseAdmin.auth.getUser(token);
        if (user) {
          const isApproved = await isUserApproved(supabaseAdmin, user);
          if (!isApproved) {
            return NextResponse.json(
              {
                error: "Early access only",
                message: "Invite-only access: your account is pending approval.",
                jobs: [],
                total: 0,
              },
              { status: 403 }
            );
          }
          userId = user.id;
          const entitlement = await getServerEntitlement(user.id);
          isPro = Boolean(entitlement.isPro);

          // Fetch user preferences for eligibility filter and preferred currency
          const { data: prefs } = await supabaseAdmin
            .from("user_preferences")
            .select("locations, eligibility_filter, salary_currency")
            .eq("user_id", user.id)
            .maybeSingle();

          if (prefs) {
            userLocations = Array.isArray(prefs.locations) ? prefs.locations : [];
            userSalaryCurrency = (prefs.salary_currency && prefs.salary_currency.trim().toUpperCase() !== "USD")
              ? prefs.salary_currency.trim().toUpperCase()
              : undefined;
            userEligibilityPref = prefs.eligibility_filter !== false;
          }
        }
      } catch (_authErr) {
        // Fall back to safe preview
        isPro = false;
      }
    }

    const eligibilityQueryParam = searchParams.get("eligibility");
    let isEligibilityActive = userEligibilityPref;
    if (eligibilityQueryParam === "off") {
      isEligibilityActive = false;
      if (userId) {
        // Persist opt-out to user_preferences
        try {
          await supabaseAdmin.from("user_preferences").update({ eligibility_filter: false }).eq("user_id", userId);
        } catch {}
      }
    } else if (eligibilityQueryParam === "on") {
      isEligibilityActive = true;
      if (userId) {
        // Persist opt-in to user_preferences
        try {
          await supabaseAdmin.from("user_preferences").update({ eligibility_filter: true }).eq("user_id", userId);
        } catch {}
      }
    }

    const preferredCurrency = searchParams.get("currency") || userSalaryCurrency || undefined;
    const normalizedUserCountries = normalizeUserCountries(userLocations);

    const selectColumns = (isPro && hasServiceKey)
      ? "*, companies(name, logo_url)"
      : hasServiceKey
      ? "id, title, company, location, category, remote, remote_scope, remote_eligibility, country_code, country, job_type, verified, posted_at, created_at, salary_min, salary_max, currency, salary_period, salary_text, source_type, source, company_id, companies(name, logo_url)"
      : "id, title, location, category, remote, remote_scope, remote_eligibility, country_code, job_type, verified, posted_at, created_at";

    const idParam = searchParams.get("id");
    if (idParam) {
      const cleanId = sanitizeSearchQuery(idParam).trim();
      const singleColumns = (isPro && hasServiceKey)
        ? "*, companies(name, logo_url)"
        : hasServiceKey
        ? "id, title, company, location, category, remote, remote_scope, remote_eligibility, country_code, country, job_type, verified, posted_at, created_at, status, is_active, company_id, companies(name, logo_url)"
        : "id, title, location, category, remote, remote_scope, remote_eligibility, country_code, job_type, verified, posted_at, created_at, status, is_active";

      const { data: rawJobRow, error: singleError } = await (supabaseAdmin
        .from(targetTable)
        .select(singleColumns as any) as any)
        .eq("id", cleanId)
        .maybeSingle();

      if (singleError) {
        log.error("single query error", { error: singleError.message || singleError });
        return NextResponse.json(
          { degraded: true, jobs: [], totalCount: 0, hasNextPage: false, hasMore: false, nextCursor: null },
          { status: 503 }
        );
      }

      if (!rawJobRow) {
        return NextResponse.json({ jobs: [], totalCount: 0, hasNextPage: false, hasMore: false, nextCursor: null });
      }

      const jobRow: any = rawJobRow;
      const isInactive = Boolean(jobRow.is_active === false || jobRow.status === "expired" || jobRow.status === "closed");
      const resolvedLogo = jobRow.logo_url || jobRow.logoUrl || jobRow.companies?.logo_url || null;
      const originalSalary = formatSalary(jobRow.salary_min, jobRow.salary_max, jobRow.currency, jobRow.salary_period) || jobRow.salary_text || null;
      const displaySalary = preferredCurrency
        ? (formatSalary(jobRow.salary_min, jobRow.salary_max, jobRow.currency, jobRow.salary_period, { displayCurrency: preferredCurrency }) || jobRow.salary_text || null)
        : originalSalary;

      const formatted = {
        id: jobRow.id,
        title: jobRow.title || "Untitled Position",
        company: isPro && !isInactive ? (jobRow.company || "Verified Employer") : "Verified Employer",
        companyId: jobRow.company_id || null,
        company_id: jobRow.company_id || null,
        location: jobRow.location || (jobRow.remote ? "Remote (Worldwide)" : "Remote"),
        category: jobRow.category || "engineering",
        remote: Boolean(jobRow.remote),
        remoteScope: jobRow.remote_scope || undefined,
        remoteEligibility: jobRow.remote_eligibility || undefined,
        country: jobRow.country_code || jobRow.country || "",
        type: jobRow.job_type === "internship" ? "Internship" : "Full-time",
        directSource: Boolean(jobRow.verified),
        applyUrl: isInactive || !isPro ? "" : (jobRow.apply_url || ""),
        salary: isInactive || !isPro ? "" : (displaySalary || originalSalary || ""),
        salary_display: isInactive || !isPro ? null : displaySalary,
        salary_original: isInactive || !isPro ? null : originalSalary,
        description: isInactive || !isPro ? "" : (jobRow.description || ""),
        skills: isPro ? (jobRow.skills || []) : [],
        postedAt: jobRow.posted_at || jobRow.created_at,
        isExpired: isInactive,
        status: isInactive ? "expired" : (jobRow.status || "active"),
        logoUrl: (isPro && !isInactive) ? resolvedLogo : null,
        logo_url: (isPro && !isInactive) ? resolvedLogo : null,
      };

      return NextResponse.json({
        jobs: [formatted],
        totalCount: 1,
        hasNextPage: false,
        hasMore: false,
        nextCursor: null,
        appliedEligibility: null,
      });
    }

    const hasActiveFilter = Boolean(
      (category && category !== "all") ||
      remoteOnly ||
      (countryCodeParam && countryCodeParam.trim() && countryCodeParam.toLowerCase() !== "all") ||
      (locationParam && locationParam.trim() && locationParam.toLowerCase() !== "all") ||
      (jobTypeParam && jobTypeParam.trim() && jobTypeParam.toLowerCase() !== "all") ||
      (levelParam && levelParam.trim() && levelParam.toLowerCase() !== "all") ||
      (workModelParam && workModelParam.trim() && workModelParam.toLowerCase() !== "all") ||
      (dateParam && dateParam.trim() && dateParam.toLowerCase() !== "all") ||
      (companyParam && companyParam.trim() && companyParam.toLowerCase() !== "all") ||
      (salaryMinParam && parseInt(salaryMinParam, 10) > 0) ||
      (sourceTypeParam && sourceTypeParam.trim() && sourceTypeParam.toLowerCase() !== "all") ||
      (experienceParam && experienceParam.trim() && experienceParam.toLowerCase() !== "all" && experienceParam.toLowerCase() !== "all experience") ||
      cleanQuery
    );

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    // Keyset cursor decoding
    const cursor = decodeCursor(cursorParam);
    const isEligibilityFilterActive = Boolean(isEligibilityActive && normalizedUserCountries.codes.length > 0);
    const initialCountMode: "exact" | "estimated" = (hasActiveFilter && !isEligibilityFilterActive) ? "exact" : "estimated";
    const fetchLimit = pageSize + 1; // fetch 1 extra to determine hasNextPage
    const isMultiWord = cleanQuery && cleanQuery.includes(" ");

    const sortByParam = searchParams.get("sortBy") || "match";

    const buildSearchQuery = (
      countMode: "exact" | "estimated" | null,
      activeCursor?: { posted_at: string | null; id: string | number } | null,
      activeFrom?: number,
      activeLimit?: number
    ) => {
      let query = supabaseAdmin
        .from(targetTable)
        .select(selectColumns, countMode ? { count: countMode } : undefined)
        .eq("is_active", true)
        .eq("status", "active");

      // Category filter matching getLiveJobs logic
      if (category && category !== "all") {
        const c = sanitizeSearchQuery(category).toLowerCase().trim();
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

    if (remoteOnly) {
      query = query.eq("remote", true);
    }

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
    }

    if (locationParam && locationParam.trim() && locationParam.toLowerCase() !== "all") {
      const loc = sanitizeSearchQuery(locationParam);
      if (loc.toLowerCase() === "remote") {
        query = query.or("remote.eq.true,location.ilike.%remote%");
      } else if (loc) {
        query = query.ilike("location", "%" + loc + "%");
      }
    }

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

    if (levelParam && levelParam.trim() && levelParam.toLowerCase() !== "all") {
      const lvl = levelParam.trim().toLowerCase();
      if (lvl.includes("lead") || lvl.includes("staff")) {
        query = query.or("title.ilike.%staff%,title.ilike.%principal%,title.ilike.%lead%");
      } else if (lvl.includes("senior")) {
        query = query.or("title.ilike.%senior%,title.ilike.%sr.%");
      } else if (lvl.includes("entry") || lvl.includes("junior")) {
        query = query.or("title.ilike.%junior%,title.ilike.%entry%,title.ilike.%associate%");
      } else if (lvl.includes("mid")) {
        query = query
          .not("title", "ilike", "%senior%")
          .not("title", "ilike", "%sr.%")
          .not("title", "ilike", "%staff%")
          .not("title", "ilike", "%principal%")
          .not("title", "ilike", "%lead%")
          .not("title", "ilike", "%junior%")
          .not("title", "ilike", "%entry%");
      }
    }

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
          .or("title.ilike.%junior%,title.ilike.%entry%,title.ilike.%associate%")
          .not("title", "ilike", "%senior%")
          .not("title", "ilike", "%sr.%")
          .not("title", "ilike", "%staff%")
          .not("title", "ilike", "%principal%")
          .not("title", "ilike", "%lead%");
      } else if (exp.includes("5") || exp.includes("senior") || exp.includes("sr")) {
        query = query.or("title.ilike.%senior%,title.ilike.%sr.%");
      }
    }

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

    // Company filter (server-side)
    if (companyParam && companyParam.trim() && companyParam.toLowerCase() !== "all") {
      if (hasServiceKey) {
        const cleanComp = sanitizeSearchQuery(companyParam).trim();
        if (cleanComp) {
          query = query.or(`company.ilike.%${cleanComp}%,company_slug.ilike.%${cleanComp.toLowerCase()}%`);
        }
      }
    }

    // Salary Min filter (only where salary exists)
    if (salaryMinParam) {
      if (hasServiceKey) {
        const minVal = parseInt(salaryMinParam, 10);
        if (!isNaN(minVal) && minVal > 0) {
          query = query.not("salary_min", "is", null).gte("salary_min", minVal);
        }
      }
    }

    // Source Type filter (ats, direct, aggregator, etc.)
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
          query = query.or(`source_type.eq.${st},source.ilike.%${st}%`);
        }
      }
    }


    // Search query matching: company and description guarded when jobs_public is used
    if (cleanQuery) {
      const parts = cleanQuery.split(" ").filter((p) => p.length >= 2);
      if (hasServiceKey) {
        if (parts.length > 1) {
          for (const p of parts) {
            query = query.or(
              `title.ilike.%${p}%,company.ilike.%${p}%,location.ilike.%${p}%,category.ilike.%${p}%,description.ilike.%${p}%`
            );
          }
        } else {
          query = query.or(
            `title.ilike.%${cleanQuery}%,company.ilike.%${cleanQuery}%,location.ilike.%${cleanQuery}%,category.ilike.%${cleanQuery}%,description.ilike.%${cleanQuery}%`
          );
        }
      } else {
        // jobs_public lacks company and description columns
        if (parts.length > 1) {
          for (const p of parts) {
            query = query.or(
              `title.ilike.%${p}%,location.ilike.%${p}%,category.ilike.%${p}%`
            );
          }
        } else {
          query = query.or(
            `title.ilike.%${cleanQuery}%,location.ilike.%${cleanQuery}%,category.ilike.%${cleanQuery}%`
          );
        }
      }
    }

    const winLimit = activeLimit ?? fetchLimit;
    const winCursor = activeCursor !== undefined ? activeCursor : cursor;
    const winFrom = activeFrom !== undefined ? activeFrom : from;

    if (isMultiWord) {
      query = query.order("posted_at", { ascending: false, nullsFirst: false }).limit(200);
    } else if (winCursor) {
      // Keyset cursor pagination (no OFFSET, 0ms on 100k+ rows)
      if (winCursor.posted_at) {
        query = query.or(
          `posted_at.lt.${winCursor.posted_at},and(posted_at.eq.${winCursor.posted_at},id.lt.${winCursor.id}),posted_at.is.null`
        );
      } else {
        query = query.is("posted_at", null).lt("id", winCursor.id);
      }
      if (sortByParam === "match") {
        query = query.order("verified", { ascending: false });
      }
      query = query.order("posted_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).limit(winLimit);
    } else if (page > 1 && !cursorParam && winFrom > 0) {
      // Legacy offset pagination fallback for backward compatibility
      if (sortByParam === "match") {
        query = query.order("verified", { ascending: false });
      }
      query = query.order("posted_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).range(winFrom, winFrom + winLimit - 1);
    } else {
      // Page 1 initial keyset query
      if (sortByParam === "match") {
        query = query.order("verified", { ascending: false });
      }
      query = query.order("posted_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).limit(winLimit);
    }

      return query;
    };

    let rows: any[] = [];
    let hasNextPage = false;
    let nextCursor: string | null = null;
    let appliedEligibility: { countries: string[]; filteredOut: number } | null = null;
    let approximateTotalCount = 0;

    if (isEligibilityFilterActive && !isMultiWord) {
      // (1) Search windowed fetching: keep fetching windows until pageSize eligible rows or a 5-window cap
      let accumulatedEligible: any[] = [];
      let totalFilteredOut = 0;
      let curCursor = cursor;
      let curFrom = from;
      let windowCount = 0;
      let rawHasMore = false;
      let estimatedCountVal: number | null = null;

      while (windowCount < 5 && accumulatedEligible.length < pageSize) {
        windowCount++;
        const isFirst = windowCount === 1;
        const countMode = isFirst ? initialCountMode : null;
        const winLimit = pageSize + 1; // +1 to determine if raw rows have more

        let queryResult = await buildSearchQuery(countMode, curCursor, curFrom, winLimit);
        if (
          isFirst &&
          queryResult.error &&
          (queryResult.error.code === "57014" ||
            String(queryResult.error.code) === "57014" ||
            (typeof queryResult.error.message === "string" && queryResult.error.message.includes("57014")))
        ) {
          log.warn("count query timed out (57014); falling back to estimated");
          queryResult = await buildSearchQuery("estimated", curCursor, curFrom, winLimit);
        }

        if (queryResult.error) {
          if (isFirst) {
            log.error("query error", { error: queryResult.error.message || queryResult.error });
            return NextResponse.json(
              { degraded: true, jobs: [], totalCount: 0, hasNextPage: false, hasMore: false, nextCursor: null },
              { status: 503 }
            );
          }
          break;
        }

        if (isFirst && queryResult.count !== undefined) {
          estimatedCountVal = queryResult.count;
        }

        const rawBatch = queryResult.data || [];
        if (rawBatch.length === 0) {
          rawHasMore = false;
          break;
        }

        const hasMoreInBatch = rawBatch.length > pageSize;
        const candidateRows = hasMoreInBatch ? rawBatch.slice(0, pageSize) : rawBatch;
        rawHasMore = hasMoreInBatch;

        // Filter candidate rows for eligibility
        let batchFiltered = 0;
        for (const item of candidateRows) {
          if (isJobEligible(item, normalizedUserCountries.codes, { filterEnabled: true })) {
            accumulatedEligible.push(item);
          } else {
            batchFiltered++;
          }
        }
        totalFilteredOut += batchFiltered;

        const lastRawItem = candidateRows[candidateRows.length - 1];
        if (lastRawItem) {
          curCursor = {
            posted_at: lastRawItem.posted_at || null,
            id: lastRawItem.id,
          };
          curFrom += candidateRows.length;
        }

        if (!hasMoreInBatch) {
          rawHasMore = false;
          break;
        }
      }

      if (accumulatedEligible.length > pageSize) {
        hasNextPage = true;
        rows = accumulatedEligible.slice(0, pageSize);
        const lastEligible = rows[rows.length - 1];
        nextCursor = lastEligible ? encodeCursor(lastEligible.posted_at, lastEligible.id) : null;
      } else {
        rows = accumulatedEligible;
        // Compute hasNextPage from raw fetched rows, not post-filter rows
        hasNextPage = rawHasMore;
        if (hasNextPage && curCursor) {
          nextCursor = encodeCursor(curCursor.posted_at, curCursor.id);
        }
      }

      appliedEligibility = {
        countries: normalizedUserCountries.names,
        filteredOut: totalFilteredOut,
      };

      // Never show an exact total when filtered; use estimated count from PostgreSQL
      approximateTotalCount = estimatedCountVal ?? (rows.length > 0 ? (page ? Math.max(rows.length, page * pageSize) : 100000) : 0);
    } else {
      let queryResult = await buildSearchQuery(initialCountMode);

      if (
        queryResult.error &&
        initialCountMode === "exact" &&
        (
          queryResult.error.code === "57014" ||
          String(queryResult.error.code) === "57014" ||
          (typeof queryResult.error.message === "string" && (
            queryResult.error.message.includes("57014") ||
            queryResult.error.message.toLowerCase().includes("timeout")
          ))
        )
      ) {
        log.warn("exact count query timed out (57014); falling back to estimated count");
        queryResult = await buildSearchQuery("estimated");
      }

      const { data, count, error } = queryResult;

      if (error) {
        log.error("query error", { error: error.message || error });
        return NextResponse.json(
          { degraded: true, jobs: [], totalCount: 0, hasNextPage: false, hasMore: false, nextCursor: null },
          { status: 503 }
        );
      }

      rows = data || [];

      if (isMultiWord && cleanQuery) {
        const lowerQuery = cleanQuery.toLowerCase();
        const parts = lowerQuery.split(" ").filter(Boolean);

        const computeRelevance = (row: any): number => {
          let score = 0;
          const lowerTitle = (row.title || "").toLowerCase();
          const lowerCompany = (row.company || "").toLowerCase();
          const lowerCategory = (row.category || "").toLowerCase();
          const lowerDesc = (row.description || "").toLowerCase();

          if (lowerTitle.includes(lowerQuery)) score += 100;
          else if (lowerCompany.includes(lowerQuery)) score += 80;

          let titleTokens = 0;
          let descTokens = 0;
          for (const p of parts) {
            if (lowerTitle.includes(p)) titleTokens++;
            if (lowerDesc.includes(p)) descTokens++;
          }
          score += titleTokens * 25;
          score += descTokens * 5;

          if (lowerCategory.includes(lowerQuery)) score += 15;
          return score;
        };

        rows.sort((a: any, b: any) => {
          const relA = computeRelevance(a);
          const relB = computeRelevance(b);
          if (relB !== relA) return relB - relA;
          const timeA = new Date(a.posted_at || a.created_at || 0).getTime();
          const timeB = new Date(b.posted_at || b.created_at || 0).getTime();
          return timeB - timeA;
        });

        rows = rows.slice(from, to + 1);

        if (isEligibilityFilterActive) {
          const eligibilityResult = applyEligibilityFilter(rows, normalizedUserCountries.codes, { filterEnabled: true });
          rows = eligibilityResult.eligibleJobs;
          appliedEligibility = {
            countries: normalizedUserCountries.names,
            filteredOut: eligibilityResult.filteredOut,
          };
        }
      }

      if (!isMultiWord) {
        if (rows.length > pageSize) {
          hasNextPage = true;
          rows = rows.slice(0, pageSize);
          const lastItem = rows[rows.length - 1] as any;
          if (lastItem) {
            nextCursor = encodeCursor(lastItem.posted_at, lastItem.id);
          }
        } else if (page > 1 && !cursorParam) {
          hasNextPage = (count ? from + rows.length < count : false);
        }
      }

      approximateTotalCount = count ?? (rows.length > 0 ? (page ? Math.max(rows.length, page * pageSize) : 100000) : 0);
    }

    // Cap jobs per company server-side (max 3 per company in visible top-30)
    // Ensures mass postings are capped even for free users using opaque company_id
    rows = capJobsPerCompany(rows, 3, 30);

    const formattedJobs = rows.map((row: any) => {
      const resolvedLogo =
        row.logo_url || row.logoUrl || row.companies?.logo_url || null;
      const originalSalary = formatSalary(row.salary_min, row.salary_max, row.currency, row.salary_period) || row.salary_text || null;
      const displaySalary = preferredCurrency
        ? (formatSalary(row.salary_min, row.salary_max, row.currency, row.salary_period, { displayCurrency: preferredCurrency }) || row.salary_text || null)
        : originalSalary;

      if (isPro && hasServiceKey) {
        return {
          id: row.id,
          title: row.title || "Untitled Position",
          company: row.company || row.companies?.name || "Verified Employer",
          companyId: row.company_id || null,
          company_id: row.company_id || null,
          location: row.location || (row.remote ? "Remote (Worldwide)" : "Remote"),
          date: formatDate(row.posted_at || row.created_at),
          salary: displaySalary || originalSalary || "",
          salary_display: displaySalary,
          salary_original: originalSalary,
          category: row.category || "engineering",
          remote: Boolean(row.remote),
          remoteScope: row.remote_scope || undefined,
          remoteEligibility: row.remote_eligibility || undefined,
          country: row.country_code || row.country || "",
          type: row.job_type === "internship" ? "Internship" : "Full-time",
          directSource: Boolean(row.verified ?? true),
          applyUrl: row.apply_url || "",
          description: row.description || "",
          skills: row.skills || [],
          postedAt: row.posted_at || row.created_at,
          logoUrl: resolvedLogo,
          logo_url: resolvedLogo,
        };
      }

      // Guest / Free preview format — ZERO paid data leakage
      return {
        id: row.id,
        title: row.title || "Untitled Position",
        company: "Verified Employer",
        companyId: row.company_id || null,
        company_id: row.company_id || null,
        location: row.location || (row.remote ? "Remote (Worldwide)" : "Remote"),
        date: formatDate(row.posted_at || row.created_at),
        salary: "",
        salary_display: null,
        salary_original: null,
        category: row.category || "engineering",
        remote: Boolean(row.remote),
        remoteScope: row.remote_scope || undefined,
        remoteEligibility: row.remote_eligibility || undefined,
        country: row.country_code || row.country || "",
        type: row.job_type === "internship" ? "Internship" : "Full-time",
        directSource: Boolean(row.verified),
        applyUrl: "",
        description: "",
        skills: [],
        postedAt: row.posted_at || row.created_at,
        logoUrl: null,
        logo_url: null,
      };
    });

    return NextResponse.json({
      jobs: formattedJobs,
      totalCount: approximateTotalCount,
      nextCursor,
      hasNextPage,
      hasMore: hasNextPage,
      page,
      pageSize,
      isPro: Boolean(isPro && hasServiceKey),
      appliedEligibility,
    });
  } catch (err: any) {
    try {
      const parsed = JSON.parse(err?.message);
      if (parsed.missingVariable) {
        return NextResponse.json({ ...parsed, jobs: [], totalCount: 0 }, { status: 500 });
      }
    } catch {}
    log.error("fatal error", { error: err?.message || String(err) });
    reportRequestErrorToSentry(req, err);
    return NextResponse.json(
      { error: "Internal server error", jobs: [], totalCount: 0 },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  return measureRouteBudget("/api/jobs/search", () => getHandler(req));
}
