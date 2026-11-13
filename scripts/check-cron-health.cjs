#!/usr/bin/env node
/**
 * scripts/check-cron-health.cjs
 *
 * Standalone read-only cron-health gate for CareerMonke scheduled workflows.
 * Evaluates the health of every scheduled GitHub Actions workflow in .github/workflows/
 * using the public GitHub API (or custom API base).
 *
 * Usage:
 *   node scripts/check-cron-health.cjs [options]
 *
 * Options:
 *   --repo <owner/repo>       Target GitHub repository (default: ORM-git/Carrier-hound)
 *   --token <token>           GitHub Personal Access Token for rate limits (or GITHUB_TOKEN / GH_TOKEN env)
 *   --json                    Append dated health record to reports/cron-health/cron-health-YYYY-MM-DD.jsonl
 *   --workflows-dir <path>    Path to .github/workflows directory (default: repo root .github/workflows)
 *   --api-base <url>          Base URL for GitHub API (default: https://api.github.com)
 *   --timeout <ms>            Request timeout in ms (default: 8000ms)
 *   --now <isoString>         Override current time for deterministic testing
 *   --help, -h                Show this help message
 *
 * Verdicts:
 *   PASS  - Latest completed run succeeded and completed within 1.5x the workflow interval.
 *   STALE - No run completed within 1.5x interval, or zero runs recorded.
 *   FAIL  - Latest completed run failed, was cancelled, timed out, or skipped.
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
const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 8000;
const USER_AGENT = "CareerMonke-CronHealthCheck/1.0 (+https://careermonke.com)";

/**
 * Parses command-line arguments into a configuration object.
 */
function parseArgs(argv = process.argv.slice(2)) {
  let repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
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
    token,
    writeJson,
    workflowsDir,
    apiBase,
    timeoutMs,
    now,
  };
}

/**
 * Computes the recurrence interval in hours from a standard cron expression.
 */
function parseCronIntervalHours(cronExpr) {
  if (!cronExpr) return 24;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return 24;

  const [min, hour, dom, mon, dow] = parts;

  // Weekly runs: explicit day of week (e.g. 0, 1, 7, SUN, MON) and wild dom
  if (dow !== "*" && dom === "*") {
    return 168; // 7 days * 24 hours
  }

  // Monthly / multi-day runs
  if (dom !== "*") {
    if (dom.startsWith("*/")) {
      const step = parseInt(dom.slice(2), 10);
      if (step > 0) return step * 24;
    }
    return 24 * 30; // approx monthly
  }

  // Sub-daily runs: hour with step (e.g. */4)
  if (hour.startsWith("*/")) {
    const step = parseInt(hour.slice(2), 10);
    if (step > 0) return step;
  }

  // Comma-separated hours: e.g. 0,6,12,18
  if (hour.includes(",")) {
    const hours = hour
      .split(",")
      .map((h) => parseInt(h.trim(), 10))
      .filter((h) => !isNaN(h));
    if (hours.length > 1) {
      return 24 / hours.length;
    }
  }

  // Daily fixed run: specific hour and minute
  if (hour !== "*" && dom === "*" && dow === "*") {
    return 24;
  }

  // Sub-hourly runs: minute with step (e.g. */30)
  if (hour === "*" && min.startsWith("*/")) {
    const step = parseInt(min.slice(2), 10);
    if (step > 0) return step / 60;
  }

  return 24; // Default baseline
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

    // Check if workflow declares schedule:
    if (/schedule:\s*$/m.test(content) || /schedule:\s*\[/.test(content)) {
      // Extract workflow name
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      const name = nameMatch ? nameMatch[1].trim().replace(/^['"]|['"]$/g, "") : file;

      // Extract cron expression
      const cronMatch = content.match(/cron:\s*['"]([^'"]+)['"]/);
      const cron = cronMatch ? cronMatch[1].trim() : null;

      if (cron) {
        const intervalHours = parseCronIntervalHours(cron);
        const thresholdHours = intervalHours * 1.5;

        scheduled.push({
          file,
          name,
          cron,
          intervalHours,
          thresholdHours,
        });
      }
    }
  }

  return scheduled;
}

/**
 * Executes a polite HTTP/HTTPS GET request with timeout and error handling.
 */
function httpGetJson(urlStr, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${urlStr}`));
    }

    const client = parsed.protocol === "http:" ? http : https;
    const reqOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/vnd.github+json",
        ...headers,
      },
      timeout: timeoutMs,
    };

    const req = client.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: data,
        });
      });

      res.on("error", (err) => {
        reject(new Error(`Response stream error: ${err.message}`));
      });
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on("error", (err) => {
      reject(new Error(`Network transport error: ${err.message}`));
    });

    req.end();
  });
}

/**
 * Fetches the latest completed workflow run for a given workflow file from GitHub Actions API.
 */
async function fetchLatestCompletedRun(apiBase, repo, workflowFile, token, timeoutMs) {
  const url = `${apiBase}/repos/${repo}/actions/workflows/${workflowFile}/runs?status=completed&per_page=1`;
  const headers = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await httpGetJson(url, headers, timeoutMs);

  // Rate limit detection
  if (res.statusCode === 403 || res.statusCode === 429) {
    const isRateLimit =
      res.headers["x-ratelimit-remaining"] === "0" ||
      res.body.includes("API rate limit exceeded") ||
      res.body.includes("rate limit");
    if (isRateLimit) {
      throw new Error(
        `GitHub API rate limit exceeded. Set GITHUB_TOKEN or pass --token <token> for higher limits. Status ${res.statusCode}`
      );
    }
  }

  // Not found (e.g. workflow never triggered or invalid repo)
  if (res.statusCode === 404) {
    return null;
  }

  if (res.statusCode !== 200) {
    throw new Error(
      `GitHub API error: HTTP ${res.statusCode} from ${url} (${res.body.slice(0, 150)})`
    );
  }

  let json;
  try {
    json = JSON.parse(res.body);
  } catch (e) {
    throw new Error(`Failed to parse GitHub API response JSON from ${url}: ${e.message}`);
  }

  if (json.workflow_runs && Array.isArray(json.workflow_runs) && json.workflow_runs.length > 0) {
    const r = json.workflow_runs[0];
    return {
      id: r.id,
      runNumber: r.run_number,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      createdAt: r.created_at,
      runStartedAt: r.run_started_at || r.created_at,
      updatedAt: r.updated_at,
      event: r.event,
      htmlUrl: r.html_url,
    };
  }

  return null;
}

/**
 * Computes verdict (PASS, STALE, or FAIL) for a workflow based on latest run and interval.
 */
function computeVerdict(latestRun, intervalHours, thresholdHours, now = new Date()) {
  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();

  if (!latestRun) {
    return {
      verdict: "STALE",
      ageHours: null,
      detail: "No completed runs recorded in repository",
    };
  }

  const runTime = new Date(latestRun.runStartedAt || latestRun.createdAt).getTime();
  const ageHours = Math.max(0, (currentTime - runTime) / (1000 * 60 * 60));

  // If the latest completed run did not succeed, verdict is FAIL
  if (latestRun.conclusion !== "success") {
    return {
      verdict: "FAIL",
      ageHours,
      detail: `Latest run #${latestRun.runNumber} concluded with '${latestRun.conclusion}' at ${latestRun.createdAt}`,
    };
  }

  // If the run succeeded but is older than 1.5x interval, verdict is STALE
  if (ageHours > thresholdHours) {
    return {
      verdict: "STALE",
      ageHours,
      detail: `Latest run #${latestRun.runNumber} was green but completed ${ageHours.toFixed(1)}h ago (exceeds 1.5x threshold of ${thresholdHours.toFixed(1)}h)`,
    };
  }

  // Green and fresh within 1.5x interval
  return {
    verdict: "PASS",
    ageHours,
    detail: `Latest run #${latestRun.runNumber} succeeded ${ageHours.toFixed(1)}h ago (fresh within 1.5x threshold of ${thresholdHours.toFixed(1)}h)`,
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
      cron: r.cron,
      intervalHours: r.intervalHours,
      thresholdHours: r.thresholdHours,
      verdict: r.verdict,
      ageHours: r.ageHours != null ? parseFloat(r.ageHours.toFixed(2)) : null,
      latestRun: r.latestRun
        ? {
            id: r.latestRun.id,
            runNumber: r.latestRun.runNumber,
            conclusion: r.latestRun.conclusion,
            status: r.latestRun.status,
            event: r.latestRun.event,
            createdAt: r.latestRun.createdAt,
            htmlUrl: r.latestRun.htmlUrl,
          }
        : null,
      detail: r.detail,
    })),
  };

  fs.appendFileSync(filePath, JSON.stringify(reportData) + "\n", "utf8");
  return filePath;
}

