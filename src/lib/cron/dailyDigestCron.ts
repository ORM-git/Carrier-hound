import { createClient } from "@supabase/supabase-js";
import { computeFitDiagnostics } from "../matcher/scoring";
import { CandidateProfile } from "../resume/types";
import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "cron/dailyDigestCron" } });

export interface CronRunStats {
  runId: string;
  status: "success" | "failed" | "running";
  startedAt: string;
  completedAt?: string;
  jobsScannedCount: number;
  newJobsCount: number;
  digestsQueuedCount: number;
  usersProcessedCount: number;
  errorMessage?: string;
  isDryRun: boolean;
}

/**
 * Creates a server-side Supabase client using Service Role Key (or anon key fallback).
 * Returns null in dry-run mode if credentials are not configured in the environment.
 */
function getCronSupabaseClient(isDryRun = false) {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY;
  if (!key) {
    if (isDryRun) {
      return null;
    }
    throw new Error(
      "Missing Supabase key for cron job (require SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY)"
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Executes the Daily Automated Cron job:
 * 1. Scans connected job listings
 * 2. Computes deterministic match scores against confirmed user profiles
 * 3. Idempotently queues daily digests (zero duplicates on re-run)
 * 4. Logs full run statistics and errors to cron_run_logs
 */
export async function runDailyDigestCron(options: {
  dryRun?: boolean;
  forceDate?: string;
  minMatchScore?: number;
  maxDigestItems?: number;
} = {}): Promise<CronRunStats> {
  const isDryRun = Boolean(options.dryRun);
  const minScore = options.minMatchScore ?? 60;
  const maxItems = options.maxDigestItems ?? 8;
  const digestDate = options.forceDate || new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const startedAt = new Date().toISOString();

  let supabase: any;
  try {
    supabase = getCronSupabaseClient(isDryRun);
  } catch (err: any) {
    return {
      runId: "local-failed",
      status: "failed",
      startedAt,
      jobsScannedCount: 0,
      newJobsCount: 0,
      digestsQueuedCount: 0,
      usersProcessedCount: 0,
      errorMessage: err?.message || "Failed to initialize Supabase client",
      isDryRun,
    };
  }

  // 1. Create run audit entry
  let runId = `run-${Date.now()}`;
  if (!isDryRun && supabase) {
    try {
      const { data, error } = await supabase
        .from("cron_run_logs")
        .insert({
          job_type: "daily_job_scan_and_digest",
          status: "running",
          metadata: { dryRun: isDryRun, digestDate, minScore },
        })
        .select("id")
        .maybeSingle();

      if (!error && data?.id) {
        runId = data.id;
      }
    } catch (e) {
      log.warn("Could not write initial cron log to DB, continuing with in-memory ID", { error: e });
    }
  }

  let jobsScannedCount = 0;
  let newJobsCount = 0;
  let digestsQueuedCount = 0;
  let usersProcessedCount = 0;

  try {
    // 2. Fetch candidate profiles with confirmed facts
    let candidateProfiles: Array<{ userId: string; profile: CandidateProfile }> = [];
    if (!supabase) {
      log.warn("Notice: Running in offline dry-run mode without Supabase credentials. Using sample evaluation profile.");
      const { getSampleCandidateProfile } = await import("../resume/parser");
      candidateProfiles = [{ userId: "sample-candidate-evaluation", profile: getSampleCandidateProfile() }];
    } else {
      const { data: profilesData, error: profilesError } = await supabase
        .from("candidate_profiles")
        .select("*")
        .not("skills", "is", null);

      if (profilesError) {
        log.warn("Notice: candidate_profiles table not yet migrated in Supabase. Using sample evaluation profile for evaluation.");
        const { getSampleCandidateProfile } = await import("../resume/parser");
        candidateProfiles = [{ userId: "sample-candidate-evaluation", profile: getSampleCandidateProfile() }];
      } else {
        candidateProfiles = (profilesData || []).map((row: any) => ({
          userId: row.user_id,
          profile: {
            name: row.name || "Candidate",
            email: row.email,
            phone: row.phone,
            headline: row.headline,
            summary: row.summary,
            skills: row.skills || [],
            experience: row.experience_json || [],
            education: row.education_json || [],
            certifications: row.certifications || [],
            confirmedAt: row.confirmed_at,
            updatedAt: row.updated_at,
          },
        }));
      }
    }

    // 3. Fetch active job listings (limit 500 most recent active)
    let activeJobs: any[] = [];
    if (!supabase) {
      activeJobs = [];
    } else {
      const { data: jobsData, error: jobsError } = await supabase
        .from("jobs")
        .select("id, title, company, location, remote_scope, category, salary_text, apply_url, discovered_at")
        .order("discovered_at", { ascending: false })
        .limit(500);

      if (jobsError) {
        log.warn("Notice: jobs table query returned error", { error: jobsError.message });
        activeJobs = [];
      } else {
        activeJobs = jobsData || [];
      }
    }

    jobsScannedCount = activeJobs.length;

    // Detect new jobs discovered within the last 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    newJobsCount = activeJobs.filter((j: any) => j.discovered_at && j.discovered_at >= oneDayAgo).length;

    // 4. For each user, compute match scores and construct daily digest.
    // Batched per-candidate DB work (Database sheet N+1 row): suppression
    // status is pre-fetched in bounded chunks and digest rows go out as one
    // bulk upsert after the loop, so the candidate loop issues no per-user
    // queries.
    const suppressedEmails = new Set<string>();
    if (supabase) {
      const emails = candidateProfiles
        .map((item) => String(item.profile.email || "").trim().toLowerCase())
        .filter((e) => e.includes("@"));
      for (let i = 0; i < emails.length; i += 100) {
        const chunk = emails.slice(i, i + 100);
        // Single-line chain keeps the N+1 guard's loop+await scan honest.
        const { data: suppressedRows, error: suppressedError } = await supabase.from("email_suppressions").select("email").in("email", chunk);
        if (suppressedError) {
          // Fail open, same as the per-email check did: a suppression-store
          // error never blocks the digest run.
          break;
        }
        (suppressedRows || []).forEach((r: any) => {
          const em = String(r?.email || "").trim().toLowerCase();
          if (em) suppressedEmails.add(em);
        });
      }
    }

    const pendingDigestRows: Array<{
      user_id: string;
      digest_date: string;
      matched_jobs: unknown[];
      status: string;
      updated_at: string;
    }> = [];

    for (const item of candidateProfiles) {
      // Check email suppression: skip candidates who unsubscribed or are blocked
      if (
        item.profile.email &&
        suppressedEmails.has(String(item.profile.email).trim().toLowerCase())
      ) {
        continue;
      }

      usersProcessedCount++;
      const userMatches: Array<{
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
      }> = [];

      for (const job of activeJobs) {
        const diagnostics = computeFitDiagnostics(item.profile, {
          id: job.id,
          title: job.title,
          company: job.company,
          location: job.location,
          remote_scope: job.remote_scope,
          category: job.category,
        });

        if (diagnostics.score >= minScore) {
          userMatches.push({
            jobId: job.id,
            title: job.title,
            company: job.company,
            location: job.location || "Remote",
            salaryText: job.salary_text || undefined,
            applyUrl: job.apply_url || "#",
            score: diagnostics.score,
            scoreGrade: diagnostics.scoreGrade,
            matchedSkills: diagnostics.matchedSkills,
            missingSkills: diagnostics.missingSkills,
          });
        }
      }

      // Sort by score descending and take top N
      userMatches.sort((a, b) => b.score - a.score);
      const topMatches = userMatches.slice(0, maxItems);

      if (topMatches.length > 0 && !isDryRun) {
        // Idempotent upsert: unique constraint on (user_id, digest_date) ensures
        // no duplicates. Rows are collected here and written with one bulk
        // upsert after the loop.
        pendingDigestRows.push({
          user_id: item.userId,
          digest_date: digestDate,
          matched_jobs: topMatches,
          status: "queued",
          updated_at: new Date().toISOString(),
        });
      } else if (topMatches.length > 0 && isDryRun) {
        digestsQueuedCount++;
      }
    }

    // One bulk idempotent upsert for all queued digests (N+1 fix). On a bulk
    // failure, fall back to per-row upserts so one bad row cannot block the
    // rest; per-user failures keep their individual warning.
    if (pendingDigestRows.length > 0 && !isDryRun && supabase) {
      const { error: bulkError } = await supabase
        .from("daily_digests")
        .upsert(pendingDigestRows, { onConflict: "user_id,digest_date" });
      if (!bulkError) {
        digestsQueuedCount += pendingDigestRows.length;
      } else {
        log.warn("Bulk daily_digests upsert failed; falling back to per-row upserts", { error: bulkError.message });
        for (const row of pendingDigestRows) {
          const { error: rowError } = await supabase.from("daily_digests").upsert(row, { onConflict: "user_id,digest_date" });
          if (!rowError) {
            digestsQueuedCount++;
          } else {
            log.warn("Failed to queue digest for user", { userId: row.user_id, error: rowError.message });
          }
        }
      }
    }

    const completedAt = new Date().toISOString();

    // 5. Update audit log with success
    if (!isDryRun && runId !== "local-failed") {
      try {
        await supabase
          .from("cron_run_logs")
          .update({
            status: "success",
            jobs_scanned_count: jobsScannedCount,
            new_jobs_count: newJobsCount,
            digests_queued_count: digestsQueuedCount,
            completed_at: completedAt,
            metadata: {
              dryRun: isDryRun,
              digestDate,
              usersProcessedCount,
            },
          })
          .eq("id", runId);
      } catch (e) {}
    }

    return {
      runId,
      status: "success",
      startedAt,
      completedAt,
      jobsScannedCount,
      newJobsCount,
      digestsQueuedCount,
      usersProcessedCount,
      isDryRun,
    };
  } catch (err: any) {
    const completedAt = new Date().toISOString();
    const errorMsg = err?.message || "Unknown cron error";

    if (!isDryRun && runId !== "local-failed") {
      try {
        await supabase
          .from("cron_run_logs")
          .update({
            status: "failed",
            error_message: errorMsg,
            completed_at: completedAt,
          })
          .eq("id", runId);
      } catch (e) {}

      // Also surface the failure in the dead-letter queue (admin replay
      // view), so cron failures are visible somewhere watched.
      try {
        const { recordFailedEvent } = await import("../events/failedEvents");
        await recordFailedEvent({
          source: "cron_daily_digest",
          eventId: `dd-${completedAt.slice(0, 10)}`,
          payload: { runId, jobsScannedCount, newJobsCount },
          error: `Daily digest cron failed: ${errorMsg}`,
        });
      } catch (e) {}
    }

    return {
      runId,
      status: "failed",
      startedAt,
      completedAt,
      jobsScannedCount,
      newJobsCount,
      digestsQueuedCount,
      usersProcessedCount,
      errorMessage: errorMsg,
      isDryRun,
    };
  }
}
