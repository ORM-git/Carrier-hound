/**
 * Cloudflare Scheduled Ingest Watchdog Worker
 *
 * Checks ingestion cadence every 15 minutes.
 * If normal 4-hour cadence is overdue by 45 minutes (total 285 minutes) and no Python
 * run is queued or running, dispatches the python-ingest workflow on main with
 * cron-equivalent inputs and watchdog: true.
 *
 * Safe & Truthful Guarantees:
 * 1. GET /check is strictly read-only inspection.
 * 2. Manual dispatch requires authenticated explicit POST /dispatch with Bearer secret.
 * 3. Freshness is derived from verified production-write cohort jobs on main.
 * 4. Tracks cohorts independently (non-workday and workday); dry-runs, skip-only, and other branches excluded.
 * 5. Bounded attempt cooldown (45m) prevents rapid retry loops after failure.
 * 6. Shared cadence (240m) and grace (45m) = 285m threshold; 200m-old successful cohort is never rewritten.
 * 7. Strictly validates runs/jobs API schemas; empty jobs or malformed types fail closed.
 * 8. Full Retry-After honored (seconds or HTTP-date); exceeding budget defers visibly without early retrying.
 * 9. Ambiguous dispatch POST never blindly retried; rechecks run state before failing closed.
 * 10. /health returns not-ready (503) for stale or unverifiable ingestion state.
 */

export interface Env {
  GITHUB_TOKEN?: string;
  REPO_OWNER?: string;
  REPO_NAME?: string;
  WORKFLOW_FILE?: string;
  TARGET_BRANCH?: string;
  CADENCE_MINUTES?: string;
  OVERDUE_GRACE_MINUTES?: string;
  STALE_JOB_THRESHOLD_MINUTES?: string;
  ATTEMPT_COOLDOWN_MINUTES?: string;
  ALERT_WEBHOOK_URL?: string;
  DISPATCH_SECRET?: string;
}

export interface WatchdogAlert {
  type: "config_error" | "stale_job" | "dispatch_failed" | "ingestion_stale" | "cohort_failed" | "webhook_error";
  message: string;
  details?: Record<string, any>;
}

export interface ValidatedConfig {
  owner: string;
  repo: string;
  token: string;
  workflow: string;
  branch: string;
  cadenceMinutes: number;
  graceMinutes: number;
  overdueThresholdMinutes: number; // cadence + grace (default 285)
  staleJobMinutes: number;
  attemptCooldownMinutes: number;
  alertWebhookUrl: string;
  dispatchSecret?: string;
}

export interface CohortStatus {
  lastSuccessMs?: number;
  lastSuccessMinutesAgo?: number;
  lastAttemptMs?: number;
  lastAttemptMinutesAgo?: number;
  status: "healthy" | "overdue" | "attempt_cooldown" | "never_succeeded";
}

export interface InspectionReport {
  healthy: boolean;
  activeRun?: {
    id: number;
    status: string;
    durationMinutes: number;
    stale: boolean;
  };
  cohorts: {
    "non-workday": CohortStatus;
    "workday": CohortStatus;
  };
  staleCohorts: string[];
  failedCohorts: string[];
  attemptCooldownActive: boolean;
  actionRecommended: "dispatch" | "none" | "stale_job_alert" | "cooldown_wait";
  reason: string;
}

export interface WatchdogCheckResult {
  action: "dispatched" | "none" | "stale_job_reported" | "cooldown_wait";
  reason: string;
  targetCohort?: "both" | "non-workday" | "workday";
  overdueMinutes?: number;
  durationMinutes?: number;
  runId?: number | string;
  cohortsFailed?: string[];
  ref?: string;
}

// In-memory alert deduplication cache: fingerprint -> timestamp (ms).
// Best-effort across Cloudflare Worker isolates (resets on isolate recycle).
const recentAlerts = new Map<string, number>();
const ALERT_DEDUPE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function clearAlertCache(): void {
  recentAlerts.clear();
}

/**
 * Validates environment configuration and enforces timing value bounds.
 */
