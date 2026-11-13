#!/usr/bin/env node
/**
 * scripts/check-jobs-live.cjs
 *
 * Standalone read-only live checker for CareerMonke /jobs route and 404 fallback.
 * Asserts status plus bounded token heuristic, not job-content or DOM verification:
 *   1. /jobs returns HTTP 200, valid HTML page shell, and bounded job/brand tokens
 *      (rejects 3xx redirects, plain text, soft-404 text, error pages, and empty bodies).
 *   2. An arbitrary nonsense path returns a real HTTP 404 plus token heuristic
 *      (HTTP 404 + CareerMonke brand + actual 'Lost in the jungle?' not-found marker;
 *      token heuristic, not a valid HTML shell;
 *      rejects 3xx redirects, 200 soft-404s, generic proxy error strings, and empty bodies).
 *
 * Fails today against live production (https://careermonke.com) with detailed evidence,
 * capturing the exact 307 redirect status and Location header to /early-access.
 *
 * Usage:
 *   node scripts/check-jobs-live.cjs [baseUrl] [options]
 *
 * Options:
 *   --base-url <url>    Target base URL (default: https://careermonke.com or first positional arg)
 *   --timeout <ms>      Request timeout in ms (default: 8000ms)
 *   --json              Append dated record to reports/smoke/jobs-live-YYYY-MM-DD.jsonl
 *   --test              Run offline mock server self-tests
 *   --now <isoString>   Override timestamp for testing
 *   --help, -h          Show usage
 *
 * Exit codes:
 *   0 - Both /jobs (200 + bounded tokens) and nonsense path (404 + branded marker) pass.
 *   1 - Any check fails (redirect detected, wrong status, empty/error body, timeout).
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const DEFAULT_BASE_URL = "https://careermonke.com";
const DEFAULT_TIMEOUT_MS = 8000;
const USER_AGENT = "CareerMonke-JobsLiveCheck/1.0 (+https://careermonke.com)";
const NONSENSE_PATH = "/this-path-definitely-does-not-exist-404-check";
const MAX_CAPTURE_BYTES = 64 * 1024; // 64 KB body capture

/**
 * Parses CLI arguments.
 */
function parseArgs(argv = process.argv.slice(2)) {
  let baseUrl = DEFAULT_BASE_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let writeJson = false;
  let runSelfTest = false;
  let now = new Date();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base-url" && i + 1 < argv.length) {
      baseUrl = argv[++i];
    } else if (arg === "--timeout" && i + 1 < argv.length) {
      timeoutMs = parseInt(argv[++i], 10) || DEFAULT_TIMEOUT_MS;
    } else if (arg === "--json") {
      writeJson = true;
    } else if (arg === "--test") {
      runSelfTest = true;
    } else if (arg === "--now" && i + 1 < argv.length) {
      now = new Date(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/check-jobs-live.cjs [baseUrl] [options]

Options:
  --base-url <url>    Base URL to probe (default: ${DEFAULT_BASE_URL})
  --timeout <ms>      Request timeout in ms (default: ${DEFAULT_TIMEOUT_MS})
  --json              Append dated result to reports/smoke/
  --test              Execute offline self-tests
  --help, -h          Show help`);
      process.exit(0);
    } else if (!arg.startsWith("-") && baseUrl === DEFAULT_BASE_URL) {
      baseUrl = arg;
    }
  }

  baseUrl = baseUrl.replace(/\/+$/, "");

  return {
    baseUrl,
    timeoutMs,
    writeJson,
    runSelfTest,
    now,
  };
}

/**
 * Probes a route without following redirects.
 * Captures status code, location header, latency, full captured body, and transport errors.
 */
function probeRoute(baseUrl, routePath, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let fullUrl;
    try {
      fullUrl = new URL(routePath, baseUrl).toString();
    } catch (err) {
      return resolve({
        routePath,
        fullUrl: `${baseUrl}${routePath}`,
        statusCode: 0,
        headers: {},
        location: null,
        latencyMs: 0,
        body: "",
        error: `Invalid URL: ${err.message}`,
      });
    }

    const parsed = new URL(fullUrl);
    const client = parsed.protocol === "http:" ? http : https;
    const startTime = Date.now();

    const reqOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    };

    let settled = false;
    let deadlineTimer = null;

    function cleanup() {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
    }

    function finish(resObj) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(resObj);
    }

    deadlineTimer = setTimeout(() => {
      try {
        req.destroy();
      } catch (_) {}
      finish({
        routePath,
        fullUrl,
        statusCode: 0,
        headers: {},
        location: null,
        latencyMs: Date.now() - startTime,
        body: "",
        error: `Request timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    const req = client.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        if (data.length < MAX_CAPTURE_BYTES) {
          data += chunk.toString("utf8");
        }
      });

      res.on("end", () => {
        const latencyMs = Date.now() - startTime;
        finish({
          routePath,
          fullUrl,
          statusCode: res.statusCode || 0,
          headers: res.headers || {},
          location: res.headers["location"] || null,
          latencyMs,
          body: data,
          error: null,
        });
      });

      res.on("error", (err) => {
        finish({
          routePath,
          fullUrl,
          statusCode: res.statusCode || 0,
          headers: res.headers || {},
          location: res.headers["location"] || null,
          latencyMs: Date.now() - startTime,
          body: "",
          error: `Response stream error: ${err.message}`,
        });
      });
    });

    req.on("error", (err) => {
      finish({
        routePath,
        fullUrl,
        statusCode: 0,
        headers: {},
        location: null,
        latencyMs: Date.now() - startTime,
        body: "",
        error: `Transport error: ${err.message}`,
      });
    });

    req.end();
  });
}

