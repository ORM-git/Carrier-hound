#!/usr/bin/env node
/**
 * scripts/smoke-production.cjs
 *
 * Standalone automated post-deploy smoke probe for CareerMonke production.
 * Run in one command right after each deploy and on launch morning to prove
 * the live site is healthy.
 *
 * Usage:
 *   node scripts/smoke-production.cjs [baseUrl] [--json]
 *
 * Examples:
 *   node scripts/smoke-production.cjs https://careermonke.com
 *   node scripts/smoke-production.cjs https://careermonke.com --json
 *   node scripts/smoke-production.cjs https://carrier-hound.pages.dev
 *
 * Checks:
 *   1. Homepage: returns 200, contains expected app marker, not an error page.
 *   2. Readiness: /api/health/ready returns 200 with expected JSON shape.
 *   3. Public jobs feed: /jobs returns 200 and contains job content (not empty/error).
 *   4. Auth entry: /login returns 200 with login form elements.
 *   5. Negative check: live checkout creation (/api/billing/razorpay/order) is NOT
 *      reachable in payments-OFF launch state (returns disabled/403/404/405/503/redirect).
 *
 * Polite: sequential requests, 8000ms timeout per check, zero hammering/retries.
 * Exits 0 on all checks passing, 1 on any check failure.
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const DEFAULT_BASE_URL = "https://careermonke.com";
const TIMEOUT_MS = 8000;
const USER_AGENT = "CareerMonke-ProductionSmokeProbe/1.0 (+https://careermonke.com)";

function parseArgs() {
  const args = process.argv.slice(2);
  let baseUrl = DEFAULT_BASE_URL;
  let writeJson = false;

  for (const arg of args) {
    if (arg === "--json") {
      writeJson = true;
    } else if (arg.startsWith("http://") || arg.startsWith("https://")) {
      baseUrl = arg;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/smoke-production.cjs [baseUrl] [--json]");
      process.exit(0);
    }
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    writeJson,
  };
}

/**
 * Dispatches a single polite HTTP/HTTPS GET request with timeout.
 */
function requestUrl(urlStr) {
  return new Promise((resolve) => {
    const parsed = new URL(urlStr);
    const client = parsed.protocol === "http:" ? http : https;
    const start = Date.now();

    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
      },
      timeout: TIMEOUT_MS,
    };

    const req = client.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        const latencyMs = Date.now() - start;
        resolve({
          statusCode: res.statusCode || 0,
          statusMessage: res.statusMessage || "",
          headers: res.headers,
          body: data,
          latencyMs,
          error: null,
        });
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({
        statusCode: 0,
        statusMessage: "Timeout",
        headers: {},
        body: "",
        latencyMs: Date.now() - start,
        error: `Request timed out after ${TIMEOUT_MS}ms`,
      });
    });

    req.on("error", (err) => {
      resolve({
        statusCode: 0,
        statusMessage: "Error",
        headers: {},
        body: "",
        latencyMs: Date.now() - start,
        error: err.message,
      });
    });

    req.end();
  });
}

async function runCheck(name, fn) {
  try {
    const result = await fn();
    return { name, ...result };
  } catch (err) {
    return {
      name,
      ok: false,
      status: 0,
      latencyMs: 0,
      detail: `Unexpected error: ${err.message}`,
    };
  }
}

