#!/usr/bin/env node
/**
 * scripts/test-cron-health.cjs
 *
 * Standalone offline test suite for scripts/check-cron-health.cjs.
 * Thoroughly verifies:
 *   1. Cron interval parsing (sub-daily, daily, weekly, custom steps).
 *   2. Verdict logic (PASS, STALE, FAIL across all conclusion types and threshold ages).
 *   3. CLI execution with a local mock HTTP server:
 *      - Scenario A: All workflows green & fresh -> Exit code 0 (PASS).
 *      - Scenario B: Workflow run failed -> Exit code 1 (FAIL).
 *      - Scenario C: Workflow run stale (>1.5x interval) -> Exit code 1 (FAIL).
 *      - Scenario D: Zero completed runs -> Exit code 1 (FAIL / STALE).
 *      - Scenario E: GitHub API rate limit (HTTP 403) -> Exit code 1 (FAIL).
 *      - Scenario F: GitHub API 500 server error -> Exit code 1 (FAIL).
 *      - Scenario G: --json output writes valid dated JSON Lines record.
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
  computeVerdict,
} = require("./check-cron-health.cjs");

// Simulated evaluation anchor time: 2026-11-13T12:00:00.000Z
const FIXED_NOW = new Date("2026-11-13T12:00:00.000Z");

let activeMockHandler = null;

function runCliAsync(port, extraArgs = []) {
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
      env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
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

function createMockRunResponse(workflowName, conclusion = "success", ageHours = 1) {
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
        event: "schedule",
        created_at: createdAt,
        run_started_at: createdAt,
        updated_at: createdAt,
        html_url: `https://github.com/ORM-git/Carrier-hound/actions/runs/10001`,
      },
    ],
  });
}

async function runTestSuite() {
  console.log("================================================================================");
  console.log("     CAREERMONKE CRON-HEALTH CHECKER OFFLINE FIXTURE TEST SUITE                 ");
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
  // Part 1: Unit Tests for parseCronIntervalHours
  // ---------------------------------------------------------------------------
  console.log("\n--- Part 1: Cron Interval Parser ---");

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
    "1.3 Parses daily fixed time '30 21 * * *' to 24h",
    parseCronIntervalHours("30 21 * * *") === 24,
    `Got ${parseCronIntervalHours("30 21 * * *")}`
  );

  assertTest(
    "1.4 Parses daily fixed morning '30 4 * * *' to 24h",
    parseCronIntervalHours("30 4 * * *") === 24,
    `Got ${parseCronIntervalHours("30 4 * * *")}`
  );

  assertTest(
    "1.5 Parses weekly Monday '0 5 * * 1' to 168h",
    parseCronIntervalHours("0 5 * * 1") === 168,
    `Got ${parseCronIntervalHours("0 5 * * 1")}`
  );

  assertTest(
    "1.6 Parses weekly Sunday '30 19 * * 0' to 168h",
    parseCronIntervalHours("30 19 * * 0") === 168,
    `Got ${parseCronIntervalHours("30 19 * * 0")}`
  );

  assertTest(
    "1.7 Parses multi-hour comma list '0 0,6,12,18 * * *' to 6h",
    parseCronIntervalHours("0 0,6,12,18 * * *") === 6,
    `Got ${parseCronIntervalHours("0 0,6,12,18 * * *")}`
  );

  // ---------------------------------------------------------------------------
  // Part 2: Unit Tests for computeVerdict
  // ---------------------------------------------------------------------------
  console.log("\n--- Part 2: Verdict Logic (PASS / STALE / FAIL) ---");

  // 4h interval -> threshold 6h
  const fresh4hRun = {
    id: 1,
    runNumber: 10,
    conclusion: "success",
    createdAt: new Date(FIXED_NOW.getTime() - 2 * 3600 * 1000).toISOString(),
  };
  const v1 = computeVerdict(fresh4hRun, 4, 6, FIXED_NOW);
  assertTest(
    "2.1 Fresh green run within 1.5x interval reports PASS",
    v1.verdict === "PASS" && v1.ageHours >= 1.99 && v1.ageHours <= 2.01,
    `Expected PASS, got ${v1.verdict} (${v1.detail})`
  );

  const stale4hRun = {
    id: 2,
    runNumber: 11,
    conclusion: "success",
    createdAt: new Date(FIXED_NOW.getTime() - 7 * 3600 * 1000).toISOString(),
  };
  const v2 = computeVerdict(stale4hRun, 4, 6, FIXED_NOW);
  assertTest(
    "2.2 Green run older than 1.5x interval reports STALE",
    v2.verdict === "STALE" && v2.ageHours >= 6.99 && v2.ageHours <= 7.01,
    `Expected STALE, got ${v2.verdict} (${v2.detail})`
  );

  const v3 = computeVerdict(null, 4, 6, FIXED_NOW);
  assertTest(
    "2.3 Null / missing run reports STALE",
    v3.verdict === "STALE" && v3.ageHours === null,
    `Expected STALE, got ${v3.verdict} (${v3.detail})`
  );

  const failedRun = {
    id: 4,
    runNumber: 12,
    conclusion: "failure",
    createdAt: new Date(FIXED_NOW.getTime() - 1 * 3600 * 1000).toISOString(),
  };
  const v4 = computeVerdict(failedRun, 4, 6, FIXED_NOW);
  assertTest(
    "2.4 Failed run reports FAIL",
    v4.verdict === "FAIL" && v4.detail.includes("concluded with 'failure'"),
    `Expected FAIL, got ${v4.verdict} (${v4.detail})`
  );

  const cancelledRun = {
    id: 5,
    runNumber: 13,
    conclusion: "cancelled",
    createdAt: new Date(FIXED_NOW.getTime() - 1 * 3600 * 1000).toISOString(),
  };
  const v5 = computeVerdict(cancelledRun, 4, 6, FIXED_NOW);
  assertTest(
    "2.5 Cancelled run reports FAIL",
    v5.verdict === "FAIL" && v5.detail.includes("concluded with 'cancelled'"),
    `Expected FAIL, got ${v5.verdict} (${v5.detail})`
  );

  const skippedRun = {
    id: 6,
    runNumber: 14,
    conclusion: "skipped",
    createdAt: new Date(FIXED_NOW.getTime() - 1 * 3600 * 1000).toISOString(),
  };
  const v6 = computeVerdict(skippedRun, 4, 6, FIXED_NOW);
  assertTest(
    "2.6 Skipped run reports FAIL",
    v6.verdict === "FAIL" && v6.detail.includes("concluded with 'skipped'"),
    `Expected FAIL, got ${v6.verdict} (${v6.detail})`
  );

  // ---------------------------------------------------------------------------
  // Part 3: CLI Integration with Local Mock HTTP Server
  // ---------------------------------------------------------------------------
  console.log("\n--- Part 3: CLI Integration & Negative Controls ---");

  // Spin up local mock HTTP server
  let mockPort = 0;
  const server = http.createServer((req, res) => {
    if (activeMockHandler) {
      activeMockHandler(req, res);
      return;
    }
    // Default mock response: all workflows return fresh success (1h ago)
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(createMockRunResponse("Mock Workflow", "success", 1));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  mockPort = server.address().port;
  console.log(`Mock GitHub API listening at http://127.0.0.1:${mockPort}`);

  try {
    // 3.1 All Workflows PASS -> Exit code 0
    activeMockHandler = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(createMockRunResponse("Mock", "success", 1));
    };

    const resA = await runCliAsync(mockPort);
    assertTest(
      "3.1 Scenario A (All pass): Exits 0 and reports VERDICT: PASS",
      resA.exitCode === 0 &&
        resA.stdout.includes("VERDICT: PASS") &&
        resA.stdout.includes("PASS | 0 STALE | 0 FAIL"),
      `Expected exit 0 and VERDICT: PASS, got code ${resA.exitCode}\nOutput: ${resA.stdout}`
    );

    // 3.2 One Workflow Fails -> Exit code 1
    activeMockHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${mockPort}`);
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
      "3.2 Scenario B (Workflow failure): Exits 1 (non-zero) and reports VERDICT: FAIL",
      resB.exitCode === 1 &&
        resB.stdout.includes("[FAIL]  ingest.yml") &&
        resB.stdout.includes("VERDICT: FAIL"),
      `Expected exit 1 on workflow failure, got code ${resB.exitCode}`
    );

    // 3.3 One Workflow Stale (> 1.5x interval) -> Exit code 1
    activeMockHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${mockPort}`);
      if (url.pathname.includes("ingest.yml")) {
        // Ingest interval is 4h (threshold 6h); return run 8h ago
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(createMockRunResponse("Scaled Ingestion", "success", 8));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(createMockRunResponse("Mock", "success", 1));
    };

    const resC = await runCliAsync(mockPort);
    assertTest(
      "3.3 Scenario C (Workflow stale): Exits 1 (non-zero) on run exceeding 1.5x interval",
      resC.exitCode === 1 &&
        resC.stdout.includes("[STALE] ingest.yml") &&
        resC.stdout.includes("VERDICT: FAIL"),
      `Expected exit 1 on stale workflow, got code ${resC.exitCode}`
    );

    // 3.4 Zero Completed Runs -> Exit code 1
    activeMockHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${mockPort}`);
      if (url.pathname.includes("db-reconciliation.yml")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ total_count: 0, workflow_runs: [] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(createMockRunResponse("Mock", "success", 1));
    };

    const resD = await runCliAsync(mockPort);
    assertTest(
      "3.4 Scenario D (Zero runs): Exits 1 (non-zero) and flags STALE with no runs",
      resD.exitCode === 1 &&
        resD.stdout.includes("[STALE] db-reconciliation.yml") &&
        resD.stdout.includes("No completed runs recorded in repository"),
      `Expected exit 1 on zero runs, got code ${resD.exitCode}`
    );

    // 3.5 GitHub API Rate Limit (HTTP 403) -> Exit code 1
    activeMockHandler = (req, res) => {
      res.writeHead(403, {
        "Content-Type": "application/json",
        "x-ratelimit-remaining": "0",
      });
      res.end(JSON.stringify({ message: "API rate limit exceeded for user IP" }));
    };

    const resE = await runCliAsync(mockPort);
    assertTest(
      "3.5 Scenario E (Rate limit): Exits 1 (non-zero) and reports rate limit diagnostic",
      resE.exitCode === 1 &&
        resE.stdout.includes("GitHub API rate limit exceeded") &&
        resE.stdout.includes("VERDICT: FAIL"),
      `Expected exit 1 on rate limit, got code ${resE.exitCode}`
    );

    // 3.6 GitHub API Error (HTTP 500) -> Exit code 1
    activeMockHandler = (req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    };

    const resF = await runCliAsync(mockPort);
    assertTest(
      "3.6 Scenario F (API 500 error): Exits 1 (non-zero) on GitHub API server error",
      resF.exitCode === 1 &&
        resF.stdout.includes("GitHub API error: HTTP 500") &&
        resF.stdout.includes("VERDICT: FAIL"),
      `Expected exit 1 on API 500, got code ${resF.exitCode}`
    );

    // 3.7 JSON Report Output Verification
    activeMockHandler = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(createMockRunResponse("Mock", "success", 1));
    };

    const resG = await runCliAsync(mockPort, ["--json"]);
    const reportsDir = path.resolve(__dirname, "..", "reports", "cron-health");
    const dateStr = FIXED_NOW.toISOString().slice(0, 10);
    const expectedReportFile = path.join(reportsDir, `cron-health-${dateStr}.jsonl`);

    let reportEntryFound = false;
    if (fs.existsSync(expectedReportFile)) {
      const lines = fs.readFileSync(expectedReportFile, "utf8").trim().split("\n");
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.timestamp === FIXED_NOW.toISOString() && parsed.passedAll === true) {
            reportEntryFound = true;
            break;
          }
        } catch (_) {}
      }
    }

    assertTest(
      "3.7 Scenario G (--json flag): Writes dated JSON Lines record with structured result",
      resG.exitCode === 0 && reportEntryFound,
      `Expected JSON report line written to ${expectedReportFile}`
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
