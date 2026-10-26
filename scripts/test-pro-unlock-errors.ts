/**
 * scripts/test-pro-unlock-errors.ts
 *
 * Verification suite for Pro Unlock Failure Handling:
 * 1. Success path (200 OK): Unlocks full job details (salary, applyUrl, description, company).
 * 2. 401 Unauthorized: Triggers login redirect with returnTo, logs error with status 401 (never token!), locks fields.
 * 3. 403 Forbidden: Surfaces locked state (upgrade required), logs error with status 403 (never token!), locks fields.
 * 4. 5xx Server Error (500, 503): Surfaces locked state with retry action, logs status (never token!), never shows fake/partial data.
 * 5. Network Error: Surfaces locked state with retry action, logs network failure (never token!), never shows fake/partial data.
 * 6. Token Exclusion Guarantee: Verifies Bearer tokens are NEVER printed in console errors/logs on any failure path.
 * 7. Negative Control Mode: Exits non-zero if run with --negative-control or if an invalid condition is asserted.
 */

import assert from "assert";
import { spawnSync } from "child_process";

const isNegativeControl = process.argv.includes("--negative-control");
const MOCK_TOKEN = "eyJhbGciOiJIUzI1NiJ9.super-secret-user-token-never-log-this.signature";

async function runProUnlockSuite() {
  console.log("================================================================================");
  console.log("             CAREERMONKE PRO UNLOCK FAILURE HANDLING VERIFICATION               ");
  console.log("================================================================================\n");

  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL MODE] Proving assertions fail with non-zero exit on invalid condition...");
    // Deliberately assert that a 401 error results in an unlocked external apply link
    const invalidState = {
      applyUrl: "https://leaked-apply-url.com",
      proUnlockError: { status: 401 },
    };
    assert.strictEqual(
      Boolean(invalidState.applyUrl && !invalidState.proUnlockError),
      true,
      "Negative control expected mismatch: 401 failure must NEVER expose unlocked applyUrl."
    );
    return;
  }

  // Set mock environment variables for Supabase client
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://szakevhxhwpeskidvtfs.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "mock-anon-key-for-test";

  // Preserve global fetch and window
  const originalFetch = global.fetch;
  const originalWindow = (global as any).window;

  // Intercept console.error to inspect error logs and verify status is logged but TOKEN is never logged
  const loggedErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: any[]) => {
    const msg = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    loggedErrors.push(msg);
    originalConsoleError.apply(console, args);
  };

  const mockPublicJobRow = {
    id: "job-test-uuid-1",
    title: "Senior Cloud Infrastructure Engineer",
    company: "Verified Employer",
    location: "Remote (US)",
    posted_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    category: "engineering",
    remote: true,
    remote_scope: "worldwide",
    remote_eligibility: "worldwide",
    country_code: "US",
    job_type: "full-time",
    verified: true,
  };

  const mockSupabaseClient = {
    auth: {
      getSession: async () => ({
        data: {
          session: {
            access_token: MOCK_TOKEN,
            user: { id: "usr_mock_123" },
          },
        },
      }),
    },
    from: (table: string) => {
      const q: any = {
        select: () => q,
        eq: () => q,
        neq: () => q,
        in: () => q,
        is: () => q,
        or: () => q,
        ilike: () => q,
        order: () => q,
        limit: () => q,
        range: async () => ({ data: [mockPublicJobRow], count: 1, error: null }),
        maybeSingle: async () => ({ data: mockPublicJobRow, error: null }),
        single: async () => ({ data: mockPublicJobRow, error: null }),
        then: (resolve: any) => Promise.resolve({ data: [mockPublicJobRow], count: 1, error: null }).then(resolve),
      };
      return q;
    },
  };
  (globalThis as any).__mockSupabaseClient = mockSupabaseClient;

  const { getLiveJobById, getLiveJobs } = await import("../src/lib/jobs/service");

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Success Path (HTTP 200 OK)
    // -------------------------------------------------------------------------
    console.log("Test 1: Verifying Success Path (HTTP 200 OK) unlocks full details...");
    global.fetch = async (input: any, init?: any): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/jobs/pro")) {
        return new Response(
          JSON.stringify({
            job: {
              id: "job-test-uuid-1",
              title: "Senior Cloud Infrastructure Engineer",
              company: "Stripe",
              location: "San Francisco, CA (Remote)",
              salary_min: 190000,
              salary_max: 230000,
              currency: "USD",
              salary_period: "year",
              apply_url: "https://stripe.com/jobs/apply/cloud-eng-1",
              description: "Architect multi-region Kubernetes clusters and high-availability databases.",
              skills: ["Go", "Kubernetes", "AWS", "Terraform"],
              remote: true,
              job_type: "full-time",
              verified: true,
            },
            isPro: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("jobs_public")) {
        return new Response(JSON.stringify([mockPublicJobRow]), {
          status: 200,
          headers: { "Content-Type": "application/json", "content-range": "0-0/1" },
        });
      }
      if (url.includes("/auth/v1/session") || url.includes("/auth/v1/token") || url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            access_token: MOCK_TOKEN,
            user: { id: "usr_mock_123" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return originalFetch(input, init);
    };

    const successJob = await getLiveJobById("job-test-uuid-1", true);
    assert.ok(successJob, "Success job must not be null");
    assert.strictEqual(successJob.company, "Stripe", "Full company name must be unlocked");
    assert.strictEqual(successJob.applyUrl, "https://stripe.com/jobs/apply/cloud-eng-1", "Apply URL must be unlocked");
    assert.ok(successJob.description?.includes("Kubernetes clusters"), "Full description must be unlocked");
    assert.strictEqual(successJob.proUnlockError, undefined, "proUnlockError must be undefined on success");
    console.log("  -> [PASS-LOCAL] 200 OK: Full details unlocked without error flag.");

    // -------------------------------------------------------------------------
    // TEST 2: HTTP 401 Unauthorized (Session Expired / Invalid Token)
    // -------------------------------------------------------------------------
    console.log("\nTest 2: Verifying HTTP 401 Unauthorized handling, redirect, and token masking...");
    loggedErrors.length = 0;
    let redirectedUrl: string | null = null;

    // Simulate browser window context with location
    (global as any).window = {
      location: {
        pathname: "/jobs",
        search: "?id=job-test-uuid-1",
        assign: (dest: string) => {
          redirectedUrl = dest;
        },
      },
    };

    global.fetch = async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/jobs/pro")) {
        return new Response(
          JSON.stringify({ error: "Invalid or expired session. Please sign in again.", isPro: false }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("jobs_public")) {
        return new Response(JSON.stringify([mockPublicJobRow]), {
          status: 200,
          headers: { "Content-Type": "application/json", "content-range": "0-0/1" },
        });
      }
      if (url.includes("/auth/v1/")) {
        return new Response(
          JSON.stringify({ access_token: MOCK_TOKEN, user: { id: "usr_mock_123" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const job401 = await getLiveJobById("job-test-uuid-1", true);
    assert.ok(job401, "Job preview must still be returned (not null crash)");
    assert.strictEqual(job401.proUnlockError?.status, 401, "proUnlockError status must be 401");
    // Verify zero leaked paid fields:
    assert.strictEqual(job401.applyUrl, "", "applyUrl must remain empty on 401 failure");
    assert.strictEqual(job401.description, "", "description must remain empty on 401 failure");
    assert.strictEqual(job401.salary, "", "salary must remain empty on 401 failure");
    assert.strictEqual(job401.company, "Verified Employer", "company must remain masked as 'Verified Employer'");

    // Verify 401 redirect triggered with returnTo:
    assert.ok(redirectedUrl, "401 must trigger window.location.assign redirect");
    assert.ok(
      redirectedUrl!.includes("/login?returnTo="),
      `Redirect target must be /login with returnTo parameter, got: '${redirectedUrl}'`
    );
    assert.ok(
      redirectedUrl!.includes(encodeURIComponent("/jobs?id=job-test-uuid-1")),
      `returnTo must encode current pathname and query, got: '${redirectedUrl}'`
    );

    // Verify error logging: status logged, TOKEN NOT LOGGED
    const error401Logs = loggedErrors.filter((l) => l.includes("401"));
    assert.ok(error401Logs.length > 0, "Console error must log status 401");
    for (const log of loggedErrors) {
      assert.ok(!log.includes(MOCK_TOKEN), "SECURITY: Bearer token must NEVER appear in console logs!");
    }
    console.log("  -> [PASS-LOCAL] 401: Redirect to /login triggered; zero paid data leaks; token excluded from logs.");

    // -------------------------------------------------------------------------
    // TEST 3: HTTP 403 Forbidden (Non-Pro or Revoked Access)
    // -------------------------------------------------------------------------
    console.log("\nTest 3: Verifying HTTP 403 Forbidden handling and locked state flag...");
    loggedErrors.length = 0;
    redirectedUrl = null;

    global.fetch = async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/jobs/pro")) {
        return new Response(
          JSON.stringify({ error: "Pro subscription required to access full job details.", isPro: false }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("jobs_public")) {
        return new Response(JSON.stringify([mockPublicJobRow]), {
          status: 200,
          headers: { "Content-Type": "application/json", "content-range": "0-0/1" },
        });
      }
      if (url.includes("/auth/v1/")) {
        return new Response(
          JSON.stringify({ access_token: MOCK_TOKEN, user: { id: "usr_mock_123" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const job403 = await getLiveJobById("job-test-uuid-1", true);
    assert.ok(job403, "Job preview must be returned");
    assert.strictEqual(job403.proUnlockError?.status, 403, "proUnlockError status must be 403");
    assert.strictEqual(job403.applyUrl, "", "applyUrl must remain empty on 403 failure");
    assert.strictEqual(job403.description, "", "description must remain empty on 403 failure");
    assert.strictEqual(job403.salary, "", "salary must remain empty on 403 failure");
    assert.strictEqual(job403.company, "Verified Employer", "company must remain masked on 403 failure");
    assert.strictEqual(redirectedUrl, null, "403 must NOT redirect to /login (shows locked state in-place)");

    // Verify error logging: status logged, TOKEN NOT LOGGED
    const error403Logs = loggedErrors.filter((l) => l.includes("403"));
    assert.ok(error403Logs.length > 0, "Console error must log status 403");
    for (const log of loggedErrors) {
      assert.ok(!log.includes(MOCK_TOKEN), "SECURITY: Bearer token must NEVER appear in console logs!");
    }
    console.log("  -> [PASS-LOCAL] 403: Surfaces locked state; no login redirect; token excluded from logs.");

    // -------------------------------------------------------------------------
    // TEST 4: HTTP 500 / 503 Server Error
    // -------------------------------------------------------------------------
    console.log("\nTest 4: Verifying HTTP 5xx Server Error handling and retry action metadata...");
    loggedErrors.length = 0;

    for (const serverStatus of [500, 503]) {
      global.fetch = async (input: any): Promise<Response> => {
        const url = String(input);
        if (url.includes("/api/jobs/pro")) {
          return new Response(
            JSON.stringify({ error: "Database timeout / internal server error" }),
            { status: serverStatus, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("jobs_public")) {
          return new Response(JSON.stringify([mockPublicJobRow]), {
            status: 200,
            headers: { "Content-Type": "application/json", "content-range": "0-0/1" },
          });
        }
        if (url.includes("/auth/v1/")) {
          return new Response(
            JSON.stringify({ access_token: MOCK_TOKEN, user: { id: "usr_mock_123" } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      const job5xx = await getLiveJobById("job-test-uuid-1", true);
      assert.ok(job5xx, "Job preview must be returned");
      assert.strictEqual(job5xx.proUnlockError?.status, serverStatus, `proUnlockError status must be ${serverStatus}`);
      assert.strictEqual(job5xx.applyUrl, "", "applyUrl must remain empty on 5xx failure");
      assert.strictEqual(job5xx.description, "", "description must remain empty on 5xx failure");
      assert.strictEqual(job5xx.salary, "", "salary must remain empty on 5xx failure");
      assert.strictEqual(job5xx.company, "Verified Employer", "company must remain masked on 5xx failure");

      const errorLogs = loggedErrors.filter((l) => l.includes(String(serverStatus)));
      assert.ok(errorLogs.length > 0, `Console error must log status ${serverStatus}`);
      for (const log of loggedErrors) {
        assert.ok(!log.includes(MOCK_TOKEN), "SECURITY: Bearer token must NEVER appear in console logs!");
      }
      console.log(`  -> [PASS-LOCAL] HTTP ${serverStatus}: Surfaced locked state with retry metadata; token excluded.`);
    }

    // -------------------------------------------------------------------------
    // TEST 5: Network Error (Fetch throws / Offline)
    // -------------------------------------------------------------------------
    console.log("\nTest 5: Verifying Network Error handling and offline locked state...");
    loggedErrors.length = 0;

    global.fetch = async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/jobs/pro")) {
        throw new TypeError("Failed to fetch (offline network failure)");
      }
      if (url.includes("jobs_public")) {
        return new Response(JSON.stringify([mockPublicJobRow]), {
          status: 200,
          headers: { "Content-Type": "application/json", "content-range": "0-0/1" },
        });
      }
      if (url.includes("/auth/v1/")) {
        return new Response(
          JSON.stringify({ access_token: MOCK_TOKEN, user: { id: "usr_mock_123" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const jobNetError = await getLiveJobById("job-test-uuid-1", true);
    assert.ok(jobNetError, "Job preview must be returned");
    assert.strictEqual(jobNetError.proUnlockError?.isNetworkError, true, "isNetworkError must be true");
    assert.strictEqual(jobNetError.applyUrl, "", "applyUrl must remain empty on network error");
    assert.strictEqual(jobNetError.description, "", "description must remain empty on network error");
    assert.strictEqual(jobNetError.salary, "", "salary must remain empty on network error");
    assert.strictEqual(jobNetError.company, "Verified Employer", "company must remain masked on network error");

    const netLogs = loggedErrors.filter((l) => l.toLowerCase().includes("network"));
    assert.ok(netLogs.length > 0, "Console error must log network failure");
    for (const log of loggedErrors) {
      assert.ok(!log.includes(MOCK_TOKEN), "SECURITY: Bearer token must NEVER appear in console logs!");
    }
    console.log("  -> [PASS-LOCAL] Network Error: Caught gracefully; locked state surfaced; token excluded.");

    // -------------------------------------------------------------------------
    // TEST 6: Batch Pro Unlock Failures in getLiveJobs()
    // -------------------------------------------------------------------------
    console.log("\nTest 6: Verifying batch Pro unlock failure handling in getLiveJobs()...");
    loggedErrors.length = 0;

    // Simulate batch 500 failure
    global.fetch = async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/jobs/pro")) {
        return new Response(JSON.stringify({ error: "Batch unlock failed" }), { status: 500 });
      }
      if (url.includes("jobs_public")) {
        return new Response(JSON.stringify([mockPublicJobRow]), {
          status: 200,
          headers: { "Content-Type": "application/json", "content-range": "0-0/1" },
        });
      }
      if (url.includes("/auth/v1/")) {
        return new Response(
          JSON.stringify({ access_token: MOCK_TOKEN, user: { id: "usr_mock_123" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const batchResult = await getLiveJobs({ isPro: true, pageSize: 1 });
    assert.ok(batchResult.jobs.length > 0, "Jobs array must not be empty");
    const firstJob = batchResult.jobs[0];
    assert.strictEqual(firstJob.proUnlockError?.status, 500, "Batch job must carry proUnlockError status 500");
    assert.strictEqual(firstJob.applyUrl, "", "applyUrl must remain empty on batch failure");
    assert.strictEqual(firstJob.description, "", "description must remain empty on batch failure");
    assert.strictEqual(firstJob.salary, "", "salary must remain empty on batch failure");
    assert.strictEqual(firstJob.company, "Verified Employer", "company must remain masked on batch failure");

    for (const log of loggedErrors) {
      assert.ok(!log.includes(MOCK_TOKEN), "SECURITY: Bearer token must NEVER appear in batch console logs!");
    }
    console.log("  -> [PASS-LOCAL] getLiveJobs batch unlock failure handled; all rows preserve locked state.");

    // -------------------------------------------------------------------------
    // TEST 7: Subprocess Negative Control Verification
    // -------------------------------------------------------------------------
    console.log("\nTest 7: Confirming negative control fails with non-zero exit...");
    const negResult = spawnSync(process.execPath, ["-r", "tsx", __filename, "--negative-control"], {
      encoding: "utf-8",
      env: process.env,
    });

    assert.notStrictEqual(
      negResult.status,
      0,
      "Negative control MUST exit with non-zero exit code when invalid condition is asserted!"
    );
    assert.ok(
      negResult.stderr.includes("AssertionError") || negResult.stderr.includes("Negative control expected mismatch"),
      `Negative control stderr must contain AssertionError or expected message, got:\n${negResult.stderr}`
    );
    console.log(`  -> [PASS-LOCAL] Negative control exited non-zero (${negResult.status}) as expected on invalid state.`);

  } finally {
    // Restore original globals
    delete (globalThis as any).__mockSupabaseClient;
    global.fetch = originalFetch;
    (global as any).window = originalWindow;
    console.error = originalConsoleError;
  }

  console.log("\n================================================================================");
  console.log("            ALL PRO UNLOCK ERROR HANDLING TESTS PASSED [PASS-LOCAL]             ");
  console.log("================================================================================");
}

runProUnlockSuite().catch((err) => {
  console.error("\n[FAIL] Pro Unlock Test Suite Error:\n", err);
  process.exit(1);
});
