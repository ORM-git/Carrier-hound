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
 *   6. Billing checks & negative controls (parse JSON, require code === 'BILLING_DISABLED'):
 *      - 503 with HTML containing string fails.
 *      - 503 with plain text containing string fails.
 *      - 503 with malformed JSON fails.
 *      - 503 with missing code fails.
 *      - 503 with wrong code fails.
 *      - 503 with negated code fails.
 *      - 401, 403, 404, 405, 302 redirect, 500 fail (inconclusive / NOT VERIFIED).
 *      - 200 live checkout fails.
 *   7. Per-request timeout handling (exit code 1).
 *   8. Transport failure handling (socket destroyed, exit code 1).
 *   9. Wall-clock abort deadline:
 *      - Slow headers aborts within elapsed bound.
 *      - Drip body (12 bytes every 20ms with 40-50ms wall budget) aborts within elapsed bound.
 *      - Request starting just before suite deadline aborts within elapsed bound and skips later checks.
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
    const startTime = Date.now();
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
      const elapsedMs = Date.now() - startTime;
      resolve({
        exitCode: code,
        stdout,
        stderr,
        elapsedMs,
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
        t1.stdout.includes("observed unauthenticated disabled-gate response") &&
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
    // Test 6: Comprehensive Billing Gate Controls & Non-Pass Cases
    // -------------------------------------------------------------------------

    // 6a: Billing 503 with HTML containing "BILLING_DISABLED" (Must NOT pass)
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/billing/razorpay/order") {
        res.writeHead(503, { "Content-Type": "text/html" });
        res.end("<!DOCTYPE html><html><body><h1>503</h1><p>BILLING_DISABLED</p></body></html>");
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };
    const t6_html = await runSmokeCli(fixturePort);
    assertTest(
      "6a. Billing HTML body: 503 HTML containing string fails JSON parse requirement",
      t6_html.exitCode !== 0 &&
        t6_html.stdout.includes("HTTP 503 body is not valid JSON") &&
        t6_html.stdout.includes("VERDICT: FAIL"),
      `Expected HTML 503 to fail, got: ${t6_html.stdout}`
    );

    // 6b: Billing 503 with plain text containing "BILLING_DISABLED" (Must NOT pass)
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/billing/razorpay/order") {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("BILLING_DISABLED");
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };
    const t6_text = await runSmokeCli(fixturePort);
    assertTest(
      "6b. Billing text body: 503 plain text containing string fails JSON requirement",
      t6_text.exitCode !== 0 &&
        t6_text.stdout.includes("HTTP 503 body is not valid JSON") &&
        t6_text.stdout.includes("VERDICT: FAIL"),
      `Expected plain text 503 to fail, got: ${t6_text.stdout}`
    );

    // 6c: Billing 503 with malformed JSON (Must NOT pass)
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/billing/razorpay/order") {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end('{"error": "Unavailable", "code": "BILLING_DISABLED"'); // missing closing brace
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };
    const t6_malformed = await runSmokeCli(fixturePort);
    assertTest(
      "6c. Billing malformed JSON: 503 malformed JSON fails with non-zero exit code",
      t6_malformed.exitCode !== 0 &&
        t6_malformed.stdout.includes("HTTP 503 body is not valid JSON") &&
        t6_malformed.stdout.includes("VERDICT: FAIL"),
      `Expected malformed JSON 503 to fail, got: ${t6_malformed.stdout}`
    );

    // 6d: Billing 503 with missing code field (Must NOT pass)
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/billing/razorpay/order") {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Billing is disabled", reason: "maintenance" }));
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };
    const t6_missing_code = await runSmokeCli(fixturePort);
    assertTest(
      "6d. Billing missing code: 503 JSON without code field fails with non-zero exit code",
      t6_missing_code.exitCode !== 0 &&
        t6_missing_code.stdout.includes("missing expected code 'BILLING_DISABLED'") &&
        t6_missing_code.stdout.includes("VERDICT: FAIL"),
      `Expected missing code to fail, got: ${t6_missing_code.stdout}`
    );

    // 6e: Billing 503 with wrong code (Must NOT pass)
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/billing/razorpay/order") {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unavailable", code: "DATABASE_OVERLOAD" }));
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };
    const t6_wrong_code = await runSmokeCli(fixturePort);
    assertTest(
      "6e. Billing wrong code: 503 JSON with wrong code fails with non-zero exit code",
      t6_wrong_code.exitCode !== 0 &&
        t6_wrong_code.stdout.includes("missing expected code 'BILLING_DISABLED'") &&
        t6_wrong_code.stdout.includes("VERDICT: FAIL"),
      `Expected wrong code to fail, got: ${t6_wrong_code.stdout}`
    );

    // 6f: Billing 503 with negated code (Must NOT pass)
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/billing/razorpay/order") {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Active", code: "NOT_BILLING_DISABLED" }));
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };
    const t6_negated_code = await runSmokeCli(fixturePort);
    assertTest(
      "6f. Billing negated code: 503 JSON with 'NOT_BILLING_DISABLED' fails with non-zero exit code",
      t6_negated_code.exitCode !== 0 &&
        t6_negated_code.stdout.includes("missing expected code 'BILLING_DISABLED'") &&
        t6_negated_code.stdout.includes("VERDICT: FAIL"),
      `Expected negated code to fail, got: ${t6_negated_code.stdout}`
    );

    // 6g: Billing 405 Method Not Allowed (Must NOT pass)
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/billing/razorpay/order") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method Not Allowed" }));
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };
    const t6_405 = await runSmokeCli(fixturePort);
    assertTest(
      "6g. Billing 405: Method Not Allowed is marked inconclusive and fails with non-zero exit code",
      t6_405.exitCode !== 0 &&
        t6_405.stdout.includes("NOT VERIFIED / inconclusive: returned HTTP 405") &&
        t6_405.stdout.includes("VERDICT: FAIL"),
      `Expected 405 to fail, got: ${t6_405.stdout}`
    );

    // 6h: Billing 404 Not Found (Must NOT pass)
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/billing/razorpay/order") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Route Not Found" }));
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };
    const t6_404 = await runSmokeCli(fixturePort);
    assertTest(
      "6h. Billing 404: Not Found is marked inconclusive and fails with non-zero exit code",
      t6_404.exitCode !== 0 &&
        t6_404.stdout.includes("NOT VERIFIED / inconclusive: returned HTTP 404") &&
        t6_404.stdout.includes("VERDICT: FAIL"),
      `Expected 404 to fail, got: ${t6_404.stdout}`
    );

    // 6i: Billing 302/307 Redirect (Must NOT pass)
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/billing/razorpay/order") {
        res.writeHead(302, { Location: "/login" });
        res.end();
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };
    const t6_redirect = await runSmokeCli(fixturePort);
    assertTest(
      "6i. Billing redirect: HTTP 302 redirect is marked inconclusive and fails with non-zero exit code",
      t6_redirect.exitCode !== 0 &&
        t6_redirect.stdout.includes("NOT VERIFIED / inconclusive: returned HTTP 302") &&
        t6_redirect.stdout.includes("VERDICT: FAIL"),
      `Expected 302 redirect to fail, got: ${t6_redirect.stdout}`
    );

    // 6j: Billing 500 Internal Server Error (Must NOT pass)
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/billing/razorpay/order") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };
    const t6_500 = await runSmokeCli(fixturePort);
    assertTest(
      "6j. Billing 500: Internal Server Error is marked inconclusive and fails with non-zero exit code",
      t6_500.exitCode !== 0 &&
        t6_500.stdout.includes("NOT VERIFIED / inconclusive: returned HTTP 500") &&
        t6_500.stdout.includes("VERDICT: FAIL"),
      `Expected 500 to fail, got: ${t6_500.stdout}`
    );

    // 6k: Billing 401 Unauthorized (Must NOT pass)
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/billing/razorpay/order") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };
    const t6_401 = await runSmokeCli(fixturePort);
    assertTest(
      "6k. Billing 401: Unauthorized is marked inconclusive and fails with non-zero exit code",
      t6_401.exitCode !== 0 &&
        t6_401.stdout.includes("NOT VERIFIED / inconclusive: returned HTTP 401") &&
        t6_401.stdout.includes("VERDICT: FAIL"),
      `Expected 401 to fail, got: ${t6_401.stdout}`
    );

    // 6l: Billing 403 Forbidden (Must NOT pass)
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/billing/razorpay/order") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Early access only" }));
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };
    const t6_403 = await runSmokeCli(fixturePort);
    assertTest(
      "6l. Billing 403: Early access intercept is marked inconclusive and fails with non-zero exit code",
      t6_403.exitCode !== 0 &&
        t6_403.stdout.includes("NOT VERIFIED / inconclusive: returned HTTP 403") &&
        t6_403.stdout.includes("VERDICT: FAIL"),
      `Expected 403 to fail, got: ${t6_403.stdout}`
    );

    // 6m: Billing 200 Order Created (Must NOT pass - Live Checkout Security Violation)
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/api/billing/razorpay/order") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "order_mock123", amount: 50000 }));
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };
    const t6_200 = await runSmokeCli(fixturePort);
    assertTest(
      "6m. Billing 200: Live checkout response fails with non-zero exit code",
      t6_200.exitCode !== 0 &&
        t6_200.stdout.includes("Unexpected HTTP 200 from checkout creation route") &&
        t6_200.stdout.includes("VERDICT: FAIL"),
      `Expected 200 live checkout to fail, got: ${t6_200.stdout}`
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
    // Test 9a: Wall-clock deadline: Slow headers aborts within elapsed bound
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/") {
        // Delay headers by 250ms with a wall budget of 60ms
        setTimeout(() => {
          try {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(VALID_HOME_BODY);
          } catch (_) {}
        }, 250);
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };

    const t9a = await runSmokeCli(fixturePort, ["--wall-timeout", "60", "--timeout", "2000"]);
    assertTest(
      "9a. Wall-clock deadline (slow headers): Aborts within elapsed bound (~60ms) and fails",
      t9a.exitCode !== 0 &&
        t9a.stdout.includes("ABORTED: Exceeded overall wall-clock deadline") &&
        t9a.stdout.includes("VERDICT: FAIL") &&
        t9a.elapsedMs >= 45 &&
        t9a.elapsedMs < 600,
      `Expected slow headers to abort near 60ms, took ${t9a.elapsedMs}ms, exitCode: ${t9a.exitCode}`
    );

    // -------------------------------------------------------------------------
    // Test 9b: Wall-clock deadline: Drip body (12 bytes every 20ms with 40-50ms budget)
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        const interval = setInterval(() => {
          try {
            res.write("123456789012"); // 12 bytes
          } catch (_) {
            clearInterval(interval);
          }
        }, 20);

        req.on("close", () => clearInterval(interval));
        res.on("close", () => clearInterval(interval));
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };

    const t9b = await runSmokeCli(fixturePort, ["--wall-timeout", "50", "--timeout", "2000"]);
    assertTest(
      "9b. Wall-clock deadline (drip body): 12 bytes/20ms aborts within elapsed bound (~50ms) and fails",
      t9b.exitCode !== 0 &&
        t9b.stdout.includes("ABORTED: Exceeded overall wall-clock deadline") &&
        t9b.stdout.includes("VERDICT: FAIL") &&
        t9b.elapsedMs >= 40 &&
        t9b.elapsedMs < 600,
      `Expected drip body to abort near 50ms, took ${t9b.elapsedMs}ms, exitCode: ${t9b.exitCode}`
    );

    // -------------------------------------------------------------------------
    // Test 9c: Wall-clock deadline: Request starting just before suite deadline
    // -------------------------------------------------------------------------
    activeHandler = (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${fixturePort}`);
      if (url.pathname === "/") {
        // Fast response for check 1 (~20ms)
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(VALID_HOME_BODY);
        }, 20);
        return;
      } else if (url.pathname === "/api/health/ready") {
        // Starts with ~30ms remaining of an 60ms wall budget; server delays by 300ms
        setTimeout(() => {
          try {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(READY_OK_JSON);
          } catch (_) {}
        }, 300);
        return;
      }
      defaultValidHandler(req, res, fixturePort);
    };

    const t9c = await runSmokeCli(fixturePort, ["--wall-timeout", "70", "--timeout", "2000"]);
    assertTest(
      "9c. Wall-clock deadline (request near deadline): In-flight probe aborts at remaining wall budget and skips later checks",
      t9c.exitCode !== 0 &&
        t9c.stdout.includes("1. Homepage (/)") &&
        t9c.stdout.includes("2. Readiness Probe (/api/health/ready)") &&
        t9c.stdout.includes("ABORTED: Exceeded overall wall-clock deadline") &&
        t9c.stdout.includes("(check skipped)") &&
        t9c.stdout.includes("VERDICT: FAIL") &&
        t9c.elapsedMs >= 60 &&
        t9c.elapsedMs < 600,
      `Expected check 2 to abort at remaining deadline and skip checks 3-5, took ${t9c.elapsedMs}ms, exitCode: ${t9c.exitCode}`
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
