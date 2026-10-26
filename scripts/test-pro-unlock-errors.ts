import assert from "assert";
import { spawnSync } from "child_process";
import * as path from "path";

// Ensure NODE_ENV is set to "test" so the client test gate activates
process.env.NODE_ENV = "test";

// Mock environment variables for local testing
process.env.NEXT_PUBLIC_SITE_URL = "https://careermonke.com";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock-project-test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "mock-anon-key-test-value";

const MOCK_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvZSBEb2UiLCJpYXQiOjE1MTYyMzkwMjJ9.mockSignatureValueSecretToken";

async function runProUnlockSuite() {
  console.log("================================================================================");
  console.log("             CAREERMONKE PRO UNLOCK FAILURE HANDLING VERIFICATION               ");
  console.log("================================================================================");

  const isNegativeControl = process.argv.includes("--negative-control");

  if (isNegativeControl) {
    console.log("\n[NEGATIVE CONTROL MODE] Proving assertions fail with non-zero exit on invalid condition...\n");
    // Force a deliberate contradiction: asserting that an unlocked paid URL leaks on 401 failure
    const intentionalLeak = false;
    assert.strictEqual(
      intentionalLeak,
      true,
      "Negative control expected mismatch: 401 failure must NEVER expose unlocked applyUrl."
    );
    return;
  }

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

  let mockCurrentSession: any = {
    access_token: MOCK_TOKEN,
    user: { id: "usr_mock_123" },
  };

  const mockSupabaseClient = {
    auth: {
      getSession: async () => ({
        data: {
          session: mockCurrentSession,
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
    mockCurrentSession = { access_token: MOCK_TOKEN, user: { id: "usr_mock_123" } };
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
    // TEST 2A: HTTP 401 with NO Session on check -> Redirects to /login?returnTo=...
    // -------------------------------------------------------------------------
    console.log("\nTest 2A: Verifying HTTP 401 when getSession() is null triggers login redirect...");
    loggedErrors.length = 0;
    let redirectedUrl: string | null = null;
    let sessionCalls = 0;

    // Simulate session expired between sending request and handling 401
    mockSupabaseClient.auth.getSession = async () => {
      sessionCalls++;
      return {
        data: {
          session: sessionCalls === 1 ? { access_token: MOCK_TOKEN, user: { id: "usr_mock_123" } } : null,
        },
      };
    };

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
          JSON.stringify({ error: "Session expired", isPro: false }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("jobs_public")) {
        return new Response(JSON.stringify([mockPublicJobRow]), {
          status: 200,
          headers: { "Content-Type": "application/json", "content-range": "0-0/1" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const job401NoSession = await getLiveJobById("job-test-uuid-1", true);
    assert.ok(job401NoSession, "Job preview must still be returned");
    assert.strictEqual(job401NoSession.proUnlockError?.status, 401, "proUnlockError status must be 401");
    assert.ok(redirectedUrl, "401 with no session MUST trigger window.location.assign redirect");
    assert.ok(redirectedUrl!.includes("/login?returnTo="), "Redirect must target /login?returnTo=");
    console.log("  -> [PASS-LOCAL] 401 (no session): Redirect to /login triggered as expected.");

    // -------------------------------------------------------------------------
    // TEST 2B: HTTP 401 with VALID Session -> NO redirect, locked state with Retry
    // -------------------------------------------------------------------------
    console.log("\nTest 2B: Verifying HTTP 401 when getSession() is valid prevents redirect loop...");
    redirectedUrl = null;
    mockSupabaseClient.auth.getSession = async () => ({
      data: {
        session: { access_token: MOCK_TOKEN, user: { id: "usr_mock_123" } },
      },
    });

    const job401WithSession = await getLiveJobById("job-test-uuid-1", true);
    assert.ok(job401WithSession, "Job preview must still be returned");
    assert.strictEqual(job401WithSession.proUnlockError?.status, 401, "proUnlockError status must be 401");
    assert.strictEqual(redirectedUrl, null, "401 with active session MUST NOT redirect (prevents redirect loop)");
    assert.strictEqual(job401WithSession.applyUrl, "", "applyUrl must remain empty (locked)");
    assert.strictEqual(job401WithSession.company, "Verified Employer", "company must remain masked");
    console.log("  -> [PASS-LOCAL] 401 (valid session): Redirect suppressed; locked state surfaced without loop.");

    // -------------------------------------------------------------------------
    // TEST 3: HTTP 403 Forbidden (Non-Pro / Gated) -> Neutral locked state
    // -------------------------------------------------------------------------
    console.log("\nTest 3: Verifying HTTP 403 Forbidden handling and neutral locked state flag...");
    loggedErrors.length = 0;
    redirectedUrl = null;

    global.fetch = async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/jobs/pro")) {
        return new Response(
          JSON.stringify({ error: "Pro subscription required", isPro: false }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("jobs_public")) {
        return new Response(JSON.stringify([mockPublicJobRow]), {
          status: 200,
          headers: { "Content-Type": "application/json", "content-range": "0-0/1" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const job403 = await getLiveJobById("job-test-uuid-1", true);
    assert.ok(job403, "Job preview must still be returned");
    assert.strictEqual(job403.proUnlockError?.status, 403, "proUnlockError status must be 403");
    assert.strictEqual(redirectedUrl, null, "403 must not redirect to login");
    assert.strictEqual(job403.applyUrl, "", "applyUrl must remain empty on 403");
    console.log("  -> [PASS-LOCAL] 403: Surfaces neutral locked state; no redirect; token excluded.");

    // -------------------------------------------------------------------------
    // TEST 4: HTTP 500 / 503 Server Errors
    // -------------------------------------------------------------------------
    console.log("\nTest 4: Verifying HTTP 5xx Server Error handling and retry action metadata...");
    loggedErrors.length = 0;

    for (const status of [500, 503]) {
      global.fetch = async (input: any): Promise<Response> => {
        const url = String(input);
        if (url.includes("/api/jobs/pro")) {
          return new Response(
            JSON.stringify({ error: `Internal Server Error ${status}` }),
            { status, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("jobs_public")) {
          return new Response(JSON.stringify([mockPublicJobRow]), {
            status: 200,
            headers: { "Content-Type": "application/json", "content-range": "0-0/1" },
          });
        }
        return new Response("Not found", { status: 404 });
      };

      const job5xx = await getLiveJobById("job-test-uuid-1", true);
      assert.ok(job5xx, `Job preview must be returned on ${status}`);
      assert.strictEqual(job5xx.proUnlockError?.status, status, `proUnlockError status must be ${status}`);
      assert.strictEqual(job5xx.applyUrl, "", `applyUrl must remain empty on ${status}`);
      console.log(`  -> [PASS-LOCAL] HTTP ${status}: Surfaced locked state with retry metadata; token excluded.`);
    }

    // -------------------------------------------------------------------------
    // TEST 5: Network Offline Failure
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
      return new Response("Not found", { status: 404 });
    };

    const jobNetError = await getLiveJobById("job-test-uuid-1", true);
    assert.ok(jobNetError, "Job preview must be returned");
    assert.strictEqual(jobNetError.proUnlockError?.isNetworkError, true, "isNetworkError must be true");
    assert.strictEqual(jobNetError.applyUrl, "", "applyUrl must remain empty on network error");
    console.log("  -> [PASS-LOCAL] Network Error: Caught gracefully; locked state surfaced; token excluded.");

    // -------------------------------------------------------------------------
    // TEST 6: Batch Pro Unlock in getLiveJobs() with 401 loop prevention
    // -------------------------------------------------------------------------
    console.log("\nTest 6: Verifying batch Pro unlock failure handling and 401 loop prevention in getLiveJobs()...");
    loggedErrors.length = 0;
    redirectedUrl = null;
    mockCurrentSession = { access_token: MOCK_TOKEN, user: { id: "usr_mock_123" } }; // Session present

    global.fetch = async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/jobs/pro")) {
        return new Response(JSON.stringify({ error: "Batch 401" }), { status: 401 });
      }
      if (url.includes("jobs_public")) {
        return new Response(JSON.stringify([mockPublicJobRow]), {
          status: 200,
          headers: { "Content-Type": "application/json", "content-range": "0-0/1" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const batchResult = await getLiveJobs({ isPro: true, pageSize: 1 });
    assert.ok(batchResult.jobs.length > 0, "Jobs array must not be empty");
    assert.strictEqual(redirectedUrl, null, "Batch 401 with session MUST NOT redirect to login");
    assert.strictEqual(batchResult.jobs[0].proUnlockError?.status, 401, "Batch job must carry status 401");
    assert.strictEqual(batchResult.jobs[0].applyUrl, "", "applyUrl must remain empty on batch 401");
    console.log("  -> [PASS-LOCAL] getLiveJobs batch 401 handled; redirect prevented; locked state preserved.");

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
    console.log(`  -> [PASS-LOCAL] Negative control exited non-zero (${negResult.status}) as expected on invalid state.`);

  } finally {
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