export function validateConfig(env: Env): ValidatedConfig {
  const token = env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new Error("Missing GITHUB_TOKEN: watchdog cannot authenticate to GitHub Actions API");
  }

  const webhookUrl = env.ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    throw new Error("Missing ALERT_WEBHOOK_URL: watchdog alert destination must be configured");
  }
  try {
    const parsed = new URL(webhookUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Invalid ALERT_WEBHOOK_URL protocol: must be HTTP or HTTPS");
    }
  } catch {
    throw new Error("Invalid ALERT_WEBHOOK_URL: must be a valid URL");
  }

  const parseBoundedTiming = (
    val: string | undefined,
    defaultVal: number,
    name: string,
    minVal: number,
    maxVal: number
  ): number => {
    if (val === undefined || val.trim() === "") return defaultVal;
    const n = Number(val);
    if (!Number.isFinite(n) || Number.isNaN(n) || !Number.isInteger(n) || n < minVal || n > maxVal) {
      throw new Error(
        `Invalid timing value for ${name}: must be an integer between ${minVal} and ${maxVal}, got "${val}"`
      );
    }
    return n;
  };

  const cadenceMinutes = parseBoundedTiming(env.CADENCE_MINUTES, 240, "CADENCE_MINUTES", 15, 1440);
  const graceMinutes = parseBoundedTiming(env.OVERDUE_GRACE_MINUTES, 45, "OVERDUE_GRACE_MINUTES", 0, 360);
  const staleJobMinutes = parseBoundedTiming(env.STALE_JOB_THRESHOLD_MINUTES, 120, "STALE_JOB_THRESHOLD_MINUTES", 15, 720);
  const attemptCooldownMinutes = parseBoundedTiming(env.ATTEMPT_COOLDOWN_MINUTES, 45, "ATTEMPT_COOLDOWN_MINUTES", 5, 360);

  return {
    owner: env.REPO_OWNER?.trim() || "ORM-git",
    repo: env.REPO_NAME?.trim() || "Carrier-hound",
    token,
    workflow: env.WORKFLOW_FILE?.trim() || "python-ingest.yml",
    branch: env.TARGET_BRANCH?.trim() || "main",
    cadenceMinutes,
    graceMinutes,
    overdueThresholdMinutes: cadenceMinutes + graceMinutes, // 285 min
    staleJobMinutes,
    attemptCooldownMinutes,
    alertWebhookUrl: webhookUrl,
    dispatchSecret: env.DISPATCH_SECRET?.trim() || undefined,
  };
}

/**
 * Parses Retry-After header as either delta-seconds or HTTP-date.
 */
export function parseRetryAfter(headerVal: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!headerVal) return null;
  const trimmed = headerVal.trim();
  if (/^\d+$/.test(trimmed)) {
    const sec = parseInt(trimmed, 10);
    return Number.isFinite(sec) && sec >= 0 ? sec : null;
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    const diffSec = Math.ceil((parsedDate - nowMs) / 1000);
    return Math.max(0, diffSec);
  }
  return null;
}

