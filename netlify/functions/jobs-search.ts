import { createClient } from "@supabase/supabase-js";
import { formatSalary } from "../../src/lib/salary/parser";
import { COUNTRY_CODE_TO_NAME, getCountryFilterClause } from "../../src/lib/countries";
import { decodeCursor, encodeCursor } from "../../src/lib/pagination/cursor";
import { capJobsPerCompany, buildCompanyGroupIdMap, COMPANY_GROUP_SECRET_ENV } from "../../src/lib/jobs/capping";
import { normalizeUserCountries, applyEligibilityFilter, isJobEligible } from "../../src/lib/jobs/eligibility";
import { isUserApproved } from "../../src/lib/auth/approval";
import { safeLog } from "./_logger";

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl) {
    safeLog.error("[Netlify /jobs-search] Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL");
    throw new Error(JSON.stringify({
      error: "Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL",
      missingVariable: "NEXT_PUBLIC_SUPABASE_URL",
    }));
  }

  if (!serviceKey) {
    safeLog.error("[Netlify /jobs-search] Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY");
    throw new Error(JSON.stringify({
      error: "Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY",
      missingVariable: "SUPABASE_SERVICE_ROLE_KEY",
    }));
  }

  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
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

function sanitizeSearchQuery(input: string): string {
  if (!input) return "";
  return input
    .replace(/[%_(),"'`;\\$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

import { buildCorsHeaders, handleCorsPreflight } from "./_cors";

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

// In-memory rate-limit store (best-effort per serverless container)
const searchRateLimitStore = new Map<string, RateLimitBucket>();

export const SEARCH_RATE_LIMIT = {
  maxRequests: 30,
  windowMs: 60 * 1000,
};

export function _resetSearchRateLimitStore() {
  searchRateLimitStore.clear();
}

export function _setSearchRateLimitConfig(maxRequests: number, windowMs?: number) {
  SEARCH_RATE_LIMIT.maxRequests = maxRequests;
  if (windowMs) SEARCH_RATE_LIMIT.windowMs = windowMs;
}

export function getClientIp(event: any): string {
  if (!event || !event.headers) return "anonymous-client";
  const xfwd = event.headers["x-forwarded-for"] || event.headers["X-Forwarded-For"];
  if (xfwd) {
    const first = xfwd.split(",")[0].trim();
    if (first) return first;
  }
  const clientIp =
    event.headers["x-nf-client-connection-ip"] ||
    event.headers["client-ip"] ||
    event.headers["Client-Ip"];
  return clientIp || "anonymous-client";
}

export function checkSearchRateLimit(clientIp: string): { allowed: boolean; retryAfter: number; currentCount: number } {
  const now = Date.now();
  let bucket = searchRateLimitStore.get(clientIp);

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 1, resetAt: now + SEARCH_RATE_LIMIT.windowMs };
    searchRateLimitStore.set(clientIp, bucket);
    return { allowed: true, retryAfter: 0, currentCount: 1 };
  }

  if (bucket.count >= SEARCH_RATE_LIMIT.maxRequests) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return { allowed: false, retryAfter, currentCount: bucket.count };
  }

  bucket.count++;
  return { allowed: true, retryAfter: 0, currentCount: bucket.count };
}

