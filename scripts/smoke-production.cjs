#!/usr/bin/env node
/**
 * scripts/smoke-production.cjs
 *
 * Standalone post-deploy smoke probe for CareerMonke production.
 * Runs sequential, polite read-only probes against the target base URL.
 *
 * Usage:
 *   node scripts/smoke-production.cjs [baseUrl] [--json] [--sha <commit>]
 *
 * Checks:
 *   1. Homepage (/): Shell-only check; asserts route-specific structure, rejects soft-404.
 *   2. Readiness probe (/api/health/ready): Evaluates status="ready" and env/database checks;
 *      proves ONLY single anonymous select on jobs_public view.
 *   3. Public jobs feed (/jobs): Shell-only check; asserts jobs directory structure and distinct body.
 *   4. Auth entry page (/login): Shell-only check; asserts login form elements and distinct body.
 *   5. Payments-OFF gate (/api/billing/razorpay/order): Non-wallet-bearing probe;
 *      observes unauthenticated disabled-gate response (exact 503 + code: 'BILLING_DISABLED').
 *      Any other status (401, 403, 404, 405, 3xx, 500, HTML/text bodies) is marked
 *      NOT VERIFIED / inconclusive or FAIL, NEVER pass.
 *
 * Safeguards:
 *   - Overall wall-clock abort deadline (default 25s) with active abort timers on in-flight sockets/streams.
 *   - Per-request timeout (default 6s).
 *   - Per-response body size cap (512KB) with stream error handling.
 *   - Detects identical generic fallback bodies across distinct routes.
 *   - Sequential execution, zero retries.
 *   - Exits 0 on all checks passing, 1 on any failure or inconclusive check.
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_BASE_URL = "https://careermonke.com";
const PER_REQUEST_TIMEOUT_MS = 6000;
const WALL_CLOCK_TIMEOUT_MS = 25000;
const MAX_BODY_BYTES = 512 * 1024; // 512 KB
const USER_AGENT = "CareerMonke-ProductionSmokeProbe/2.0 (+https://careermonke.com)";

function parseArgs() {
  const args = process.argv.slice(2);
  let baseUrl = DEFAULT_BASE_URL;
  let writeJson = false;
  let deploySha = process.env.DEPLOY_SHA || null;
  let wallTimeoutMs = WALL_CLOCK_TIMEOUT_MS;
  let reqTimeoutMs = PER_REQUEST_TIMEOUT_MS;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      writeJson = true;
    } else if (arg === "--sha" && i + 1 < args.length) {
      deploySha = args[++i];
    } else if (arg === "--timeout" && i + 1 < args.length) {
      reqTimeoutMs = parseInt(args[++i], 10) || PER_REQUEST_TIMEOUT_MS;
    } else if (arg === "--wall-timeout" && i + 1 < args.length) {
      wallTimeoutMs = parseInt(args[++i], 10) || WALL_CLOCK_TIMEOUT_MS;
    } else if (arg.startsWith("http://") || arg.startsWith("https://")) {
      baseUrl = arg;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/smoke-production.cjs [baseUrl] [--json] [--sha <commit>] [--timeout <ms>] [--wall-timeout <ms>]");
      process.exit(0);
    }
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    writeJson,
    deploySha,
    wallTimeoutMs,
    reqTimeoutMs,
  };
}

/**
 * Computes a normalized content hash for detecting identical generic fallback bodies across routes.
 */