/**
 * Fetch wrapper with explicit timeout and bounded retries honoring full Retry-After.
 * If Retry-After exceeds maxRetryBudgetSeconds, defers visibly without early retrying.
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  fetchFn: typeof fetch = fetch,
  maxRetries = 2,
  timeoutMs = 15000,
  maxRetryBudgetSeconds = 30,
  nowMs: number = Date.now()
): Promise<Response> {
  let attempt = 0;
  while (true) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchFn(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Check for rate limit or temporary server failure
      if ((res.status === 429 || res.status === 503) && attempt <= maxRetries) {
        const retryAfterHeader = res.headers.get("Retry-After");
        const retrySeconds = parseRetryAfter(retryAfterHeader, nowMs);

        if (retrySeconds !== null) {
          if (retrySeconds > maxRetryBudgetSeconds) {
            throw new Error(
              `Rate limited with Retry-After (${retrySeconds}s) exceeding retry budget (${maxRetryBudgetSeconds}s); deferring execution.`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1000));
          continue;
        }

        // Standard exponential backoff when no header is present
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        continue;
      }

      return res;
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.message?.includes("exceeding retry budget")) {
        throw err;
      }
      if (attempt <= maxRetries && err?.name !== "AbortError") {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      throw err;
    }
  }
}

export async function sendAlert(
  env: Env,
  alert: WatchdogAlert,
  fetchFn: typeof fetch = fetch,
  nowMs: number = Date.now()
): Promise<void> {
  const webhookUrl = env.ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    throw new Error("Missing ALERT_WEBHOOK_URL: cannot send alert");
  }

  // Best-effort in-memory deduplication within isolate
  const dedupeKey = `${alert.type}:${alert.message}`;
  const lastSent = recentAlerts.get(dedupeKey);
  if (lastSent && nowMs - lastSent < ALERT_DEDUPE_TTL_MS) {
    console.log(`[Watchdog Alert] Suppressing duplicate alert: ${dedupeKey}`);
    return;
  }

  const payload = {
    text: `[CarrierHound Watchdog Alert] *${alert.type.toUpperCase()}*: ${alert.message}`,
    alertType: alert.type,
    message: alert.message,
    details: alert.details,
    timestamp: new Date(nowMs).toISOString(),
  };

  const res = await fetchWithRetry(
    webhookUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    fetchFn,
    2,
    10000,
    15,
    nowMs
  );

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Webhook alert failed with HTTP ${res.status}: ${errBody}`);
  }

  recentAlerts.set(dedupeKey, nowMs);
}

/**
 * Genuinely READ-ONLY inspection of ingestion status on main.
 * Strictly validates runs/jobs API response schemas, enforces pagination bounds,
 * and tracks cohorts independently.
 */