const CORS_OPTIONS = {
  allowedMethods: "GET, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

export interface JobsSearchDeps {
  getSupabaseAdmin?: () => any;
}

export function createHandler(deps: JobsSearchDeps = {}) {
  const getAdmin = deps.getSupabaseAdmin || getSupabaseAdmin;

  return async function handler(event: any) {
  const preflight = handleCorsPreflight(event, CORS_OPTIONS);
  if (preflight) return preflight;

  const headers = {
    "Content-Type": "application/json",
    ...buildCorsHeaders(event, CORS_OPTIONS),
  };

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  // Request Rate Limiting (30 requests per 60s per client IP)
  const clientIp = getClientIp(event);
  const rateLimit = checkSearchRateLimit(clientIp);
  if (!rateLimit.allowed) {
    return {
      statusCode: 429,
      headers: {
        ...headers,
        "Retry-After": String(rateLimit.retryAfter),
      },
      body: JSON.stringify({
        error: "Rate limit exceeded. Please wait a moment.",
        retryAfter: rateLimit.retryAfter,
      }),
    };
  }


  try {
    const params = event.queryStringParameters || {};
    const rawQuery = params.q || params.search || "";
    const category = params.category || "";
    const remoteOnly = params.remoteOnly === "true";
    const locationParam = params.location || "";
    const countryCodeParam = params.country_code || params.country || "";
    const levelParam = params.level || "";
    const jobTypeParam = params.jobType || "";
    const dateParam = params.datePosted || params.date || "";
    const workModelParam = params.workModel || "";
    const salaryMinParam = params.salaryMin || params.salary_min || "";
    const sourceTypeParam = params.sourceType || params.source_type || "";
    const companyParam = params.company || "";
    const cursorParam = params.cursor || "";
    const page = Math.max(1, parseInt(params.page || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(params.pageSize || "25", 10)));

    const cleanQuery = sanitizeSearchQuery(rawQuery);
    const supabaseAdmin = getAdmin();
    const hasServiceKey = Boolean(
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
    );
    const targetTable = hasServiceKey ? "jobs" : "jobs_public";


    // Check optional Pro entitlement
    let isPro = false;
    let userId: string | null = null;
    let userLocations: string[] = [];
    let userSalaryCurrency: string | undefined;
    let userEligibilityPref = true;

    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (authHeader && authHeader.startsWith("Bearer ") && hasServiceKey) {
      const token = authHeader.replace("Bearer ", "").trim();
      try {
        const { data: { user } } = await supabaseAdmin.auth.getUser(token);
        if (user) {
          const isApproved = await isUserApproved(supabaseAdmin, user);
          if (!isApproved) {
            return {
              statusCode: 403,
              headers,
              body: JSON.stringify({
                error: "Early access only",
                message: "Invite-only access: your account is pending approval.",
                jobs: [],
                total: 0,
              }),
            };
          }
          userId = user.id;
          const { data: sub } = await supabaseAdmin
            .from("subscriptions")
            .select("*")
            .eq("user_id", user.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (sub) {
            const now = new Date();
            const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
            const graceEnd = sub.grace_period_end ? new Date(sub.grace_period_end) : null;
            const isPeriodActive = periodEnd ? periodEnd > now : false;
            const isGraceActive = graceEnd ? graceEnd > now : false;
            if ((sub.status === "active" && isPeriodActive) || isGraceActive) {
              isPro = true;
            }
          }

          // Fetch user preferences
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
      } catch (authErr) {
        safeLog.warn("[Netlify /jobs-search] Token verification failed", authErr);
        isPro = false;
      }
    }

    const eligibilityQueryParam = params.eligibility;
    let isEligibilityActive = userEligibilityPref;
    if (eligibilityQueryParam === "off") {
      isEligibilityActive = false;
      if (userId) {
        try {
          await supabaseAdmin.from("user_preferences").update({ eligibility_filter: false }).eq("user_id", userId);
        } catch {}
      }
    } else if (eligibilityQueryParam === "on") {
      isEligibilityActive = true;
      if (userId) {
        try {
          await supabaseAdmin.from("user_preferences").update({ eligibility_filter: true }).eq("user_id", userId);
        } catch {}
      }
    }

    const preferredCurrency = params.currency || userSalaryCurrency || undefined;
    const normalizedUserCountries = normalizeUserCountries(userLocations);

    const selectColumns = (isPro && hasServiceKey)
      ? "*, companies(name, logo_url)"
      : hasServiceKey
      ? "id, title, company, location, category, remote, remote_scope, remote_eligibility, country_code, country, job_type, verified, posted_at, created_at, salary_min, salary_max, currency, salary_period, salary_text, source_type, source, company_id, companies(name, logo_url)"
      : "id, title, location, category, remote, remote_scope, remote_eligibility, country_code, job_type, verified, posted_at, created_at";

    const idParam = params.id;
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
        safeLog.error("[Netlify /jobs-search] single query error:", singleError.message || singleError);
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({ degraded: true, jobs: [], totalCount: 0, hasNextPage: false, hasMore: false, nextCursor: null }),
        };
      }

      if (!rawJobRow) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ jobs: [], totalCount: 0, hasNextPage: false, hasMore: false, nextCursor: null }),
        };
      }

      const jobRow: any = rawJobRow;

      // Non-Pro responses never carry the real company_id: they get an opaque keyed hash instead (fails closed).
      let singleGroupId: string | null = null;
      if (!isPro) {
        try {
          const groupMap = await buildCompanyGroupIdMap([jobRow.company_id], process.env[COMPANY_GROUP_SECRET_ENV]);
          singleGroupId = jobRow.company_id ? groupMap.get(jobRow.company_id) ?? null : null;
        } catch (groupErr: any) {
          safeLog.error("[Netlify /jobs-search] company group secret unavailable; refusing non-Pro response", groupErr?.message || String(groupErr));
          return {
          statusCode: 503,
          headers,
          body: JSON.stringify({ degraded: true, jobs: [], totalCount: 0, hasNextPage: false, hasMore: false, nextCursor: null }),
        };
        }
      }

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
        ...(isPro
          ? { companyId: jobRow.company_id || null, company_id: jobRow.company_id || null }
          : { companyGroupId: singleGroupId }),
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

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          jobs: [formatted],
          totalCount: 1,
          hasNextPage: false,
          hasMore: false,
          nextCursor: null,
          appliedEligibility: null,
        }),
      };
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
    const sortByParam = params.sortBy || "match";

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

      if (workModelParam && workModelParam.trim() && workModelParam.toLowerCase() !== "all") {
        const wmTokens = workModelParam.toLowerCase().split(",").map((s: string) => s.trim()).filter(Boolean);
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

      if (cleanQuery) {
        const parts = cleanQuery.split(" ").filter((p: string) => p.length >= 2);
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
          safeLog.warn("[Netlify /jobs-search] count query timed out (57014); falling back to estimated");
          queryResult = await buildSearchQuery("estimated", curCursor, curFrom, winLimit);
        }

        if (queryResult.error) {
          if (isFirst) {
            safeLog.error("[Netlify /jobs-search] query error:", queryResult.error.message || queryResult.error);
            return {
              statusCode: 503,
              headers,
              body: JSON.stringify({ degraded: true, jobs: [], totalCount: 0, hasNextPage: false, hasMore: false, nextCursor: null }),
            };
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
        safeLog.warn("[Netlify /jobs-search] exact count query timed out (57014); falling back to estimated count");
        queryResult = await buildSearchQuery("estimated");
      }

      const { data, count, error } = queryResult;

      if (error) {
        safeLog.error("[Netlify /jobs-search] query error:", error.message || error);
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({ degraded: true, jobs: [], totalCount: 0, hasNextPage: false, hasMore: false, nextCursor: null }),
        };
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

    // Non-Pro responses never carry the real company_id: they get an opaque keyed hash instead (fails closed).
    let listGroupIds = new Map<string, string>();
    if (!isPro) {
      try {
        listGroupIds = await buildCompanyGroupIdMap(rows.map((r: any) => r.company_id), process.env[COMPANY_GROUP_SECRET_ENV]);
      } catch (groupErr: any) {
        safeLog.error("[Netlify /jobs-search] company group secret unavailable; refusing non-Pro response", groupErr?.message || String(groupErr));
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({ degraded: true, jobs: [], totalCount: 0, hasNextPage: false, hasMore: false, nextCursor: null }),
        };
      }
    }

    const formattedJobs = rows.map((row: any) => {
      const resolvedLogo =
        row.logo_url || row.logoUrl || row.companies?.logo_url || null;
      const originalSalary = formatSalary(row.salary_min, row.salary_max, row.currency, row.salary_period) || row.salary_text || null;
      const displaySalary = preferredCurrency
        ? (formatSalary(row.salary_min, row.salary_max, row.currency, row.salary_period, { displayCurrency: preferredCurrency }) || row.salary_text || null)
        : originalSalary;

      if (isPro) {
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

      return {
        id: row.id,
        title: row.title || "Untitled Position",
        company: "Verified Employer",
        companyGroupId: row.company_id ? listGroupIds.get(row.company_id) ?? null : null,
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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        jobs: formattedJobs,
        totalCount: approximateTotalCount,
        nextCursor,
        hasNextPage,
        hasMore: hasNextPage,
        page,
        pageSize,
        isPro,
        appliedEligibility,
      }),
    };
  } catch (err: any) {
    safeLog.error("[Netlify /jobs-search] fatal error:", err);
    try {
      const parsed = JSON.parse(err?.message);
      if (parsed.missingVariable) {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ ...parsed, jobs: [], totalCount: 0 }),
        };
      }
    } catch {}
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Internal server error", jobs: [], totalCount: 0 }),
    };
  }
  };
}

export const handler = createHandler();
export const createSearchHandler = createHandler;

