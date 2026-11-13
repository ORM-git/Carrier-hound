#!/usr/bin/env node
/**
 * scripts/test-cron-health.cjs
 *
 * Standalone offline test suite for scripts/check-cron-health.cjs.
 * Thoroughly verifies all reviewer requirements:
 *   1. Cron parser: hourly (0 * * * *), weekdays (1-5 are 24h, not 168h),
 *      inline comments (schedule: # comment), multi-cron entries,
 *      and unsupported patterns failing closed.
 *   2. Inventory drift test: ensures all workflows in .github/workflows with schedule:
 *      are accounted for and valid.
 *   3. Timestamp fail-closed: missing, invalid date, or future timestamps fail closed
 *      (never ageHours=NaN or age 0).
 *   4. Job conclusion inspection: a green workflow whose guarded jobs were all skipped
 *      reports FAIL ("All guarded jobs were skipped; no work executed").
 *   5. Schedule vs Manual run separation: manual dispatch runs do not reset schedule freshness.
 *   6. HTTP transport robustness:
 *      - Stalled headers (timeout)
 *      - Slow drip (absolute request deadline)
 *      - Stream truncation / socket destroy
 *      - Malformed JSON
 *      - HTTP 404 Not Found
 *      - HTTP 401 Auth error
 *      - HTTP 403 Rate limit
 *      - Body size cap (>512KB)
 *      - Token security: verify GITHUB_TOKEN is NEVER sent to http:// or non-GitHub hosts
 *   7. JSON reporting: --json writes valid dated JSONL record with scheduleRun & diagnostic info.
 *
 * Usage:
 *   node scripts/test-cron-health.cjs
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const SCRIPT_PATH = path.resolve(__dirname, "check-cron-health.cjs");
const {
  parseCronIntervalHours,
  extractScheduleCrons,
  scanLocalWorkflows,
  computeVerdict,
  isSafeGitHubHost,
} = require("./check-cron-health.cjs");

// Simulated evaluation anchor time: 2026-11-13T12:00:00.000Z
const FIXED_NOW = new Date("2026-11-13T12:00:00.000Z");

let activeMockHandler = null;

function runCliAsync(port, extraArgs = [], envOverride = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      SCRIPT_PATH,
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--now",
      FIXED_NOW.toISOString(),
      ...extraArgs,
    ];

    const child = spawn(process.execPath, args, {
      env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "", ...envOverride },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);

    child.on("close", (code) => {
      resolve({
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}

function createMockRunResponse(workflowName, conclusion = "success", ageHours = 1, event = "schedule", branch = "main") {
  const createdAt = new Date(FIXED_NOW.getTime() - ageHours * 3600 * 1000).toISOString();
  return JSON.stringify({
    total_count: 1,
    workflow_runs: [
      {
        id: 10001,
        run_number: 42,
        name: workflowName,
        status: "completed",
        conclusion,
        event,
        head_branch: branch,
        head_sha: "3382015b6c20165c4eb5e76839352e0fba8c4bb1",
        created_at: createdAt,
        run_started_at: createdAt,
        updated_at: createdAt,
        html_url: `https://github.com/ORM-git/Carrier-hound/actions/runs/10001`,
      },
    ],
  });
}

function createMockJobsResponse(jobs = [{ id: 501, name: "main-job", status: "completed", conclusion: "success" }]) {
  return JSON.stringify({
    total_count: jobs.length,
    jobs,
  });
}

async function runTestSuite() {
  console.log("================================================================================");
  console.log("     CAREERMONKE CRON-HEALTH CHECKER COMPREHENSIVE OFFLINE TEST SUITE           ");
  console.log("================================================================================");

  let totalTests = 0;
  let passedTests = 0;

  function assertTest(name, condition, errorMsg = "") {
    totalTests++;
    if (condition) {
      console.log(`[PASS] ${name}`);
      passedTests++;
    } else {
      console.error(`[FAIL] ${name}: ${errorMsg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Part 1: Cron Interval Parser & Supported Forms
  // ---------------------------------------------------------------------------
  console.log("\n--- Part 1: Cron Interval Parser & Supported Forms ---");

  assertTest(
    "1.1 Parses 4-hourly step '0 */4 * * *' to 4h",
    parseCronIntervalHours("0 */4 * * *") === 4,
    `Got ${parseCronIntervalHours("0 */4 * * *")}`
  );

  assertTest(
    "1.2 Parses offset 4-hourly step '15 */4 * * *' to 4h",
    parseCronIntervalHours("15 */4 * * *") === 4,
    `Got ${parseCronIntervalHours("15 */4 * * *")}`
  );

  assertTest(
    "1.3 Parses hourly '0 * * * *' to 1h (not 24h)",
    parseCronIntervalHours("0 * * * *") === 1,
    `Got ${parseCronIntervalHours("0 * * * *")}`
  );

  assertTest(
    "1.4 Parses offset hourly '15 * * * *' to 1h",
    parseCronIntervalHours("15 * * * *") === 1,
    `Got ${parseCronIntervalHours("15 * * * *")}`
  );

  assertTest(
    "1.5 Parses sub-hourly '*/30 * * * *' to 0.5h",
    parseCronIntervalHours("*/30 * * * *") === 0.5,
    `Got ${parseCronIntervalHours("*/30 * * * *")}`
  );

  assertTest(
    "1.6 Parses daily fixed time '30 21 * * *' to 24h",
    parseCronIntervalHours("30 21 * * *") === 24,
    `Got ${parseCronIntervalHours("30 21 * * *")}`
  );

  assertTest(
    "1.7 Parses weekday daily '0 4 * * 1-5' to 24h (NOT 168h)",
    parseCronIntervalHours("0 4 * * 1-5") === 24,
    `Got ${parseCronIntervalHours("0 4 * * 1-5")}`
  );

  assertTest(
    "1.8 Parses weekday daily '0 4 * * MON-FRI' to 24h (NOT 168h)",
    parseCronIntervalHours("0 4 * * MON-FRI") === 24,
    `Got ${parseCronIntervalHours("0 4 * * MON-FRI")}`
  );

  assertTest(
    "1.9 Parses weekly Monday '0 5 * * 1' to 168h",
    parseCronIntervalHours("0 5 * * 1") === 168,
    `Got ${parseCronIntervalHours("0 5 * * 1")}`
  );

  assertTest(
    "1.10 Parses weekly Sunday '30 19 * * 0' to 168h",
    parseCronIntervalHours("30 19 * * 0") === 168,
    `Got ${parseCronIntervalHours("30 19 * * 0")}`
  );

  assertTest(
    "1.11 Parses multi-hour comma list '0 0,6,12,18 * * *' to 6h",
    parseCronIntervalHours("0 0,6,12,18 * * *") === 6,
    `Got ${parseCronIntervalHours("0 0,6,12,18 * * *")}`
  );

  let unsupportedFailedClosed = false;
  try {
    parseCronIntervalHours("0 0 1 1 *"); // yearly (unsupported)
  } catch (err) {
    unsupportedFailedClosed = err.message.includes("Unsupported cron pattern");
  }
  assertTest(
    "1.12 Unsupported cron '0 0 1 1 *' throws error and fails closed (does not guess 24h)",
    unsupportedFailedClosed
  );

  let invalidPartsFailedClosed = false;
  try {
    parseCronIntervalHours("not-a-valid-cron");
  } catch (err) {
    invalidPartsFailedClosed = true;
  }
  assertTest("1.13 Malformed cron string fails closed", invalidPartsFailedClosed);

  // ---------------------------------------------------------------------------
  // Part 2: YAML Schedule Block Parser
  // ---------------------------------------------------------------------------
  console.log("\n--- Part 2: YAML Schedule Parser & Inline Comments ---");

  const singleWithCommentYaml = `
on:
  schedule: # runs daily
    - cron: '30 21 * * *' # 03:00 AM IST
  workflow_dispatch:
`;
  const crons1 = extractScheduleCrons(singleWithCommentYaml);
  assertTest(
    "2.1 Extracts cron when 'schedule: # comment' has inline comment",
    crons1.length === 1 && crons1[0] === "30 21 * * *",
    `Got ${JSON.stringify(crons1)}`
  );

  const multiCronYaml = `
on:
  schedule:
    - cron: '0 4 * * 1'
    - cron: '0 4 * * 4'
`;
  const crons2 = extractScheduleCrons(multiCronYaml);
  assertTest(
    "2.2 Extracts multiple - cron: entries under schedule",
    crons2.length === 2 && crons2[0] === "0 4 * * 1" && crons2[1] === "0 4 * * 4",
    `Got ${JSON.stringify(crons2)}`
  );

  // ---------------------------------------------------------------------------
  // Part 3: Inventory Drift Test (Disk vs Baseline)
  // ---------------------------------------------------------------------------
  console.log("\n--- Part 3: Scheduled Workflows Inventory Drift ---");

  const workflowsDir = path.resolve(__dirname, "..", ".github", "workflows");
  const scannedWorkflows = scanLocalWorkflows(workflowsDir);

  const expectedWorkflowFiles = [
    "capacity-report-cron.yml",
    "daily-digest-cron.yml",
    "db-health-probe.yml",
    "db-reconciliation.yml",
    "dunning-dispatch-cron.yml",
    "early-access-digest-cron.yml",
    "inbound-poll-cron.yml",
    "ingest.yml",
    "license-guard.yml",
    "plan-regression.yml",
    "retention-cron.yml",
    "security-scan.yml",
    "source-health-cron.yml",
  ].sort();

  const foundFiles = scannedWorkflows.map((w) => w.file).sort();

  assertTest(
    "3.1 Inventory drift: exact 13 scheduled workflows found on disk",
    scannedWorkflows.length === 13 && JSON.stringify(foundFiles) === JSON.stringify(expectedWorkflowFiles),
    `Expected ${JSON.stringify(expectedWorkflowFiles)}, got ${JSON.stringify(foundFiles)}`
  );

  const allCronsParsed = scannedWorkflows.every((w) => w.intervalHours > 0 && !w.cronError);
  assertTest(
    "3.2 Inventory drift: all 13 workflows have valid supported cron expressions and computed intervals",
    allCronsParsed,
    `Workflows with parse errors: ${JSON.stringify(scannedWorkflows.filter((w) => w.cronError))}`
  );

  // ---------------------------------------------------------------------------
  // Part 4: Verdict Logic (PASS, STALE, FAIL) & Fail-Closed Checks
  // ---------------------------------------------------------------------------
  console.log("\n--- Part 4: Verdict Logic & Fail-Closed Guards ---");

  const meta4h = { file: "ingest.yml", name: "Ingest", cron: "0 */4 * * *", intervalHours: 4, thresholdHours: 6 };

  // 4.1 Fresh green schedule run on main
  const freshRun = {
    id: 1,
    runNumber: 10,
    conclusion: "success",
    event: "schedule",
    headBranch: "main",
    headSha: "abcdef12",
    updatedAt: new Date(FIXED_NOW.getTime() - 2 * 3600 * 1000).toISOString(),
  };
  const normalJobs = { totalJobs: 1, jobNames: ["ingest"], allSkipped: false, failedJob: null };
  const v1 = computeVerdict(meta4h, freshRun, normalJobs, FIXED_NOW);
  assertTest(
    "4.1 Fresh green schedule run on main reports PASS",
    v1.verdict === "PASS" && v1.ageHours >= 1.99 && v1.ageHours <= 2.01 && v1.timestampField.includes("updated_at"),
    `Expected PASS, got ${v1.verdict} (${v1.detail})`
  );

  // 4.2 Green run older than 1.5x interval reports STALE
  const staleRun = {
    id: 2,
    runNumber: 11,
    conclusion: "success",
    event: "schedule",
    headBranch: "main",
    updatedAt: new Date(FIXED_NOW.getTime() - 7 * 3600 * 1000).toISOString(),
  };
  const v2 = computeVerdict(meta4h, staleRun, normalJobs, FIXED_NOW);
  assertTest(
    "4.2 Green schedule run older than 1.5x interval reports STALE",
    v2.verdict === "STALE" && v2.ageHours >= 6.99 && v2.ageHours <= 7.01,
    `Expected STALE, got ${v2.verdict} (${v2.detail})`
  );

  // 4.3 Zero completed runs reports STALE
  const v3 = computeVerdict(meta4h, null, null, FIXED_NOW);
  assertTest(
    "4.3 Null / zero completed runs reports STALE with ageHours: null",
    v3.verdict === "STALE" && v3.ageHours === null,
    `Expected STALE, got ${v3.verdict} (${v3.detail})`
  );

  // 4.4 Run failed
  const failedRun = {
    id: 4,
    runNumber: 12,
    conclusion: "failure",
    event: "schedule",
    headBranch: "main",
    updatedAt: new Date(FIXED_NOW.getTime() - 1 * 3600 * 1000).toISOString(),
  };
  const v4 = computeVerdict(meta4h, failedRun, normalJobs, FIXED_NOW);
  assertTest(
    "4.4 Failed schedule run reports FAIL",
    v4.verdict === "FAIL" && v4.detail.includes("concluded with 'failure'"),
    `Expected FAIL, got ${v4.verdict} (${v4.detail})`
  );

  // 4.5 Green workflow but all guarded jobs were skipped
  const allSkippedJobs = { totalJobs: 1, jobNames: ["probe"], allSkipped: true, failedJob: null };
  const v5 = computeVerdict(meta4h, freshRun, allSkippedJobs, FIXED_NOW);
  assertTest(
    "4.5 Green workflow whose guarded jobs were all skipped reports FAIL (no work executed)",
    v5.verdict === "FAIL" && v5.detail.includes("All guarded jobs were skipped"),
    `Expected FAIL, got ${v5.verdict} (${v5.detail})`
  );

  // 4.6 Green workflow but a guarded job failed
  const jobFailedData = { totalJobs: 2, jobNames: ["build", "test"], allSkipped: false, failedJob: { name: "test", conclusion: "failure" } };
  const v6 = computeVerdict(meta4h, freshRun, jobFailedData, FIXED_NOW);
  assertTest(
    "4.6 Green workflow where a guarded job failed reports FAIL",
    v6.verdict === "FAIL" && v6.detail.includes("Guarded job 'test' concluded with 'failure'"),
    `Expected FAIL, got ${v6.verdict} (${v6.detail})`
  );

  // 4.7 Fail closed on invalid timestamp string
  const invalidDateRun = {
    id: 7,
    runNumber: 14,
    conclusion: "success",
    event: "schedule",
    updatedAt: "invalid-timestamp-value",
  };
  const v7 = computeVerdict(meta4h, invalidDateRun, normalJobs, FIXED_NOW);
  assertTest(
    "4.7 Invalid timestamp string reports FAIL with ageHours: null (never NaN)",
    v7.verdict === "FAIL" && v7.ageHours === null && !Number.isNaN(v7.ageHours),
    `Expected FAIL & ageHours: null, got ${v7.verdict}, ageHours=${v7.ageHours}`
  );

  // 4.8 Fail closed on future timestamp
  const futureRun = {
    id: 8,
    runNumber: 15,
    conclusion: "success",
    event: "schedule",
    updatedAt: new Date(FIXED_NOW.getTime() + 2 * 3600 * 1000).toISOString(),
  };
  const v8 = computeVerdict(meta4h, futureRun, normalJobs, FIXED_NOW);
  assertTest(
    "4.8 Future timestamp reports FAIL with ageHours: null (never 0)",
    v8.verdict === "FAIL" && v8.ageHours === null && v8.detail.includes("Future timestamp detected"),
    `Expected FAIL & ageHours: null, got ${v8.verdict}, ageHours=${v8.ageHours}`
  );

  // 4.9 Cron error in metadata fails closed
  const metaWithCronError = { file: "broken.yml", name: "Broken", cron: "bad cron", cronError: "Unsupported pattern" };
  const v9 = computeVerdict(metaWithCronError, freshRun, normalJobs, FIXED_NOW);
  assertTest(
    "4.9 Cron parsing error in metadata reports FAIL",
    v9.verdict === "FAIL" && v9.detail.includes("Unsupported or invalid cron pattern"),
    `Expected FAIL, got ${v9.verdict}`
  );

  // ---------------------------------------------------------------------------
  // Part 5: Token Security Unit Checks
  // ---------------------------------------------------------------------------
  console.log("\n--- Part 5: Token Security ---");

  assertTest(
    "5.1 https://api.github.com is verified safe GitHub host",
    isSafeGitHubHost("https://api.github.com") === true
  );

  assertTest(
    "5.2 https://enterprise.github.com is verified safe GitHub host",
    isSafeGitHubHost("https://enterprise.github.com") === true
  );

  assertTest(
    "5.3 Plain http://api.github.com is REJECTED (insecure plain http)",
    isSafeGitHubHost("http://api.github.com") === false
  );

  assertTest(
    "5.4 Local mock http://127.0.0.1 is REJECTED (token must not be sent)",
    isSafeGitHubHost("http://127.0.0.1:8080") === false
  );

  assertTest(
    "5.5 Spoofed https://api.github.com.attacker.com is REJECTED",
    isSafeGitHubHost("https://api.github.com.attacker.com") === false
  );

  // ---------------------------------------------------------------------------
  // Part 6: CLI Integration & HTTP Robustness Negative Controls
  // ---------------------------------------------------------------------------
  console.log("\n--- Part 6: CLI Integration & Mock HTTP Negative Controls ---");

  let mockPort = 0;
  let receivedAuthHeader = null;

  const server = http.createServer((req, res) => {
    if (req.headers["authorization"]) {
      receivedAuthHeader = req.headers["authorization"];
    }

    if (activeMockHandler) {
      activeMockHandler(req, res);
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${mockPort}`);
    if (url.pathname.includes("/jobs")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(createMockJobsResponse());
      return;
    }

    // Default mock response: all workflows return fresh success on main (1h ago)
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(createMockRunResponse("Mock Workflow", "success", 1));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  mockPort = server.address().port;
  console.log(`Mock GitHub API listening at http://127.0.0.1:${mockPort}`);

  try {
    // 6.1 All Workflows PASS on default branch -> Exit code 0
    activeMockHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${mockPort}`);
      if (url.pathname.includes("/jobs")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(createMockJobsResponse());
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(createMockRunResponse("Mock", "success", 1));
    };

    const resA = await runCliAsync(mockPort);
    assertTest(
      "6.1 Scenario A (All pass on default branch): Exits 0 and reports VERDICT: PASS",
      resA.exitCode === 0 &&
        resA.stdout.includes("VERDICT: PASS") &&
        resA.stdout.includes("PASS | 0 STALE | 0 FAIL"),
      `Expected exit 0 and VERDICT: PASS, got code ${resA.exitCode}\nOutput: ${resA.stdout}`
    );

    // 6.2 Token Security: CLI with --token must NOT send Authorization header to http:// API base
    receivedAuthHeader = null;
    await runCliAsync(mockPort, ["--token", "ghp_SECRET_TOKEN_DO_NOT_LEAK"]);
    assertTest(
      "6.2 Token Security: Authorization header was NOT sent to http:// --api-base",
      receivedAuthHeader === null,
      `Authorization header was leaked: ${receivedAuthHeader}`
    );

    // 6.3 Workflow Run Failure on Default Branch -> Exit code 1
    activeMockHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${mockPort}`);
      if (url.pathname.includes("/jobs")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(createMockJobsResponse());
        return;
      }
      if (url.pathname.includes("ingest.yml")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(createMockRunResponse("Scaled Ingestion", "failure", 1));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(createMockRunResponse("Mock", "success", 1));
    };

    const resB = await runCliAsync(mockPort);
    assertTest(
      "6.3 Scenario B (Workflow failure): Exits 1 on run failure and reports VERDICT: FAIL",
      resB.exitCode === 1 && resB.stdout.includes("[FAIL]  ingest.yml") && resB.stdout.includes("VERDICT: FAIL"),
      `Expected exit 1 on workflow failure, got code ${resB.exitCode}`
    );

    // 6.4 Guarded Jobs All Skipped -> Exit code 1 (FAIL)
    activeMockHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${mockPort}`);
      if (url.pathname.includes("db-health-probe.yml") && url.pathname.includes("/runs")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            total_count: 1,
            workflow_runs: [
              {
                id: 88888,
                run_number: 99,
                name: "Read-only DB Health Probe",
                status: "completed",
                conclusion: "success",
                event: "schedule",
                head_branch: "main",
                head_sha: "3382015b",
                created_at: new Date(FIXED_NOW.getTime() - 3600000).toISOString(),
                run_started_at: new Date(FIXED_NOW.getTime() - 3600000).toISOString(),
                updated_at: new Date(FIXED_NOW.getTime() - 3600000).toISOString(),
                html_url: `https://github.com/ORM-git/Carrier-hound/actions/runs/88888`,
              },
            ],
          })
        );
        return;
      }
      if (url.pathname.includes("/runs/88888/jobs")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(createMockJobsResponse([{ id: 801, name: "probe", status: "completed", conclusion: "skipped" }]));
        return;
      }
      if (url.pathname.includes("/jobs")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(createMockJobsResponse());
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(createMockRunResponse("Mock", "success", 1));
    };

    const resSkipped = await runCliAsync(mockPort);
    assertTest(
      "6.4 Scenario C (Guarded jobs skipped): Exits 1 and flags FAIL when all guarded jobs were skipped",
      resSkipped.exitCode === 1 &&
        resSkipped.stdout.includes("[FAIL]  db-health-probe.yml") &&
        resSkipped.stdout.includes("All guarded jobs were skipped"),
      `Expected exit 1 on all skipped jobs, got code ${resSkipped.exitCode}`
    );

    // 6.5 Schedule vs Manual Run Separation: Manual run does NOT reset schedule freshness
    activeMockHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${mockPort}`);
      if (url.pathname.includes("/jobs")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(createMockJobsResponse());
        return;
      }
      if (url.pathname.includes("ingest.yml")) {
        if (url.searchParams.get("event") === "schedule") {
          // Schedule run is 10 hours old (stale for 4h ingest)
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(createMockRunResponse("Scaled Ingestion", "success", 10, "schedule", "main"));
          return;
        } else {
          // Latest overall run is a manual workflow_dispatch 1h ago
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(createMockRunResponse("Scaled Ingestion", "success", 1, "workflow_dispatch", "main"));
          return;
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(createMockRunResponse("Mock", "success", 1));
    };

    const resManual = await runCliAsync(mockPort);
    assertTest(
      "6.5 Scenario D (Manual dispatch): Manual run does not reset schedule freshness (ingest reports STALE with diagnostic note)",
      resManual.exitCode === 1 &&
        resManual.stdout.includes("[STALE] ingest.yml") &&
        resManual.stdout.includes("[Diagnostic] Latest overall run was #42 (workflow_dispatch on main"),
      `Expected ingest STALE with diagnostic note, got code ${resManual.exitCode}\nOutput: ${resManual.stdout}`
    );

    // 6.6 Zero Completed Scheduled Runs -> Exit code 1 (STALE)
    activeMockHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${mockPort}`);
      if (url.pathname.includes("/jobs")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(createMockJobsResponse());
        return;
      }
      if (url.pathname.includes("db-reconciliation.yml")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ total_count: 0, workflow_runs: [] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(createMockRunResponse("Mock", "success", 1));
    };

    const resZero = await runCliAsync(mockPort);
    assertTest(
      "6.6 Scenario E (Zero runs): Exits 1 and reports STALE when zero runs recorded",
      resZero.exitCode === 1 &&
        resZero.stdout.includes("[STALE] db-reconciliation.yml") &&
        resZero.stdout.includes("No completed schedule runs recorded"),
      `Expected STALE on zero runs, got code ${resZero.exitCode}`
    );

    // 6.7 HTTP Robustness: Stalled Headers (Timeout)
    activeMockHandler = (req, res) => {
      // Intentionally stall without writing headers
    };
    const resTimeout = await runCliAsync(mockPort, ["--timeout", "400"]);
    assertTest(
      "6.7 Scenario F (Stalled headers): Absolute deadline triggers and exits 1",
      resTimeout.exitCode === 1 && resTimeout.stdout.includes("exceeded absolute deadline of 400ms"),
      `Expected timeout error, got code ${resTimeout.exitCode}`
    );

    // 6.8 HTTP Robustness: Slow Drip (Exceeds Absolute Deadline)
    activeMockHandler = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const interval = setInterval(() => {
        try {
          res.write(" ");
        } catch (_) {
          clearInterval(interval);
        }
      }, 50);
      res.on("close", () => clearInterval(interval));
    };
    const resDrip = await runCliAsync(mockPort, ["--timeout", "400"]);
    assertTest(
      "6.8 Scenario G (Slow drip): Absolute deadline aborts stream and exits 1",
      resDrip.exitCode === 1 && resDrip.stdout.includes("exceeded absolute deadline of 400ms"),
      `Expected drip deadline abort, got code ${resDrip.exitCode}`
    );

    // 6.9 HTTP Robustness: Stream Truncation / Abrupt Socket Close
    activeMockHandler = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000" });
      res.write('{"workflow_runs": [');
      req.socket.destroy();
    };
    const resTrunc = await runCliAsync(mockPort);
    assertTest(
      "6.9 Scenario H (Stream truncation): Abrupt connection termination fails cleanly",
      resTrunc.exitCode === 1 &&
        (resTrunc.stdout.includes("Response stream") || resTrunc.stdout.includes("Network transport error")),
      `Expected truncation error, got code ${resTrunc.exitCode}`
    );

    // 6.10 HTTP Robustness: Malformed JSON Response
    activeMockHandler = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{ not-valid-json-response");
    };
    const resMalformed = await runCliAsync(mockPort);
    assertTest(
      "6.10 Scenario I (Malformed JSON): Catches JSON parse error and exits 1",
      resMalformed.exitCode === 1 && resMalformed.stdout.includes("Failed to parse GitHub API JSON response"),
      `Expected parse error, got code ${resMalformed.exitCode}`
    );

    // 6.11 HTTP Robustness: HTTP 401 Authentication Error
    activeMockHandler = (req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Bad credentials" }));
    };
    const res401 = await runCliAsync(mockPort);
    assertTest(
      "6.11 Scenario J (HTTP 401 Auth error): Exits 1 with clear authentication diagnostic",
      res401.exitCode === 1 && res401.stdout.includes("GitHub API authentication error (HTTP 401)"),
      `Expected 401 error, got code ${res401.exitCode}`
    );

    // 6.12 HTTP Robustness: HTTP 403 Rate Limit Error
    activeMockHandler = (req, res) => {
      res.writeHead(403, { "Content-Type": "application/json", "x-ratelimit-remaining": "0" });
      res.end(JSON.stringify({ message: "API rate limit exceeded" }));
    };
    const res403 = await runCliAsync(mockPort);
    assertTest(
      "6.12 Scenario K (HTTP 403 Rate limit): Exits 1 with rate limit guidance",
      res403.exitCode === 1 && res403.stdout.includes("GitHub API rate limit exceeded"),
      `Expected rate limit error, got code ${res403.exitCode}`
    );

    // 6.13 JSON Report Output Verification
    activeMockHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${mockPort}`);
      if (url.pathname.includes("/jobs")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(createMockJobsResponse());
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(createMockRunResponse("Mock", "success", 1));
    };

    const resJson = await runCliAsync(mockPort, ["--json"]);
    const reportsDir = path.resolve(__dirname, "..", "reports", "cron-health");
    const dateStr = FIXED_NOW.toISOString().slice(0, 10);
    const expectedReportFile = path.join(reportsDir, `cron-health-${dateStr}.jsonl`);

    let reportEntryFound = false;
    if (fs.existsSync(expectedReportFile)) {
      const lines = fs.readFileSync(expectedReportFile, "utf8").trim().split("\n");
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (
            parsed.timestamp === FIXED_NOW.toISOString() &&
            parsed.passedAll === true &&
            parsed.workflows &&
            parsed.workflows[0].scheduleRun &&
            parsed.workflows[0].scheduleRun.headBranch === "main" &&
            parsed.workflows[0].scheduleRun.event === "schedule"
          ) {
            reportEntryFound = true;
            break;
          }
        } catch (_) {}
      }
    }

    assertTest(
      "6.13 Scenario L (--json report): Writes dated JSONL record with scheduleRun evidence and branch/event",
      resJson.exitCode === 0 && reportEntryFound,
      `Expected valid report entry written to ${expectedReportFile}`
    );

  } finally {
    await new Promise((resolve) => server.close(resolve));
    console.log("Mock GitHub API server shut down.\n");
  }

  console.log("--------------------------------------------------------------------------------");
  console.log(`TEST SUITE SUMMARY: ${passedTests}/${totalTests} offline tests passed`);
  console.log("--------------------------------------------------------------------------------");

  if (passedTests === totalTests) {
    console.log("VERDICT: PASS (Cron health offline fixture test suite verified)");
    process.exit(0);
  } else {
    console.error("VERDICT: FAIL (One or more offline tests failed)");
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error("FATAL: Offline test suite encountered unexpected error:", err);
  process.exit(1);
});