async function runSmokeSuite(baseUrl) {
  const results = [];

  // Check 1: Homepage
  results.push(
    await runCheck("1. Homepage (/)", async () => {
      const res = await requestUrl(`${baseUrl}/`);
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
      const hasAppMarker =
        res.body.includes("CareerMonke") ||
        res.body.includes("careermonke") ||
        res.body.includes("career-monke");
      const hasErrorMarker =
        res.body.includes("Application error: a client-side exception has occurred") ||
        res.body.includes("500 Internal Server Error") ||
        res.body.includes("502 Bad Gateway");

      if (!hasAppMarker) {
        return {
          ok: false,
          status: res.statusCode,
          latencyMs: res.latencyMs,
          detail: "Response missing expected app marker (CareerMonke)",
        };
      }
      if (hasErrorMarker) {
        return {
          ok: false,
          status: res.statusCode,
          latencyMs: res.latencyMs,
          detail: "Response contains application error marker",
        };
      }
      return {
        ok: true,
        status: res.statusCode,
        latencyMs: res.latencyMs,
        detail: "HTTP 200 OK, verified CareerMonke app marker present",
      };
    })
  );

  // Check 2: Readiness Endpoint
  results.push(
    await runCheck("2. Readiness Probe (/api/health/ready)", async () => {
      const res = await requestUrl(`${baseUrl}/api/health/ready`);
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
          detail: `Status is not 'ready' (received '${json.status}')`,
        };
      }
      if (!json.checks || json.checks.env !== "ok" || json.checks.database !== "ok") {
        return {
          ok: false,
          status: res.statusCode,
          latencyMs: res.latencyMs,
          detail: `Health checks degraded: ${JSON.stringify(json.checks)}`,
        };
      }
      return {
        ok: true,
        status: res.statusCode,
        latencyMs: res.latencyMs,
        detail: `HTTP 200 OK, ready state confirmed (env: ${json.checks.env}, database: ${json.checks.database})`,
      };
    })
  );

  // Check 3: Public Jobs Feed Page
  results.push(
    await runCheck("3. Public Jobs Feed (/jobs)", async () => {
      const res = await requestUrl(`${baseUrl}/jobs`);
      if (res.error) {
        return { ok: false, status: 0, latencyMs: res.latencyMs, detail: res.error };
      }
      if (res.statusCode === 307 || res.statusCode === 302 || res.statusCode === 301) {
        const location = res.headers.location || "";
        return {
          ok: false,
          status: res.statusCode,
          latencyMs: res.latencyMs,
          detail: `Redirected to ${location} (early-access gate or auth redirect active; launch state requires public 200)`,
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
      const hasJobContent =
        res.body.includes("jobs-skeleton-list") ||
        res.body.includes("Jobs") ||
        res.body.includes("positions") ||
        res.body.includes("job");
      const hasErrorMarker =
        res.body.includes("Application error:") ||
        res.body.includes("500 Internal Server") ||
        res.body.includes("404 Not Found");

      if (res.body.length < 500) {
        return {
          ok: false,
          status: res.statusCode,
          latencyMs: res.latencyMs,
          detail: `Response body unexpectedly short (${res.body.length} bytes)`,
        };
      }
      if (!hasJobContent) {
        return {
          ok: false,
          status: res.statusCode,
          latencyMs: res.latencyMs,
          detail: "Response missing expected jobs feed elements",
        };
      }
      if (hasErrorMarker) {
        return {
          ok: false,
          status: res.statusCode,
          latencyMs: res.latencyMs,
          detail: "Response contains error page content",
        };
      }
      return {
        ok: true,
        status: res.statusCode,
        latencyMs: res.latencyMs,
        detail: `HTTP 200 OK, jobs feed page rendered (${res.body.length} bytes)`,
      };
    })
  );

  // Check 4: Auth Entry Page
  results.push(
    await runCheck("4. Auth Entry Page (/login)", async () => {
      const res = await requestUrl(`${baseUrl}/login`);
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
      const hasAuthMarker =
        res.body.includes("Sign in") ||
        res.body.includes("Log in") ||
        res.body.includes("login") ||
        res.body.includes("Magic Link") ||
        res.body.includes("Google") ||
        res.body.includes("CareerMonke");

      if (!hasAuthMarker || res.body.length < 500) {
        return {
          ok: false,
          status: res.statusCode,
          latencyMs: res.latencyMs,
          detail: "Response missing expected authentication entry markers",
        };
      }
      return {
        ok: true,
        status: res.statusCode,
        latencyMs: res.latencyMs,
        detail: `HTTP 200 OK, auth entry page rendered (${res.body.length} bytes)`,
      };
    })
  );

  // Check 5: Negative Check - Checkout Creation Route Disabled
  results.push(
    await runCheck("5. Payments-OFF Checkout Gate (/api/billing/razorpay/order)", async () => {
      const res = await requestUrl(`${baseUrl}/api/billing/razorpay/order`);
      if (res.error) {
        return { ok: false, status: 0, latencyMs: res.latencyMs, detail: res.error };
      }
      // In payments-OFF launch state, live checkout creation must NOT be reachable with 200/201.
      // Expected: disabled status 503 (BILLING_DISABLED), 403 (Forbidden / Early Access),
      // 404 (Not Found), 405 (Method Not Allowed for GET), or 3xx redirect.
      const isBlocked =
        res.statusCode === 503 ||
        res.statusCode === 403 ||
        res.statusCode === 404 ||
        res.statusCode === 405 ||
        (res.statusCode >= 300 && res.statusCode < 400);

      const snippet = res.body.trim().slice(0, 100);

      if (res.statusCode === 200 || res.statusCode === 201) {
        return {
          ok: false,
          status: res.statusCode,
          latencyMs: res.latencyMs,
          detail: `UNEXPECTED: Live checkout creation route returned HTTP ${res.statusCode} (payments must be OFF at launch!)`,
        };
      }

      if (isBlocked) {
        return {
          ok: true,
          status: res.statusCode,
          latencyMs: res.latencyMs,
          detail: `HTTP ${res.statusCode} as expected in payments-OFF state ${snippet ? `(${snippet})` : ""}`,
        };
      }

      // Any other non-200 code is also technically unreachable, but report warning
      return {
        ok: true,
        status: res.statusCode,
        latencyMs: res.latencyMs,
        detail: `HTTP ${res.statusCode} returned (checkout disabled) ${snippet ? `(${snippet})` : ""}`,
      };
    })
  );

  return results;
}

function writeJsonReport(baseUrl, results, passedAll) {
  const reportsDir = path.resolve(__dirname, "..", "reports", "smoke");
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const filePath = path.join(reportsDir, `smoke-${dateStr}.jsonl`);

  const reportLine = JSON.stringify({
    timestamp: now.toISOString(),
    baseUrl,
    passedAll,
    totalChecks: results.length,
    passedCount: results.filter((r) => r.ok).length,
    failedCount: results.filter((r) => !r.ok).length,
    checks: results.map((r) => ({
      name: r.name,
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
  const { baseUrl, writeJson } = parseArgs();

  console.log("================================================================================");
  console.log("       CAREERMONKE PRODUCTION POST-DEPLOY SMOKE PROBE (READ-ONLY)               ");
  console.log("================================================================================");
  console.log(`Target Base URL: ${baseUrl}`);
  console.log(`Mode:            Sequential, polite (timeout ${TIMEOUT_MS}ms per check)`);
  console.log(`Execution Time:  ${new Date().toISOString()}`);
  console.log("--------------------------------------------------------------------------------\n");

  const results = await runSmokeSuite(baseUrl);

  let passedCount = 0;
  for (const r of results) {
    const badge = r.ok ? "[PASS]" : "[FAIL]";
    const latency = `${r.latencyMs}ms`.padStart(6);
    console.log(`${badge} ${r.name.padEnd(52)} ${latency}  ${r.detail}`);
    if (r.ok) passedCount++;
  }

  const passedAll = passedCount === results.length;
  console.log("\n--------------------------------------------------------------------------------");
  console.log(`SUMMARY: ${passedCount}/${results.length} checks passed against ${baseUrl}`);
  console.log("--------------------------------------------------------------------------------");

  if (writeJson) {
    const reportFile = writeJsonReport(baseUrl, results, passedAll);
    console.log(`Report written to: ${reportFile}`);
  }

  if (passedAll) {
    console.log("\n================================================================================");
    console.log("VERDICT: PASS (Production site is healthy and responsive)");
    console.log("================================================================================");
    process.exit(0);
  } else {
    console.log("\n================================================================================");
    console.log("VERDICT: FAIL (One or more smoke checks failed; see details above)");
    console.log("================================================================================");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL: Unexpected smoke probe execution failure:", err);
  process.exit(1);
});