/**
 * Validates status and bounded token heuristic for the public /jobs route.
 * Rejects 3xx redirects, non-200 status, plain text, soft-404 text, error bodies, and missing tokens.
 */
function evaluateJobsProbe(probe) {
  if (probe.error) {
    return {
      passed: false,
      detail: `Network/transport error probing /jobs: ${probe.error}`,
    };
  }

  // Check 1: Must not be a redirect
  if (probe.statusCode >= 300 && probe.statusCode < 400) {
    return {
      passed: false,
      detail: `HTTP ${probe.statusCode} Redirect to '${probe.location}' (expected HTTP 200; route blocked by redirect)`,
    };
  }

  // Check 2: Status must be 200
  if (probe.statusCode !== 200) {
    return {
      passed: false,
      detail: `Unexpected HTTP ${probe.statusCode} (expected HTTP 200)`,
    };
  }

  // Check 3: Body must not be empty
  const trimmed = probe.body ? probe.body.trim() : "";
  if (trimmed.length === 0) {
    return {
      passed: false,
      detail: `HTTP 200 OK received, but response body was empty (expected HTML page shell)`,
    };
  }

  // Check 4: Must be HTML (not plain text or raw text error)
  const contentType = (probe.headers["content-type"] || "").toLowerCase();
  const hasHtmlRoot = /<html|<!doctype html/i.test(trimmed);
  if (contentType.includes("text/plain") || (!hasHtmlRoot && !trimmed.startsWith("<"))) {
    return {
      passed: false,
      detail: `HTTP 200 OK received, but response is plain text/non-HTML (expected HTML page shell)`,
    };
  }

  // Check 5: Body must not contain server error or soft-404 text
  const lower = trimmed.toLowerCase();
  const errorPatterns = [
    "500 internal server error",
    "application error",
    "unhandled server exception",
    "temporarily unavailable",
    "404 page not found",
    "page not found",
    "lost in the jungle?",
    "this page could not be found",
    "<title>404",
  ];
  for (const pat of errorPatterns) {
    if (lower.includes(pat)) {
      return {
        passed: false,
        detail: `HTTP 200 OK received, but response body contains error or soft-404 text ('${pat}')`,
      };
    }
  }

  // Check 6: Bounded token heuristic (CareerMonke brand + job keyword)
  const hasBrand = trimmed.includes("CareerMonke");
  const hasJobMarker = /job|jobs|search/i.test(trimmed);

  if (!hasBrand || !hasJobMarker) {
    return {
      passed: false,
      detail: `HTTP 200 OK received, but response body lacked required bounded tokens (CareerMonke / jobs)`,
    };
  }

  return {
    passed: true,
    detail: `HTTP 200 OK (${probe.latencyMs}ms; status plus bounded token heuristic passed)`,
  };
}

/**
 * Validates status and bounded token heuristic for the nonsense 404 path.
 * Requires HTTP 404 status, non-empty body, and the actual branded 'Lost in the jungle?' marker.
 * Rejects 3xx redirects, 200 soft-404s, generic proxy error text, and missing brand markers.
 */