/**
 * Main execution function.
 */
async function checkCronHealth(options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const token = options.token || null;
  const writeJson = options.writeJson || false;
  const workflowsDir = options.workflowsDir || path.resolve(__dirname, "..", ".github", "workflows");
  const apiBase = (options.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());

  const workflows = scanLocalWorkflows(workflowsDir);
  const results = [];

  for (const wf of workflows) {
    try {
      const latestRun = await fetchLatestCompletedRun(apiBase, repo, wf.file, token, timeoutMs);
      const evaluation = computeVerdict(latestRun, wf.intervalHours, wf.thresholdHours, now);

      results.push({
        ...wf,
        latestRun,
        verdict: evaluation.verdict,
        ageHours: evaluation.ageHours,
        detail: evaluation.detail,
      });
    } catch (err) {
      results.push({
        ...wf,
        latestRun: null,
        verdict: "FAIL",
        ageHours: null,
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

  // Print results table
  for (const r of workflows) {
    const badge = `[${r.verdict}]`.padEnd(7);
    const fileName = r.file.padEnd(30);
    const schedule = `${r.cron} (${r.intervalHours}h, cap ${r.thresholdHours}h)`.padEnd(28);
    const conclusion = r.latestRun ? r.latestRun.conclusion : "none";
    const age = r.ageHours != null ? `${r.ageHours.toFixed(1)}h ago`.padStart(10) : "no runs".padStart(10);

    console.log(`${badge} ${fileName} ${schedule} | Run: ${conclusion.padEnd(9)} (${age})`);
    console.log(`        -> ${r.detail}`);
    if (r.latestRun && r.latestRun.htmlUrl) {
      console.log(`        -> URL: ${r.latestRun.htmlUrl}`);
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
    console.log("VERDICT: PASS (All scheduled cron workflows are green and fresh within 1.5x interval)");
    console.log("================================================================================");
    process.exit(0);
  } else {
    console.log("\n================================================================================");
    console.log("VERDICT: FAIL (One or more scheduled workflows are failing or stale)");
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
  scanLocalWorkflows,
  fetchLatestCompletedRun,
  computeVerdict,
  checkCronHealth,
  writeJsonReport,
  DEFAULT_REPO,
  DEFAULT_TIMEOUT_MS,
};