function hashBody(body) {
  const normalized = body.replace(/\s+/g, " ").trim();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * Checks for generic error or soft-404 markers in response body.
 */
function isErrorOrSoft404(body, statusCode) {
  if (statusCode >= 400) return true;
  if (!body || body.trim().length === 0) return true;

  const lower = body.toLowerCase();
  const errorPatterns = [
    "application error: a client-side exception has occurred",
    "500 internal server error",
    "502 bad gateway",
    "503 service unavailable",
    "504 gateway timeout",
    "this page could not be found",
    "<title>404",
    "cannot get /",
  ];

  return errorPatterns.some((pattern) => lower.includes(pattern));
}

/**
 * Executes a single polite HTTP/HTTPS request with body size cap, stream error guards,
 * and active wall-clock + request abort timers covering start to completion.
 */
function politeRequest(urlStr, options = {}, suiteStartTime, wallTimeoutMs, reqTimeoutMs) {
  return new Promise((resolve) => {
    const elapsedSinceSuiteStart = Date.now() - suiteStartTime;
    const remainingWallMs = wallTimeoutMs - elapsedSinceSuiteStart;

    // Check overall suite wall-clock deadline before starting
    if (remainingWallMs <= 0) {
      return resolve({
        statusCode: 0,
        headers: {},
        body: "",
        latencyMs: 0,
        error: `ABORTED: Exceeded overall wall-clock deadline of ${wallTimeoutMs}ms`,
      });
    }

    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      return resolve({
        statusCode: 0,
        headers: {},
        body: "",
        latencyMs: 0,
        error: `Invalid URL: ${urlStr}`,
      });
    }

    const client = parsed.protocol === "http:" ? http : https;
    const start = Date.now();
    const method = options.method || "GET";
    const postData = options.body || "";

    const reqOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": options.accept || "*/*",
        ...(options.headers || {}),
      },
    };

    if (postData) {
      reqOptions.headers["Content-Type"] = "application/json";
      reqOptions.headers["Content-Length"] = Buffer.byteLength(postData);
    }

    let totalBytes = 0;
    let data = "";
    let completed = false;
    let activeReq = null;
    let activeRes = null;

    let wallTimer = null;
    let reqTimer = null;

    function clearTimers() {
      if (wallTimer) {
        clearTimeout(wallTimer);
        wallTimer = null;
      }
      if (reqTimer) {
        clearTimeout(reqTimer);
        reqTimer = null;
      }
    }

    function finish(resObj) {
      if (completed) return;
      completed = true;
      clearTimers();
      resolve(resObj);
    }

    // Wall-clock abort timer covering the entire request + response lifecycle
    wallTimer = setTimeout(() => {
      if (completed) return;
      if (activeReq && !activeReq.destroyed) {
        activeReq.destroy();
      }
      if (activeRes && !activeRes.destroyed) {
        activeRes.destroy();
      }
      finish({
        statusCode: activeRes?.statusCode || 0,
        headers: activeRes?.headers || {},
        body: data,
        latencyMs: Date.now() - start,
        error: `ABORTED: Exceeded overall wall-clock deadline of ${wallTimeoutMs}ms`,
      });
    }, Math.max(1, remainingWallMs));

    // Per-request timeout timer covering request + response lifecycle
    reqTimer = setTimeout(() => {
      if (completed) return;
      if (activeReq && !activeReq.destroyed) {
        activeReq.destroy();
      }
      if (activeRes && !activeRes.destroyed) {
        activeRes.destroy();
      }
      finish({
        statusCode: activeRes?.statusCode || 0,
        headers: activeRes?.headers || {},
        body: data,
        latencyMs: Date.now() - start,
        error: `Request timed out after ${reqTimeoutMs}ms`,
      });
    }, reqTimeoutMs);

    const req = client.request(reqOptions, (res) => {
      activeRes = res;

      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          req.destroy();
          res.destroy();
          finish({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: data,
            latencyMs: Date.now() - start,
            error: `Response body exceeded size cap of ${MAX_BODY_BYTES} bytes`,
          });
          return;
        }
        data += chunk;
      });

      res.on("end", () => {
        finish({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: data,
          latencyMs: Date.now() - start,
          error: null,
        });
      });

      res.on("error", (err) => {
        finish({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: data,
          latencyMs: Date.now() - start,
          error: `Response stream error: ${err.message}`,
        });
      });
    });

    activeReq = req;

    req.on("error", (err) => {
      finish({
        statusCode: 0,
        headers: {},
        body: "",
        latencyMs: Date.now() - start,
        error: `Transport error: ${err.message}`,
      });
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

/**
 * Runs the full smoke suite sequentially against the target base URL.
 */
async function runSmokeSuite(baseUrl, config = {}) {
  const suiteStartTime = Date.now();
  const wallTimeoutMs = config.wallTimeoutMs || WALL_CLOCK_TIMEOUT_MS;
  const reqTimeoutMs = config.reqTimeoutMs || PER_REQUEST_TIMEOUT_MS;
  const results = [];
  const routeBodyHashes = new Map();
  let suiteAborted = false;

  // Helper for sequential execution; checks deadline and skips remaining if aborted
  async function execCheck(name, label, fn) {
    if (suiteAborted || (Date.now() - suiteStartTime >= wallTimeoutMs)) {
      suiteAborted = true;
      return {
        name,
        label,
        ok: false,
        status: 0,
        latencyMs: 0,
        detail: `ABORTED: Exceeded overall wall-clock deadline of ${wallTimeoutMs}ms (check skipped)`,
      };
    }

    try {
      const res = await fn();
      if (res.detail && res.detail.startsWith("ABORTED: Exceeded overall wall-clock deadline")) {
        suiteAborted = true;
      }
      return { name, label, ...res };
    } catch (err) {
      return {
        name,
        label,
        ok: false,
        status: 0,
        latencyMs: 0,
        detail: `Unexpected error: ${err.message}`,
      };
    }
  }

  // 1. Homepage (/)
  results.push(
    await execCheck(
      "1. Homepage (/)",
      "Shell-only check: verifies root layout and branding HTML shell",
      async () => {
        const res = await politeRequest(`${baseUrl}/`, {}, suiteStartTime, wallTimeoutMs, reqTimeoutMs);
        if (res.error) {
          return { ok: false, status: 0, latencyMs: res.latencyMs, detail: res.error };
        }
        if (res.statusCode !== 200) {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: `Expected HTTP 200, got ${res.statusCode} ${res.headers.location ? `(Location: ${res.headers.location})` : ""}`,
          };
        }
        if (isErrorOrSoft404(res.body, res.statusCode)) {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: "Response flagged as error page or soft-404",
          };
        }

        // Assert route-specific structure
        const hasHtmlRoot = /<html[^>]*>/i.test(res.body);
        const hasMain = /<main[^>]*>/i.test(res.body) || /id="__next"/i.test(res.body);
        const hasBranding = res.body.includes("CareerMonke") || res.body.includes("careermonke");

        if (!hasHtmlRoot || !hasMain || !hasBranding || res.body.length < 500) {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: "Response missing expected homepage root structure, main container, or CareerMonke branding",
          };
        }

        routeBodyHashes.set("home", hashBody(res.body));

        return {
          ok: true,
          status: res.statusCode,
          latencyMs: res.latencyMs,
          detail: `HTTP 200 OK (shell rendered, ${res.body.length} bytes)`,
        };
      }
    )
  );

  // 2. Readiness Probe (/api/health/ready)
  results.push(
    await execCheck(
      "2. Readiness Probe (/api/health/ready)",
      "Shallow read probe: verifies single anonymous select on jobs_public",
      async () => {
        const res = await politeRequest(`${baseUrl}/api/health/ready`, { accept: "application/json" }, suiteStartTime, wallTimeoutMs, reqTimeoutMs);
        if (res.error) {
          return { ok: false, status: 0, latencyMs: res.latencyMs, detail: res.error };
        }
        if (res.statusCode !== 200) {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: `Expected HTTP 200, got ${res.statusCode}: ${res.body.slice(0, 150)}`,
          };
        }

        let json;
        try {
          json = JSON.parse(res.body);
        } catch (e) {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: `Invalid JSON response: ${res.body.slice(0, 100)}`,
          };
        }

        if (json.status !== "ready") {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: `Readiness status degraded: '${json.status}' (checks: ${JSON.stringify(json.checks)})`,
          };
        }

        if (!json.checks || json.checks.env !== "ok" || json.checks.database !== "ok") {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: `Checks degraded (env: ${json.checks?.env}, database: ${json.checks?.database})`,
          };
        }

        return {
          ok: true,
          status: res.statusCode,
          latencyMs: res.latencyMs,
          detail: `HTTP 200 OK (ready: env=ok, database=ok; single jobs_public select verified)`,
        };
      }
    )
  );

  // 3. Public Jobs Feed (/jobs)
  results.push(
    await execCheck(
      "3. Public Jobs Feed (/jobs)",
      "Shell-only check: verifies jobs directory HTML shell (no claim of hydration or live feed)",
      async () => {
        const res = await politeRequest(`${baseUrl}/jobs`, {}, suiteStartTime, wallTimeoutMs, reqTimeoutMs);
        if (res.error) {
          return { ok: false, status: 0, latencyMs: res.latencyMs, detail: res.error };
        }
        if (res.statusCode === 307 || res.statusCode === 302 || res.statusCode === 301) {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: `Redirected to ${res.headers.location || "unknown"} (early-access or auth redirect active; launch requires public 200)`,
          };
        }
        if (res.statusCode !== 200) {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: `Expected HTTP 200, got ${res.statusCode}`,
          };
        }
        if (isErrorOrSoft404(res.body, res.statusCode)) {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: "Response flagged as error page or soft-404",
          };
        }

        // Cross-route duplicate body detection
        const jobsHash = hashBody(res.body);
        if (routeBodyHashes.has("home") && jobsHash === routeBodyHashes.get("home")) {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: "Identical generic fallback HTML body served across distinct routes (/jobs matches /)",
          };
        }
        routeBodyHashes.set("jobs", jobsHash);

        // Assert route-specific structure for jobs directory
        const hasJobsStructure =
          res.body.includes("jobs-skeleton-list") ||
          res.body.includes("JobFilterBar") ||
          res.body.includes("jobs-main-content") ||
          res.body.includes("jobs directory") ||
          res.body.includes("jobs-directory") ||
          res.body.includes("data-testid=\"jobs-main-content\"") ||
          res.body.includes("data-testid=\"jobs-skeleton-list\"");

        if (!hasJobsStructure || res.body.length < 500) {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: "Response missing expected jobs directory structural elements",
          };
        }

        return {
          ok: true,
          status: res.statusCode,
          latencyMs: res.latencyMs,
          detail: `HTTP 200 OK (jobs shell rendered, distinct body, ${res.body.length} bytes)`,
        };
      }
    )
  );

  // 4. Auth Entry Page (/login)
  results.push(
    await execCheck(
      "4. Auth Entry Page (/login)",
      "Shell-only check: verifies login gateway HTML shell (no claim of auth service readiness)",
      async () => {
        const res = await politeRequest(`${baseUrl}/login`, {}, suiteStartTime, wallTimeoutMs, reqTimeoutMs);
        if (res.error) {
          return { ok: false, status: 0, latencyMs: res.latencyMs, detail: res.error };
        }
        if (res.statusCode !== 200) {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: `Expected HTTP 200, got ${res.statusCode} ${res.headers.location ? `(Location: ${res.headers.location})` : ""}`,
          };
        }
        if (isErrorOrSoft404(res.body, res.statusCode)) {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: "Response flagged as error page or soft-404",
          };
        }

        // Cross-route duplicate body detection
        const loginHash = hashBody(res.body);
        if (routeBodyHashes.has("home") && loginHash === routeBodyHashes.get("home")) {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: "Identical generic fallback HTML body served across distinct routes (/login matches /)",
          };
        }
        if (routeBodyHashes.has("jobs") && loginHash === routeBodyHashes.get("jobs")) {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: "Identical generic fallback HTML body served across distinct routes (/login matches /jobs)",
          };
        }
        routeBodyHashes.set("login", loginHash);

        // Assert route-specific login elements
        const hasEmailInput =
          res.body.includes("type=\"email\"") ||
          res.body.includes("name=\"email\"") ||
          res.body.includes("placeholder=\"Email\"");

        const hasLoginAction =
          res.body.includes("Sign in") ||
          res.body.includes("Log in") ||
          res.body.includes("login") ||
          res.body.includes("Magic Link") ||
          res.body.includes("Magic link") ||
          res.body.includes("Google");

        if (!hasEmailInput || !hasLoginAction || res.body.length < 500) {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: "Response missing expected login form elements (email input and auth actions)",
          };
        }

        return {
          ok: true,
          status: res.statusCode,
          latencyMs: res.latencyMs,
          detail: `HTTP 200 OK (login shell rendered, distinct body, ${res.body.length} bytes)`,
        };
      }
    )
  );

  // 5. Payments-OFF Disabled Gate (/api/billing/razorpay/order)
  results.push(
    await execCheck(
      "5. Payments-OFF Gate (/api/billing/razorpay/order)",
      "Non-wallet-bearing probe: observes unauthenticated disabled-gate response (exact 503 + code: 'BILLING_DISABLED')",
      async () => {
        // Dispatches unauthenticated empty POST to live order creation route
        const res = await politeRequest(
          `${baseUrl}/api/billing/razorpay/order`,
          { method: "POST", body: "{}" },
          suiteStartTime,
          wallTimeoutMs,
          reqTimeoutMs
        );
        if (res.error) {
          return { ok: false, status: 0, latencyMs: res.latencyMs, detail: res.error };
        }

        // Live checkout active: HTTP 200 or 201 is a critical security failure
        if (res.statusCode === 200 || res.statusCode === 201) {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: `FAIL: Unexpected HTTP ${res.statusCode} from checkout creation route (payments must be disabled at launch!)`,
          };
        }

        // Must be exactly HTTP 503
        if (res.statusCode !== 503) {
          const snippet = res.body.trim().slice(0, 100);
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: `NOT VERIFIED / inconclusive: returned HTTP ${res.statusCode} ${snippet ? `(${snippet})` : ""}; cannot verify disabled gate (requires exact HTTP 503 with JSON code 'BILLING_DISABLED')`,
          };
        }

        // Parse 503 body as JSON: HTML or plain text containing the string must NOT pass
        let json;
        try {
          json = JSON.parse(res.body);
        } catch {
          const snippet = res.body.trim().slice(0, 100);
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: `FAIL: HTTP 503 body is not valid JSON ${snippet ? `(${snippet})` : ""}; requires JSON object with code === 'BILLING_DISABLED'`,
          };
        }

        // Require code === "BILLING_DISABLED". Missing, wrong, or negated code must NOT pass.
        if (!json || typeof json !== "object" || json.code !== "BILLING_DISABLED") {
          return {
            ok: false,
            status: res.statusCode,
            latencyMs: res.latencyMs,
            detail: `FAIL: HTTP 503 JSON missing expected code 'BILLING_DISABLED' (got code: ${JSON.stringify(json?.code)}); cannot verify disabled gate`,
          };
        }

        return {
          ok: true,
          status: res.statusCode,
          latencyMs: res.latencyMs,
          detail: "HTTP 503 BILLING_DISABLED verified (observed unauthenticated disabled-gate response)",
        };
      }
    )
  );

  return results;
}

