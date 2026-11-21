#!/usr/bin/env node
/**
 * scripts/check-cron-health.cjs
 *
 * Standalone read-only cron-health gate for CareerMonke scheduled workflows.
 * Evaluates the health of every scheduled GitHub Actions workflow in .github/workflows/
 * using the public GitHub API (or custom API base).
 *
 * Requirements enforced per review:
 *   1. Monitors only default-branch schedule runs (event=schedule, branch=main).
 *   2. Keeps event, branch, and SHA in the run evidence.
 *   3. Manual or PR runs do not reset schedule freshness (reported as diagnostics).
 *   4. Inspects job conclusions: a green workflow whose guarded jobs were all skipped
 *      reports FAIL ("All guarded jobs were skipped; no work executed").
 *   5. Fail closed: invalid or future timestamps report FAIL (never ageHours=NaN or age 0).
 *   6. Explicit supported cron parser: hourly (0 * * * *), weekdays (1-5 are daily 24h, not 168h),
 *      inline comments, and unsupported patterns FAIL closed.
 *   7. HTTP robustness: absolute per-request deadline timer covering the full response,
 *      512KB body size cap, stream-abort handling.
 *   8. Token security: never sends GITHUB_TOKEN to http:// or non-GitHub hosts,
 *      and never includes tokens in reports, logs, or error URLs.
 *
 * Usage:
 *   node scripts/check-cron-health.cjs [options]
 *
 * Options:
 *   --repo <owner/repo>       Target GitHub repository (default: ORM-git/Carrier-hound)
 *   --branch <name>           Target default branch (default: main)
 *   --token <token>           GitHub Personal Access Token for rate limits (or GITHUB_TOKEN / GH_TOKEN env)
 *   --json                    Append dated health record to reports/cron-health/cron-health-YYYY-MM-DD.jsonl
 *   --workflows-dir <path>    Path to .github/workflows directory (default: repo root .github/workflows)
 *   --api-base <url>          Base URL for GitHub API (default: https://api.github.com)
 *   --timeout <ms>            Request timeout in ms (default: 8000ms)
 *   --now <isoString>         Override current time for deterministic testing
 *   --help, -h                Show this help message
 *
 * Verdicts:
 *   PASS  - Scheduled run on default branch succeeded, all guarded jobs executed, and fresh within 1.5x interval.
 *   STALE - No scheduled run within 1.5x interval, or zero scheduled runs recorded.
 *   FAIL  - Scheduled run failed/cancelled/timed out, jobs were all skipped, invalid/future timestamp, or unsupported cron.
 *
 * Exit codes:
 *   0 - All scheduled workflows report PASS.
 *   1 - One or more scheduled workflows report FAIL or STALE, or API request failed.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const DEFAULT_REPO = "ORM-git/Carrier-hound";
const DEFAULT_BRANCH = "main";
const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 512 * 1024; // 512 KB
const USER_AGENT = "CareerMonke-CronHealthCheck/1.0 (+https://careermonke.com)";

/**
 * Checks whether an API base URL is a safe, authentic GitHub endpoint.
 * Tokens are ONLY transmitted over https:// to api.github.com or *.github.com.
 */
function isSafeGitHubHost(apiBaseUrl) {
  try {
    const parsed = new URL(apiBaseUrl);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "api.github.com" || host.endsWith(".github.com");
  } catch (_) {
    return false;
  }
}

/**
 * Sanitizes URLs for log and error output to prevent leaking tokens or query params.
 */
function sanitizeUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch (_) {
    return "[invalid-url]";
  }
}

/**
 * Parses command-line arguments into a configuration object.
 */
