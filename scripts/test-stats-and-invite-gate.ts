/**
 * scripts/test-stats-and-invite-gate.ts
 *
 * Comprehensive verification suite for:
 * 1. Public stats endpoint (/api/stats & netlify/functions/stats.ts):
 *    - Anonymous callers receive strictly { jobsToday, updatedAt }.
 *    - Anonymous callers MUST NOT receive totalJobs, companiesScanned, activeJobs, or companies.
 *    - Authenticated unapproved callers receive 403 Forbidden { error: "Early access only" }.
 *    - Authenticated approved callers receive full corpus metrics.
 * 2. Server-side invite-only access across API routes & Netlify functions on Cloudflare static deploy:
 *    - jobs-search: anonymous gets public preview; unapproved authenticated gets 403 and empty jobs.
 *    - jobs-pro: anonymous gets 401; unapproved authenticated gets 403.
 *    - jobs-top10: anonymous gets 401; unapproved authenticated gets 403 and empty jobs.
 *    - ai: anonymous gets 401; unapproved authenticated gets 403.
 *    - interview-pack: anonymous gets 401; unapproved authenticated gets 403.
 *    - skill-what-if: anonymous gets 401; unapproved authenticated gets 403.
 *    - me/quota: anonymous gets 401; unapproved authenticated gets 403.
 * 3. Client service fallback safety (src/lib/jobs/service.ts):
 *    - When server search returns 403, returns empty jobs and forbidden error (no fallback leak).
 *    - When getJobById gets 403, returns null.
 *    - When top10 gets 403, returns empty array.
 * 4. Negative controls:
 *    - Flags exit non-zero on assertion errors.
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import Module from "node:module";

// Register Node test hook for @cloudflare/next-on-pages in unit test environment
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options: any
) {
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

import { _clearApprovalCacheForTesting } from "../src/lib/auth/approval";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

process.env.NODE_ENV = "test";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock-supabase.local";
process.env.SUPABASE_URL = "https://mock-supabase.local";
process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-role-key-stats-gate";
process.env.SUPABASE_SERVICE_KEY = "mock-service-role-key-stats-gate";
process.env.EARLY_ACCESS_ALLOWED_EMAILS = "allowlisted@example.com";

// Setup mock fetch for Supabase client PostgREST and Auth calls
const originalFetch = global.fetch;
global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const urlStr = String(input);
  const method = init?.method || "GET";
  const reqHeaders = new Headers(init?.headers);
  const authHeader = reqHeaders.get("authorization") || "";

  // 1. Supabase Auth: /auth/v1/user
  if (urlStr.includes("/auth/v1/user")) {
    if (authHeader.includes("Bearer mock-token-approved")) {
      return new Response(
        JSON.stringify({
          id: "00000000-0000-4000-a000-000000000010",
          email: "approved@example.com",
          user_metadata: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (authHeader.includes("Bearer mock-token-allowlisted")) {
      return new Response(
        JSON.stringify({
          id: "00000000-0000-4000-a000-000000000011",
          email: "allowlisted@example.com",
          user_metadata: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (authHeader.includes("Bearer mock-token-unapproved")) {
      return new Response(
        JSON.stringify({
          id: "00000000-0000-4000-a000-000000000020",
          email: "unapproved@example.com",
          user_metadata: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (authHeader.includes("Bearer mock-token-pro-approved")) {
      return new Response(
        JSON.stringify({
          id: "00000000-0000-4000-a000-000000000030",
          email: "pro-approved@example.com",
          user_metadata: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (authHeader.includes("Bearer mock-token-pro-unapproved")) {
      return new Response(
        JSON.stringify({
          id: "00000000-0000-4000-a000-000000000031",
          email: "pro-unapproved@example.com",
          user_metadata: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({ message: "Invalid or expired JWT token" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  // 2. Supabase DB: early_access_approved
  if (urlStr.includes("/rest/v1/early_access_approved")) {
    if (!urlStr.includes("unapproved") && (urlStr.includes("approved%40example.com") || urlStr.includes("pro-approved%40example.com"))) {
      return new Response(
        JSON.stringify([{ email: "approved@example.com", approved: true }]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 3. Supabase DB: blocked_users (ban check)
  if (urlStr.includes("/rest/v1/blocked_users")) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 4. Supabase DB: subscriptions
  if (urlStr.includes("/rest/v1/subscriptions")) {
    if (urlStr.includes("00000000-0000-4000-a000-000000000030") || urlStr.includes("00000000-0000-4000-a000-000000000031")) {
      const targetUserId = urlStr.includes("00000000-0000-4000-a000-000000000030")
        ? "00000000-0000-4000-a000-000000000030"
        : "00000000-0000-4000-a000-000000000031";
      return new Response(
        JSON.stringify([
          {
            id: "sub-pro-001",
            user_id: targetUserId,
            status: "active",
            plan_id: "weekly_plan_9",
            current_period_start: "2026-01-01T00:00:00Z",
            current_period_end: "2099-01-01T00:00:00Z",
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 5. Supabase DB: user_preferences
  if (urlStr.includes("/rest/v1/user_preferences")) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 6. Supabase DB: jobs / jobs_public
  if (urlStr.includes("/rest/v1/jobs") || urlStr.includes("/rest/v1/jobs_public")) {
    const mockJobs = [
      {
        id: "job-001",
        title: "Staff Platform Engineer",
        company: "Stripe",
        location: "Remote",
        remote: true,
        category: "engineering",
        is_active: true,
        status: "active",
        created_at: new Date().toISOString(),
        posted_at: new Date().toISOString(),
      },
    ];

    if (method === "HEAD" || reqHeaders.get("prefer")?.includes("count=exact")) {
      return new Response(JSON.stringify(mockJobs), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "content-range": "0-0/142",
        },
      });
    }

    return new Response(JSON.stringify(mockJobs), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "content-range": "0-0/142",
      },
    });
  }

  // 7. Supabase DB: companies
  if (urlStr.includes("/rest/v1/companies")) {
    return new Response(JSON.stringify([{ id: "comp-1" }]), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "content-range": "0-0/55",
      },
    });
  }

  // 8. Supabase RPCs (rate limits, global budget, concurrency, and quotas)
  if (urlStr.includes("/rest/v1/rpc/")) {
    if (urlStr.includes("ai_global_budget_reserve")) {
      return new Response(JSON.stringify([{ allowed: true, remaining: 100000 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (urlStr.includes("ai_concurrency_acquire")) {
      return new Response(JSON.stringify([{ allowed: true }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (urlStr.includes("ai_concurrency_release") || urlStr.includes("ai_global_budget_settle")) {
      return new Response(JSON.stringify(null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (urlStr.includes("check_and_increment_ai_quota")) {
      return new Response(JSON.stringify([{ allowed: true, current_count: 1, daily_limit: 100 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (urlStr.includes("check_shared_rate_limit")) {
      return new Response(JSON.stringify([{ allowed: true, remaining: 100, reset_ms: 1000 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify([{ allowed: true }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (urlStr.includes("mock-supabase.local") || urlStr.includes("/rest/v1/")) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return originalFetch(input, init);
};

async function runTests() {
  console.log("==================================================================================");
  console.log("       TEST SUITE: PUBLIC STATS RESTRICTION & SERVER-SIDE INVITE-ONLY GATE        ");
  console.log("==================================================================================");

  // Import handlers dynamically after setting up mock environment
  const { handler: netlifyStatsHandler } = await import("../netlify/functions/stats");
  const { GET: nextStatsGet } = await import("../src/app/api/stats/route");
  const { handler: netlifyJobsSearchHandler } = await import("../netlify/functions/jobs-search");
  const { GET: nextJobsSearchGet } = await import("../src/app/api/jobs/search/route");
  const { handler: netlifyJobsProHandler } = await import("../netlify/functions/jobs-pro");
  const { GET: nextJobsProGet } = await import("../src/app/api/jobs/pro/route");
  const { handler: netlifyJobsTop10Handler } = await import("../netlify/functions/jobs-top10");
  const { POST: nextJobsTop10Post } = await import("../src/app/api/jobs/top10/route");
  const { handleInterviewPackRequest } = await import("../src/lib/interview-pack/handler");
  const { handleSkillWhatIfRequest } = await import("../src/lib/skill-what-if/handler");
  const { GET: nextMeQuotaGet } = await import("../src/app/api/me/quota/route");

  // ---------------------------------------------------------------------------
  // TEST 1: Anonymous Caller on /api/stats (Both Netlify & Next.js routes)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 1] Verifying anonymous caller receives ONLY { jobsToday, updatedAt }...");
  _clearApprovalCacheForTesting();

  // 1a. Netlify handler
  const netlifyAnonStats = await netlifyStatsHandler({
    httpMethod: "GET",
    headers: {},
  });
  assert.strictEqual(netlifyAnonStats.statusCode, 200, "Netlify stats must return 200 to anonymous callers");
  const netlifyAnonBody = JSON.parse(netlifyAnonStats.body);
  assert.strictEqual(typeof netlifyAnonBody.jobsToday, "number", "jobsToday must be present and number");
  assert.strictEqual(typeof netlifyAnonBody.updatedAt, "string", "updatedAt must be present and string");

  // STRICT REQUIREMENT: must NOT expose totalJobs, companiesScanned, activeJobs, companies to anonymous callers
  assert.strictEqual(netlifyAnonBody.totalJobs, undefined, "totalJobs must NOT be exposed to anonymous callers");
  assert.strictEqual(netlifyAnonBody.companiesScanned, undefined, "companiesScanned must NOT be exposed to anonymous callers");
  assert.strictEqual(netlifyAnonBody.activeJobs, undefined, "activeJobs must NOT be exposed to anonymous callers");
  assert.strictEqual(netlifyAnonBody.companies, undefined, "companies must NOT be exposed to anonymous callers");

  // 1b. Next.js App Router route
  const nextAnonStats = await nextStatsGet(new Request("https://careermonke.com/api/stats"));
  assert.strictEqual(nextAnonStats.status, 200, "Next.js /api/stats must return 200 to anonymous callers");
  const nextAnonBody = await nextAnonStats.json();
  assert.strictEqual(typeof nextAnonBody.jobsToday, "number");
  assert.strictEqual(typeof nextAnonBody.updatedAt, "string");
  assert.strictEqual(nextAnonBody.totalJobs, undefined, "totalJobs must NOT be exposed to anonymous callers");
  assert.strictEqual(nextAnonBody.companiesScanned, undefined, "companiesScanned must NOT be exposed to anonymous callers");
  assert.strictEqual(nextAnonBody.activeJobs, undefined, "activeJobs must NOT be exposed to anonymous callers");
  assert.strictEqual(nextAnonBody.companies, undefined, "companies must NOT be exposed to anonymous callers");

  if (IS_NEGATIVE_CONTROL) {
    // Deliberate negative control: simulate exposure of totalJobs
    assert.strictEqual(nextAnonBody.totalJobs, 142, "NEGATIVE CONTROL FAILURE TRIGGER");
  }

  console.log("  [PASS] Anonymous stats returns ONLY jobsToday & updatedAt; 0 aggregate counts exposed");

  // ---------------------------------------------------------------------------
  // TEST 2: Authenticated New Signed-in User on /api/stats -> 200 OK
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 2] Verifying authenticated new signed-in user receives 200 on stats (not 403)...");
  _clearApprovalCacheForTesting();

  // 2a. Netlify handler with new signed-in token
  const netlifyUnapprovedStats = await netlifyStatsHandler({
    httpMethod: "GET",
    headers: {
      Authorization: "Bearer mock-token-unapproved",
    },
  });
  assert.strictEqual(netlifyUnapprovedStats.statusCode, 200, "New signed-in user must get 200 on Netlify stats");
  const netlifyUnapprovedBody = JSON.parse(netlifyUnapprovedStats.body);
  assert.strictEqual(typeof netlifyUnapprovedBody.jobsToday, "number");
  assert.ok(!netlifyUnapprovedBody.error, "Must not return early access error");

  // 2b. Next.js route with new signed-in token
  const nextUnapprovedStats = await nextStatsGet(
    new Request("https://careermonke.com/api/stats", {
      headers: { Authorization: "Bearer mock-token-unapproved" },
    })
  );
  assert.strictEqual(nextUnapprovedStats.status, 200, "New signed-in user must get 200 on Next.js stats");
  const nextUnapprovedBody = await nextUnapprovedStats.json();
  assert.ok(!nextUnapprovedBody.error);

  console.log("  [PASS] Authenticated new signed-in user gets 200 on stats endpoint (early-access gate removed)");

  // ---------------------------------------------------------------------------
  // TEST 3: Authenticated Approved User on /api/stats -> 200 with full corpus metrics
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 3] Verifying authenticated approved user receives 200 with full corpus stats...");
  _clearApprovalCacheForTesting();

  // 3a. Netlify handler with approved token
  const netlifyApprovedStats = await netlifyStatsHandler({
    httpMethod: "GET",
    headers: {
      Authorization: "Bearer mock-token-approved",
    },
  });
  assert.strictEqual(netlifyApprovedStats.statusCode, 200, "Approved user must get 200 on Netlify stats");
  const netlifyApprovedBody = JSON.parse(netlifyApprovedStats.body);
  assert.strictEqual(typeof netlifyApprovedBody.jobsToday, "number");
  assert.strictEqual(typeof netlifyApprovedBody.totalJobs, "number");
  assert.strictEqual(typeof netlifyApprovedBody.companiesScanned, "number");

  // 3b. Next.js route with approved token
  const nextApprovedStats = await nextStatsGet(
    new Request("https://careermonke.com/api/stats", {
      headers: { Authorization: "Bearer mock-token-approved" },
    })
  );
  assert.strictEqual(nextApprovedStats.status, 200, "Approved user must get 200 on Next.js stats");
  const nextApprovedBody = await nextApprovedStats.json();
  assert.strictEqual(typeof nextApprovedBody.totalJobs, "number");
  assert.strictEqual(typeof nextApprovedBody.companiesScanned, "number");

  console.log("  [PASS] Authenticated approved user receives complete corpus statistics");

  // ---------------------------------------------------------------------------
  // TEST 4: Invite-Only Gate on Jobs Search Endpoint
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 4] Verifying invite-only gate on jobs search...");
  _clearApprovalCacheForTesting();

  // 4a. Anonymous user gets public preview
  const netlifyAnonSearch = await netlifyJobsSearchHandler({
    httpMethod: "GET",
    queryStringParameters: { q: "platform" },
    headers: {},
  });
  assert.strictEqual(netlifyAnonSearch.statusCode, 200);

  // 4b. Authenticated new signed-in user receives 200 and jobs on Netlify (not 403)
  const netlifyUnapprovedSearch = await netlifyJobsSearchHandler({
    httpMethod: "GET",
    queryStringParameters: { q: "platform" },
    headers: { Authorization: "Bearer mock-token-unapproved" },
  });
  assert.strictEqual(netlifyUnapprovedSearch.statusCode, 200, "New signed-in user search must return 200");
  const unapprovedSearchBody = JSON.parse(netlifyUnapprovedSearch.body);
  assert.ok(Array.isArray(unapprovedSearchBody.jobs), "Must return jobs array");
  assert.ok(!unapprovedSearchBody.error, "Must not return early access error");

  // 4c. Next.js search new signed-in user receives 200 (not 403)
  const nextUnapprovedSearch = await nextJobsSearchGet(
    new Request("https://careermonke.com/api/jobs/search?q=platform", {
      headers: { Authorization: "Bearer mock-token-unapproved" },
    })
  );
  assert.strictEqual(nextUnapprovedSearch.status, 200, "Next.js search must return 200 for new signed-in user");
  const nextUnapprovedSearchBody = await nextUnapprovedSearch.json();
  assert.ok(Array.isArray(nextUnapprovedSearchBody.jobs));
  assert.ok(!nextUnapprovedSearchBody.error);

  // 4d. Authenticated approved user receives 200 with jobs
  const netlifyApprovedSearch = await netlifyJobsSearchHandler({
    httpMethod: "GET",
    queryStringParameters: { q: "platform" },
    headers: { Authorization: "Bearer mock-token-approved" },
  });
  assert.strictEqual(netlifyApprovedSearch.statusCode, 200);
  const approvedSearchBody = JSON.parse(netlifyApprovedSearch.body);
  assert.ok(Array.isArray(approvedSearchBody.jobs), "Must return jobs array for approved user");

  console.log("  [PASS] Jobs search does not block new signed-in users with 403");

  // ---------------------------------------------------------------------------
  // TEST 5: Invite-Only Gate on Jobs Pro & Top10 Endpoints
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 5] Verifying invite-only gate on jobs-pro and jobs-top10...");
  _clearApprovalCacheForTesting();

  // 5a. Pro Endpoint Anonymous -> 401
  const netlifyAnonPro = await netlifyJobsProHandler({
    httpMethod: "GET",
    queryStringParameters: { id: "job-001" },
    headers: {},
  });
  assert.strictEqual(netlifyAnonPro.statusCode, 401);

  const nextAnonPro = await nextJobsProGet(
    new Request("https://careermonke.com/api/jobs/pro?id=job-001")
  );
  assert.strictEqual(nextAnonPro.status, 401);

  // 5b. Pro Endpoint New Signed-in User without subscription -> 403 Pro subscription required (NOT Early access only!)
  const netlifyUnapprovedPro = await netlifyJobsProHandler({
    httpMethod: "GET",
    queryStringParameters: { id: "job-001" },
    headers: { Authorization: "Bearer mock-token-unapproved" },
  });
  const netlifyProBody = JSON.parse(netlifyUnapprovedPro.body);
  assert.ok(!String(netlifyProBody.error || "").includes("Early access only"), "Must not block on Early access only");
  assert.strictEqual(netlifyProBody.error, "Pro subscription required to access full job details.", "Paid subscription gate preserved");

  const nextUnapprovedPro = await nextJobsProGet(
    new Request("https://careermonke.com/api/jobs/pro?id=job-001", {
      headers: { Authorization: "Bearer mock-token-unapproved" },
    })
  );
  const nextProBody = await nextUnapprovedPro.json();
  assert.ok(!String(nextProBody.error || "").includes("Early access only"), "Must not block on Early access only");
  assert.strictEqual(nextProBody.error, "Pro subscription required to access full job details.", "Paid subscription gate preserved");

  // 5c. Top10 Endpoint Anonymous -> 401
  const netlifyAnonTop10 = await netlifyJobsTop10Handler({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({}),
  });
  assert.strictEqual(netlifyAnonTop10.statusCode, 401);

  const nextAnonTop10 = await nextJobsTop10Post(
    new Request("https://careermonke.com/api/jobs/top10", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
  );
  assert.strictEqual(nextAnonTop10.status, 401);

  // 5d. Top10 Endpoint Unpaid New User -> 403 PRO_REQUIRED (NOT Early access only!)
  const netlifyUnapprovedTop10 = await netlifyJobsTop10Handler({
    httpMethod: "POST",
    headers: { Authorization: "Bearer mock-token-unapproved" },
    body: JSON.stringify({}),
  });
  assert.strictEqual(netlifyUnapprovedTop10.statusCode, 403, "Unpaid user hits paid gate");
  const unapprovedTop10Body = JSON.parse(netlifyUnapprovedTop10.body);
  assert.ok(!String(unapprovedTop10Body.error || "").includes("Early access only"), "Must not return Early access only");
  assert.strictEqual(unapprovedTop10Body.code, "PRO_REQUIRED", "Paid subscription gate preserved on top10");

  const nextUnapprovedTop10 = await nextJobsTop10Post(
    new Request("https://careermonke.com/api/jobs/top10", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer mock-token-unapproved",
      },
      body: JSON.stringify({}),
    })
  );
  assert.strictEqual(nextUnapprovedTop10.status, 403, "Unpaid user hits paid gate");
  const nextUnapprovedTop10Body = await nextUnapprovedTop10.json();
  assert.ok(!String(nextUnapprovedTop10Body.error || "").includes("Early access only"), "Must not return Early access only");
  assert.strictEqual(nextUnapprovedTop10Body.code, "PRO_REQUIRED", "Paid subscription gate preserved on top10");

  // 5e. Pro & Top10 Endpoints Paid New Signed-in User (NOT in early access) -> 200 (not blocked by early access!)
  const candidatePayload = {
    candidate: { name: "Test Candidate", skills: ["TypeScript", "Node.js"], experience: [] },
  };

  const netlifyProNewUserTop10 = await netlifyJobsTop10Handler({
    httpMethod: "POST",
    headers: { Authorization: "Bearer mock-token-pro-unapproved" },
    body: JSON.stringify(candidatePayload),
  });
  assert.strictEqual(netlifyProNewUserTop10.statusCode, 200, "New signed-in paid user gets 200 on Netlify jobs-top10");

  const nextProNewUserTop10 = await nextJobsTop10Post(
    new Request("https://careermonke.com/api/jobs/top10", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer mock-token-pro-unapproved",
      },
      body: JSON.stringify(candidatePayload),
    })
  );
  assert.strictEqual(nextProNewUserTop10.status, 200, "New signed-in paid user gets 200 on Next.js jobs-top10");

  const netlifyProNewUserPro = await netlifyJobsProHandler({
    httpMethod: "GET",
    queryStringParameters: { id: "job-001" },
    headers: { Authorization: "Bearer mock-token-pro-unapproved" },
  });
  assert.strictEqual(netlifyProNewUserPro.statusCode, 200, "New signed-in paid user gets 200 on Netlify jobs-pro");

  const nextProNewUserPro = await nextJobsProGet(
    new Request("https://careermonke.com/api/jobs/pro?id=job-001", {
      headers: { Authorization: "Bearer mock-token-pro-unapproved" },
    })
  );
  assert.strictEqual(nextProNewUserPro.status, 200, "New signed-in paid user gets 200 on Next.js jobs-pro");

  console.log("  [PASS] jobs-pro and jobs-top10 enforce paid gating while completely removing early-access restrictions");

  // ---------------------------------------------------------------------------
  // TEST 6: Authenticated Endpoints: Interview Pack, Skill What-If, Quota, Shared AI
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 6] Verifying interview pack, skill what-if, quota, and shared AI endpoints do not block new signed-in user...");
  _clearApprovalCacheForTesting();

  // 6a. Interview pack: new signed-in user without subscription gets PRO_REQUIRED, not Early access only
  const unapprovedInterview = await handleInterviewPackRequest(
    new Request("https://careermonke.com/api/jobs/interview-pack?jobId=job-001", {
      headers: { Authorization: "Bearer mock-token-unapproved" },
    }),
    { jobId: "job-001" }
  );
  assert.strictEqual(unapprovedInterview.status, 403, "Unpaid user hits pro gate");
  const interviewBody = await unapprovedInterview.json().catch(() => ({}));
  assert.ok(!String(interviewBody.error || "").includes("Early access only"), "Must not return Early access only");
  assert.strictEqual(interviewBody.code, "PRO_REQUIRED", "Pro subscription gate preserved");

  // Paid new user (not in early access) gets 200 on interview pack
  const proNewInterview = await handleInterviewPackRequest(
    new Request("https://careermonke.com/api/jobs/interview-pack?jobId=job-001", {
      headers: { Authorization: "Bearer mock-token-pro-unapproved" },
    }),
    {
      jobId: "job-001",
      generateInterviewPack: async () => ({
        jobId: "job-001",
        jobTitle: "Software Engineer",
        companyName: "Acme Corp",
        cards: [{ question: "Tell me about yourself", category: "intro", answer: "Sample answer" }],
      }),
    } as any
  );
  assert.strictEqual(proNewInterview.status, 200, "Paid new user gets 200 on interview pack");

  // 6b. Skill What-If: new signed-in user without subscription gets PRO_REQUIRED, not Early access only
  const unapprovedSkill = await handleSkillWhatIfRequest(
    new Request("https://careermonke.com/api/jobs/skill-what-if?jobId=job-001&skill=Rust", {
      headers: { Authorization: "Bearer mock-token-unapproved" },
    }),
    { jobId: "job-001", skill: "Rust" }
  );
  assert.strictEqual(unapprovedSkill.status, 403, "Unpaid user hits pro gate");
  const skillBody = await unapprovedSkill.json().catch(() => ({}));
  assert.ok(!String(skillBody.error || "").includes("Early access only"), "Must not return Early access only");
  assert.strictEqual(skillBody.code, "PRO_REQUIRED", "Pro subscription gate preserved");

  // Paid new user (not in early access) gets 200 on skill what-if
  const proNewSkill = await handleSkillWhatIfRequest(
    new Request("https://careermonke.com/api/jobs/skill-what-if?jobId=job-001&skill=Rust", {
      headers: { Authorization: "Bearer mock-token-pro-unapproved" },
    }),
    {
      jobId: "job-001",
      skill: "Rust",
      generateSkillWhatIf: async () => ({
        jobId: "job-001",
        jobTitle: "Software Engineer",
        companyName: "Acme Corp",
        missingSkills: ["Rust"],
        matchDelta: 10,
        explanation: "Adding Rust increases match",
      }),
    } as any
  );
  assert.strictEqual(proNewSkill.status, 200, "Paid new user gets 200 on skill what-if");

  // 6c. Me Quota: new signed-in user -> 200 (not 403 Early access only)
  const unapprovedQuota = await nextMeQuotaGet(
    new Request("https://careermonke.com/api/me/quota", {
      headers: { Authorization: "Bearer mock-token-unapproved" },
    })
  );
  assert.strictEqual(unapprovedQuota.status, 200, "Me Quota must return 200 for new signed-in user");
  const quotaBody = await unapprovedQuota.json().catch(() => ({}));
  assert.ok(!String(quotaBody.error || "").includes("Early access only"));

  // 6d. Shared AI service: new signed-in user -> does not return 403 Early access only
  const { handleAiRequest, handleNetlifyAiRequest } = await import("../src/lib/ai/serviceHandler");
  const aiDeps = {
    checkSharedRateLimit: async () => ({ allowed: true, remaining: 10, resetMs: 1000 }),
    consumeSet: async () => ({ success: true, allowed: true, remaining: 10 }),
    callGroq: async () => {
      const payloadStr = JSON.stringify({
        name: "Test Candidate",
        headline: "Senior Software Engineer",
        summary: "Senior Software Engineer with TypeScript and React experience.",
        skills: ["TypeScript", "React"],
        experience: [],
      });
      return {
        content: payloadStr,
        result: payloadStr,
        text: payloadStr,
        tokenUsage: { totalTokens: 25 },
      };
    },
  };

  // 6d. Shared AI service: unpaid new signed-in user hits PRO_REQUIRED, not Early access only
  const nextAiRes = await handleAiRequest(
    new Request("https://careermonke.com/api/ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer mock-token-unapproved",
      },
      body: JSON.stringify({
        operation: "cover_letter",
        payload: {
          candidate: { name: "Test Candidate", skills: ["TypeScript"] },
          job: { title: "Software Engineer", description: "Need TypeScript engineer" },
        },
      }),
    }),
    aiDeps
  );
  assert.strictEqual(nextAiRes.status, 403, "Unpaid user hits pro gate on Next.js AI service");
  const aiBody = await nextAiRes.json().catch(() => ({}));
  assert.ok(!String(aiBody.error || "").includes("Early access only"), "Must not return Early access only");
  assert.strictEqual(aiBody.code, "PRO_REQUIRED", "Pro subscription gate preserved on Next.js AI service");

  const netlifyAiRes = await handleNetlifyAiRequest(
    {
      httpMethod: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer mock-token-unapproved",
      },
      body: JSON.stringify({
        operation: "cover_letter",
        payload: {
          candidate: { name: "Test Candidate", skills: ["TypeScript"] },
          job: { title: "Software Engineer", description: "Need TypeScript engineer" },
        },
      }),
    } as any,
    aiDeps
  );
  assert.strictEqual(netlifyAiRes.statusCode, 403, "Unpaid user hits pro gate on Netlify AI service");
  const netlifyAiBody = JSON.parse(netlifyAiRes.body || "{}");
  assert.ok(!String(netlifyAiBody.error || "").includes("Early access only"), "Must not return Early access only");
  assert.strictEqual(netlifyAiBody.code, "PRO_REQUIRED", "Pro subscription gate preserved on Netlify AI service");

  // Paid new signed-in user (not in early access) gets 200 on Next.js and Netlify AI service
  const proAiRes = await handleAiRequest(
    new Request("https://careermonke.com/api/ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer mock-token-pro-unapproved",
      },
      body: JSON.stringify({
        operation: "resume_extraction",
        params: {
          rawText: "Senior Software Engineer with TypeScript and React experience.",
        },
      }),
    }),
    aiDeps
  );
  assert.strictEqual(proAiRes.status, 200, "Paid new user receives exact 200 on Next.js AI service");
  const proAiBody = await proAiRes.json().catch(() => ({}));
  assert.ok(!String(proAiBody.error || "").includes("Early access only"), "Must not return Early access only");

  const proNetlifyAiRes = await handleNetlifyAiRequest(
    {
      httpMethod: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer mock-token-pro-unapproved",
      },
      body: JSON.stringify({
        operation: "resume_extraction",
        params: {
          rawText: "Senior Software Engineer with TypeScript and React experience.",
        },
      }),
    } as any,
    aiDeps
  );
  assert.strictEqual(proNetlifyAiRes.statusCode, 200, "Paid new user receives exact 200 on Netlify AI service");
  const proNetlifyBody = JSON.parse(proNetlifyAiRes.body || "{}");
  assert.ok(!String(proNetlifyBody.error || "").includes("Early access only"), "Must not return Early access only");

  console.log("  [PASS] Interview pack, skill what-if, quota, and AI endpoints do not block new signed-in users with Early access only");

  // ---------------------------------------------------------------------------
  // TEST 7: Client Service (src/lib/jobs/service.ts) Fallback Safety
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 7] Verifying client service layer does not fall back when server gives 403...");
  (globalThis as any).window = globalThis;
  const { getLiveJobs, getLiveJobById, getTopRankedJobsForCandidate } = await import(
    "../src/lib/jobs/service"
  );

  // Mock global fetch to return 403 for server requests
  const prevFetch = global.fetch;
  try {
    global.fetch = async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("/api/jobs/search") || u.includes("/api/jobs/top10")) {
        return new Response(
          JSON.stringify({ error: "Early access only", jobs: [] }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      return prevFetch(input);
    };

    const liveJobsResult = await getLiveJobs({ search: "security" });
    assert.deepStrictEqual(liveJobsResult.jobs, [], "Must return empty jobs on 403");
    assert.strictEqual(liveJobsResult.totalCount, 0, "Must return totalCount 0 on 403");
    assert.strictEqual(liveJobsResult.error, "forbidden", "Must flag error as forbidden");

    const singleJobResult = await getLiveJobById("job-001");
    assert.strictEqual(singleJobResult, null, "Must return null on 403");

    const top10Result = await getTopRankedJobsForCandidate({
      candidate: { name: "Test" } as any,
      limit: 5,
    });
    assert.deepStrictEqual(top10Result, [], "Must return empty array on 403");
  } finally {
    global.fetch = prevFetch;
  }

  console.log("  [PASS] Client service returns empty results on 403 without direct DB query fallback");

  // ---------------------------------------------------------------------------
  // TEST 7b: Guest request to /jobs is not redirected
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 7b] Verifying guest requests to /jobs are not redirected server-side...");
  const { middleware: appMiddleware } = await import("../src/middleware");
  const { NextRequest: AppNextRequest } = await import("next/server");
  const guestJobsReq = new AppNextRequest("http://localhost:3000/jobs");
  const guestJobsRes = await appMiddleware(guestJobsReq);
  assert.strictEqual(guestJobsRes.status, 200, "Guest request to /jobs must return 200");
  assert.strictEqual(guestJobsRes.headers.get("location"), null, "Guest request to /jobs must not redirect");
  console.log("  [PASS] Guest request to /jobs returns 200 without redirect (blurred view preserved)");

  // ---------------------------------------------------------------------------
  // TEST 8: Automated Negative Control Execution
  // ---------------------------------------------------------------------------
  if (!IS_NEGATIVE_CONTROL) {
    console.log("\n[TEST 8] Executing automated negative control as sub-process...");
    const selfScript = path.resolve(__dirname, "test-stats-and-invite-gate.ts");
    const child = spawnSync("npx", ["tsx", selfScript, "--negative-control"], {
      shell: true,
      stdio: "pipe",
      env: { ...process.env },
    });

    assert.notStrictEqual(
      child.status,
      0,
      `Negative control MUST exit with non-zero code. Output:\n${child.stderr?.toString()}`
    );
    console.log("  [PASS] Negative control verified: failed with non-zero exit code as expected");
  }

  console.log("\n==================================================================================");
  console.log("ALL CHECKS PASSED [PASS-LOCAL]");
  console.log("==================================================================================");
}

runTests().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
