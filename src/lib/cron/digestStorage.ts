import { createClient } from "../supabase/client";
import { getCandidateProfile } from "../resume/storage";
import { computeFitDiagnostics } from "../matcher/scoring";
import { getLiveJobs } from "../jobs/service";
import { getProAccessStatus } from "../billing/subscription";
import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "cron/digestStorage" } });

export interface DigestMatchItem {
  jobId: string;
  title: string;
  company: string;
  location: string;
  salaryText?: string;
  applyUrl: string;
  score: number;
  scoreGrade: string;
  matchedSkills: string[];
  missingSkills: string[];
}

export interface DailyDigestQueue {
  digestDate: string;
  matches: DigestMatchItem[];
  isQueuedByCron: boolean;
}

/**
 * Loads today's daily digest for the authenticated user, or computes top matches locally
 * using the live Supabase dataset and consistent Pro field-level gating.
 */
export async function getTodayDigest(userId?: string, isProUser?: boolean): Promise<DailyDigestQueue> {
  const todayStr = new Date().toISOString().split("T")[0];
  let isPro = isProUser;
  if (isPro === undefined) {
    const proStatus = await getProAccessStatus(userId);
    isPro = proStatus.isPro;
  }

  try {
    const supabase = createClient();
    let resolvedUserId = userId;

    if (!resolvedUserId) {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        resolvedUserId = session.user.id;
      } else {
        const { data: { user } } = await supabase.auth.getUser();
        resolvedUserId = user?.id;
      }
    }

    const profile = await getCandidateProfile();

    if (resolvedUserId) {
      // Query today's digest specifically to avoid presenting stale digests from previous dates
      const queryPromise = supabase
        .from("daily_digests")
        .select("*")
        .eq("user_id", resolvedUserId)
        .eq("digest_date", todayStr)
        .limit(1)
        .maybeSingle();

      const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: new Error("Digest query timeout") }), 4000)
      );

      const { data, error } = await Promise.race([queryPromise, timeoutPromise]);

      // Check if profile was updated after this digest was generated
      const isProfileNewer = Boolean(
        profile?.updatedAt &&
        data?.created_at &&
        new Date(profile.updatedAt).getTime() > new Date(data.created_at).getTime()
      );

      if (!error && data && Array.isArray(data.matched_jobs) && data.matched_jobs.length > 0 && !isProfileNewer) {
        // Enforce consistent payload-level Pro gating on stored matches
        const sanitizedMatches: DigestMatchItem[] = data.matched_jobs.map((item: any) => ({
          jobId: item.jobId || item.id,
          title: item.title,
          company: isPro ? (item.company || "Verified Employer") : "Confidential Employer",
          location: item.location || "Remote",
          salaryText: isPro ? (item.salaryText || item.salary || "") : "",
          applyUrl: isPro ? (item.applyUrl || "") : "",
          score: item.score ?? 50,
          scoreGrade: item.scoreGrade || "moderate",
          matchedSkills: item.matchedSkills || [],
          missingSkills: item.missingSkills || [],
        }));

        return {
          digestDate: data.digest_date,
          matches: sanitizedMatches,
          isQueuedByCron: true,
        };
      }
    }
  } catch (e) {
    log.warn("Could not retrieve remote digest, computing from live jobs:", { error: e });
  }

  // Compute top matches across the full relevant dataset against candidate profile
  try {
    const profile = await getCandidateProfile();
    if (!profile || !profile.confirmedAt) {
      return {
        digestDate: todayStr,
        matches: [],
        isQueuedByCron: false,
      };
    }

    // Scan full relevant dataset (up to 200 jobs) rather than subset of 50
    const liveRes = await getLiveJobs({ page: 1, pageSize: 200, isPro });
    const matches: DigestMatchItem[] = [];

    for (const job of liveRes.jobs) {
      const diagnostics = computeFitDiagnostics(profile, {
        id: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        remote_scope: job.remoteScope || (job.remote ? "worldwide" : undefined),
        category: job.category,
        skills: job.skills,
        salary_text: job.salary,
      });

      if (diagnostics.score >= 35) {
        matches.push({
          jobId: job.id,
          title: job.title,
          company: isPro ? job.company : "Confidential Employer",
          location: job.location || "Remote",
          salaryText: isPro ? job.salary : "",
          applyUrl: isPro ? job.applyUrl : "",
          score: diagnostics.score,
          scoreGrade: diagnostics.scoreGrade,
          matchedSkills: diagnostics.matchedSkills,
          missingSkills: diagnostics.missingSkills,
        });
      }
    }

    matches.sort((a, b) => b.score - a.score);

    return {
      digestDate: todayStr,
      matches: matches.slice(0, 5),
      isQueuedByCron: false,
    };
  } catch (e) {
    return {
      digestDate: todayStr,
      matches: [],
      isQueuedByCron: false,
    };
  }
}