function parseArgs(argv = process.argv.slice(2)) {
  let repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
  let branch = DEFAULT_BRANCH;
  let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  let writeJson = false;
  let workflowsDir = path.resolve(__dirname, "..", ".github", "workflows");
  let apiBase = DEFAULT_API_BASE;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let now = new Date();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo" && i + 1 < argv.length) {
      repo = argv[++i];
    } else if (arg === "--branch" && i + 1 < argv.length) {
      branch = argv[++i];
    } else if (arg === "--token" && i + 1 < argv.length) {
      token = argv[++i];
    } else if (arg === "--json") {
      writeJson = true;
    } else if (arg === "--workflows-dir" && i + 1 < argv.length) {
      workflowsDir = path.resolve(argv[++i]);
    } else if (arg === "--api-base" && i + 1 < argv.length) {
      apiBase = argv[++i].replace(/\/+$/, "");
    } else if (arg === "--timeout" && i + 1 < argv.length) {
      timeoutMs = parseInt(argv[++i], 10) || DEFAULT_TIMEOUT_MS;
    } else if (arg === "--now" && i + 1 < argv.length) {
      now = new Date(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/check-cron-health.cjs [options]

Options:
  --repo <owner/repo>       Target GitHub repository (default: ${DEFAULT_REPO})
  --branch <name>           Target default branch (default: ${DEFAULT_BRANCH})
  --token <token>           GitHub token for rate limits (optional)
  --json                    Append dated report to reports/cron-health/
  --workflows-dir <path>    Path to .github/workflows
  --api-base <url>          GitHub API base URL
  --timeout <ms>            Request timeout ms (default: ${DEFAULT_TIMEOUT_MS})
  --now <isoDate>           Override current timestamp
  --help, -h                Show usage`);
      process.exit(0);
    }
  }

  return {
    repo,
    branch,
    token,
    writeJson,
    workflowsDir,
    apiBase,
    timeoutMs,
    now,
  };
}

/**
 * Computes recurrence interval in hours from an explicit supported cron pattern.
 * Fails closed: unsupported or malformed expressions throw an Error.
 *
 * Explicitly supported:
 *   - Hourly: 0 * * * * or min * * * * -> 1h
 *   - Sub-hourly step: *\/M * * * * -> M/60 h
 *   - Sub-daily step: min *\/N * * * -> N h
 *   - Comma hours: min 0,6,12,18 * * * -> min spacing in hours
 *   - Daily fixed: min hour * * * -> 24h
 *   - Weekday daily: min hour * * 1-5 or MON-FRI -> 24h (NOT 168h!)
 *   - Weekly single day: min hour * * d (0-7 or SUN-SAT) -> 168h
 */
function parseCronIntervalHours(cronExpr) {
  if (!cronExpr || typeof cronExpr !== "string") {
    throw new Error(`Invalid cron expression: ${cronExpr}`);
  }
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have exactly 5 fields, got ${parts.length}: '${cronExpr}'`);
  }

  const [min, hour, dom, mon, dow] = parts;

  // Validate minute field: number 0-59, or */step, or *
  const isValidMin = min === "*" || /^\*\/\d+$/.test(min) || /^([0-5]?\d)$/.test(min);
  if (!isValidMin) {
    throw new Error(`Unsupported minute field in cron: '${cronExpr}'`);
  }

  // 1. Sub-hourly step or hourly: min * * * *
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    if (min.startsWith("*/")) {
      const step = parseInt(min.slice(2), 10);
      if (step > 0 && step <= 60) return step / 60;
    }
    if (/^[0-5]?\d$/.test(min)) {
      return 1; // Hourly!
    }
  }

  // 2. Sub-daily step: min */N * * *
  if (hour.startsWith("*/") && dom === "*" && mon === "*" && dow === "*") {
    const step = parseInt(hour.slice(2), 10);
    if (step > 0 && step <= 24) return step;
    throw new Error(`Unsupported hour step '${hour}' in cron: '${cronExpr}'`);
  }

  // 3. Comma-separated hours: min h1,h2,... * * *
  if (hour.includes(",") && dom === "*" && mon === "*" && dow === "*") {
    const hours = hour.split(",").map((h) => parseInt(h.trim(), 10));
    if (hours.every((h) => !isNaN(h) && h >= 0 && h <= 23)) {
      hours.sort((a, b) => a - b);
      let minDiff = 24;
      for (let i = 0; i < hours.length; i++) {
        const next = i + 1 < hours.length ? hours[i + 1] : hours[0] + 24;
        const diff = next - hours[i];
        if (diff < minDiff) minDiff = diff;
      }
      return minDiff;
    }
    throw new Error(`Invalid comma-separated hours in cron: '${cronExpr}'`);
  }

  // 4. Weekday daily: min hour * * 1-5 or min hour * * MON-FRI
  const isWeekday = dow === "1-5" || dow.toUpperCase() === "MON-FRI";
  if (isWeekday && dom === "*" && mon === "*" && /^[0-5]?\d$/.test(hour)) {
    return 24; // Daily on weekdays, interval is 24h
  }

  // 5. Weekly: min hour * * d (single day 0-7 or SUN-SAT)
  const isSingleDow = /^[0-7]$/.test(dow) || /^(SUN|MON|TUE|WED|THU|FRI|SAT)$/i.test(dow);
  if (isSingleDow && dom === "*" && mon === "*" && /^[0-5]?\d$/.test(hour)) {
    return 168; // 7 * 24h
  }

  // 6. Daily fixed: min hour * * *
  if (dom === "*" && mon === "*" && dow === "*" && /^[0-5]?\d$/.test(hour)) {
    return 24;
  }

  // Unsupported patterns fail closed; never guess 24h
  throw new Error(`Unsupported cron pattern '${cronExpr}'. Fails closed; unknown interval cannot be safely audited`);
}