function evaluateNonsenseProbe(probe) {
  if (probe.error) {
    return {
      passed: false,
      detail: `Network/transport error probing nonsense path: ${probe.error}`,
    };
  }

  // Check 1: Must not be a redirect
  if (probe.statusCode >= 300 && probe.statusCode < 400) {
    return {
      passed: false,
      detail: `HTTP ${probe.statusCode} Redirect to '${probe.location}' (expected HTTP 404; unknown path redirected instead of returning 404)`,
    };
  }

  // Check 2: Soft-404 rejection (status 200 on non-existent path is invalid)
  if (probe.statusCode === 200) {
    return {
      passed: false,
      detail: `HTTP 200 OK received on nonsense path (soft-404; server must return real HTTP 404 status)`,
    };
  }

  // Check 3: Status must be 404
  if (probe.statusCode !== 404) {
    return {
      passed: false,
      detail: `Unexpected HTTP ${probe.statusCode} (expected HTTP 404)`,
    };
  }

  // Check 4: Body must not be empty
  const trimmed = probe.body ? probe.body.trim() : "";
  if (trimmed.length === 0) {
    return {
      passed: false,
      detail: `HTTP 404 received, but response body was empty (expected branded 404 page)`,
    };
  }

  // Check 5: Body must contain the actual branded not-found marker from src/app/not-found.tsx
  // Specifically: 'Lost in the jungle?' heading AND 'CareerMonke' brand.
  // Rejects generic/upstream 404 error strings like "CareerMonke 404 upstream route failed".
  const hasBrand = trimmed.includes("CareerMonke");
  const hasActualNotFoundHeading = trimmed.includes("Lost in the jungle?");
  const isUpstreamError = /upstream route failed|bad gateway|proxy error/i.test(trimmed);

  if (!hasBrand || !hasActualNotFoundHeading || isUpstreamError) {
    return {
      passed: false,
      detail: `HTTP 404 received, but response body lacked actual branded not-found marker ('Lost in the jungle?' and CareerMonke)`,
    };
  }

  return {
    passed: true,
    detail: `HTTP 404 Not Found (${probe.latencyMs}ms; verified actual branded 'Lost in the jungle?' marker)`,
  };
}

/**
 * Executes checks against the target base URL.
 */
async function checkJobsLive(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const jobsProbe = await probeRoute(baseUrl, "/jobs", timeoutMs);
  const jobsEval = evaluateJobsProbe(jobsProbe);

  const nonsenseProbe = await probeRoute(baseUrl, NONSENSE_PATH, timeoutMs);
  const nonsenseEval = evaluateNonsenseProbe(nonsenseProbe);

  const passedAll = jobsEval.passed && nonsenseEval.passed;

  return {
    baseUrl,
    passedAll,
    checks: [
      {
        name: "Public Jobs Feed (/jobs)",
        route: "/jobs",
        expectedStatus: 200,
        actualStatus: jobsProbe.statusCode,
        location: jobsProbe.location,
        latencyMs: jobsProbe.latencyMs,
        passed: jobsEval.passed,
        detail: jobsEval.detail,
        probe: jobsProbe,
      },
      {
        name: "Nonsense Path 404 Fallback",
        route: NONSENSE_PATH,
        expectedStatus: 404,
        actualStatus: nonsenseProbe.statusCode,
        location: nonsenseProbe.location,
        latencyMs: nonsenseProbe.latencyMs,
        passed: nonsenseEval.passed,
        detail: nonsenseEval.detail,
        probe: nonsenseProbe,
      },
    ],
  };
}

/**
 * Appends a structured JSON Lines record to reports/smoke/jobs-live-YYYY-MM-DD.jsonl.
 */
function writeJsonReport(result, now = new Date()) {
  const reportsDir = path.resolve(__dirname, "..", "reports", "smoke");
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const dateStr = now.toISOString().slice(0, 10);
  const filePath = path.join(reportsDir, `jobs-live-${dateStr}.jsonl`);

  const record = {
    timestamp: now.toISOString(),
    baseUrl: result.baseUrl,
    passedAll: result.passedAll,
    checks: result.checks.map((c) => ({
      name: c.name,
      route: c.route,
      expectedStatus: c.expectedStatus,
      actualStatus: c.actualStatus,
      location: c.location,
      latencyMs: c.latencyMs,
      passed: c.passed,
      detail: c.detail,
    })),
  };

  fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
  return filePath;
}

