import { createClient } from "@supabase/supabase-js";
import { getServerEntitlement } from "../../src/lib/billing/serverEntitlement";
import { verifyUserNotBanned } from "../../src/lib/admin/auth";
import { computeFitDiagnostics, StandardJobScoringInput } from "../../src/lib/matcher/scoring";
import { formatSalary } from "../../src/lib/salary/parser";
import { extractCandidateRelevanceTerms, LiveJob } from "../../src/lib/jobs/service";
import { CandidateProfile } from "../../src/lib/resume/types";
import { isJobEligible } from "../../src/lib/jobs/eligibility";
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
    safeLog.error("[Netlify /jobs-top10] Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL");
    throw new Error(JSON.stringify({
      error: "Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL",
      missingVariable: "NEXT_PUBLIC_SUPABASE_URL",
    }));
  }

  if (!serviceKey) {
    safeLog.error("[Netlify /jobs-top10] Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY");
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

interface Top10CacheEntry {
  timestamp: number;
  data: any;
}

const top10Cache = new Map<string, Top10CacheEntry>();
const TOP10_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes in-memory cache

function getTop10CacheKey(
  userId: string,
  candidate: CandidateProfile,
  limit: number,
  currency?: string,
  eligibility?: boolean
): string {
  const headline = (candidate.headline || "").trim().toLowerCase();
  const skills = (candidate.skills || []).map((s) => s.trim().toLowerCase()).sort().join(",");
  const loc = (candidate.location || "").trim().toLowerCase();
  const expCount = (candidate.experience || []).length;
  return `${userId}:${limit}:${headline}:${loc}:${expCount}:${skills}:${currency || "default"}:${eligibility ?? true}`;
}

import { buildCorsHeaders, handleCorsPreflight } from "./_cors";

const CORS_OPTIONS = {
  allowedMethods: "POST, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

export async function handler(event: any) {
  const preflight = handleCorsPreflight(event, CORS_OPTIONS);
  if (preflight) return preflight;

  const headers = {
    "Content-Type": "application/json",
    ...buildCorsHeaders(event, CORS_OPTIONS),
  };


  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    // 1. Verify Authorization Header (Bearer Supabase access token)
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Unauthorized. Please sign in to view Top 10 matches." }),
      };
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const supabaseAdmin = getSupabaseAdmin();

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Invalid or expired session. Please sign in again." }),
      };
    }

    // Invite-only early-access approval check
    const isApproved = await isUserApproved(supabaseAdmin, user);
    if (!isApproved) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: "Early access only",
          message: "Invite-only access: your account is pending approval.",
          jobs: [],
        }),
      };
    }

    // Ban check (fails closed on lookup error)
    const banCheck = await verifyUserNotBanned(supabaseAdmin, user.id, user.user_metadata);
    if (banCheck.isBlocked) {
      return {
        statusCode: banCheck.isServiceUnavailable ? 503 : 403,
        headers,
        body: JSON.stringify({ error: banCheck.error || "Account suspended. Access revoked by administrator." }),
      };
    }

    // 2. Server-Managed Pro Entitlement Check (Single Source of Truth)
    const entitlement = await getServerEntitlement(user.id);
    if (!entitlement.isPro) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: "CareerMonke Pro subscription required for Top 10 high-compatibility matches.",
          isPro: false,
          code: "PRO_REQUIRED",
        }),
      };
    }

    // 3. Parse Request Payload
    let body: any = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (parseErr) {
      safeLog.warn("[Netlify /jobs-top10] Request body parse error", parseErr);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Invalid JSON request body." }),
      };
    }

    const candidate: CandidateProfile = body.candidate || null;
    const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 25) : 10;

    if (!candidate || !Array.isArray(candidate.skills)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing or invalid candidate profile.", jobs: [] }),
      };
    }

    // Fetch user preferences for eligibility filter and preferred currency
    let userLocations: string[] = [];
    let userSalaryCurrency: string | undefined;
    let userEligibilityPref = true;

    try {
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
    } catch {}

    const eligibilityParam = event.queryStringParameters?.eligibility || body.eligibility;
    let isEligibilityActive = userEligibilityPref;
    if (eligibilityParam === "off") {
      isEligibilityActive = false;
      try {
        await supabaseAdmin.from("user_preferences").update({ eligibility_filter: false }).eq("user_id", user.id);
      } catch {}
    } else if (eligibilityParam === "on") {
      isEligibilityActive = true;
      try {
        await supabaseAdmin.from("user_preferences").update({ eligibility_filter: true }).eq("user_id", user.id);
      } catch {}
    }

    const preferredCurrency = event.queryStringParameters?.currency || body.currency || userSalaryCurrency || undefined;

    // Check In-Memory Cache (reduces repeat latency from ~6s to <10ms)
    const cacheKey = getTop10CacheKey(user.id, candidate, limit, preferredCurrency, isEligibilityActive);
    const cached = top10Cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < TOP10_CACHE_TTL_MS) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(cached.data),
      };
    }

    // 4. Transparent Server-Side Prefiltering from Live Database
    const relevanceTerms = extractCandidateRelevanceTerms(candidate);

    let query = supabaseAdmin
      .from("jobs")
      .select(
        "id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, country_code, posted_at, first_seen_at"
      )
      .eq("is_active", true)
      .eq("status", "active");

    if (relevanceTerms.length > 0) {
      const orClauses = relevanceTerms.map((t) => `title.ilike.%${t}%`).join(",");
      query = query.or(orClauses);
    }

    // Trimmed to 120 most relevant rows: fast network transfer while providing plenty of candidates
    const { data: candidatePool, error: queryErr } = await query
      .order("posted_at", { ascending: false, nullsFirst: false })
      .limit(120);

    if (queryErr) {
      console.error("[Netlify jobs-top10] Query error:", queryErr);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Failed to query jobs corpus" }),
      };
    }

    let rawPool = candidatePool || [];
    // Apply country eligibility auto-filtering to candidate pool BEFORE scoring
    if (isEligibilityActive && userLocations.length > 0) {
      rawPool = rawPool.filter((j) => isJobEligible(j, userLocations, { filterEnabled: true }));
    }

    let jobsToScore = rawPool;

    // Fallback: If candidate terms returned fewer than 20 results, widen pool with active verified jobs
    if (jobsToScore.length < 20) {
      const { data: fallbackPool } = await supabaseAdmin
        .from("jobs")
        .select(
          "id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, country_code, posted_at, first_seen_at"
        )
        .eq("is_active", true)
        .eq("status", "active")
        .order("posted_at", { ascending: false, nullsFirst: false })
        .limit(50);

      const existingIds = new Set(jobsToScore.map((j) => j.id));
      for (const f of fallbackPool || []) {
        if (!existingIds.has(f.id)) {
          if (!isEligibilityActive || userLocations.length === 0 || isJobEligible(f, userLocations, { filterEnabled: true })) {
            jobsToScore.push(f);
          }
        }
      }
    }

    // 5. Score Candidates with Shared Unified Scoring Function
    const scoredJobs = jobsToScore.map((row) => {
      const originalSalary =
        formatSalary(row.salary_min, row.salary_max, row.currency, row.salary_period) ||
        row.salary_text || null;
      const displaySalary = preferredCurrency
        ? (formatSalary(row.salary_min, row.salary_max, row.currency, row.salary_period, { displayCurrency: preferredCurrency }) || row.salary_text || null)
        : originalSalary;

      const standardizedJob: StandardJobScoringInput = {
        id: row.id,
        title: row.title || "Untitled Position",
        company: row.company || "Verified Employer",
        location: row.location || (row.remote ? "Remote (Worldwide)" : "Remote"),
        remote: Boolean(row.remote),
        remote_scope: row.remote_scope || (row.remote ? "worldwide" : undefined),
        category: row.category || "engineering",
        skills: Array.isArray(row.skills) ? row.skills : [],
        description: row.description || "",
        salary_text: displaySalary || originalSalary || "",
      };

      const diagnostics = computeFitDiagnostics(candidate, standardizedJob);

      const liveJob: LiveJob = {
        id: row.id,
        title: row.title || "Untitled Position",
        company: row.company || "Verified Employer",
        location: row.location || (row.remote ? "Remote (Worldwide)" : "Remote"),
        date: formatDate(row.posted_at || row.first_seen_at),
        salary: displaySalary || originalSalary || "",
        salary_display: displaySalary,
        salary_original: originalSalary,
        category: row.category || "engineering",
        remote: Boolean(row.remote),
        remoteScope: row.remote_scope || undefined,
        remoteEligibility: row.remote_eligibility || undefined,
        country: row.country_code || row.country || "",
        type: row.job_type === "internship" ? "Internship" : "Full-time",
        directSource: Boolean(row.apply_url),
        applyUrl: row.apply_url || "",
        description: row.description || "",
        skills: Array.isArray(row.skills) ? row.skills : [],
        postedAt: row.posted_at || row.first_seen_at,
      };

      return { job: liveJob, diagnostics };
    });

    // 6. Sort by Match Score descending, then Recency descending
    scoredJobs.sort((a, b) => {
      if (b.diagnostics.score !== a.diagnostics.score) {
        return b.diagnostics.score - a.diagnostics.score;
      }
      const timeA = new Date(a.job.postedAt || 0).getTime();
      const timeB = new Date(b.job.postedAt || 0).getTime();
      return timeB - timeA;
    });

    // 7. Deduplicate identical jobs (same title+company+location) and duplicate company postings
    const seenDedupe = new Set<string>();
    const seenCompanyRole = new Set<string>();
    const dedupedScoredJobs: typeof scoredJobs = [];

    for (const item of scoredJobs) {
      const normTitle = (item.job.title || "").trim().toLowerCase().replace(/\s+/g, " ");
      const normCompany = (item.job.company || "").trim().toLowerCase();
      const normLoc = (item.job.location || "").trim().toLowerCase().replace(/\s+/g, " ");

      // Exact title + company + location key
      const exactKey = `${normTitle}|${normCompany}|${normLoc}`;
      if (seenDedupe.has(exactKey)) {
        continue;
      }
      seenDedupe.add(exactKey);

      // Ensure identical base role at the same company doesn't appear multiple times
      // (e.g. Fastly "Threat Detection Analyst" posted in multiple regions)
      const baseTitle = normTitle.replace(/\([^)]*\)/g, "").trim();
      const companyRoleKey = `${baseTitle}|${normCompany}`;
      if (baseTitle.length >= 4 && seenCompanyRole.has(companyRoleKey)) {
        continue;
      }
      if (baseTitle.length >= 4) {
        seenCompanyRole.add(companyRoleKey);
      }

      dedupedScoredJobs.push(item);
    }

    const topRanked = dedupedScoredJobs.slice(0, limit);

    // Query exact active count for totalCorpus (same source as /api/stats)
    const { count: totalActiveCount } = await supabaseAdmin
      .from("jobs_public")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .eq("status", "active");
    const totalCorpus = totalActiveCount ?? dedupedScoredJobs.length;

    const responsePayload = {
      jobs: topRanked,
      totalScored: dedupedScoredJobs.length,
      totalCorpus,
      isPro: true,
    };

    // Cache the result for 5 minutes
    top10Cache.set(cacheKey, {
      timestamp: Date.now(),
      data: responsePayload,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(responsePayload),
    };
  } catch (err: any) {
    safeLog.error("[Netlify /jobs-top10]", err);
    try {
      const parsed = JSON.parse(err?.message);
      if (parsed.missingVariable) {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify(parsed),
        };
      }
    } catch {}
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