/**
 * Extracts all cron expressions from a workflow YAML's schedule block.
 * Correctly handles `schedule: # comment` and multiple `- cron:` entries.
 */
function extractScheduleCrons(yamlContent) {
  const lines = yamlContent.split(/\r?\n/);
  let inSchedule = false;
  let scheduleIndent = -1;
  const crons = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const commentIndex = line.indexOf("#");
    const lineWithoutComment = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
    const trimmed = lineWithoutComment.trim();

    if (!inSchedule) {
      const schedMatch = line.match(/^(\s*)schedule:\s*(?:#.*)?$/);
      if (schedMatch) {
        inSchedule = true;
        scheduleIndent = schedMatch[1].length;
      }
    } else {
      if (trimmed === "") continue;
      const currentIndent = line.search(/\S/);
      if (currentIndent <= scheduleIndent) {
        break;
      }
      const cronMatch = line.match(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/);
      if (cronMatch) {
        crons.push(cronMatch[1].trim());
      }
    }
  }
  return crons;
}

/**
 * Scans the local .github/workflows directory and returns metadata for scheduled workflows.
 */
function scanLocalWorkflows(workflowsDir) {
  if (!fs.existsSync(workflowsDir)) {
    throw new Error(`Workflows directory not found at: ${workflowsDir}`);
  }

  const files = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();

  const scheduled = [];

  for (const file of files) {
    const filePath = path.join(workflowsDir, file);
    const content = fs.readFileSync(filePath, "utf8");

    const crons = extractScheduleCrons(content);
    if (crons.length > 0) {
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      const name = nameMatch ? nameMatch[1].trim().replace(/^['"]|['"]$/g, "") : file;

      let intervalHours = null;
      let thresholdHours = null;
      let cronError = null;

      try {
        const intervals = crons.map((c) => parseCronIntervalHours(c));
        intervalHours = Math.min(...intervals);
        thresholdHours = intervalHours * 1.5;
      } catch (err) {
        cronError = err.message;
      }

      scheduled.push({
        file,
        name,
        crons,
        cron: crons.join(" ; "),
        intervalHours,
        thresholdHours,
        cronError,
      });
    }
  }

  return scheduled;
}

/**
 * Executes an HTTP/HTTPS GET request with absolute timeout, body size cap,
 * stream-abort handling, and strict token leak prevention.
 */
function httpGetJson(urlStr, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      return reject(new Error("Invalid URL"));
    }

    const sanitizedUrl = sanitizeUrl(urlStr);
    const client = parsed.protocol === "http:" ? http : https;

    // Security: Only transmit Authorization headers to verified safe GitHub endpoints over HTTPS
    const effectiveHeaders = {
      "User-Agent": USER_AGENT,
      Accept: "application/vnd.github+json",
      ...headers,
    };
    if (!isSafeGitHubHost(urlStr)) {
      delete effectiveHeaders["Authorization"];
      delete effectiveHeaders["authorization"];
    }

    const reqOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: effectiveHeaders,
    };

    let settled = false;
    let deadlineTimer = null;

    function cleanup() {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        req.destroy();
      } catch (_) {}
      reject(err);
    }

    function succeed(resObj) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(resObj);
    }

    // Absolute deadline timer covering the entire request and response stream
    deadlineTimer = setTimeout(() => {
      fail(new Error(`Request to ${sanitizedUrl} exceeded absolute deadline of ${timeoutMs}ms`));
    }, timeoutMs);

    const req = client.request(reqOptions, (res) => {
      let data = "";
      let receivedBytes = 0;

      res.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_BODY_BYTES) {
          fail(new Error(`Response from ${sanitizedUrl} exceeded body size cap of ${MAX_BODY_BYTES} bytes`));
          return;
        }
        data += chunk;
      });

      res.on("end", () => {
        succeed({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: data,
        });
      });

      res.on("error", (err) => {
        fail(new Error(`Response stream error from ${sanitizedUrl}: ${err.message}`));
      });

      res.on("aborted", () => {
        fail(new Error(`Response stream aborted by server from ${sanitizedUrl}`));
      });
    });

    req.on("error", (err) => {
      fail(new Error(`Network transport error to ${sanitizedUrl}: ${err.message}`));
    });

    req.on("timeout", () => {
      fail(new Error(`Socket timeout to ${sanitizedUrl} after ${timeoutMs}ms`));
    });

    req.end();
  });
}