export async function inspectIngestionStatus(
  env: Env,
  fetchFn: typeof fetch = fetch,
  nowMs: number = Date.now()
): Promise<InspectionReport> {
  const config = validateConfig(env);
  const { owner, repo, token, workflow, branch, overdueThresholdMinutes, staleJobMinutes, attemptCooldownMinutes } = config;

  const MAX_PAGES = 3;
  const PER_PAGE = 30;
  let page = 1;
  const allRuns: any[] = [];
  let totalCount = 0;

  while (page <= MAX_PAGES) {
    const runsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?branch=${branch}&per_page=${PER_PAGE}&page=${page}`;
    const runsRes = await fetchWithRetry(
      runsUrl,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "carrier-hound-ingest-watchdog",
        },
      },
      fetchFn,
      2,
      15000,
      30,
      nowMs
    );

    if (!runsRes.ok) {
      const errText = await runsRes.text().catch(() => "");
      throw new Error(`GitHub API request failed with status ${runsRes.status}: ${errText}`);
    }

    let runsData: any;
    try {
      runsData = await runsRes.json();
    } catch (err: any) {
      throw new Error(`Invalid JSON in runs API response: ${err?.message}`);
    }

    // Strict schema validation of runs API response
    if (typeof runsData !== "object" || runsData === null || Array.isArray(runsData)) {
      throw new Error("Invalid runs API response schema: expected object, got non-object");
    }
    if (!Array.isArray(runsData.workflow_runs)) {
      throw new Error("Invalid runs API response schema: missing or malformed 'workflow_runs' array");
    }
    if (typeof runsData.total_count !== "number" || !Number.isFinite(runsData.total_count)) {
      throw new Error("Invalid runs API response schema: missing or non-numeric 'total_count'");
    }

    totalCount = runsData.total_count;
    const pageRuns = runsData.workflow_runs;

    // Detect inconsistent API state: nonzero total_count with empty page
    if (page === 1 && totalCount > 0 && pageRuns.length === 0) {
      throw new Error(`Inconsistent runs API response: nonzero total_count (${totalCount}) with empty page.`);
    }

    // Validate each run in page
    for (const r of pageRuns) {
      if (typeof r !== "object" || r === null) {
        throw new Error("Invalid run schema: run entry is not an object");
      }
      if (typeof r.id !== "number" || typeof r.head_branch !== "string" || typeof r.status !== "string") {
        throw new Error(`Invalid run schema: missing required fields in run #${r?.id}`);
      }
      allRuns.push(r);
    }

    // Stop paginating if page is incomplete or we have received all runs
    if (pageRuns.length < PER_PAGE || allRuns.length >= totalCount) {
      break;
    }
    page++;
  }

  // Filter strictly to runs on target branch (main)
  const runs = allRuns.filter((r) => r.head_branch === branch);

  // Verified bootstrap check: total_count === 0, or zero runs on main after exhausting all runs
  const isVerifiedBootstrap = (totalCount === 0 && allRuns.length === 0) || (allRuns.length >= totalCount && runs.length === 0);

  // If bound blocked verification without finding main runs while more runs exist
  if (!isVerifiedBootstrap && runs.length === 0 && allRuns.length < totalCount) {
    throw new Error(
      `History verification truncated at pagination bound (max ${MAX_PAGES} pages, ${allRuns.length}/${totalCount} runs); failing closed to not-ready.`
    );
  }

  // 1. Check for active (queued or in_progress) runs
  const activeRun = runs.find((r) => r.status === "queued" || r.status === "in_progress");
  let activeRunInfo: InspectionReport["activeRun"] = undefined;

  if (activeRun) {
    const startedAt = new Date(activeRun.run_started_at || activeRun.created_at).getTime();
    const durationMinutes = Math.max(0, Math.floor((nowMs - startedAt) / 60000));
    const isStale = durationMinutes >= staleJobMinutes;
    activeRunInfo = {
      id: activeRun.id,
      status: activeRun.status,
      durationMinutes,
      stale: isStale,
    };
  }

  // 2. Inspect completed runs and derive per-cohort verified production-write outcomes
  const completedRuns = runs.filter((r) => r.status === "completed");

  const cohorts: InspectionReport["cohorts"] = {
    "non-workday": { status: "never_succeeded" },
    "workday": { status: "never_succeeded" },
  };

  const failedCohortsSet = new Set<string>();

  for (const run of completedRuns) {
    const runTime = new Date(run.updated_at || run.created_at).getTime();

    // Fetch jobs for this run to verify actual cohort jobs
    const jobsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?per_page=100`;
    const jobsRes = await fetchWithRetry(
      jobsUrl,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "carrier-hound-ingest-watchdog",
        },
      },
      fetchFn,
      2,
      15000,
      30,
      nowMs
    );

    if (!jobsRes.ok) {
      throw new Error(`Failed to fetch jobs for run #${run.id}: HTTP ${jobsRes.status}`);
    }

    let jobsData: any;
    try {
      jobsData = await jobsRes.json();
    } catch (err: any) {
      throw new Error(`Invalid JSON in jobs API response for run #${run.id}: ${err?.message}`);
    }

    // Strict schema validation of jobs API response
    if (typeof jobsData !== "object" || jobsData === null || Array.isArray(jobsData)) {
      throw new Error(`Invalid jobs API schema for run #${run.id}: expected object`);
    }
    if (!Array.isArray(jobsData.jobs)) {
      throw new Error(`Invalid jobs API schema for run #${run.id}: missing or malformed 'jobs' array`);
    }

    const jobs = jobsData.jobs;

    // Fail closed if completed run has empty jobs
    if (jobs.length === 0) {
      throw new Error(`Unverifiable history: completed run #${run.id} has empty jobs list.`);
    }

    for (const j of jobs) {
      if (typeof j !== "object" || j === null || typeof j.name !== "string" || typeof j.status !== "string") {
        throw new Error(`Invalid job schema in run #${run.id}: missing name or status`);
      }
    }

    // Check each cohort job in this run
    for (const c of ["non-workday", "workday"] as const) {
      // Find production write job for this cohort:
      // Pattern: "Python ingestion [cohort] (write-production-expire)"
      const prodJob = jobs.find((j: any) =>
        j.name.includes(`[${c}]`) && j.name.includes("(write-production-expire)")
      );

      if (prodJob) {
        // Track latest attempt
        if (!cohorts[c].lastAttemptMs || runTime > cohorts[c].lastAttemptMs!) {
          cohorts[c].lastAttemptMs = runTime;
          cohorts[c].lastAttemptMinutesAgo = Math.max(0, Math.floor((nowMs - runTime) / 60000));
        }

        if (prodJob.conclusion === "success") {
          if (!cohorts[c].lastSuccessMs || runTime > cohorts[c].lastSuccessMs!) {
            cohorts[c].lastSuccessMs = runTime;
            cohorts[c].lastSuccessMinutesAgo = Math.max(0, Math.floor((nowMs - runTime) / 60000));
          }
        } else if (prodJob.conclusion === "failure") {
          failedCohortsSet.add(c);
        }
      }
      // Note: Jobs matching "(dry-run)" or skip-only runs have no prodJob and are ignored
    }

    // Stop searching once both cohorts have found their most recent success
    if (cohorts["non-workday"].lastSuccessMs && cohorts["workday"].lastSuccessMs) {
      break;
    }
  }

  // 3. Evaluate freshness and attempt cooldown per cohort
  const staleCohorts: string[] = [];
  let attemptCooldownActive = false;

  for (const c of ["non-workday", "workday"] as const) {
    const ch = cohorts[c];
    const isHealthy = ch.lastSuccessMinutesAgo !== undefined && ch.lastSuccessMinutesAgo <= overdueThresholdMinutes;

    if (isHealthy) {
      ch.status = "healthy";
    } else {
      staleCohorts.push(c);
      if (ch.lastAttemptMinutesAgo !== undefined && ch.lastAttemptMinutesAgo < attemptCooldownMinutes) {
        ch.status = "attempt_cooldown";
        attemptCooldownActive = true;
      } else if (ch.lastSuccessMinutesAgo !== undefined) {
        ch.status = "overdue";
      } else {
        ch.status = "never_succeeded";
      }
    }
  }

  // Determine overall action recommendation
  let actionRecommended: InspectionReport["actionRecommended"] = "none";
  let reason = "Ingestion cadence is healthy across all cohorts.";

  if (activeRunInfo) {
    if (activeRunInfo.stale) {
      actionRecommended = "stale_job_alert";
      reason = `Run #${activeRunInfo.id} has been ${activeRunInfo.status} for ${activeRunInfo.durationMinutes}m (>= ${staleJobMinutes}m threshold).`;
    } else {
      actionRecommended = "none";
      reason = `Run #${activeRunInfo.id} is currently ${activeRunInfo.status} (${activeRunInfo.durationMinutes}m elapsed); skipping catch-up.`;
    }
  } else if (staleCohorts.length > 0) {
    if (attemptCooldownActive) {
      actionRecommended = "cooldown_wait";
      reason = `Ingestion overdue for [${staleCohorts.join(", ")}], but attempt cooldown is active (${attemptCooldownMinutes}m). Skipping dispatch to prevent retry loop.`;
    } else {
      actionRecommended = "dispatch";
      reason = `Ingestion overdue for cohort(s): [${staleCohorts.join(", ")}]. Dispatch required.`;
    }
  }

  const failedCohorts = Array.from(failedCohortsSet);
  const healthy = staleCohorts.length === 0 && failedCohorts.length === 0 && !activeRunInfo?.stale;

  return {
    healthy,
    activeRun: activeRunInfo,
    cohorts,
    staleCohorts,
    failedCohorts,
    attemptCooldownActive,
    actionRecommended,
    reason,
  };
}