function writeJsonReport(baseUrl, results, passedAll, deploySha) {
  const reportsDir = path.resolve(__dirname, "..", "reports", "smoke");
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const filePath = path.join(reportsDir, `smoke-${dateStr}.jsonl`);

  const reportLine = JSON.stringify({
    timestamp: now.toISOString(),
    baseUrl,
    deploySha: deploySha || "unspecified",
    passedAll,
    totalChecks: results.length,
    passedCount: results.filter((r) => r.ok).length,
    failedCount: results.filter((r) => !r.ok).length,
    checks: results.map((r) => ({
      name: r.name,
      label: r.label,
      ok: r.ok,
      status: r.status,
      latencyMs: r.latencyMs,
      detail: r.detail,
    })),
  });

  fs.appendFileSync(filePath, reportLine + "\n", "utf8");
  return filePath;
}

async function main() {
  const { baseUrl, writeJson, deploySha, wallTimeoutMs, reqTimeoutMs } = parseArgs();

  console.log("================================================================================");
  console.log("  CAREERMONKE PRODUCTION POST-DEPLOY SMOKE PROBE (STANDALONE READ-ONLY)         ");
  console.log("================================================================================");
  console.log(`Target Base URL:       ${baseUrl}`);
  console.log(`Deployment SHA:        ${deploySha || "Not specified (use --sha <commit> for operator annotation)"}`);
  console.log(`Execution Mode:        Sequential, polite (timeout ${reqTimeoutMs}ms, wall deadline ${wallTimeoutMs}ms)`);
  console.log(`Execution Time:        ${new Date().toISOString()}`);
  console.log("--------------------------------------------------------------------------------\n");

  const results = await runSmokeSuite(baseUrl, { wallTimeoutMs, reqTimeoutMs });

  let passedCount = 0;
  for (const r of results) {
    const badge = r.ok ? "[PASS]" : "[FAIL]";
    const latency = `${r.latencyMs}ms`.padStart(6);
    console.log(`${badge} ${r.name.padEnd(52)} ${latency}  ${r.detail}`);
    console.log(`       (${r.label})`);
    if (r.ok) passedCount++;
  }

  const passedAll = passedCount === results.length;
  console.log("\n--------------------------------------------------------------------------------");
  console.log(`SUMMARY: ${passedCount}/${results.length} checks passed against ${baseUrl}`);
  console.log("--------------------------------------------------------------------------------");

  if (writeJson) {
    const reportFile = writeJsonReport(baseUrl, results, passedAll, deploySha);
    console.log(`Dated local evidence appended to: ${reportFile}`);
  }

  if (passedAll) {
    console.log("\n================================================================================");
    console.log("VERDICT: PASS (All smoke checks satisfied baseline requirements)");
    console.log("================================================================================");
    process.exit(0);
  } else {
    console.log("\n================================================================================");
    console.log("VERDICT: FAIL (One or more smoke checks failed or inconclusive; see details above)");
    console.log("================================================================================");
    process.exit(1);
  }
}

// Support direct CLI invocation as well as programmatic import
if (require.main === module) {
  main().catch((err) => {
    console.error("FATAL: Unexpected smoke probe execution failure:", err);
    process.exit(1);
  });
}

module.exports = {
  runSmokeSuite,
  politeRequest,
  isErrorOrSoft404,
  hashBody,
  MAX_BODY_BYTES,
  WALL_CLOCK_TIMEOUT_MS,
  PER_REQUEST_TIMEOUT_MS,
};