function handleApiErrors(res, urlStr) {
  const sanitizedUrl = sanitizeUrl(urlStr);
  if (res.statusCode === 401) {
    throw new Error(`GitHub API authentication error (HTTP 401) from ${sanitizedUrl}. Verify token credentials.`);
  }

  if (res.statusCode === 403 || res.statusCode === 429) {
    const isRateLimit =
      res.headers["x-ratelimit-remaining"] === "0" ||
      res.body.includes("API rate limit exceeded") ||
      res.body.includes("rate limit");
    if (isRateLimit) {
      throw new Error(`GitHub API rate limit exceeded on ${sanitizedUrl}. Provide GITHUB_TOKEN or pass --token.`);
    }
    throw new Error(`GitHub API forbidden (HTTP 403) from ${sanitizedUrl}`);
  }

  if (res.statusCode === 404) {
    return; // Caller handles 404
  }

  if (res.statusCode !== 200) {
    throw new Error(`GitHub API error: HTTP ${res.statusCode} from ${sanitizedUrl}`);
  }
}

function parseJsonSafe(body, urlStr) {
  const sanitizedUrl = sanitizeUrl(urlStr);
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`Failed to parse GitHub API JSON response from ${sanitizedUrl}: ${e.message}`);
  }
}

function mapRunObject(r) {
  return {
    id: r.id,
    runNumber: r.run_number,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    event: r.event,
    headBranch: r.head_branch,
    headSha: r.head_sha,
    createdAt: r.created_at,
    runStartedAt: r.run_started_at || r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at || r.updated_at,
    htmlUrl: r.html_url,
  };
}

/**
 * Fetches workflow run data for a workflow:
 *   1. Latest completed schedule run on default branch (evaluates freshness/verdict).
 *   2. Latest overall completed run (diagnostic, manual/PR dispatch does not reset freshness).
 *   3. If scheduled run succeeded, inspects jobs to verify guarded jobs were not skipped.
 */