/**
 * Reconcile ingestion: performs inspection, sends necessary alerts, and if overdue
 * and outside cooldown, dispatches catch-up workflow on main for the stale cohort(s).
 *
 * Guarantees that ambiguous dispatch POSTs (timeouts/network drops) are never blindly retried;
 * instead rechecks run state and fails closed if uncertain.
 */
export async function checkAndReconcileIngestion(
  env: Env,
  fetchFn: typeof fetch = fetch,
  nowMs: number = Date.now()
): Promise<WatchdogCheckResult> {
  let inspection: InspectionReport;
  try {
    inspection = await inspectIngestionStatus(env, fetchFn, nowMs);
  } catch (err: any) {
    if (env.ALERT_WEBHOOK_URL) {
      await sendAlert(
        env,
        {
          type: "config_error",
          message: err?.message || "Failed to inspect ingestion status",
          details: { error: String(err) },
        },
        fetchFn,
        nowMs
      ).catch(() => {});
    }
    throw err;
  }

  const config = validateConfig(env);
  const { owner, repo, token, workflow, branch } = config;

  // 1. Report stale active job
  if (inspection.activeRun?.stale) {
    await sendAlert(
      env,
      {
        type: "stale_job",
        message: inspection.reason,
        details: {
          runId: inspection.activeRun.id,
          status: inspection.activeRun.status,
          durationMinutes: inspection.activeRun.durationMinutes,
        },
      },
      fetchFn,
      nowMs
    );
    return {
      action: "stale_job_reported",
      runId: inspection.activeRun.id,
      durationMinutes: inspection.activeRun.durationMinutes,
      reason: inspection.reason,
    };
  }

  if (inspection.activeRun) {
    return {
      action: "none",
      runId: inspection.activeRun.id,
      durationMinutes: inspection.activeRun.durationMinutes,
      reason: inspection.reason,
    };
  }

  // 2. Alert on failed cohorts
  if (inspection.failedCohorts.length > 0) {
    await sendAlert(
      env,
      {
        type: "cohort_failed",
        message: `Recent ingestion runs had failed cohort(s): ${inspection.failedCohorts.join(", ")}`,
        details: { failedCohorts: inspection.failedCohorts },
      },
      fetchFn,
      nowMs
    );
  }

  // 3. Attempt cooldown active: do not dispatch
  if (inspection.attemptCooldownActive && inspection.staleCohorts.length > 0) {
    return {
      action: "cooldown_wait",
      reason: inspection.reason,
      cohortsFailed: inspection.failedCohorts.length > 0 ? inspection.failedCohorts : undefined,
    };
  }

  // 4. Cadence check & dispatch
  if (inspection.staleCohorts.length > 0) {
    // Determine target cohort: do not rewrite healthy cohort if only one is degraded
    let targetCohort: "both" | "non-workday" | "workday" = "both";
    if (inspection.staleCohorts.length === 1) {
      targetCohort = inspection.staleCohorts[0] as "non-workday" | "workday";
    }

    console.log(`[Watchdog] Dispatching catch-up for cohort "${targetCohort}" on ${branch}...`);

    const dispatchUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
    const dispatchPayload = {
      ref: branch,
      inputs: {
        cohort: targetCohort,
        mode: "write-production-expire",
        confirm: "WRITE PRODUCTION AND EXPIRE",
        watchdog: true,
      },
    };

    let dispatchRes: Response;
    try {
      // Dispatch POST has a strict 15s timeout and is NOT blindly retried on network failure
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      dispatchRes = await fetchFn(dispatchUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "carrier-hound-ingest-watchdog",
        },
        body: JSON.stringify(dispatchPayload),
        signal: controller.signal,
      });
      clearTimeout(timer);
    } catch (postErr: any) {
      // Network drop or timeout ambiguity: NEVER blindly retry dispatch POST!
      console.warn("[Watchdog] Ambiguous dispatch POST error; rechecking workflow run state...", postErr);
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Recheck run state
      try {
        const verifyRes = await fetchFn(
          `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?branch=${branch}&per_page=5`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "carrier-hound-ingest-watchdog",
            },
          }
        );
        if (verifyRes.ok) {
          const vData = (await verifyRes.json()) as any;
          const latestRun = vData.workflow_runs?.[0];
          if (latestRun) {
            const ageSec = Math.floor((Date.now() - new Date(latestRun.created_at).getTime()) / 1000);
            if (ageSec < 120 && (latestRun.status === "queued" || latestRun.status === "in_progress")) {
              return {
                action: "dispatched",
                targetCohort,
                ref: branch,
                runId: latestRun.id,
                reason: "Dispatch confirmed via state recheck after ambiguous network response.",
              };
            }
          }
        }
      } catch {
        // Fall through to fail closed
      }

      const alertMsg = `Ambiguous dispatch POST outcome: ${postErr?.message || postErr}; run state unconfirmed. Failing closed to prevent double-dispatch.`;
      await sendAlert(
        env,
        {
          type: "dispatch_failed",
          message: alertMsg,
          details: { url: dispatchUrl },
        },
        fetchFn,
        nowMs
      ).catch(() => {});
      throw new Error(alertMsg);
    }

    if (dispatchRes.status !== 204 && !dispatchRes.ok) {
      const errText = await dispatchRes.text().catch(() => "");
      const alertMsg = `Watchdog catch-up dispatch failed with status ${dispatchRes.status}: ${errText}`;
      await sendAlert(
        env,
        {
          type: "dispatch_failed",
          message: alertMsg,
          details: { status: dispatchRes.status, url: dispatchUrl },
        },
        fetchFn,
        nowMs
      );
      throw new Error(alertMsg);
    }

    return {
      action: "dispatched",
      targetCohort,
      ref: branch,
      reason: inspection.reason,
      cohortsFailed: inspection.failedCohorts.length > 0 ? inspection.failedCohorts : undefined,
    };
  }

  return {
    action: "none",
    reason: inspection.reason,
    cohortsFailed: inspection.failedCohorts.length > 0 ? inspection.failedCohorts : undefined,
  };
}

