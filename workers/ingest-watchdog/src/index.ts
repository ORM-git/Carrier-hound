/**
 * Cloudflare Scheduled Ingest Watchdog Worker
 *
 * Checks ingestion cadence every 15 minutes.
 * If normal 4-hour cadence is overdue by 45 minutes (total 285 minutes) and no Python
 * run is queued or running, dispatches the python-ingest workflow on main with
 * cron-equivalent inputs and watchdog: true.
 *
 * Inspects per-cohort outcomes, alerts on dispatch failure or stale ingestion, and
 * fails visibly if configuration is missing.
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
  ALERT_WEBHOOK_URL?: string;
}

export interface WatchdogAlert {
  type: "config_error" | "stale_job" | "dispatch_failed" | "ingestion_stale" | "cohort_failed";
  message: string;
  details?: Record<string, any>;
}

export interface WatchdogCheckResult {
  action: "dispatched" | "none" | "stale_job_reported";
  reason?: string;
  overdueMinutes?: number;
  durationMinutes?: number;
  runId?: number | string;
  cohortsFailed?: string[];
  ref?: string;
}

export function validateConfig(env: Env): {
  owner: string;
  repo: string;
  token: string;
  workflow: string;
  branch: string;
  cadenceMinutes: number;
  graceMinutes: number;
  staleJobMinutes: number;
} {
  const token = env.GITHUB_TOKEN?.trim();
  const owner = env.REPO_OWNER?.trim() || "ORM-git";
  const repo = env.REPO_NAME?.trim() || "Carrier-hound";
  const workflow = env.WORKFLOW_FILE?.trim() || "python-ingest.yml";
  const branch = env.TARGET_BRANCH?.trim() || "main";
  const cadenceMinutes = parseInt(env.CADENCE_MINUTES || "240", 10);
  const graceMinutes = parseInt(env.OVERDUE_GRACE_MINUTES || "45", 10);
  const staleJobMinutes = parseInt(env.STALE_JOB_THRESHOLD_MINUTES || "120", 10);

  if (!token) {
    throw new Error("Missing GITHUB_TOKEN: watchdog cannot authenticate to GitHub Actions API");
  }

  return {
    owner,
    repo,
    token,
    workflow,
    branch,
    cadenceMinutes,
    graceMinutes,
    staleJobMinutes,
  };
}

export async function sendAlert(
  env: Env,
  alert: WatchdogAlert,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  console.error(`[Watchdog Alert] [${alert.type.toUpperCase()}] ${alert.message}`, alert.details || "");

  const webhookUrl = env.ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    return;
  }

  try {
    const payload = {
      text: `[CarrierHound Watchdog Alert] *${alert.type.toUpperCase()}*: ${alert.message}`,
      alertType: alert.type,
      message: alert.message,
      details: alert.details,
      timestamp: new Date().toISOString(),
    };

    await fetchFn(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[Watchdog Alert] Failed to dispatch webhook alert:", err);
  }
}

export async function checkAndReconcileIngestion(
  env: Env,
  fetchFn: typeof fetch = fetch,
  nowMs: number = Date.now()
): Promise<WatchdogCheckResult> {
  let config: ReturnType<typeof validateConfig>;
  try {
    config = validateConfig(env);
  } catch (err: any) {
    await sendAlert(
      env,
      {
        type: "config_error",
        message: err?.message || "Invalid watchdog configuration",
      },
      fetchFn
    );
    throw err;
  }

  const { owner, repo, token, workflow, branch, cadenceMinutes, graceMinutes, staleJobMinutes } = config;
  const overdueThresholdMinutes = cadenceMinutes + graceMinutes; // 240 + 45 = 285 min

  const runsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?branch=${branch}&per_page=10`;
  const runsRes = await fetchFn(runsUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "carrier-hound-ingest-watchdog",
    },
  });

  if (!runsRes.ok) {
    const errText = await runsRes.text().catch(() => "");
    const alertMsg = `GitHub API request failed with status ${runsRes.status}: ${errText}`;
    await sendAlert(
      env,
      {
        type: "config_error",
        message: alertMsg,
        details: { status: runsRes.status, url: runsUrl },
      },
      fetchFn
    );
    throw new Error(alertMsg);
  }

  const runsData = (await runsRes.json()) as { workflow_runs?: any[] };
  const runs = runsData.workflow_runs || [];

  // 1. Check for active (queued or in_progress) runs
  const activeRun = runs.find((r) => r.status === "queued" || r.status === "in_progress");
  if (activeRun) {
    const startedAt = new Date(activeRun.run_started_at || activeRun.created_at).getTime();
    const durationMinutes = Math.max(0, Math.floor((nowMs - startedAt) / 60000));

    if (durationMinutes >= staleJobMinutes) {
      const alertMsg = `Stale ingestion run detected: Run #${activeRun.id} has been ${activeRun.status} for ${durationMinutes} minutes (>= threshold ${staleJobMinutes}m)`;
      await sendAlert(
        env,
        {
          type: "stale_job",
          message: alertMsg,
          details: { runId: activeRun.id, status: activeRun.status, durationMinutes },
        },
        fetchFn
      );
      return {
        action: "stale_job_reported",
        runId: activeRun.id,
        durationMinutes,
        reason: alertMsg,
      };
    }

    return {
      action: "none",
      reason: `Workflow run #${activeRun.id} is currently ${activeRun.status} (${durationMinutes}m elapsed); skipping catch-up dispatch.`,
      runId: activeRun.id,
    };
  }

  // 2. Inspect completed runs and per-cohort outcomes
  const completedRuns = runs.filter((r) => r.status === "completed");
  const latestCompleted = completedRuns[0];
  let failedCohorts: string[] = [];

  if (latestCompleted) {
    try {
      const jobsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${latestCompleted.id}/jobs`;
      const jobsRes = await fetchFn(jobsUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "carrier-hound-ingest-watchdog",
        },
      });
      if (jobsRes.ok) {
        const jobsData = (await jobsRes.json()) as { jobs?: any[] };
        const jobs = jobsData.jobs || [];
        for (const job of jobs) {
          if (job.conclusion === "failure") {
            const cohortMatch = job.name.match(/\[(.*?)\]/);
            failedCohorts.push(cohortMatch ? cohortMatch[1] : job.name);
          }
        }
      }
    } catch (err) {
      console.warn("[Watchdog] Could not inspect per-cohort jobs:", err);
    }
  }

  if (failedCohorts.length > 0) {
    await sendAlert(
      env,
      {
        type: "cohort_failed",
        message: `Latest ingestion run #${latestCompleted?.id} had failed cohort(s): ${failedCohorts.join(", ")}`,
        details: { runId: latestCompleted?.id, failedCohorts },
      },
      fetchFn
    );
  }

  // Find latest fully successful run
  const latestSuccessRun = completedRuns.find((r) => r.conclusion === "success");
  let elapsedMinutes = Infinity;

  if (latestSuccessRun) {
    const successTime = new Date(latestSuccessRun.updated_at || latestSuccessRun.created_at).getTime();
    elapsedMinutes = Math.max(0, Math.floor((nowMs - successTime) / 60000));
  }

  // 3. Cadence check: is successful ingestion overdue?
  if (elapsedMinutes > overdueThresholdMinutes) {
    console.log(
      `[Watchdog] Ingestion overdue (${elapsedMinutes}m elapsed since last success, threshold is ${overdueThresholdMinutes}m). Dispatching catch-up on ${branch}...`
    );

    const dispatchUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
    const dispatchPayload = {
      ref: branch,
      inputs: {
        cohort: "both",
        mode: "write-production-expire",
        confirm: "WRITE PRODUCTION AND EXPIRE",
        watchdog: true,
      },
    };

    const dispatchRes = await fetchFn(dispatchUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "carrier-hound-ingest-watchdog",
      },
      body: JSON.stringify(dispatchPayload),
    });

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
        fetchFn
      );
      throw new Error(alertMsg);
    }

    return {
      action: "dispatched",
      overdueMinutes: elapsedMinutes,
      ref: branch,
      cohortsFailed: failedCohorts.length > 0 ? failedCohorts : undefined,
    };
  }

  return {
    action: "none",
    reason: `Ingestion cadence healthy: last success was ${elapsedMinutes}m ago (threshold: ${overdueThresholdMinutes}m).`,
    overdueMinutes: elapsedMinutes,
    cohortsFailed: failedCohorts.length > 0 ? failedCohorts : undefined,
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

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "carrier-hound-ingest-watchdog" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/check") {
      try {
        const result = await checkAndReconcileIngestion(env);
        return new Response(JSON.stringify({ success: true, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ success: false, error: err?.message || String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