async function fetchWorkflowRunData(apiBase, repo, workflowFile, defaultBranch, token, timeoutMs) {
  const headers = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // 1. Fetch latest completed schedule run on default branch
  const scheduleUrl = `${apiBase}/repos/${repo}/actions/workflows/${workflowFile}/runs?event=schedule&branch=${encodeURIComponent(defaultBranch)}&status=completed&per_page=1`;
  const scheduleRes = await httpGetJson(scheduleUrl, headers, timeoutMs);
  handleApiErrors(scheduleRes, scheduleUrl);

  let scheduleRun = null;
  if (scheduleRes.statusCode === 200) {
    const json = parseJsonSafe(scheduleRes.body, scheduleUrl);
    if (json.workflow_runs && Array.isArray(json.workflow_runs) && json.workflow_runs.length > 0) {
      scheduleRun = mapRunObject(json.workflow_runs[0]);
    }
  }

  // 2. Fetch latest overall completed run (diagnostic)
  const overallUrl = `${apiBase}/repos/${repo}/actions/workflows/${workflowFile}/runs?status=completed&per_page=1`;
  let diagnosticLatestRun = null;
  try {
    const overallRes = await httpGetJson(overallUrl, headers, timeoutMs);
    if (overallRes.statusCode === 200) {
      const overallJson = parseJsonSafe(overallRes.body, overallUrl);
      if (overallJson.workflow_runs && Array.isArray(overallJson.workflow_runs) && overallJson.workflow_runs.length > 0) {
        const latestOverall = mapRunObject(overallJson.workflow_runs[0]);
        if (!scheduleRun || latestOverall.id !== scheduleRun.id || latestOverall.event !== "schedule" || latestOverall.headBranch !== defaultBranch) {
          diagnosticLatestRun = latestOverall;
        }
      }
    }
  } catch (_) {
    // Diagnostic query failure is non-fatal
  }

  // 3. Inspect jobs if scheduleRun is present and reported success
  let jobsData = null;
  if (scheduleRun && scheduleRun.conclusion === "success") {
    const jobsUrl = `${apiBase}/repos/${repo}/actions/runs/${scheduleRun.id}/jobs?per_page=100`;
    const jobsRes = await httpGetJson(jobsUrl, headers, timeoutMs);
    handleApiErrors(jobsRes, jobsUrl);
    if (jobsRes.statusCode === 200) {
      const jobsJson = parseJsonSafe(jobsRes.body, jobsUrl);
      const jobs = Array.isArray(jobsJson.jobs) ? jobsJson.jobs : [];
      const totalJobs = jobs.length;
      const skippedJobs = jobs.filter((j) => j.conclusion === "skipped");
      const failedJob = jobs.find((j) => j.conclusion !== "success" && j.conclusion !== "skipped");
      const allSkipped = totalJobs > 0 && skippedJobs.length === totalJobs;

      jobsData = {
        totalJobs,
        jobNames: jobs.map((j) => j.name),
        allSkipped,
        failedJob: failedJob ? { id: failedJob.id, name: failedJob.name, conclusion: failedJob.conclusion } : null,
      };
    }
  }

  return {
    scheduleRun,
    diagnosticLatestRun,
    jobsData,
  };
}

/**
 * Computes verdict (PASS, STALE, or FAIL) for a workflow based on scheduled run and threshold.
 * Enforces:
 *   - Fail closed on unsupported cron.
 *   - Fail closed on missing/invalid/future timestamps (never ageHours=NaN or age 0).
 *   - Fail closed when all guarded jobs were skipped.
 *   - Fail closed when any job failed.
 *   - Fail closed when workflow run concluded non-success.
 *   - STALE when age > 1.5x interval or zero runs recorded.
 */
