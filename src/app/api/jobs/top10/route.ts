import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";
import { verifyUserNotBanned } from "@/lib/admin/auth";
import { computeFitDiagnostics, StandardJobScoringInput } from "@/lib/matcher/scoring";
import { formatSalary } from "@/lib/salary/parser";
import { extractCandidateRelevanceTerms, LiveJob } from "@/lib/jobs/service";
import { CandidateProfile } from "@/lib/resume/types";

import { checkRequiredEnv } from "@/lib/api/envCheck";

export const runtime = "edge";

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const missing = checkRequiredEnv(
    {
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    },
    "API /jobs/top10"
  );
  if (missing) {
    throw new Error(JSON.stringify(missing));
  }

  return createClient(supabaseUrl, serviceKey!, {
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

function getTop10CacheKey(userId: string, candidate: CandidateProfile, limit: number): string {
  const headline = (candidate.headline || "").trim().toLowerCase();
  const skills = (candidate.skills || []).map((s) => s.trim().toLowerCase()).sort().join(",");
  const loc = (candidate.location || "").trim().toLowerCase();
  const expCount = (candidate.experience || []).length;
  return `${userId}:${limit}:${headline}:${loc}:${expCount}:${skills}`;
}

/**
 * POST /api/jobs/top10
 * 
 * Server-Side Top 10 High-Compatibility Matching:
 * Transparently prefilters against the live active jobs corpus by the candidate's
 * verified skills and role titles, executes unified scoring server-side, and returns
 * only the top N results with full unlocked Pro data.
 */
export async function POST(req: Request) {
  try {
    // 1. Verify Authorization Header (Bearer Supabase access token)
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized. Please sign in to view Top 10 matches." },
        { status: 401 }
      );
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const supabaseAdmin = getSupabaseAdmin();

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return NextResponse.json(
        { error: "Invalid or expired session. Please sign in again." },
        { status: 401 }
      );
    }

    // Ban check (fails closed on lookup error)
    const banCheck = await verifyUserNotBanned(supabaseAdmin, user.id, user.user_metadata);
    if (banCheck.isBlocked) {
      return NextResponse.json(
        { error: banCheck.error || "Account suspended. Access revoked by administrator." },
        { status: banCheck.isServiceUnavailable ? 503 : 403 }
      );
    }

    // 2. Server-Managed Pro Entitlement Check (Single Source of Truth)
    const entitlement = await getServerEntitlement(user.id);
    if (!entitlement.isPro) {
      return NextResponse.json(
        {
          error: "CareerMonke Pro subscription required for Top 10 high-compatibility matches.",
          isPro: false,
          code: "PRO_REQUIRED",
        },
        { status: 403 }
      );
    }

    // 3. Parse Candidate Profile & Parameters
    const body = await req.json().catch(() => ({}));
    const candidate: CandidateProfile = body.candidate || null;
    const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 25) : 10;

    if (!candidate || !Array.isArray(candidate.skills)) {
      return NextResponse.json(
        { error: "Missing or invalid candidate profile.", jobs: [] },
        { status: 400 }
      );
    }

    // Check In-Memory Cache (brings latency down from ~6s to <10ms for returning dashboard loads)
    const cacheKey = getTop10CacheKey(user.id, candidate, limit);
    const cached = top10Cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < TOP10_CACHE_TTL_MS) {
      return NextResponse.json(cached.data);
    }

    // 4. Transparent Server-Side Prefiltering from Live Database
    // Strategy: Filter candidate's verified skills & title keywords across active jobs
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
      console.error("[API /jobs/top10] Query error:", queryErr);
      return NextResponse.json({ error: "Failed to query jobs corpus" }, { status: 500 });
    }

    let jobsToScore = candidatePool || [];

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
          jobsToScore.push(f);
        }
      }
    }

    // 5. Score Candidates with Shared Unified Scoring Function
    const scoredJobs = jobsToScore.map((row) => {
      const formattedSalary =
        formatSalary(row.salary_min, row.salary_max, row.currency, row.salary_period) ||
        row.salary_text;

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
        salary_text: formattedSalary || "",
      };

      const diagnostics = computeFitDiagnostics(candidate, standardizedJob);

      const liveJob: LiveJob = {
        id: row.id,
        title: row.title || "Untitled Position",
        company: row.company || "Verified Employer",
        location: row.location || (row.remote ? "Remote (Worldwide)" : "Remote"),
        date: formatDate(row.posted_at || row.first_seen_at),
        salary: formattedSalary || "",
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

    return NextResponse.json(responsePayload);
  } catch (err: any) {
    try {
      const parsed = JSON.parse(err?.message);
      if (parsed.missingVariable) {
        return NextResponse.json(parsed, { status: 500 });
      }
    } catch {}
    console.error("[API /jobs/top10 error]:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
