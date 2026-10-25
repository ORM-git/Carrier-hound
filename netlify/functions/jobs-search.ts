import { createClient } from "@supabase/supabase-js";
import { formatSalary } from "../../src/lib/salary/parser";
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
    const levelParam = params.level || "";
    const jobTypeParam = params.jobType || "";
    const dateParam = params.datePosted || params.date || "";
    const workModelParam = params.workModel || "";
    const page = Math.max(1, parseInt(params.page || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(params.pageSize || "50", 10)));

    const cleanQuery = sanitizeSearchQuery(rawQuery);
    const supabaseAdmin = getAdmin();

    // Check optional Pro entitlement
    let isPro = false;
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.replace("Bearer ", "").trim();
      try {
        const { data: { user } } = await supabaseAdmin.auth.getUser(token);
        if (user) {
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
        }
      } catch (authErr) {
        safeLog.warn("[Netlify /jobs-search] Token verification failed", authErr);
        isPro = false;
      }
    }

    const selectColumns = isPro
      ? "*"
      : "id, title, location, category, remote, remote_scope, remote_eligibility, country_code, job_type, verified, posted_at, created_at";

    let query = supabaseAdmin
      .from("jobs")
      .select(selectColumns, { count: "exact" })
      .eq("is_active", true)
      .eq("status", "active");

    if (category && category !== "all") {
      const c = sanitizeSearchQuery(category).toLowerCase().trim();
      if (c === "trending") {
        query = query.in("category", ["ai", "engineering", "devops"]);
      } else if (c === "tech") {
        query = query.in("category", ["engineering", "devops", "ai", "software"]);
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

    if (cleanQuery) {
      const parts = cleanQuery.split(" ").filter((p) => p.length >= 2);
      if (parts.length > 1) {
        // All-words matching (AND): every word must appear in (title OR company OR location OR category OR description)
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
    }

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    // For multi-word text queries, pull pool to rank by relevance before pagination
    const isMultiWord = cleanQuery && cleanQuery.includes(" ");
    if (isMultiWord) {
      query = query.order("posted_at", { ascending: false }).limit(200);
    } else {
      query = query.order("posted_at", { ascending: false }).range(from, to);
    }

    const { data, count, error } = await query;

    if (error) {
      console.error("[Netlify /jobs-search] query error:", error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: error.message, jobs: [], totalCount: 0 }),
      };
    }

    let rows = data || [];

    if (isMultiWord && cleanQuery) {
      const lowerQuery = cleanQuery.toLowerCase();
      const parts = lowerQuery.split(" ").filter(Boolean);

      const computeRelevance = (row: any): number => {
        let score = 0;
        const lowerTitle = (row.title || "").toLowerCase();
        const lowerCompany = (row.company || "").toLowerCase();
        const lowerCategory = (row.category || "").toLowerCase();
        const lowerDesc = (row.description || "").toLowerCase();

        // Exact phrase match in title or company
        if (lowerTitle.includes(lowerQuery)) score += 100;
        else if (lowerCompany.includes(lowerQuery)) score += 80;

        // Individual search words in title
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

      // Slice to page window
      rows = rows.slice(from, to + 1);
    }
    const formattedJobs = rows.map((row: any) => {
      if (isPro) {
        return {
          id: row.id,
          title: row.title || "Untitled Position",
          company: row.company || "Verified Employer",
          location: row.location || (row.remote ? "Remote (Worldwide)" : "Remote"),
          date: formatDate(row.posted_at || row.created_at),
          salary: formatSalary(row.salary_min, row.salary_max, row.currency, row.salary_period) || row.salary_text || "",
          category: row.category || "engineering",
          remote: Boolean(row.remote),
          remoteScope: row.remote_scope || undefined,
          remoteEligibility: row.remote_eligibility || undefined,
          country: row.country || row.country_code || "US",
          type: row.job_type === "internship" ? "Internship" : "Full-time",
          directSource: Boolean(row.verified ?? true),
          applyUrl: row.apply_url || "",
          description: row.description || "",
          skills: row.skills || [],
          postedAt: row.posted_at || row.created_at,
        };
      }

      return {
        id: row.id,
        title: row.title || "Untitled Position",
        company: "Verified Employer",
        location: row.location || (row.remote ? "Remote (Worldwide)" : "Remote"),
        date: formatDate(row.posted_at || row.created_at),
        salary: "",
        category: row.category || "engineering",
        remote: Boolean(row.remote),
        remoteScope: row.remote_scope || undefined,
        remoteEligibility: row.remote_eligibility || undefined,
        country: row.country_code || "US",
        type: row.job_type === "internship" ? "Internship" : "Full-time",
        directSource: Boolean(row.verified),
        applyUrl: "",
        description: "",
        skills: [],
        postedAt: row.posted_at || row.created_at,
      };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        jobs: formattedJobs,
        totalCount: count || 0,
        page,
        pageSize,
        isPro,
      }),
    };
  } catch (err: any) {
    safeLog.error("[Netlify /jobs-search]", err);
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
      body: JSON.stringify({ error: err?.message || "Internal server error", jobs: [], totalCount: 0 }),
    };
  }
  };
}

export const handler = createHandler();
export const createSearchHandler = createHandler;