function computeVerdict(workflowMeta, scheduleRun, jobsData, now = new Date()) {
  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();

  // 1. Cron parsing failure fails closed
  if (workflowMeta.cronError) {
    return {
      verdict: "FAIL",
      ageHours: null,
      timestampField: "none",
      detail: `Unsupported or invalid cron pattern '${workflowMeta.cron}'. Fails closed: ${workflowMeta.cronError}`,
    };
  }

  // 2. Zero completed scheduled runs on default branch
  if (!scheduleRun) {
    return {
      verdict: "STALE",
      ageHours: null,
      timestampField: "none",
      detail: `No completed schedule runs recorded on default branch`,
    };
  }

  // 3. Timestamps validation (fail closed)
  const timestampField = scheduleRun.completedAt
    ? "completed_at"
    : scheduleRun.updatedAt
    ? "updated_at (completed)"
    : "run_started_at (started)";
  const timestampStr = scheduleRun.completedAt || scheduleRun.updatedAt || scheduleRun.runStartedAt;

  if (!timestampStr) {
    return {
      verdict: "FAIL",
      ageHours: null,
      timestampField: "none",
      detail: `Missing run timestamp in scheduled run #${scheduleRun.runNumber}`,
    };
  }

  const runTime = Date.parse(timestampStr);
  if (isNaN(runTime)) {
    return {
      verdict: "FAIL",
      ageHours: null,
      timestampField,
      detail: `Invalid timestamp format '${timestampStr}' in scheduled run #${scheduleRun.runNumber} (fails closed; age is undefined)`,
    };
  }

  if (isNaN(currentTime)) {
    return {
      verdict: "FAIL",
      ageHours: null,
      timestampField,
      detail: `Invalid evaluation time '${now}' (fails closed)`,
    };
  }

  const diffMs = currentTime - runTime;
  // Clock skew allowance: 60 seconds
  if (diffMs < -60000) {
    return {
      verdict: "FAIL",
      ageHours: null,
      timestampField,
      detail: `Future timestamp detected: scheduled run #${scheduleRun.runNumber} timestamp (${timestampStr}) is in the future relative to evaluation time (${new Date(currentTime).toISOString()})`,
    };
  }

  const ageHours = Math.max(0, diffMs / (1000 * 60 * 60));

  // 4. Job conclusion inspection: a green workflow whose guarded jobs were all skipped must not count as PASS
  if (jobsData && jobsData.allSkipped) {
    return {
      verdict: "FAIL",
      ageHours,
      timestampField,
      detail: `All guarded jobs were skipped (${jobsData.jobNames.join(", ")}); no work executed in scheduled run #${scheduleRun.runNumber}`,
    };
  }

  if (jobsData && jobsData.failedJob) {
    return {
      verdict: "FAIL",
      ageHours,
      timestampField,
      detail: `Guarded job '${jobsData.failedJob.name}' concluded with '${jobsData.failedJob.conclusion}' in scheduled run #${scheduleRun.runNumber}`,
    };
  }

  // 5. Workflow run conclusion
  if (scheduleRun.conclusion !== "success") {
    return {
      verdict: "FAIL",
      ageHours,
      timestampField,
      detail: `Latest scheduled run #${scheduleRun.runNumber} concluded with '${scheduleRun.conclusion}' at ${timestampStr} (event=${scheduleRun.event}, branch=${scheduleRun.headBranch || "main"}, sha=${(scheduleRun.headSha || "").slice(0, 8)})`,
    };
  }

  // 6. Freshness check against 1.5x interval
  if (ageHours > workflowMeta.thresholdHours) {
    return {
      verdict: "STALE",
      ageHours,
      timestampField,
      detail: `Scheduled run #${scheduleRun.runNumber} was green but completed ${ageHours.toFixed(1)}h ago (exceeds 1.5x threshold of ${workflowMeta.thresholdHours.toFixed(1)}h; timestamp=${timestampField})`,
    };
  }

  return {
    verdict: "PASS",
    ageHours,
    timestampField,
    detail: `Scheduled run #${scheduleRun.runNumber} succeeded ${ageHours.toFixed(1)}h ago (fresh within 1.5x threshold of ${workflowMeta.thresholdHours.toFixed(1)}h; ${jobsData ? jobsData.totalJobs + ' jobs' : 'verified'}; timestamp=${timestampField})`,
  };
}

/**
 * Appends a dated JSON Lines record to reports/cron-health/cron-health-YYYY-MM-DD.jsonl.
 */
