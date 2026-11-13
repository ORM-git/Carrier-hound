#!/usr/bin/env node
/**
 * scripts/test-smoke-production.cjs
 *
 * Standalone offline test suite for scripts/smoke-production.cjs.
 * Uses an in-memory local HTTP fixture server to thoroughly verify:
 *   1. Valid baseline responses (exit code 0, all 5 checks pass).
 *   2. Redirect handling (e.g. 307 /early-access, exit code 1).
 *   3. Cross-route identical generic fallback detection (exit code 1).
 *   4. Soft-404 and wrong bodies detection (exit code 1).
 *   5. Degraded /api/health/ready payload detection (exit code 1).
 *   6. Billing enabled/unknown statuses (401, 403, 200; exit code 1, marked NOT VERIFIED / FAIL).
 *   7. Per-request timeout handling (exit code 1).
 *   8. Transport failure handling (socket destroyed, exit code 1).
 *   9. Wall-clock abort deadline (exit code 1).
 *  10. Response body size cap (512KB cap exceeded, exit code 1).
 *  11. Dated JSON report output and deployment SHA parameter.
 *
 * Usage:
 *   node scripts/test-smoke-production.cjs
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const SMOKE_SCRIPT = path.resolve(__dirname, "smoke-production.cjs");

// Reusable mock HTML templates (> 500 characters, distinct hashes)
function createMockHtml(title, mainContent, extraClasses = "") {
  return `<!DOCTYPE html>
<html lang="en" class="${extraClasses}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} | CareerMonke</title>
  <style>body { font-family: sans-serif; margin: 0; padding: 20px; }</style>
</head>
<body>
  <div id="__next">
    <header>
      <nav aria-label="Main Navigation">
        <a href="/" class="brand">CareerMonke</a>
        <a href="/jobs">Jobs</a>
        <a href="/login">Sign in</a>
      </nav>
    </header>
    <main role="main" class="container">
      ${mainContent}
    </main>
    <footer>
      <p>&copy; 2026 CareerMonke. Verified company ATS feeds refreshed every 15 minutes.</p>
    </footer>
  </div>
</body>
</html>`;
}

const VALID_HOME_BODY = createMockHtml(
  "Home",
  `<h1>CareerMonke Home</h1>
   <p>High-signal curated job search without the noise.</p>
   <section class="features">
     <div>Real ATS feeds direct to company career portals.</div>
     <div>Zero ghost listings, zero paid sponsor priority.</div>
   </section>`
);

const VALID_JOBS_BODY = createMockHtml(
  "Explore Jobs",
  `<div data-testid="jobs-main-content">
     <h2>Curated Job Directory</h2>
     <div class="JobFilterBar" role="search">
       <input type="text" placeholder="Search roles..." />
     </div>
     <div class="jobs-skeleton-list" data-testid="jobs-skeleton-list">
       <div class="job-card">Software Engineer (Worldwide Remote)</div>
       <div class="job-card">Product Lead (Bangalore)</div>
     </div>
   </div>`
);

const VALID_LOGIN_BODY = createMockHtml(
  "Sign In",
  `<div class="auth-box">
     <h2>Log in to CareerMonke</h2>
     <form method="post" action="/api/auth">
       <label for="email">Email address</label>
       <input type="email" id="email" name="email" placeholder="Email" required />
       <button type="submit">Sign in</button>
       <button type="button">Magic link</button>
       <button type="button">Continue with Google</button>
     </form>
   </div>`
);

const GENERIC_FALLBACK_BODY = createMockHtml(
  "CareerMonke App",
  `<div>Generic Single Page Application Loading State for CareerMonke</div>`
);

const READY_OK_JSON = JSON.stringify({
  status: "ready",
  checks: {
    env: "ok",
    database: "ok",
  },
});

const BILLING_DISABLED_JSON = JSON.stringify({
  error: "Billing is currently unavailable",
  code: "BILLING_DISABLED",
});

function defaultValidHandler(req, res, port) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(VALID_HOME_BODY);
  } else if (req.method === "GET" && url.pathname === "/api/health/ready") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(READY_OK_JSON);
  } else if (req.method === "GET" && url.pathname === "/jobs") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(VALID_JOBS_BODY);
  } else if (req.method === "GET" && url.pathname === "/login") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(VALID_LOGIN_BODY);
  } else if (req.method === "POST" && url.pathname === "/api/billing/razorpay/order") {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(BILLING_DISABLED_JSON);
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
}

let activeHandler = null;

function runSmokeCli(port, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const args = [SMOKE_SCRIPT, `http://127.0.0.1:${port}`, ...extraArgs];
    const child = spawn(process.execPath, args, {
      env: { ...process.env, DEPLOY_SHA: "" },
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

async function runTests() {
  console.log("================================================================================");
  console.log("  CAREERMONKE PRODUCTION SMOKE PROBE OFFLINE FIXTURE TEST SUITE                 ");
  console.log("================================================================================");

  // Start local fixture HTTP server on random free port
  let fixturePort = 0;
  const server = http.createServer((req, res) => {
    if (activeHandler) {
      activeHandler(req, res);
      return;
    }
    defaultValidHandler(req, res, fixturePort);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixturePort = server.address().port;
  console.log(`Local fixture server listening at http://127.0.0.1:${fixturePort}\n`);

  let passedTests = 0;
  let totalTests = 0;

  function assertTest(name, condition, errorMsg = "") {
    totalTests++;
    if (condition) {
      console.log(`[PASS] ${name}`);
      passedTests++;
    } else {
      console.error(`[FAIL] ${name}: ${errorMsg}`);
    }
  }

  try {
    // -------------------------------------------------------------------------
    // Test 1: Valid Baseline Responses (All 5 pass -> Exit code 0)
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => defaultValidHandler(req, res, fixturePort);

    const t1 = await runSmokeCli(fixturePort);
    assertTest(
      "1. Valid responses: All 5 checks pass and exit code is 0",
      t1.exitCode === 0 &&
        t1.stdout.includes("SUMMARY: 5/5 checks passed") &&
        t1.stdout.includes("VERDICT: PASS"),
      `Expected exit code 0 and VERDICT: PASS, got code ${t1.exitCode}\nOutput: ${t1.stdout}`
    );

    // -------------------------------------------------------------------------
    // Test 2: Redirect on /jobs (e.g. 307 /early-access -> Exit code 1)
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/jobs") {
        res.writeHead(307, { Location: "/early-access" });
        res.end();
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };

    const t2 = await runSmokeCli(fixturePort);
    assertTest(
      "2. Redirects: /jobs returning 307 fails with non-zero exit code",
      t2.exitCode !== 0 &&
        t2.stdout.includes("Redirected to /early-access") &&
        t2.stdout.includes("VERDICT: FAIL"),
      `Expected exit code 1 with redirection message, got code ${t2.exitCode}`
    );

    // -------------------------------------------------------------------------
    // Test 3: Same generic fallback served on all paths (Exit code 1)
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/health/ready" || url.pathname === "/api/billing/razorpay/order") {
        defaultValidHandler(req, res, fixturePort);
        return;
      }
      // Return identical generic SPA body for /, /jobs, and /login
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(GENERIC_FALLBACK_BODY);
    };

    const t3 = await runSmokeCli(fixturePort);
    assertTest(
      "3. Cross-route fallback: Identical generic body across distinct routes fails with non-zero exit code",
      t3.exitCode !== 0 &&
        t3.stdout.includes("Identical generic fallback HTML body served across distinct routes") &&
        t3.stdout.includes("VERDICT: FAIL"),
      `Expected duplicate body detection failure, got code ${t3.exitCode}`
    );

    // -------------------------------------------------------------------------
    // Test 4a: Soft-404 error page on /login (Exit code 1)
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/login") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><head><title>404 Not Found</title></head><body>This page could not be found</body></html>`);
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };

    const t4a = await runSmokeCli(fixturePort);
    assertTest(
      "4a. Wrong bodies: Soft-404 page on /login fails with non-zero exit code",
      t4a.exitCode !== 0 &&
        t4a.stdout.includes("Response flagged as error page or soft-404") &&
        t4a.stdout.includes("VERDICT: FAIL"),
      `Expected soft-404 detection failure, got code ${t4a.exitCode}`
    );

    // -------------------------------------------------------------------------
    // Test 4b: Missing route-specific structure on /jobs (Exit code 1)
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/jobs") {
        res.writeHead(200, { "Content-Type": "text/html" });
        // Valid length and valid HTML but missing any jobs skeleton/filter elements
        res.end(createMockHtml("Arbitrary Page", `<p>Arbitrary non-jobs text content without any directory structure.</p>`.repeat(10)));
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };

    const t4b = await runSmokeCli(fixturePort);
    assertTest(
      "4b. Wrong bodies: /jobs missing route structure fails with non-zero exit code",
      t4b.exitCode !== 0 &&
        t4b.stdout.includes("Response missing expected jobs directory structural elements") &&
        t4b.stdout.includes("VERDICT: FAIL"),
      `Expected missing jobs structure failure, got code ${t4b.exitCode}`
    );

    // -------------------------------------------------------------------------
    // Test 5: Degraded /api/health/ready payload (Exit code 1)
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/health/ready") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "not_ready", checks: { env: "ok", database: "fail" } }));
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };

    const t5 = await runSmokeCli(fixturePort);
    assertTest(
      "5. Degraded readiness: status='not_ready' fails with non-zero exit code",
      t5.exitCode !== 0 &&
        t5.stdout.includes("Readiness status degraded: 'not_ready'") &&
        t5.stdout.includes("VERDICT: FAIL"),
      `Expected readiness degraded failure, got code ${t5.exitCode}`
    );

    // -------------------------------------------------------------------------
    // Test 6a: Billing unknown (HTTP 401 Unauthorized -> Exit code 1)
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/billing/razorpay/order") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };

    const t6a = await runSmokeCli(fixturePort);
    assertTest(
      "6a. Billing unknown: HTTP 401 is marked NOT VERIFIED / inconclusive and exits non-zero",
      t6a.exitCode !== 0 &&
        t6a.stdout.includes("NOT VERIFIED / inconclusive: returned HTTP 401") &&
        t6a.stdout.includes("VERDICT: FAIL"),
      `Expected inconclusive billing failure on 401, got code ${t6a.exitCode}`
    );

    // -------------------------------------------------------------------------
    // Test 6b: Billing unknown (HTTP 403 Early access -> Exit code 1)
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/billing/razorpay/order") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Early access only" }));
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };

    const t6b = await runSmokeCli(fixturePort);
    assertTest(
      "6b. Billing unknown: HTTP 403 is marked NOT VERIFIED / inconclusive and exits non-zero",
      t6b.exitCode !== 0 &&
        t6b.stdout.includes("NOT VERIFIED / inconclusive: returned HTTP 403") &&
        t6b.stdout.includes("VERDICT: FAIL"),
      `Expected inconclusive billing failure on 403, got code ${t6b.exitCode}`
    );

    // -------------------------------------------------------------------------
    // Test 6c: Billing live (HTTP 200 Order Created -> Exit code 1)
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/billing/razorpay/order") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "order_mock123", amount: 50000 }));
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };

    const t6c = await runSmokeCli(fixturePort);
    assertTest(
      "6c. Billing live: HTTP 200 from order endpoint fails with non-zero exit code",
      t6c.exitCode !== 0 &&
        t6c.stdout.includes("Unexpected HTTP 200 from checkout creation route") &&
        t6c.stdout.includes("VERDICT: FAIL"),
      `Expected live billing failure, got code ${t6c.exitCode}`
    );

    // -------------------------------------------------------------------------
    // Test 7: Per-request timeout (Exit code 1)
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/") {
        // Intentionally hang without responding
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };

    const t7 = await runSmokeCli(fixturePort, ["--timeout", "200"]);
    assertTest(
      "7. Per-request timeout: Stalled connection fails after timeout with non-zero exit code",
      t7.exitCode !== 0 &&
        t7.stdout.includes("Request timed out after 200ms") &&
        t7.stdout.includes("VERDICT: FAIL"),
      `Expected timeout failure, got code ${t7.exitCode}`
    );

    // -------------------------------------------------------------------------
    // Test 8: Transport failure (Exit code 1)
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => {
      // Abruptly destroy socket to simulate transport error
      req.socket.destroy();
    };

    const t8 = await runSmokeCli(fixturePort);
    assertTest(
      "8. Transport failure: Abrupt socket destruction fails with non-zero exit code",
      t8.exitCode !== 0 &&
        (t8.stdout.includes("Transport error") || t8.stdout.includes("socket hang up")) &&
        t8.stdout.includes("VERDICT: FAIL"),
      `Expected transport error failure, got code ${t8.exitCode}`
    );

    // -------------------------------------------------------------------------
    // Test 9: Wall-clock abort deadline (Exit code 1)
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/") {
        setTimeout(() => {
          defaultValidHandler(req, res, fixturePort);
        }, 150);
      } else if (url.pathname === "/api/health/ready") {
        setTimeout(() => {
          defaultValidHandler(req, res, fixturePort);
        }, 150);
      } else {
        defaultValidHandler(req, res, fixturePort);
      }
    };

    // Set wall deadline to 200ms (check 1 + check 2 will exceed 200ms total)
    const t9 = await runSmokeCli(fixturePort, ["--wall-timeout", "200", "--timeout", "1000"]);
    assertTest(
      "9. Wall-clock deadline: Exceeding wall deadline aborts remaining checks with non-zero exit code",
      t9.exitCode !== 0 &&
        t9.stdout.includes("ABORTED: Exceeded overall wall-clock deadline") &&
        t9.stdout.includes("VERDICT: FAIL"),
      `Expected wall-clock deadline abort, got code ${t9.exitCode}`
    );

    // -------------------------------------------------------------------------
    // Test 10: Body size cap exceeded (>512KB -> Exit code 1)
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        // Stream 600 KB of data
        const chunk = Buffer.alloc(100 * 1024, "a");
        res.write(chunk);
        res.write(chunk);
        res.write(chunk);
        res.write(chunk);
        res.write(chunk);
        res.write(chunk);
        res.end();
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };

    const t10 = await runSmokeCli(fixturePort);
    assertTest(
      "10. Body size cap: Stream exceeding 512KB fails with non-zero exit code",
      t10.exitCode !== 0 &&
        t10.stdout.includes("Response body exceeded size cap") &&
        t10.stdout.includes("VERDICT: FAIL"),
      `Expected body size cap failure, got code ${t10.exitCode}`
    );

    // -------------------------------------------------------------------------
    // Test 11: JSON report writing and deployment SHA flag
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => defaultValidHandler(req, res, fixturePort);

    const testSha = "26b8e575f4351550bbcc2dfcb4dba4b48abf111d";
    const t11 = await runSmokeCli(fixturePort, ["--json", "--sha", testSha]);

    const reportsDir = path.resolve(__dirname, "..", "reports", "smoke");
    const dateStr = new Date().toISOString().slice(0, 10);
    const reportFile = path.join(reportsDir, `smoke-${dateStr}.jsonl`);

    let foundLine = null;
    if (fs.existsSync(reportFile)) {
      const lines = fs.readFileSync(reportFile, "utf8").trim().split("\n");
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.deploySha === testSha && parsed.passedAll === true) {
            foundLine = parsed;
            break;
          }
        } catch (_) {}
      }
    }

    assertTest(
      "11. JSON report: Written with deploySha recorded and passedAll=true",
      t11.exitCode === 0 && foundLine !== null && foundLine.deploySha === testSha,
      `Expected JSON report line with deploySha=${testSha}`
    );

  } finally {
    // Shutdown fixture HTTP server cleanly
    await new Promise((resolve) => server.close(resolve));
    console.log("Local fixture server shut down.\n");
  }

  console.log("--------------------------------------------------------------------------------");
  console.log(`TEST SUITE SUMMARY: ${passedTests}/${totalTests} offline test scenarios passed`);
  console.log("--------------------------------------------------------------------------------");

  if (passedTests === totalTests) {
    console.log("VERDICT: PASS (Offline smoke fixture suite verified)");
    process.exit(0);
  } else {
    console.error("VERDICT: FAIL (One or more offline fixture tests failed)");
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("FATAL: Offline test suite encountered unexpected error:", err);
  process.exit(1);
});
