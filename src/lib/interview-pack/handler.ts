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

// In-memory daily quota tracker (resets daily)
interface UserQuotaBucket {
  count: number;
  resetAt: number;
}
const userQuotaStore = new Map<string, UserQuotaBucket>();

export function _resetInterviewPackQuotaStore() {
  userQuotaStore.clear();
}

/**
 * Checks and increments the daily interview pack quota for a user (10 packs/day).
 */
export async function checkInterviewPackQuota(
  supabaseAdmin: any,
  userId: string,
  limit: number = 10
): Promise<{ allowed: boolean; currentCount: number; limit: number }> {
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const now = Date.now();

  // 1. Try public.ai_usage_quotas if Supabase table is accessible
  if (supabaseAdmin?.from) {
    try {
      const { data: row, error: selectErr } = await supabaseAdmin
        .from("ai_usage_quotas")
        .select("count")
        .eq("user_id", userId)
        .eq("period_date", today)
        .eq("operation", "interview_pack")
        .maybeSingle();

      if (!selectErr) {
        const currentCount = row?.count || 0;
        if (currentCount >= limit) {
          return { allowed: false, currentCount, limit };
        }

        if (row) {
          await supabaseAdmin
            .from("ai_usage_quotas")
            .update({
              count: currentCount + 1,
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId)
            .eq("period_date", today)
            .eq("operation", "interview_pack");
        } else {
          await supabaseAdmin.from("ai_usage_quotas").insert({
            user_id: userId,
            period_date: today,
            operation: "interview_pack",
            count: 1,
            total_tokens: 0,
            updated_at: new Date().toISOString(),
          });
        }
        return { allowed: true, currentCount: currentCount + 1, limit };
      }
    } catch {
      // Fall through to memory store if database table is unavailable
    }
  }

  // 2. Fallback to in-memory store
  const endOfDay = new Date();
  endOfDay.setUTCHours(23, 59, 59, 999);
  const resetAt = endOfDay.getTime();

  let bucket = userQuotaStore.get(userId);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 1, resetAt };
    userQuotaStore.set(userId, bucket);
    return { allowed: true, currentCount: 1, limit };
  }

  if (bucket.count >= limit) {
    return { allowed: false, currentCount: bucket.count, limit };
  }

  bucket.count++;
  return { allowed: true, currentCount: bucket.count, limit };
}

export interface InterviewPackDeps {
  getSupabaseAdmin?: () => any;
  getServerEntitlement?: (userId: string) => Promise<{ isPro: boolean }>;
  fetchCandidateProfile?: (userId: string) => Promise<CandidateInput | null>;
  fetchJob?: (jobId: string) => Promise<JobInput | null>;
  fetchCompanyIntelClaims?: (companyName: string) => Promise<any[]>;
  callAi?: (payload: any) => Promise<any>;
  checkQuota?: (userId: string) => Promise<{ allowed: boolean; currentCount: number; limit: number }>;
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

  // 3. Per-User Rate Limit / Quota Check (10 packs/day)
  const quotaChecker = deps.checkQuota || ((uid) => checkInterviewPackQuota(supabaseAdmin, uid, 10));
  const quotaResult = await quotaChecker(user.id);
  if (!quotaResult.allowed) {
    return NextResponse.json(
      {
        error: `Daily Interview Pack generation quota exceeded (${quotaResult.currentCount}/${quotaResult.limit}). Quotas reset daily at midnight UTC.`,
        code: "RATE_LIMIT_EXCEEDED",
      },
      {
        status: 429,
        headers: {
          "Retry-After": "86400",
        },
      }
    );
  }

  // 4. Resolve Job Details
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId") || "sample";

  let job: JobInput | null = null;
  if (deps.fetchJob) {
    job = await deps.fetchJob(jobId);
  } else if (jobId !== "sample" && supabaseAdmin?.from) {
    try {
      const { data: jobRow, error: jobErr } = await supabaseAdmin
        .from("jobs")
        .select("id, title, company, description, location, category, skills")
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
        };
      }
    } catch (e) {
      console.warn("[InterviewPack] Error querying job:", e);
    }
  }

  // Fallback to sample job specification if jobId === 'sample' or not found
  if (!job) {
    job = {
      id: jobId,
      title: "Senior Full-Stack Engineer",
      company: "CareerMonke Partner",
      description:
        "Building real-time job discovery engine, distributed search indexing, Next.js architecture, and high-performance serverless endpoints.",
      location: "Worldwide (Remote)",
      category: "Engineering",
      skills: ["React", "TypeScript", "Node.js", "Next.js", "SQL", "Cloudflare Workers"],
    };
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

  // 6. Fetch Verified Company Intel with 30-Day Cache
  const companyIntel = await getCompanyIntel(job.company, supabaseAdmin, {
    fetchClaims: deps.fetchCompanyIntelClaims,
  });

  // 7. Generate Grounded Interview Pack with Timeout & Graceful Error
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
    // Provider failure -> clear error JSON, never fake fallback content
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
