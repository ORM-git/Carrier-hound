import { createLogger } from "@/lib/observability/logger";
import { VISIBLE_SOURCE_FILTER } from "@/lib/jobs/sourcePolicy";

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
 * Executes the Daily Automated Cron job:
 * 1. Scans connected job listings
 * 2. Computes deterministic match scores against confirmed user profiles
 * 3. Idempotently queues daily digests (zero duplicates on re-run)
 * 4. Logs full run statistics and errors to cron_run_logs
 */
/**
 * Fetches active jobs discovered since `windowCutoff`, newest first, using keyset pagination on the
 * composite cursor (discovered_at, id). Ordering on both columns and the OR-filter on the cursor mean
 * rows that share a boundary timestamp are never skipped between pages.
 * Throws on query exceptions; a returned page error stops pagination and keeps the rows read so far.
 */
export async function fetchActiveJobsWindow(
  supabase: any,
  windowCutoff: string,
  maxJobs: number,
  pageSize: number
): Promise<any[]> {
  const jobs: any[] = [];
  let cursor: { discoveredAt: string; id: string } | null = null;
  while (jobs.length < maxJobs) {
    const limit = Math.min(pageSize, maxJobs - jobs.length);
    let query = supabase
      .from("jobs")
      .select("id, title, company, location, remote_scope, category, salary_text, apply_url, discovered_at").or(VISIBLE_SOURCE_FILTER)
      .eq("status", "active")
      .eq("is_active", true)
      .gte("discovered_at", windowCutoff);

    if (cursor) {
      query = query.or(
        `discovered_at.lt."${cursor.discoveredAt}",and(discovered_at.eq."${cursor.discoveredAt}",id.lt."${cursor.id}")`
      );
    }

    query = query.order("discovered_at", { ascending: false }).order("id", { ascending: false }).limit(limit);

    const { data: pageData, error: pageError } = await query;
    if (pageError) {
      log.warn("Notice: jobs table query returned error", { error: pageError.message });
      break;
    }
    if (!pageData || pageData.length === 0) break;

    jobs.push(...pageData);
    if (pageData.length < limit) break;
    const last = pageData[pageData.length - 1];
    if (!last.discovered_at || !last.id) break;
    cursor = { discoveredAt: last.discovered_at, id: last.id };
  }
  return jobs;
}

export async function runDailyDigestCron(options: {
  dryRun?: boolean; forceDate?: string;
  minMatchScore?: number; maxDigestItems?: number;
  scannedWindowDays?: number;
  maxScannedJobs?: number;
} = {}): Promise<CronRunStats> {
  const isDryRun = Boolean(options.dryRun);
  const startedAt = new Date().toISOString();

  // Launch scope gate: daily matching and digest workflows are Coming Soon
  return {
    runId: "coming-soon",
    status: "coming_soon" as any,
    startedAt,
    jobsScannedCount: 0,
    newJobsCount: 0,
    digestsQueuedCount: 0,
    usersProcessedCount: 0,
    errorMessage: "Daily matching and digest workflows are coming soon.",
    isDryRun,
  };
}