/**
 * Self-test suite running offline against local mock HTTP servers.
 * Verifies passing server and all negative controls:
 *   1. Passing server (200 with tokens, 404 with actual branded marker) -> PASS
 *   2. Live 307 redirect simulation -> FAIL
 *   3. Negative Control: Empty 200 body on /jobs -> FAIL
 *   4. Negative Control: Empty 404 body on nonsense path -> FAIL
 *   5. Negative Control: Error body on /jobs (500 marker) -> FAIL
 *   6. Negative Control: Soft-404 (status 200 on nonsense path) -> FAIL
 *   7. Negative Control: Stalled connection / request timeout -> FAIL
 *   8. Negative Control: Stream truncation / abrupt socket close -> FAIL
 *   9. Negative Control: 200 plain text "CareerMonke job temporarily unavailable" on /jobs -> FAIL
 *  10. Negative Control: 200 HTML with "404 Page Not Found" on /jobs -> FAIL
 *  11. Negative Control: 404 body "CareerMonke 404 upstream route failed" claiming a branded page -> FAIL
 */
async function runSelfTests() {
  console.log("================================================================================");
  console.log("     CHECK-JOBS-LIVE OFFLINE FIXTURE SELF-TEST SUITE                           ");
  console.log("================================================================================\n");

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

  // 1. Mock Server Scenario 1: Passing Server (Valid 200 + tokens, Valid 404 + branded marker)
  let server1;
  const port1 = await new Promise((resolve) => {
    server1 = http.createServer((req, res) => {
      if (req.url === "/jobs") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><header>CareerMonke</header><main><h1>Remote Jobs Search</h1></main></body></html>");
      } else {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<html><body><div>CareerMonke</div><h1>Lost in the jungle?</h1><p>Page Not Found</p></body></html>");
      }
    });
    server1.listen(0, "127.0.0.1", () => resolve(server1.address().port));
  });

  try {
    const res1 = await checkJobsLive(`http://127.0.0.1:${port1}`, 2000);
    assertTest(
      "1. Valid content & statuses: reports passedAll === true",
      res1.passedAll === true && res1.checks[0].passed && res1.checks[1].passed,
      `Expected true, got ${res1.passedAll}`
    );
  } finally {
    await new Promise((resolve) => server1.close(resolve));
  }

  // 2. Mock Server Scenario 2: Live Failure Simulation (307 redirect to /early-access)
  let server2;
  const port2 = await new Promise((resolve) => {
    server2 = http.createServer((req, res) => {
      res.writeHead(307, {
        Location: "https://careermonke.com/early-access",
        "Content-Length": "0",
      });
      res.end();
    });
    server2.listen(0, "127.0.0.1", () => resolve(server2.address().port));
  });

  try {
    const res2 = await checkJobsLive(`http://127.0.0.1:${port2}`, 2000);
    assertTest(
      "2. Live 307 simulation: reports passedAll === false with redirect evidence",
      res2.passedAll === false &&
        !res2.checks[0].passed &&
        !res2.checks[1].passed &&
        res2.checks[0].actualStatus === 307 &&
        res2.checks[0].location === "https://careermonke.com/early-access",
      `Expected false with 307, got ${res2.passedAll}`
    );
  } finally {
    await new Promise((resolve) => server2.close(resolve));
  }

  // 3. Negative Control: Empty 200 body on /jobs
  let server3;
  const port3 = await new Promise((resolve) => {
    server3 = http.createServer((req, res) => {
      if (req.url === "/jobs") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(""); // Empty body
      } else {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<html><body>CareerMonke Lost in the jungle? Page Not Found</body></html>");
      }
    });
    server3.listen(0, "127.0.0.1", () => resolve(server3.address().port));
  });

  try {
    const res3 = await checkJobsLive(`http://127.0.0.1:${port3}`, 2000);
    assertTest(
      "3. Negative Control: Empty 200 body on /jobs FAILS check",
      res3.passedAll === false && !res3.checks[0].passed && res3.checks[0].detail.includes("body was empty"),
      `Expected empty body failure, got ${res3.checks[0].detail}`
    );
  } finally {
    await new Promise((resolve) => server3.close(resolve));
  }

  // 4. Negative Control: Empty 404 body on nonsense path
  let server4;
  const port4 = await new Promise((resolve) => {
    server4 = http.createServer((req, res) => {
      if (req.url === "/jobs") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body>CareerMonke Job Search</body></html>");
      } else {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end(""); // Empty 404
      }
    });
    server4.listen(0, "127.0.0.1", () => resolve(server4.address().port));
  });

  try {
    const res4 = await checkJobsLive(`http://127.0.0.1:${port4}`, 2000);
    assertTest(
      "4. Negative Control: Empty 404 body on nonsense path FAILS check",
      res4.passedAll === false && !res4.checks[1].passed && res4.checks[1].detail.includes("body was empty"),
      `Expected empty 404 failure, got ${res4.checks[1].detail}`
    );
  } finally {
    await new Promise((resolve) => server4.close(resolve));
  }

  // 5. Negative Control: Error body on /jobs (HTTP 200 with 500 error marker)
  let server5;
  const port5 = await new Promise((resolve) => {
    server5 = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>500 Internal Server Error</h1></body></html>");
    });
    server5.listen(0, "127.0.0.1", () => resolve(server5.address().port));
  });

  try {
    const res5 = await checkJobsLive(`http://127.0.0.1:${port5}`, 2000);
    assertTest(
      "5. Negative Control: Error body on /jobs FAILS check",
      res5.passedAll === false && !res5.checks[0].passed && res5.checks[0].detail.includes("error or soft-404 text"),
      `Expected error body failure, got ${res5.checks[0].detail}`
    );
  } finally {
    await new Promise((resolve) => server5.close(resolve));
  }

  // 6. Negative Control: Soft-404 (status 200 on nonsense path)
  let server6;
  const port6 = await new Promise((resolve) => {
    server6 = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>CareerMonke Job Search</body></html>");
    });
    server6.listen(0, "127.0.0.1", () => resolve(server6.address().port));
  });

  try {
    const res6 = await checkJobsLive(`http://127.0.0.1:${port6}`, 2000);
    assertTest(
      "6. Negative Control: Soft-404 on nonsense path FAILS check",
      res6.passedAll === false && !res6.checks[1].passed && res6.checks[1].detail.includes("soft-404"),
      `Expected soft-404 failure, got ${res6.checks[1].detail}`
    );
  } finally {
    await new Promise((resolve) => server6.close(resolve));
  }

  // 7. Negative Control: Request timeout / stalled headers
  let server7;
  const port7 = await new Promise((resolve) => {
    server7 = http.createServer(() => {
      // Intentionally never respond
    });
    server7.listen(0, "127.0.0.1", () => resolve(server7.address().port));
  });

  try {
    const res7 = await checkJobsLive(`http://127.0.0.1:${port7}`, 300); // 300ms timeout
    assertTest(
      "7. Negative Control: Stalled request triggers timeout and FAILS check",
      res7.passedAll === false && !res7.checks[0].passed && res7.checks[0].detail.includes("timed out"),
      `Expected timeout failure, got ${res7.checks[0].detail}`
    );
  } finally {
    await new Promise((resolve) => server7.close(resolve));
  }

  // 8. Negative Control: Stream truncation / abrupt socket destroy
  let server8;
  const port8 = await new Promise((resolve) => {
    server8 = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Length": "5000" });
      res.write("<html><body>Career");
      req.socket.destroy();
    });
    server8.listen(0, "127.0.0.1", () => resolve(server8.address().port));
  });

  try {
    const res8 = await checkJobsLive(`http://127.0.0.1:${port8}`, 2000);
    assertTest(
      "8. Negative Control: Stream truncation fails cleanly",
      res8.passedAll === false &&
        !res8.checks[0].passed &&
        (res8.checks[0].detail.includes("stream error") || res8.checks[0].detail.includes("Transport error")),
      `Expected truncation failure, got ${res8.checks[0].detail}`
    );
  } finally {
    await new Promise((resolve) => server8.close(resolve));
  }

  // 9. Negative Control: 200 plain text "CareerMonke job temporarily unavailable" on /jobs
  let server9;
  const port9 = await new Promise((resolve) => {
    server9 = http.createServer((req, res) => {
      if (req.url === "/jobs") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("CareerMonke job temporarily unavailable");
      } else {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<html><body>CareerMonke Lost in the jungle?</body></html>");
      }
    });
    server9.listen(0, "127.0.0.1", () => resolve(server9.address().port));
  });

  try {
    const res9 = await checkJobsLive(`http://127.0.0.1:${port9}`, 2000);
    assertTest(
      "9. Negative Control: 200 plain text 'CareerMonke job temporarily unavailable' on /jobs FAILS check",
      res9.passedAll === false &&
        !res9.checks[0].passed &&
        (res9.checks[0].detail.includes("plain text") || res9.checks[0].detail.includes("temporarily unavailable")),
      `Expected plain text or error text failure, got ${res9.checks[0].detail}`
    );
  } finally {
    await new Promise((resolve) => server9.close(resolve));
  }

  // 10. Negative Control: 200 HTML with "404 Page Not Found" on /jobs
  let server10;
  const port10 = await new Promise((resolve) => {
    server10 = http.createServer((req, res) => {
      if (req.url === "/jobs") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><div>CareerMonke</div><h1>404 Page Not Found</h1><p>Jobs search</p></body></html>");
      } else {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<html><body>CareerMonke Lost in the jungle?</body></html>");
      }
    });
    server10.listen(0, "127.0.0.1", () => resolve(server10.address().port));
  });

  try {
    const res10 = await checkJobsLive(`http://127.0.0.1:${port10}`, 2000);
    assertTest(
      "10. Negative Control: 200 HTML with '404 Page Not Found' on /jobs FAILS check",
      res10.passedAll === false &&
        !res10.checks[0].passed &&
        res10.checks[0].detail.includes("soft-404 text"),
      `Expected soft-404 text failure, got ${res10.checks[0].detail}`
    );
  } finally {
    await new Promise((resolve) => server10.close(resolve));
  }

  // 11. Negative Control: 404 body "CareerMonke 404 upstream route failed" claiming a branded page
  let server11;
  const port11 = await new Promise((resolve) => {
    server11 = http.createServer((req, res) => {
      if (req.url === "/jobs") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body>CareerMonke Job Search</body></html>");
      } else {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<html><body>CareerMonke 404 upstream route failed</body></html>");
      }
    });
    server11.listen(0, "127.0.0.1", () => resolve(server11.address().port));
  });

  try {
    const res11 = await checkJobsLive(`http://127.0.0.1:${port11}`, 2000);
    assertTest(
      "11. Negative Control: 404 body 'CareerMonke 404 upstream route failed' claiming a branded page FAILS check",
      res11.passedAll === false &&
        !res11.checks[1].passed &&
        res11.checks[1].detail.includes("lacked actual branded not-found marker"),
      `Expected missing actual branded marker failure, got ${res11.checks[1].detail}`
    );
  } finally {
    await new Promise((resolve) => server11.close(resolve));
  }

  console.log("\n--------------------------------------------------------------------------------");
  console.log(`SELF-TEST SUMMARY: ${passedTests}/${totalTests} offline tests passed`);
  console.log("--------------------------------------------------------------------------------");

  if (passedTests === totalTests) {
    console.log("VERDICT: PASS (All passing and negative control tests verified)\n");
    return true;
  }
  return false;
}

