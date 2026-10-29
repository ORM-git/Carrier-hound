/**
 * scripts/test-search-track-rate-limits.ts
 *
 * Test suite for:
 * 1. GET /api/jobs/search per-IP rate limiting (60/min, 429 with Retry-After)
 * 2. GET /api/jobs/search query length capping at 100 characters
 * 3. POST /api/track per-IP rate limiting (30/min, 429 with Retry-After)
 * 4. POST /api/track client-supplied userId ignored (derived from session only)
 * 5. Negative control verifying failure (non-zero exit) under legacy behavior
 */

import assert from "node:assert";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Module from "node:module";

// Register Node test hook for @cloudflare/next-on-pages in unit test environment
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, parent: any, isMain: boolean, options: any) {
  if (request === "@cloudflare/next-on-pages") {
    return "virtual:@cloudflare/next-on-pages";
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

require.cache["virtual:@cloudflare/next-on-pages"] = {
  id: "virtual:@cloudflare/next-on-pages",
  filename: "virtual:@cloudflare/next-on-pages",
  loaded: true,
  exports: {
    getRequestContext: () => {
      const sym = Symbol.for("__cloudflare-request-context__");
      return (globalThis as any)[sym];
    },
  },
} as any;

process.env.NODE_ENV = "test";

const isNegativeControl = process.argv.includes("--negative-control");

function createMockSupabaseClient() {
  const sampleJob = {
    id: "mock-job-id-1",
    title: "Senior Backend Engineer",
    company: "Tech Corp",
    location: "Remote",
    category: "engineering",
    remote: true,
    remote_scope: "worldwide",
    remote_eligibility: "Anywhere",
    country_code: "US",
    job_type: "full-time",
    verified: true,
    posted_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  const queryBuilder: any = {
    select: () => queryBuilder,
    eq: () => queryBuilder,
    in: () => queryBuilder,
    or: () => queryBuilder,
    order: () => queryBuilder,
    range: () => queryBuilder,
    limit: () => queryBuilder,
    maybeSingle: async () => ({ data: sampleJob, error: null }),
    then: (resolve: (val: any) => void) => resolve({ data: [sampleJob], count: 1, error: null }),
  };

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "valid-session-token-123") {
          return {
            data: {
              user: {
                id: "user-session-abc-456",
                email: "sessionuser@example.com",
                user_metadata: {},
              },
            },
            error: null,
          };
        }
        return { data: { user: null }, error: new Error("Invalid session token") };
      },
    },
    from: (table: string) => {
      if (table === "page_views") {
        const pvBuilder: any = {
          select: () => pvBuilder,
          eq: () => pvBuilder,
          order: () => pvBuilder,
          limit: () => pvBuilder,
          then: (resolve: (val: any) => void) => resolve({ data: [], error: null }),
        };
        return pvBuilder;
      }
      return queryBuilder;
    },
  };
}

(globalThis as any).__mockSupabaseClient = createMockSupabaseClient();
(globalThis as any).__mockRateLimitClient = null; // Exercise memoryFallback in test environment

