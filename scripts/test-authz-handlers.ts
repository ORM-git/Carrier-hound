/**
 * CareerMonke Handler-Level Authorization & Quota Verification Suite
 * Tests paywall, token authentication, role separation (Free vs Pro vs Admin),
 * payload validation, invalid JSON resilience, and AI daily quotas.
 * 
 * Run with: npx tsx scripts/test-authz-handlers.ts
 * Run negative control: npx tsx scripts/test-authz-handlers.ts --negative-control
 */

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

// Configure local mock environment variables
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock-supabase.local";
process.env.SUPABASE_URL = "https://mock-supabase.local";
process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-role-key-for-test-suite";
process.env.SUPABASE_SERVICE_KEY = "mock-service-role-key-for-test-suite";
process.env.GROQ_API_KEY = "gsk_mock_test_key_for_handler_authz_verification";
process.env.EARLY_ACCESS_ALLOWED_EMAILS = "pro@example.com,free@example.com";

// In-memory quota store for mock quota tests
let mockAiQuotaStore: { [key: string]: { count: number; total_tokens: number } } = {};

// Setup mock global.fetch
const originalFetch = global.fetch;
global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const urlStr = String(input);
  const method = init?.method || "GET";
  const headers = (init?.headers as any) || {};
  const authHeader = headers["Authorization"] || headers["authorization"] || "";

  // 1. Supabase Auth: /auth/v1/user
  if (urlStr.includes("/auth/v1/user")) {
    if (authHeader.includes("Bearer mock-token-admin")) {
      return new Response(
        JSON.stringify({
          id: "00000000-0000-4000-a000-000000000001",
          email: "xbsuryakant@gmail.com",
          email_confirmed_at: "2026-10-30T00:00:00.000Z",
          app_metadata: { provider: "google", providers: ["google"] },
          user_metadata: { role: "admin" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (authHeader.includes("Bearer mock-token-pro")) {
      return new Response(
        JSON.stringify({
          id: "00000000-0000-4000-a000-000000000002",
          email: "pro@example.com",
          user_metadata: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (authHeader.includes("Bearer mock-token-free")) {
      return new Response(
        JSON.stringify({
          id: "00000000-0000-4000-a000-000000000003",
          email: "free@example.com",
          user_metadata: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (authHeader.includes("Bearer mock-token-bad")) {
      return new Response(
        JSON.stringify({ message: "Invalid or expired JWT token" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({ message: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  // 1b. Supabase Admin Auth: /auth/v1/admin/users
  if (urlStr.includes("/auth/v1/admin/users")) {
    return new Response(JSON.stringify({ user: { id: "00000000-0000-4000-a000-000000000003" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 1c. Supabase Storage: /storage/v1/
  if (urlStr.includes("/storage/v1/")) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 2. Supabase DB: /rest/v1/subscriptions
  if (urlStr.includes("/rest/v1/subscriptions")) {
    if (urlStr.includes("00000000-0000-4000-a000-000000000002")) {
      return new Response(
        JSON.stringify([
          {
            id: "sub-pro-001",
            user_id: "00000000-0000-4000-a000-000000000002",
            status: "active",
            plan_id: "intl_monthly_9",
            current_period_start: "2026-01-01T00:00:00Z",
            current_period_end: "2099-01-01T00:00:00Z",
            metadata: {},
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    // Free user has no active subscription
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 3. Supabase DB: /rest/v1/jobs
  if (urlStr.includes("/rest/v1/jobs")) {
    return new Response(
      JSON.stringify([
        {
          id: "job-mock-001",
          title: "Principal Infrastructure Engineer",
          company: "Monzo",
          location: "Remote (Worldwide)",
          remote: true,
          remote_scope: "worldwide",
          category: "engineering",
          skills: ["Kubernetes", "Go", "Terraform", "AWS"],
          description: "Design and operate distributed platform systems.",
          salary_text: "$180,000 - $220,000",
          salary_min: 180000,
          salary_max: 220000,
          currency: "USD",
          salary_period: "yearly",
          apply_url: "https://boards.greenhouse.io/monzo/jobs/12345",
          is_active: true,
          status: "active",
          posted_at: "2026-10-10T00:00:00Z",
        },
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // 4. Supabase DB: /rest/v1/ai_usage_quotas
  if (urlStr.includes("/rest/v1/ai_usage_quotas")) {
    const key = urlStr;
    const existing = mockAiQuotaStore[key];
    if (method === "GET") {
      return new Response(JSON.stringify(existing || null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "POST" || method === "PATCH") {
      return new Response(JSON.stringify(existing || {}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // 5. Upstream Groq API: api.groq.com
  if (urlStr.includes("api.groq.com")) {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-mock-12345",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                score: 95,
                matchedSkills: ["Go", "Kubernetes"],
                missingSkills: [],
                summary: "Strong candidate match for platform engineering role.",
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // 6. Generic DB table operations (e.g. delete on candidate_profiles, applications, etc.)
  if (urlStr.includes("/rest/v1/")) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return originalFetch(input, init);
};

// Import Handlers after mock fetch is established
import { handler as jobsProHandler } from "../netlify/functions/jobs-pro";
import { handler as aiHandler } from "../netlify/functions/ai";
import { handler as jobsTop10Handler } from "../netlify/functions/jobs-top10";
import { handler as accountDeleteHandler } from "../netlify/functions/account-delete";

import { GET as adminStatsGet } from "../src/app/api/admin/stats/route";
import { GET as adminUsersGet } from "../src/app/api/admin/users/route";
import { POST as adminUsersBlockPost } from "../src/app/api/admin/users/block/route";
import { checkAndIncrementAiQuota, OPERATION_CONFIGS } from "../src/lib/ai/security";

interface TestCase {
  endpoint: string;
  role: string;
  scenario: string;
  expectedStatus: number;
  actualStatus?: number;
  pass?: boolean;
  notes?: string;
}

const results: TestCase[] = [];

function recordCase(tc: TestCase) {
  tc.pass = tc.actualStatus === tc.expectedStatus;
  results.push(tc);

  const statusStr = String(tc.actualStatus).padStart(3);
  const expectedStr = String(tc.expectedStatus).padStart(3);
  const verdict = tc.pass ? "PASS-LOCAL" : "FAIL";

  console.log(
    `${tc.endpoint.padEnd(26)} | ${tc.role.padEnd(12)} | Exp: ${expectedStr} | Act: ${statusStr} | ${verdict} | ${tc.scenario}`
  );
}

async function runTestSuite() {
  console.log("====================================================================================================");
  console.log("             CAREERMONKE OFFLINE HANDLER AUTHORIZATION & QUOTA VERIFICATION SUITE                   ");
  console.log("====================================================================================================\n");

  if (IS_NEGATIVE_CONTROL) {
    console.log("⚠️ [NEGATIVE CONTROL MODE ACTIVE]: Intentionally expecting free-user to access Pro endpoint...");
  }

  // -----------------------------------------------------------------------------------------------
  // 1. netlify/functions/jobs-pro (Pro Protected)
  // -----------------------------------------------------------------------------------------------
  // 1a. No token
  const resProNoToken = await jobsProHandler({
    httpMethod: "GET",
    headers: {},
    queryStringParameters: { id: "job-mock-001" },
  });
  recordCase({
    endpoint: "netlify/jobs-pro (GET)",
    role: "none",
    scenario: "No token provided",
    expectedStatus: 401,
    actualStatus: resProNoToken.statusCode,
  });

  // 1b. Bad token
  const resProBadToken = await jobsProHandler({
    httpMethod: "GET",
    headers: { authorization: "Bearer mock-token-bad" },
    queryStringParameters: { id: "job-mock-001" },
  });
  recordCase({
    endpoint: "netlify/jobs-pro (GET)",
    role: "bad-token",
    scenario: "Expired/invalid token",
    expectedStatus: 401,
    actualStatus: resProBadToken.statusCode,
  });

  // 1c. Free-user token
  const resProFreeToken = await jobsProHandler({
    httpMethod: "GET",
    headers: { authorization: "Bearer mock-token-free" },
    queryStringParameters: { id: "job-mock-001" },
  });
  recordCase({
    endpoint: "netlify/jobs-pro (GET)",
    role: "free-user",
    scenario: "Free user attempting to unlock paid job data",
    expectedStatus: IS_NEGATIVE_CONTROL ? 200 : 403, // Negative control asserts failure here!
    actualStatus: resProFreeToken.statusCode,
  });

  // 1d. Pro token
  const resProValid = await jobsProHandler({
    httpMethod: "GET",
    headers: { authorization: "Bearer mock-token-pro" },
    queryStringParameters: { id: "job-mock-001" },
  });
  recordCase({
    endpoint: "netlify/jobs-pro (GET)",
    role: "pro-user",
    scenario: "Pro subscriber unlocking single job details",
    expectedStatus: 200,
    actualStatus: resProValid.statusCode,
  });

  // 1e. Invalid JSON in POST
  const resProInvalidJson = await jobsProHandler({
    httpMethod: "POST",
    headers: {
      authorization: "Bearer mock-token-pro",
      "content-type": "application/json",
    },
    body: "{ malformed json...",
  });
  recordCase({
    endpoint: "netlify/jobs-pro (POST)",
    role: "pro-user",
    scenario: "Malformed JSON payload yields 4xx (never 500)",
    expectedStatus: 400,
    actualStatus: resProInvalidJson.statusCode,
  });

  // -----------------------------------------------------------------------------------------------
  // 2. netlify/functions/ai (Pro & Quota Protected)
  // -----------------------------------------------------------------------------------------------
  // 2a. No token
  const resAiNoToken = await aiHandler({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({ operation: "job_fit" }),
  });
  recordCase({
    endpoint: "netlify/ai (POST)",
    role: "none",
    scenario: "No token provided",
    expectedStatus: 401,
    actualStatus: resAiNoToken.statusCode,
  });

  // 2b. Bad token
  const resAiBadToken = await aiHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer mock-token-bad" },
    body: JSON.stringify({ operation: "job_fit" }),
  });
  recordCase({
    endpoint: "netlify/ai (POST)",
    role: "bad-token",
    scenario: "Invalid JWT token",
    expectedStatus: 401,
    actualStatus: resAiBadToken.statusCode,
  });

  // 2c. Free-user token
  const resAiFreeToken = await aiHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer mock-token-free" },
    body: JSON.stringify({
      operation: "job_fit",
      params: {
        candidate: { name: "Test Candidate", skills: ["Go"] },
        job: { title: "Engineer" },
      },
    }),
  });
  recordCase({
    endpoint: "netlify/ai (POST)",
    role: "free-user",
    scenario: "Free user attempting AI evaluation",
    expectedStatus: 403,
    actualStatus: resAiFreeToken.statusCode,
  });

  // 2d. Pro token
  const resAiProToken = await aiHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer mock-token-pro" },
    body: JSON.stringify({
      operation: "job_fit",
      params: {
        candidate: { name: "Test Pro Candidate", skills: ["Go", "Kubernetes"] },
        job: { title: "Principal Engineer", description: "Cloud systems" },
      },
    }),
  });
  recordCase({
    endpoint: "netlify/ai (POST)",
    role: "pro-user",
    scenario: "Pro subscriber authorized for job_fit AI generation",
    expectedStatus: 200,
    actualStatus: resAiProToken.statusCode,
  });

  // 2e. Oversized payload
  const hugeText = "A".repeat(25000); // Exceeds 3000 token limit
  const resAiOversized = await aiHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer mock-token-pro" },
    body: JSON.stringify({
      operation: "job_fit",
      params: {
        candidate: { name: "Test Pro", skills: ["Go"] },
        job: { title: "Engineer", description: hugeText },
      },
    }),
  });
  recordCase({
    endpoint: "netlify/ai (POST)",
    role: "pro-user",
    scenario: "Oversized payload exceeding token cap rejected",
    expectedStatus: 400,
    actualStatus: resAiOversized.statusCode,
  });

  // 2f. Malformed JSON
  const resAiMalformedJson = await aiHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer mock-token-pro" },
    body: "{ malformed: json",
  });
  recordCase({
    endpoint: "netlify/ai (POST)",
    role: "pro-user",
    scenario: "Malformed JSON payload rejected cleanly with 4xx",
    expectedStatus: 400,
    actualStatus: resAiMalformedJson.statusCode,
  });

  // -----------------------------------------------------------------------------------------------
  // 3. netlify/functions/jobs-top10 (Pro Protected)
  // -----------------------------------------------------------------------------------------------
  // 3a. No token
  const resTop10NoToken = await jobsTop10Handler({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({ candidate: { skills: ["TypeScript"] } }),
  });
  recordCase({
    endpoint: "netlify/jobs-top10 (POST)",
    role: "none",
    scenario: "No token provided",
    expectedStatus: 401,
    actualStatus: resTop10NoToken.statusCode,
  });

  // 3b. Free-user token
  const resTop10Free = await jobsTop10Handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer mock-token-free" },
    body: JSON.stringify({ candidate: { skills: ["TypeScript"] } }),
  });
  recordCase({
    endpoint: "netlify/jobs-top10 (POST)",
    role: "free-user",
    scenario: "Free user attempting Top 10 unlocked matches",
    expectedStatus: 403,
    actualStatus: resTop10Free.statusCode,
  });

  // 3c. Pro token
  const resTop10Pro = await jobsTop10Handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer mock-token-pro" },
    body: JSON.stringify({ candidate: { skills: ["Go", "Kubernetes"] }, limit: 5 }),
  });
  recordCase({
    endpoint: "netlify/jobs-top10 (POST)",
    role: "pro-user",
    scenario: "Pro subscriber fetching Top 10 matches",
    expectedStatus: 200,
    actualStatus: resTop10Pro.statusCode,
  });

  // -----------------------------------------------------------------------------------------------
  // 4. Admin API Routes (Admin Protected)
  // -----------------------------------------------------------------------------------------------
  // 4a. /api/admin/stats with no token
  const reqAdminNoToken = new Request("http://localhost:3000/api/admin/stats", {
    method: "GET",
  });
  const resAdminNoToken = await adminStatsGet(reqAdminNoToken);
  recordCase({
    endpoint: "app/api/admin/stats (GET)",
    role: "none",
    scenario: "No authorization provided",
    expectedStatus: 403,
    actualStatus: resAdminNoToken.status,
  });

  // 4b. /api/admin/stats with Pro (non-admin) token
  const reqAdminProToken = new Request("http://localhost:3000/api/admin/stats", {
    method: "GET",
    headers: { authorization: "Bearer mock-token-pro" },
  });
  const resAdminProToken = await adminStatsGet(reqAdminProToken);
  recordCase({
    endpoint: "app/api/admin/stats (GET)",
    role: "pro-user",
    scenario: "Pro user attempting to view Admin analytics stats",
    expectedStatus: 403,
    actualStatus: resAdminProToken.status,
  });

  // 4c. /api/admin/stats with Admin token
  const reqAdminValid = new Request("http://localhost:3000/api/admin/stats", {
    method: "GET",
    headers: { authorization: "Bearer mock-token-admin" },
  });
  const resAdminValid = await adminStatsGet(reqAdminValid);
  recordCase({
    endpoint: "app/api/admin/stats (GET)",
    role: "admin",
    scenario: "Verified administrator accessing analytics",
    expectedStatus: 200,
    actualStatus: resAdminValid.status,
  });

  // 4d. /api/admin/users with Pro (non-admin) token
  const reqUsersPro = new Request("http://localhost:3000/api/admin/users", {
    method: "GET",
    headers: { authorization: "Bearer mock-token-pro" },
  });
  const resUsersPro = await adminUsersGet(reqUsersPro);
  recordCase({
    endpoint: "app/api/admin/users (GET)",
    role: "pro-user",
    scenario: "Non-admin accessing users management list",
    expectedStatus: 403,
    actualStatus: resUsersPro.status,
  });

  // 4e. /api/admin/users/block with non-admin
  const reqBlockPro = new Request("http://localhost:3000/api/admin/users/block", {
    method: "POST",
    headers: {
      authorization: "Bearer mock-token-pro",
      "content-type": "application/json",
    },
    body: JSON.stringify({ userId: "some-user-id", action: "block" }),
  });
  const resBlockPro = await adminUsersBlockPost(reqBlockPro);
  recordCase({
    endpoint: "app/api/admin/users/block",
    role: "pro-user",
    scenario: "Non-admin attempting to block users",
    expectedStatus: 403,
    actualStatus: resBlockPro.status,
  });

  // 4f. /api/admin/users/block with malformed JSON
  const reqBlockMalformed = new Request("http://localhost:3000/api/admin/users/block", {
    method: "POST",
    headers: {
      authorization: "Bearer mock-token-admin",
      "content-type": "application/json",
    },
    body: "{ malformed: json",
  });
  const resBlockMalformed = await adminUsersBlockPost(reqBlockMalformed);
  recordCase({
    endpoint: "app/api/admin/users/block",
    role: "admin",
    scenario: "Admin block endpoint with invalid JSON yields 400",
    expectedStatus: 400,
    actualStatus: resBlockMalformed.status,
  });

  // -----------------------------------------------------------------------------------------------
  // 5. Account Deletion (Self-Service Logged-In User)
  // -----------------------------------------------------------------------------------------------
  const resDeleteNoToken = await accountDeleteHandler({
    httpMethod: "POST",
    headers: {},
  });
  recordCase({
    endpoint: "netlify/account-delete",
    role: "none",
    scenario: "Unauthenticated account deletion rejected",
    expectedStatus: 401,
    actualStatus: resDeleteNoToken.statusCode,
  });

  const resDeleteFreeUser = await accountDeleteHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer mock-token-free" },
  });
  recordCase({
    endpoint: "netlify/account-delete",
    role: "free-user",
    scenario: "Free user deleting own account (self-service)",
    expectedStatus: 200,
    actualStatus: resDeleteFreeUser.statusCode,
  });

  // -----------------------------------------------------------------------------------------------
  // 6. AI Daily Quota Enforcement Unit Verification
  // -----------------------------------------------------------------------------------------------
  console.log("\n====================================================================================================");
  console.log("                        AI DAILY QUOTA & FAIR-USE CAP VERIFICATION                                  ");
  console.log("====================================================================================================");

  const mockSupabase = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { count: 30, total_tokens: 45000 }, // Simulated at 30/30 cap!
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
  } as any;

  const quotaAtCap = await checkAndIncrementAiQuota(mockSupabase, "pro-user-uid", "cover_letter", 500);
  console.log(`[QUOTA CHECK: At Daily Cap (30/30)]: allowed = ${quotaAtCap.allowed}, count = ${quotaAtCap.currentCount}/${quotaAtCap.limit}`);
  
  const mockSupabaseUnder = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { count: 12, total_tokens: 15000 }, // Simulated under cap (12/30)
                error: null,
              }),
            }),
          }),
        }),
      }),
      update: () => ({
        eq: () => ({
          eq: () => ({
            eq: async () => ({ error: null }),
          }),
        }),
      }),
    }),
  } as any;

  const quotaUnderCap = await checkAndIncrementAiQuota(mockSupabaseUnder, "pro-user-uid", "cover_letter", 500);
  console.log(`[QUOTA CHECK: Under Cap (12/30)]:   allowed = ${quotaUnderCap.allowed}, count = ${quotaUnderCap.currentCount}/${quotaUnderCap.limit}\n`);

  const quotaPass = !quotaAtCap.allowed && quotaUnderCap.allowed;
  console.log(`AI Quota Cap Verification Verdict: ${quotaPass ? "PASS-LOCAL" : "FAIL"}`);

  // Summary
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = total - passed;

  console.log("\n====================================================================================================");
  console.log(`TEST SUMMARY: ${passed}/${total} test cases passed. Failures: ${failed}`);
  console.log("====================================================================================================");

  if (IS_NEGATIVE_CONTROL) {
    if (failed > 0) {
      console.error("\n❌ NEGATIVE CONTROL VERIFIED: Injected expectation mismatch caught as expected!");
      console.error("Exiting with non-zero exit code (1) to prove negative control test failure.");
      process.exit(1);
    }
  }

  if (failed > 0 || !quotaPass) {
    console.error(`\n❌ AUTHORIZATION TEST SUITE FAILED: ${failed} mismatches detected.`);
    process.exit(1);
  }

  console.log("\n🎉 ALL AUTHORIZATION AND QUOTA HANDLER TESTS PASSED WITH 100% CONFORMANCE!");
  process.exit(0);
}

runTestSuite().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
