import { NextResponse } from "next/server";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";
import { formatSalary } from "@/lib/salary/parser";
import { getSupabaseAdminClient, getRuntimeEnv } from "@/lib/ai/serviceHandler";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { COUNTRY_CODE_TO_NAME, getCountryFilterClause } from "@/lib/countries";
import { decodeCursor, encodeCursor } from "@/lib/pagination/cursor";

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
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const rawQuery = searchParams.get("q") || searchParams.get("search") || "";
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

    const cleanQuery = sanitizeSearchQuery(rawQuery);
    const supabaseAdmin = getSupabaseAdminClient(cfEnv, true);

    const hasServiceKey = Boolean(
      getRuntimeEnv("SUPABASE_SERVICE_ROLE_KEY", cfEnv) ||
      getRuntimeEnv("SUPABASE_SERVICE_KEY", cfEnv)
    );
    const targetTable = hasServiceKey ? "jobs" : "jobs_public";

    // Check optional Pro entitlement via Bearer token
    let isPro = false;
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ") && hasServiceKey) {
      const token = authHeader.replace("Bearer ", "").trim();
      try {
        const { data: { user } } = await supabaseAdmin.auth.getUser(token);
        if (user) {
          const entitlement = await getServerEntitlement(user.id);
          isPro = Boolean(entitlement.isPro);
        }
      } catch (authErr) {
        // Fall back to safe preview
        isPro = false;
      }
    }

    const selectColumns = (isPro && hasServiceKey)
      ? "*"
      : hasServiceKey
      ? "id, title, company, location, category, remote, remote_scope, remote_eligibility, country_code, country, job_type, verified, posted_at, created_at, salary_min, salary_max, currency, salary_period, salary_text, source_type, source"
      : "id, title, location, category, remote, remote_scope, remote_eligibility, country_code, job_type, verified, posted_at, created_at";

    let query = supabaseAdmin
      .from(targetTable)
      .select(selectColumns, { count: "estimated" })
      .eq("is_active", true)
      .eq("status", "active");

    // Category filter matching getLiveJobs logic
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
      const cleanComp = sanitizeSearchQuery(companyParam).trim();
      if (cleanComp) {
        query = query.or(`company.ilike.%${cleanComp}%,company_slug.ilike.%${cleanComp.toLowerCase()}%`);
      }
    }

    // Salary Min filter (only where salary exists)
    if (salaryMinParam) {
      const minVal = parseInt(salaryMinParam, 10);
      if (!isNaN(minVal) && minVal > 0) {
        query = query.not("salary_min", "is", null).gte("salary_min", minVal);
      }
    }

    // Source Type filter (ats, direct, aggregator, etc.)
    if (sourceTypeParam && sourceTypeParam.trim() && sourceTypeParam.toLowerCase() !== "all") {
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


    // Search query matching across title, company, location, category, description
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

    // Keyset cursor decoding
    const cursor = decodeCursor(cursorParam);
    const fetchLimit = pageSize + 1; // fetch 1 extra to determine hasNextPage

    // For multi-word text queries, pull pool to rank by relevance before pagination
    const isMultiWord = cleanQuery && cleanQuery.includes(" ");
    if (isMultiWord) {
      query = query.order("posted_at", { ascending: false, nullsFirst: false }).limit(200);
    } else if (cursor) {
      // Keyset cursor pagination (no OFFSET, 0ms on 100k+ rows)
      if (cursor.posted_at) {
        query = query.or(
          `posted_at.lt.${cursor.posted_at},and(posted_at.eq.${cursor.posted_at},id.lt.${cursor.id}),posted_at.is.null`
        );
      } else {
        query = query.is("posted_at", null).lt("id", cursor.id);
      }
      query = query.order("posted_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).limit(fetchLimit);
    } else if (page > 1 && !cursorParam) {
      // Legacy offset pagination fallback for backward compatibility
      query = query.order("posted_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).range(from, to);
    } else {
      // Page 1 initial keyset query
      query = query.order("posted_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).limit(fetchLimit);
    }

    const { data, count, error } = await query;

    if (error) {
      console.error("Jobs search query error:", error);
      return NextResponse.json({ error: error.message, jobs: [], totalCount: 0 }, { status: 500 });
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

    let hasNextPage = false;
    let nextCursor: string | null = null;

    if (!isMultiWord) {
      if (rows.length > pageSize) {
        hasNextPage = true;
        rows = rows.slice(0, pageSize);
        const lastItem = rows[rows.length - 1] as any;
        if (lastItem) {
          nextCursor = encodeCursor(lastItem.posted_at, lastItem.id);
        }
      } else if (page > 1 && !cursorParam) {
        // Offset pagination: check if count exceeds current window
        hasNextPage = (count ? from + rows.length < count : false);
      }
    }
    const formattedJobs = rows.map((row: any) => {
      if (isPro && hasServiceKey) {
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
          country: row.country_code || row.country || "",
          type: row.job_type === "internship" ? "Internship" : "Full-time",
          directSource: Boolean(row.verified ?? true),
          applyUrl: row.apply_url || "",
          description: row.description || "",
          skills: row.skills || [],
          postedAt: row.posted_at || row.created_at,
        };
      }

      // Guest / Free preview format — ZERO paid data leakage
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
        country: row.country_code || row.country || "",
        type: row.job_type === "internship" ? "Internship" : "Full-time",
        directSource: Boolean(row.verified),
        applyUrl: "",
        description: "",
        skills: [],
        postedAt: row.posted_at || row.created_at,
      };
    });

    const approximateTotalCount = count ?? (rows.length > 0 ? (page ? Math.max(rows.length, page * pageSize) : 100000) : 0);

    return NextResponse.json({
      jobs: formattedJobs,
      totalCount: approximateTotalCount,
      nextCursor,
      hasNextPage,
      page,
      pageSize,
      isPro: Boolean(isPro && hasServiceKey),
    });
  } catch (err: any) {
    try {
      const parsed = JSON.parse(err?.message);
      if (parsed.missingVariable) {
        return NextResponse.json({ ...parsed, jobs: [], totalCount: 0 }, { status: 500 });
      }
    } catch {}
    console.error("Jobs search API route error:", err);
    return NextResponse.json(
      { error: err?.message || "Internal server error", jobs: [], totalCount: 0 },
      { status: 500 }
    );
  }
}