function writeJsonReport(repo, results, passedAll, now = new Date()) {
  const reportsDir = path.resolve(__dirname, "..", "reports", "cron-health");
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const dateStr = now.toISOString().slice(0, 10);
  const filePath = path.join(reportsDir, `cron-health-${dateStr}.jsonl`);

  const reportData = {
    timestamp: now.toISOString(),
    repo,
    passedAll,
    totalCount: results.length,
    passCount: results.filter((r) => r.verdict === "PASS").length,
    staleCount: results.filter((r) => r.verdict === "STALE").length,
    failCount: results.filter((r) => r.verdict === "FAIL").length,
    workflows: results.map((r) => ({
      file: r.file,
      name: r.name,
      crons: r.crons,
      cron: r.cron,
      intervalHours: r.intervalHours,
      thresholdHours: r.thresholdHours,
      verdict: r.verdict,
      ageHours: r.ageHours != null ? parseFloat(r.ageHours.toFixed(2)) : null,
      timestampField: r.timestampField,
      scheduleRun: r.scheduleRun
        ? {
            id: r.scheduleRun.id,
            runNumber: r.scheduleRun.runNumber,
            conclusion: r.scheduleRun.conclusion,
            status: r.scheduleRun.status,
            event: r.scheduleRun.event,
            headBranch: r.scheduleRun.headBranch,
            headSha: r.scheduleRun.headSha,
            createdAt: r.scheduleRun.createdAt,
            runStartedAt: r.scheduleRun.runStartedAt,
            updatedAt: r.scheduleRun.updatedAt,
            htmlUrl: r.scheduleRun.htmlUrl,
          }
        : null,
      diagnosticLatestRun: r.diagnosticLatestRun
        ? {
            id: r.diagnosticLatestRun.id,
            runNumber: r.diagnosticLatestRun.runNumber,
            conclusion: r.diagnosticLatestRun.conclusion,
            status: r.diagnosticLatestRun.status,
            event: r.diagnosticLatestRun.event,
            headBranch: r.diagnosticLatestRun.headBranch,
            headSha: r.diagnosticLatestRun.headSha,
            createdAt: r.diagnosticLatestRun.createdAt,
            htmlUrl: r.diagnosticLatestRun.htmlUrl,
          }
        : null,
      detail: r.detail,
    })),
  };

  fs.appendFileSync(filePath, JSON.stringify(reportData) + "\n", "utf8");
  return filePath;
}

/**
 * Main evaluation orchestrator.
 */
async function checkCronHealth(options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const branch = options.branch || DEFAULT_BRANCH;
  const token = options.token || null;
  const writeJson = options.writeJson || false;
  const workflowsDir = options.workflowsDir || path.resolve(__dirname, "..", ".github", "workflows");
  const apiBase = (options.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());

  const workflows = scanLocalWorkflows(workflowsDir);
  const results = [];

  for (const wf of workflows) {
    if (wf.cronError) {
      const evaluation = computeVerdict(wf, null, null, now);
      results.push({
        ...wf,
        scheduleRun: null,
        diagnosticLatestRun: null,
        verdict: evaluation.verdict,
        ageHours: evaluation.ageHours,
        timestampField: evaluation.timestampField,
        detail: evaluation.detail,
      });
      continue;
    }

    try {
      const { scheduleRun, diagnosticLatestRun, jobsData } = await fetchWorkflowRunData(
        apiBase,
        repo,
        wf.file,
        branch,
        token,
        timeoutMs
      );
      const evaluation = computeVerdict(wf, scheduleRun, jobsData, now);

      results.push({
        ...wf,
        scheduleRun,
        diagnosticLatestRun,
        jobsData,
        verdict: evaluation.verdict,
        ageHours: evaluation.ageHours,
        timestampField: evaluation.timestampField,
        detail: evaluation.detail,
      });
    } catch (err) {
      results.push({
        ...wf,
        scheduleRun: null,
        diagnosticLatestRun: null,
        verdict: "FAIL",
        ageHours: null,
        timestampField: "none",
        detail: `Error querying workflow runs: ${err.message}`,
        error: err.message,
      });
    }
  }

  const passCount = results.filter((r) => r.verdict === "PASS").length;
  const staleCount = results.filter((r) => r.verdict === "STALE").length;
  const failCount = results.filter((r) => r.verdict === "FAIL").length;
  const passedAll = results.length > 0 && passCount === results.length;

  return {
    repo,
    branch,
    now,
    workflows: results,
    totalCount: results.length,
    passCount,
    staleCount,
    failCount,
    passedAll,
    writeJsonReport: () => writeJsonReport(repo, results, passedAll, now),
  };
}

