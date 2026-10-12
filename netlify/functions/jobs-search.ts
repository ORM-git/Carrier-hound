import { createClient } from "@supabase/supabase-js";
import { formatSalary } from "../../src/lib/salary/parser";

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing server Supabase configuration");
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

export async function handler(event: any) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const params = event.queryStringParameters || {};
    const rawQuery = params.q || params.search || "";
    const category = params.category || "";
    const remoteOnly = params.remoteOnly === "true";
    const page = Math.max(1, parseInt(params.page || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(params.pageSize || "50", 10)));

    const cleanQuery = sanitizeSearchQuery(rawQuery);
    const supabaseAdmin = getSupabaseAdmin();

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
      const c = category.toLowerCase().trim();
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

    if (cleanQuery) {
      const parts = cleanQuery.split(" ").filter((p) => p.length >= 2);
      const clauses = [
        `title.ilike.%${cleanQuery}%`,
        `company.ilike.%${cleanQuery}%`,
        `location.ilike.%${cleanQuery}%`,
        `category.ilike.%${cleanQuery}%`,
        `description.ilike.%${cleanQuery}%`,
      ];

      if (parts.length > 1) {
        for (const p of parts) {
          clauses.push(`company.ilike.%${p}%`);
          clauses.push(`title.ilike.%${p}%`);
        }
      }

      query = query.or(clauses.join(","));
    }

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    query = query.order("posted_at", { ascending: false }).range(from, to);

    const { data, count, error } = await query;

    if (error) {
      console.error("[Netlify /jobs-search] query error:", error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: error.message, jobs: [], totalCount: 0 }),
      };
    }

    const rows = data || [];
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
    console.error("[Netlify /jobs-search] error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err?.message || "Internal server error", jobs: [], totalCount: 0 }),
    };
  }
}