/**
 * Main CLI runner.
 */
async function main() {
  const config = parseArgs();

  if (config.runSelfTest) {
    const success = await runSelfTests();
    process.exit(success ? 0 : 1);
  }

  console.log("================================================================================");
  console.log("     CAREERMONKE LIVE JOBS FEED & 404 FALLBACK PROBE (STANDALONE READ-ONLY)   ");
  console.log("================================================================================");
  console.log(`Target Base URL:   ${config.baseUrl}`);
  console.log(`Evaluation Time:   ${config.now.toISOString()}`);
  console.log(`Request Timeout:   ${config.timeoutMs}ms`);
  console.log("Validation Mode:   HTTP status plus bounded token heuristic (not job-content or DOM verification)");
  console.log("--------------------------------------------------------------------------------\n");

  const result = await checkJobsLive(config.baseUrl, config.timeoutMs);

  for (const c of result.checks) {
    const badge = c.passed ? "[PASS]" : "[FAIL]";
    console.log(`${badge} ${c.name} (${c.route})`);
    console.log(`       Expected: HTTP ${c.expectedStatus}`);
    console.log(`       Actual:   HTTP ${c.actualStatus || "ERROR"}${c.location ? ` -> ${c.location}` : ""}`);
    console.log(`       Detail:   ${c.detail}\n`);
  }

  if (config.writeJson) {
    const reportPath = writeJsonReport(result, config.now);
    console.log(`Dated JSONL record written to: ${reportPath}\n`);
  }

  console.log("--------------------------------------------------------------------------------");
  if (result.passedAll) {
    console.log("OVERALL VERDICT: PASS (Public /jobs serves 200 with job content; unknown path serves real 404)");
    console.log("================================================================================");
    process.exit(0);
  } else {
    console.log("OVERALL VERDICT: FAIL (Redirect, invalid status, or missing structural markers detected)");
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
  checkJobsLive,
  probeRoute,
  evaluateJobsProbe,
  evaluateNonsenseProbe,
  writeJsonReport,
  runSelfTests,
};