async function main() {
  const config = parseArgs();

  console.log("================================================================================");
  console.log("     CAREERMONKE SCHEDULED WORKFLOW CRON-HEALTH GATE (STANDALONE READ-ONLY)    ");
  console.log("================================================================================");
  console.log(`Target Repository: ${config.repo}`);
  console.log(`Default Branch:    ${config.branch}`);
  console.log(`Workflows Path:    ${config.workflowsDir}`);
  console.log(`Evaluation Time:   ${config.now.toISOString()}`);
  console.log(`Authentication:    ${config.token ? "Authenticated (Token present)" : "Unauthenticated (Public API)"}`);
  console.log("--------------------------------------------------------------------------------\n");

  let checkResult;
  try {
    checkResult = await checkCronHealth(config);
  } catch (err) {
    console.error(`FATAL: Failed to evaluate cron health: ${err.message}`);
    process.exit(1);
  }

  const { workflows, passCount, staleCount, failCount, passedAll } = checkResult;

  for (const r of workflows) {
    const badge = `[${r.verdict}]`.padEnd(7);
    const fileName = r.file.padEnd(28);
    const schedule = `${r.cron} (${r.intervalHours}h, cap ${r.thresholdHours}h)`.padEnd(28);
    const conclusion = r.scheduleRun ? r.scheduleRun.conclusion : "none";
    const age = r.ageHours != null ? `${r.ageHours.toFixed(1)}h ago`.padStart(10) : "no runs".padStart(10);

    console.log(`${badge} ${fileName} ${schedule} | Run: ${conclusion.padEnd(9)} (${age})`);
    console.log(`        -> ${r.detail}`);
    if (r.scheduleRun) {
      console.log(`        -> Scheduled Run: #${r.scheduleRun.runNumber} | Event: ${r.scheduleRun.event} | Branch: ${r.scheduleRun.headBranch || config.branch} | SHA: ${(r.scheduleRun.headSha || "").slice(0, 8)}`);
      if (r.scheduleRun.htmlUrl) {
        console.log(`        -> URL: ${r.scheduleRun.htmlUrl}`);
      }
    }
    if (r.diagnosticLatestRun) {
      console.log(`        [Diagnostic] Latest overall run was #${r.diagnosticLatestRun.runNumber} (${r.diagnosticLatestRun.event} on ${r.diagnosticLatestRun.headBranch || "unknown"}, concluded '${r.diagnosticLatestRun.conclusion}' at ${r.diagnosticLatestRun.createdAt}) — does NOT reset schedule freshness.`);
    }
    console.log("");
  }

  console.log("--------------------------------------------------------------------------------");
  console.log(`SUMMARY: ${passCount}/${workflows.length} PASS | ${staleCount} STALE | ${failCount} FAIL`);
  console.log("--------------------------------------------------------------------------------");

  if (config.writeJson) {
    const reportFile = checkResult.writeJsonReport();
    console.log(`Dated launch-week record written to: ${reportFile}`);
  }

  if (passedAll) {
    console.log("\n================================================================================");
    console.log("VERDICT: PASS (All scheduled cron workflows are green and fresh on default branch)");
    console.log("================================================================================");
    process.exit(0);
  } else {
    console.log("\n================================================================================");
    console.log("VERDICT: FAIL (One or more scheduled workflows are failing, skipped, or stale)");
    console.log("================================================================================");
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("FATAL: Unexpected execution failure:", err);
    process.exit(1);
  });
}

module.exports = {
  parseCronIntervalHours,
  extractScheduleCrons,
  scanLocalWorkflows,
  fetchWorkflowRunData,
  computeVerdict,
  checkCronHealth,
  writeJsonReport,
  httpGetJson,
  isSafeGitHubHost,
  DEFAULT_REPO,
  DEFAULT_BRANCH,
  DEFAULT_TIMEOUT_MS,
};