export default {
  async scheduled(event: any, env: Env, ctx: any): Promise<void> {
    ctx.waitUntil(
      checkAndReconcileIngestion(env).catch((err) => {
        console.error("[Watchdog Scheduled Handler Error]", err);
      })
    );
  },

  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(request.url);

    // 1. Health endpoint: strictly read-only; returns not-ready (503) for stale/unverifiable state
    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: { "Content-Type": "application/json", Allow: "GET" },
        });
      }

      try {
        validateConfig(env);
      } catch (cfgErr: any) {
        return new Response(
          JSON.stringify({
            status: "unhealthy",
            ready: false,
            service: "carrier-hound-ingest-watchdog",
            issue: cfgErr?.message || String(cfgErr),
          }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      try {
        const inspection = await inspectIngestionStatus(env);
        if (!inspection.healthy) {
          return new Response(
            JSON.stringify({
              status: "not_ready",
              ready: false,
              service: "carrier-hound-ingest-watchdog",
              reason: inspection.reason,
              staleCohorts: inspection.staleCohorts,
              failedCohorts: inspection.failedCohorts,
              activeRun: inspection.activeRun,
              cohorts: inspection.cohorts,
            }),
            {
              status: 503,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        return new Response(
          JSON.stringify({
            status: "healthy",
            ready: true,
            service: "carrier-hound-ingest-watchdog",
            cohorts: inspection.cohorts,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      } catch (inspErr: any) {
        return new Response(
          JSON.stringify({
            status: "unhealthy",
            ready: false,
            service: "carrier-hound-ingest-watchdog",
            issue: `Ingestion state unverifiable: ${inspErr?.message || String(inspErr)}`,
          }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // 2. Genuinely read-only check / inspect endpoint (GET only)
    if (url.pathname === "/check" || url.pathname === "/inspect") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed. Inspection is strictly read-only GET." }), {
          status: 405,
          headers: { "Content-Type": "application/json", Allow: "GET" },
        });
      }

      try {
        const inspection = await inspectIngestionStatus(env);
        return new Response(
          JSON.stringify({
            success: true,
            readOnly: true,
            inspection,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      } catch (err: any) {
        return new Response(
          JSON.stringify({
            success: false,
            error: err?.message || String(err),
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // 3. Manual dispatch endpoint: requires authenticated POST with DISPATCH_SECRET
    if (url.pathname === "/dispatch") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method Not Allowed. Manual dispatch requires POST." }), {
          status: 405,
          headers: { "Content-Type": "application/json", Allow: "POST" },
        });
      }

      const dispatchSecret = env.DISPATCH_SECRET?.trim();
      const authHeader = request.headers.get("Authorization")?.trim();

      if (!dispatchSecret || authHeader !== `Bearer ${dispatchSecret}`) {
        return new Response(
          JSON.stringify({
            error: "Unauthorized: explicit DISPATCH_SECRET Bearer token required for manual dispatch",
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      try {
        const result = await checkAndReconcileIngestion(env);
        return new Response(
          JSON.stringify({
            success: true,
            result,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      } catch (err: any) {
        return new Response(
          JSON.stringify({
            success: false,
            error: err?.message || String(err),
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};