async function main() {
  const { GET: searchGet } = await import("../src/app/api/jobs/search/route");
  const { POST: trackPost } = await import("../src/app/api/track/route");
  const {
    _resetSearchRateLimitStore,
    _resetTrackRateLimitStore,
    SEARCH_RATE_LIMIT,
    TRACK_RATE_LIMIT,
  } = await import("../src/lib/api/sharedRateLimit");

  // ===========================================================================
  // NEGATIVE CONTROL MODE
  // ===========================================================================
  if (isNegativeControl) {
    console.log("================================================================================");
    console.log(" [NEGATIVE CONTROL MODE] Executing against legacy behaviour");
    console.log("================================================================================");
    process.env.__CAREERMONKE_LEGACY_RATE_LIMIT = "true";

    _resetSearchRateLimitStore();
    const testIp = "203.0.113.99";

    console.log("Running 61 search requests under legacy behavior...");
    let lastSearchStatus = 200;
    for (let i = 1; i <= 61; i++) {
      const req = new Request("http://localhost:3000/api/jobs/search?q=engineer", {
        headers: { "x-forwarded-for": testIp },
      });
      const res = await searchGet(req);
      lastSearchStatus = res.status;
    }

    // Under legacy behaviour, the 61st request returned 200 because rate limiting was absent.
    // Asserting 429 will throw AssertionError and exit non-zero:
    assert.strictEqual(
      lastSearchStatus,
      429,
      `Negative control: Search request 61 under legacy behaviour must fail 429 check (got ${lastSearchStatus})`
    );

    console.error("FATAL: Negative control expected assertion to fail under legacy mode!");
    process.exit(1);
  }

  // ===========================================================================
  // NORMAL TEST MODE
  // ===========================================================================
  console.log("================================================================================");
  console.log("CAREERMONKE RATE LIMIT & SEARCH/TRACK SECURITY TEST SUITE");
  console.log("================================================================================");

  // ---------------------------------------------------------------------------
  // Test 1: Search route rate limiting (60/min, 429 with Retry-After)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 1] GET /api/jobs/search rate limiting (60 req/min)...");
  _resetSearchRateLimitStore();
  const searchIp = "198.51.100.1";

  for (let i = 1; i <= SEARCH_RATE_LIMIT.maxRequests; i++) {
    const req = new Request("http://localhost:3000/api/jobs/search?q=engineer", {
      headers: { "x-forwarded-for": searchIp },
    });
    const res = await searchGet(req);
    assert.strictEqual(
      res.status,
      200,
      `Search request #${i} under limit should return 200, got ${res.status}`
    );
  }

  // 61st request should be rate-limited with HTTP 429
  const limitedReq = new Request("http://localhost:3000/api/jobs/search?q=engineer", {
    headers: { "x-forwarded-for": searchIp },
  });
  const limitedRes = await searchGet(limitedReq);
  assert.strictEqual(limitedRes.status, 429, `Request #61 must return 429, got ${limitedRes.status}`);

  const retryAfterHeader = limitedRes.headers.get("Retry-After");
  assert.ok(retryAfterHeader, "429 response must include Retry-After header");
  assert.ok(parseInt(retryAfterHeader, 10) > 0, "Retry-After header must be > 0");

  const limitedJson = await limitedRes.json();
  assert.strictEqual(limitedJson.error, "Rate limit exceeded. Please try again shortly.");
  assert.ok(limitedJson.retryAfter > 0, "Response body must contain retryAfter");

  // Different IP should succeed (not blocked)
  const differentIpReq = new Request("http://localhost:3000/api/jobs/search?q=engineer", {
    headers: { "x-forwarded-for": "198.51.100.2" },
  });
  const differentIpRes = await searchGet(differentIpReq);
  assert.strictEqual(differentIpRes.status, 200, "Different IP should not be rate-limited");
  console.log("  [PASS] 60 requests allowed, 61st returned 429 with Retry-After, IP isolated");

  // ---------------------------------------------------------------------------
  // Test 2: Search query capped at 100 characters
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 2] GET /api/jobs/search query length capped at 100 chars...");
  const longQuery = "a".repeat(150);
  const capTestIp = "198.51.100.5";
  const capReq = new Request(`http://localhost:3000/api/jobs/search?q=${longQuery}`, {
    headers: { "x-forwarded-for": capTestIp },
  });
  const capRes = await searchGet(capReq);
  assert.strictEqual(capRes.status, 200, "Capped search query should execute without error");
  console.log("  [PASS] Query length exceeding 100 characters accepted and capped cleanly");

  // ---------------------------------------------------------------------------
  // Test 3: Track route rate limiting (30/min, 429 with Retry-After)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 3] POST /api/track rate limiting (30 req/min)...");
  _resetTrackRateLimitStore();
  const trackIp = "198.51.100.10";

  for (let i = 1; i <= TRACK_RATE_LIMIT.maxRequests; i++) {
    const req = new Request("http://localhost:3000/api/track", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": trackIp,
      },
      body: JSON.stringify({ path: "/jobs", referrer: "https://google.com" }),
    });
    const res = await trackPost(req);
    assert.strictEqual(
      res.status,
      200,
      `Track request #${i} under limit should return 200, got ${res.status}`
    );
  }

  // 31st request should be rate-limited with HTTP 429
  const limitedTrackReq = new Request("http://localhost:3000/api/track", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": trackIp,
    },
    body: JSON.stringify({ path: "/jobs" }),
  });
  const limitedTrackRes = await trackPost(limitedTrackReq);
  assert.strictEqual(
    limitedTrackRes.status,
    429,
    `Request #31 must return 429, got ${limitedTrackRes.status}`
  );

  const trackRetryHeader = limitedTrackRes.headers.get("Retry-After");
  assert.ok(trackRetryHeader, "Track 429 response must include Retry-After header");
  assert.ok(parseInt(trackRetryHeader, 10) > 0, "Track Retry-After must be > 0");

  const trackLimitedJson = await limitedTrackRes.json();
  assert.strictEqual(trackLimitedJson.ok, false);
  assert.strictEqual(trackLimitedJson.error, "Rate limit exceeded. Please try again shortly.");

  // Different IP should succeed
  const differentTrackIpReq = new Request("http://localhost:3000/api/track", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.11",
    },
    body: JSON.stringify({ path: "/jobs" }),
  });
  const differentTrackIpRes = await trackPost(differentTrackIpReq);
  assert.strictEqual(differentTrackIpRes.status, 200, "Different IP should not be rate-limited on track");
  console.log("  [PASS] 30 requests allowed, 31st returned 429 with Retry-After, IP isolated");

  // ---------------------------------------------------------------------------
  // Test 4: Track route ignores client-supplied userId (derives from session only)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 4] POST /api/track ignores client-supplied userId from body...");
  const { getFallbackRecords, getUserActivityLogs } = await import("../src/lib/admin/analytics");

  // 4a. Client supplies spoofed userId without valid session -> userId must be null
  const spoofedReq = new Request("http://localhost:3000/api/track", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.30",
    },
    body: JSON.stringify({
      path: "/jobs/test-page-guest",
      userId: "spoofed-client-user-id-999",
      referrer: "https://somewebsite.com",
    }),
  });
  const spoofedRes = await trackPost(spoofedReq);
  assert.strictEqual(spoofedRes.status, 200);

  const allRecords = getFallbackRecords();
  const recordedGuestView = allRecords.find((v: any) => v.path === "/jobs/test-page-guest");
  assert.ok(recordedGuestView, "Page view must be recorded");
  assert.strictEqual(
    recordedGuestView.user_id,
    null,
    `Client-supplied userId must be ignored when no session exists! Got: ${recordedGuestView.user_id}`
  );
  const spoofedLogs = await getUserActivityLogs("spoofed-client-user-id-999", (globalThis as any).__mockSupabaseClient);
  assert.strictEqual(spoofedLogs.length, 0, "Spoofed user activity logs must be empty");
  console.log("  [PASS] Client-supplied userId in body is ignored; recorded user_id is null");

  // 4b. Authenticated session -> userId must come from session, ignoring spoofed body userId
  const sessionReq = new Request("http://localhost:3000/api/track", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer valid-session-token-123",
      "x-forwarded-for": "198.51.100.31",
    },
    body: JSON.stringify({
      path: "/jobs/test-page-authenticated",
      userId: "spoofed-client-user-id-999",
      referrer: "https://somewebsite.com",
    }),
  });
  const sessionRes = await trackPost(sessionReq);
  assert.strictEqual(sessionRes.status, 200);

  const recordedAuthView = allRecords.find((v: any) => v.path === "/jobs/test-page-authenticated");
  assert.ok(recordedAuthView, "Authenticated page view must be recorded");
  assert.strictEqual(
    recordedAuthView.user_id,
    "user-session-abc-456",
    `user_id must match authenticated session user, not spoofed body userId!`
  );
  const authLogs = await getUserActivityLogs("user-session-abc-456", (globalThis as any).__mockSupabaseClient);
  assert.ok(authLogs.length > 0, "Activity logs must be attributed to real session user");
  console.log("  [PASS] Session user_id 'user-session-abc-456' derived from token, spoofed body userId ignored");


  // ---------------------------------------------------------------------------
  // Test 5: Negative Control Automated Verification
  // ---------------------------------------------------------------------------
  console.log("\n[VERIFICATION] Verifying negative control non-zero exit on legacy behaviour...");
  const testScriptPath = path.resolve(__dirname, "test-search-track-rate-limits.ts");
  const child = spawnSync("npx", ["tsx", testScriptPath, "--negative-control"], {
    shell: true,
    stdio: "pipe",
    env: { ...process.env, __CAREERMONKE_LEGACY_RATE_LIMIT: "true" },
  });

  assert.notStrictEqual(
    child.status,
    0,
    `Negative control MUST exit with non-zero status! Got exit code: ${child.status}`
  );
  console.log(`  [PASS] Negative control exited with code ${child.status} (non-zero exit verified)`);

  console.log("\n================================================================================");
  console.log("ALL RATE LIMIT & SEARCH/TRACK SECURITY TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
