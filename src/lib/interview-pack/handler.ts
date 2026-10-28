import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";
import { verifyUserNotBanned } from "@/lib/admin/auth";
import { checkRequiredEnv } from "@/lib/api/envCheck";
import { getCompanyIntel } from "./companyIntel";
import {
  generateInterviewPack,
  JobInput,
  CandidateInput,
} from "./engine";

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
    "API /jobs/interview-pack"
  );
  if (missing) {
    throw new Error(JSON.stringify(missing));
  }

  return createClient(supabaseUrl, serviceKey!, {
    auth: { persistSession: false },
  });
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Atomically checks and increments the daily interview pack quota for a user (10 packs/day).
 * Strict rules:
 * - Atomic increment using INSERT ... ON CONFLICT DO UPDATE ... RETURNING
 * - Fails closed with 503 if DB errors (NO in-memory fallback)
 */
export async function checkAndIncrementInterviewPackQuota(
  supabaseAdmin: any,
  userId: string,
  limit: number = 10
): Promise<{ allowed: boolean; currentCount: number; limit: number; isServiceUnavailable?: boolean; error?: string }> {
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  if (!supabaseAdmin?.from) {
    return {
      allowed: false,
      currentCount: 0,
      limit,
      isServiceUnavailable: true,
      error: "Database unavailable",
    };
  }

  try {
    // 1. Check existing count for today
    const { data: row, error: selectErr } = await supabaseAdmin
      .from("ai_usage_quotas")
      .select("count")
      .eq("user_id", userId)
      .eq("period_date", today)
      .eq("operation", "interview_pack")
      .maybeSingle();

    if (selectErr) {
      console.warn("[InterviewPack Quota] Select error:", selectErr.message || selectErr);
      return {
        allowed: false,
        currentCount: 0,
        limit,
        isServiceUnavailable: true,
        error: selectErr.message,
      };
    }

    const currentCount = row?.count || 0;
    if (currentCount >= limit) {
      return { allowed: false, currentCount, limit };
    }

    // 2. Atomic upsert with RETURNING count
    const nextCount = currentCount + 1;
    const { data: upsertData, error: upsertErr } = await supabaseAdmin
      .from("ai_usage_quotas")
      .upsert(
        {
          user_id: userId,
          period_date: today,
          operation: "interview_pack",
          count: nextCount,
          total_tokens: 0,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,period_date,operation" }
      )
      .select("count")
      .single();

    if (upsertErr) {
      console.error("[InterviewPack Quota] Upsert error:", upsertErr);
      return {
        allowed: false,
        currentCount,
        limit,
        isServiceUnavailable: true,
        error: upsertErr.message,
      };
    }

    return { allowed: true, currentCount: upsertData?.count ?? nextCount, limit };
  } catch (err: any) {
    console.error("[InterviewPack Quota] Exception:", err);
    return {
      allowed: false,
      currentCount: 0,
      limit,
      isServiceUnavailable: true,
      error: err?.message,
    };
  }
}

/**
 * Refunds an interview pack quota reservation on upstream provider failure.
 */
export async function refundInterviewPackQuota(
  supabaseAdmin: any,
  userId: string
): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  if (!supabaseAdmin?.from) return;

  try {
    const { data: row } = await supabaseAdmin
      .from("ai_usage_quotas")
      .select("count")
      .eq("user_id", userId)
      .eq("period_date", today)
      .eq("operation", "interview_pack")
      .maybeSingle();

    if (row && typeof row.count === "number" && row.count > 0) {
      await supabaseAdmin
        .from("ai_usage_quotas")
        .update({
          count: Math.max(0, row.count - 1),
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .eq("period_date", today)
        .eq("operation", "interview_pack");
    }
  } catch (err) {
    console.warn("[InterviewPack Quota] Refund error:", err);
  }
}

export interface InterviewPackDeps {
  getSupabaseAdmin?: () => any;
  getServerEntitlement?: (userId: string) => Promise<{ isPro: boolean }>;
  fetchCandidateProfile?: (userId: string) => Promise<CandidateInput | null>;
  fetchJob?: (jobId: string) => Promise<JobInput | null>;
  fetchCompanyIntelClaims?: (companyName: string) => Promise<any[]>;
  callAi?: (payload: any) => Promise<any>;
  checkQuota?: (
    userId: string
  ) => Promise<{ allowed: boolean; currentCount: number; limit: number; isServiceUnavailable?: boolean }>;
  timeoutMs?: number;
}

export async function handleInterviewPackRequest(
  req: Request,
  deps: InterviewPackDeps = {}
) {
  // 1. Verify Authorization Header (Bearer Supabase access token)
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Unauthorized. Missing authorization token.", isPro: false },
      { status: 401 }
    );
  }

  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) {
    return NextResponse.json(
      { error: "Unauthorized. Missing authorization token.", isPro: false },
      { status: 401 }
    );
  }

  const getAdmin = deps.getSupabaseAdmin || getSupabaseAdmin;
  const getEntitlement = deps.getServerEntitlement || getServerEntitlement;

  const supabaseAdmin = getAdmin();
  const {
    data: { user },
    error: userError,
  } = await supabaseAdmin.auth.getUser(token);

  if (userError || !user) {
    return NextResponse.json(
      { error: "Invalid or expired session. Please sign in again.", isPro: false },
      { status: 401 }
    );
  }

  // Ban check (fails closed on lookup error)
  const banCheck = await verifyUserNotBanned(supabaseAdmin, user.id, user.user_metadata);
  if (banCheck.isBlocked) {
    return NextResponse.json(
      { error: banCheck.error || "Account suspended. Access revoked by administrator.", isPro: false },
      { status: banCheck.isServiceUnavailable ? 503 : 403 }
    );
  }

  // 2. Server-Managed Pro Entitlement Check (Single Source of Truth, strictly ignoring user_metadata)
  const entitlement = await getEntitlement(user.id);
  if (!entitlement.isPro) {
    return NextResponse.json(
      {
        error: "CareerMonke Pro subscription required to access the Interview Pack.",
        isPro: false,
        code: "PRO_REQUIRED",
      },
      { status: 403 }
    );
  }

  // 3. Resolve Job Details: sample mode OR valid UUID (never fictional job fallback)
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId") || "sample";

  let job: JobInput | null = null;

  if (jobId === "sample") {
    // Sample mode preserved for preview route
    job = {
      id: "sample",
      title: "Senior Full-Stack Engineer",
      company: "Acme Analytics",
      description:
        "Building real-time job discovery engine, distributed search indexing, Next.js architecture, and high-performance serverless endpoints.",
      location: "Worldwide (Remote)",
      category: "Engineering",
      skills: ["React", "TypeScript", "Node.js", "Next.js", "SQL"],
      apply_url: "https://example.com/careers/sample-job",
    };
  } else {
    // Production / Live: must be a valid UUID
    if (!UUID_REGEX.test(jobId)) {
      return NextResponse.json(
        { error: "Job not found.", isPro: true, code: "JOB_NOT_FOUND" },
        { status: 404 }
      );
    }

    if (deps.fetchJob) {
      job = await deps.fetchJob(jobId);
    } else if (supabaseAdmin?.from) {
      try {
        const { data: jobRow, error: jobErr } = await supabaseAdmin
          .from("jobs")
          .select("id, title, company, description, location, category, skills, apply_url, source_url")
          .eq("id", jobId)
          .maybeSingle();

        if (!jobErr && jobRow) {
          job = {
            id: jobRow.id,
            title: jobRow.title,
            company: jobRow.company,
            description: jobRow.description || "",
            location: jobRow.location || "Remote",
            category: jobRow.category || "Engineering",
            skills: jobRow.skills,
            apply_url: jobRow.apply_url,
            source_url: jobRow.source_url,
          };
        }
      } catch (e) {
        console.warn("[InterviewPack] Error querying job:", e);
      }
    }

    // Job not found -> 404 JSON (NEVER substitute a fictional job)
    if (!job) {
      return NextResponse.json(
        { error: "Job not found.", isPro: true, code: "JOB_NOT_FOUND" },
        { status: 404 }
      );
    }
  }

  // 4. Per-User Quota Check (Atomic increment, fail closed 503 if DB errors, no in-memory fallback)
  const quotaChecker =
    deps.checkQuota || ((uid) => checkAndIncrementInterviewPackQuota(supabaseAdmin, uid, 10));
  const quotaResult = await quotaChecker(user.id);

  if (quotaResult.isServiceUnavailable) {
    return NextResponse.json(
      {
        error: "AI quota service is temporarily unavailable. Please try again shortly.",
        code: "AI_QUOTA_SERVICE_UNAVAILABLE",
        isPro: true,
      },
      { status: 503 }
    );
  }

  if (!quotaResult.allowed) {
    return NextResponse.json(
      {
        error: `Daily Interview Pack generation quota exceeded (${quotaResult.currentCount}/${quotaResult.limit}). Quotas reset daily at midnight UTC.`,
        code: "RATE_LIMIT_EXCEEDED",
        isPro: true,
      },
      {
        status: 429,
        headers: {
          "Retry-After": "86400",
        },
      }
    );
  }

  // 5. Server-Side Fetch of Authenticated User's Resume from candidate_profiles
  let candidate: CandidateInput | undefined = undefined;
  if (deps.fetchCandidateProfile) {
    const prof = await deps.fetchCandidateProfile(user.id);
    if (prof) candidate = prof;
  } else if (supabaseAdmin?.from) {
    try {
      const { data: profileRow, error: profileErr } = await supabaseAdmin
        .from("candidate_profiles")
        .select("name, headline, summary, skills, experience_json, raw_resume_text")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!profileErr && profileRow) {
        candidate = {
          name: profileRow.name,
          headline: profileRow.headline,
          summary: profileRow.summary,
          skills: profileRow.skills,
          experience: profileRow.experience_json,
          rawResumeText: profileRow.raw_resume_text,
        };
      }
    } catch (e) {
      console.warn("[InterviewPack] Error fetching candidate profile:", e);
    }
  }

  // 6. Fetch Verified Company Intel with 30-Day Cache (no fetcher -> empty brief + thin state)
  const companyIntel = await getCompanyIntel(job.company, supabaseAdmin, {
    fetchClaims: deps.fetchCompanyIntelClaims,
  });

  // 7. Generate Grounded Interview Pack with Timeout & Provider Error Handling
  const timeoutMs = deps.timeoutMs || 25000;

  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Interview Pack generation timed out.")), timeoutMs)
    );

    const packPromise = generateInterviewPack(job, candidate, companyIntel, {
      callAi: deps.callAi,
    });

    const pack = await Promise.race([packPromise, timeoutPromise]);

    return NextResponse.json(
      {
        pack,
        isPro: true,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "private, no-cache, no-store, must-revalidate",
        },
      }
    );
  } catch (genErr: any) {
    console.error("[InterviewPack Engine Error]:", genErr?.message || genErr);

    // Refund quota charge on provider failure / timeout
    await refundInterviewPackQuota(supabaseAdmin, user.id);

    // Provider failure -> clean error JSON, never template filler
    const isTimeout = genErr?.message?.includes("timed out");
    return NextResponse.json(
      {
        error: isTimeout
          ? "Interview Pack generation timed out. Please try again."
          : "Interview Pack generation failed. Upstream AI provider returned an error.",
        code: isTimeout ? "GENERATION_TIMEOUT" : "PROVIDER_ERROR",
        isPro: true,
      },
      { status: isTimeout ? 504 : 502 }
    );
  }
}
