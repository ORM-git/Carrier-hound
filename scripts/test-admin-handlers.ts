import assert from "node:assert/strict";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

// Load local test environment variables
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "mock-service-role-key-secret-12345";
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://mock.supabase.co";

import { GET as adminStatsGet } from "../src/app/api/admin/stats/route";
import { GET as adminUsersGet } from "../src/app/api/admin/users/route";
import { GET as adminActivityGet } from "../src/app/api/admin/users/activity/route";
import { POST as adminBlockPost } from "../src/app/api/admin/users/block/route";
import { GET as adminAuditLogGet } from "../src/app/api/admin/audit-log/route";
import { ADMIN_EMAIL } from "../src/lib/admin/constants";

const ADMIN_USER_ID = "00000000-0000-0000-0000-000000000001";
const ADMIN_TARGET_USER_ID = "00000000-0000-0000-0000-000000000002";
const REGULAR_USER_ID = "00000000-0000-0000-0000-000000000003";

// Flags for backend failure simulation
let simulateAuthFailure = false;
let simulateAuditLogDbFailure = false;
let lastRequestedAuthParams: any = null;
let lastRequestedInClauseIds: string[] = [];

// Intercept network boundary and deny unexpected external traffic
const originalFetch = global.fetch;
global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const urlStr = String(input);
  const headers = (init?.headers as any) || {};
  const authHeader = typeof headers.get === "function"
    ? headers.get("authorization") || headers.get("Authorization") || ""
    : (headers["Authorization"] || headers["authorization"] || "");

  // 1. Auth /user session verification
  if (urlStr.includes("/auth/v1/user")) {
    if (authHeader.includes("Bearer mock-admin-token")) {
      return new Response(
        JSON.stringify({
          id: ADMIN_USER_ID,
          email: ADMIN_EMAIL,
          user_metadata: { role: "admin" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (authHeader.includes("Bearer mock-non-admin-token")) {
      return new Response(
        JSON.stringify({
          id: REGULAR_USER_ID,
          email: "candidate@example.com",
          user_metadata: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
  }

  // 2. Auth admin getUserById (for block / unblock checks)
  if (urlStr.includes("/auth/v1/admin/users/")) {
    const userId = urlStr.split("/admin/users/")[1]?.split("?")[0];
    if (userId === ADMIN_USER_ID || userId === ADMIN_TARGET_USER_ID) {
      return new Response(
        JSON.stringify({
          id: userId,
          email: ADMIN_EMAIL,
          user_metadata: { role: "admin" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        id: userId,
        email: `target-${userId}@example.com`,
        user_metadata: {},
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // 3. Auth admin users listing
  if (urlStr.includes("/auth/v1/admin/users")) {
    if (simulateAuthFailure) {
      return new Response(JSON.stringify({ error: "Supabase Auth Internal Failure" }), { status: 500 });
    }

    const parsedUrl = new URL(urlStr);
    const page = parseInt(parsedUrl.searchParams.get("page") || "1", 10);
    const perPage = parseInt(parsedUrl.searchParams.get("per_page") || "25", 10);
    lastRequestedAuthParams = { page, perPage };

    const totalMockUsers = 120;
    const allUsers = Array.from({ length: totalMockUsers }, (_, i) => {
      const hex = (i + 1).toString(16).padStart(12, "0");
      const id = `00000000-0000-0000-0000-${hex}`;
      return {
        id,
        email: i === 0 ? ADMIN_EMAIL : `user${i + 1}@example.com`,
        created_at: new Date(1700000000000 - i * 3600000).toISOString(),
        last_sign_in_at: new Date(1700000000000 - i * 1800000).toISOString(),
        user_metadata: i % 3 === 0 ? { is_pro: true } : {},
      };
    });

    const start = (page - 1) * perPage;
    const pageUsers = allUsers.slice(start, start + perPage);

    const linkHeader = start + perPage < totalMockUsers
      ? `<?page=${page + 1}>; rel="next",<?page=${Math.ceil(totalMockUsers / perPage)}>; rel="last"`
      : `<?page=${Math.ceil(totalMockUsers / perPage)}>; rel="last"`;

    return new Response(
      JSON.stringify({ users: pageUsers }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-total-count": String(totalMockUsers),
          link: linkHeader,
        },
      }
    );
  }

  // 4. PostgREST admin_audit_log
  if (urlStr.includes("/rest/v1/admin_audit_log")) {
    if (simulateAuditLogDbFailure) {
      return new Response(JSON.stringify({ message: "relation admin_audit_log does not exist" }), { status: 500 });
    }

    const mockLogs = [
      {
        id: "log-1",
        created_at: new Date().toISOString(),
        admin_user_id: ADMIN_USER_ID,
        action: "user.block",
        target_type: "user",
        target_id: REGULAR_USER_ID,
        metadata: { reason: "Terms violation" },
        ip_hash: "mockhash123",
      },
    ];
    return new Response(JSON.stringify(mockLogs), {
      status: 200,
      headers: { "Content-Type": "application/json", "content-range": "0-0/1" },
    });
  }

  // 5. PostgREST subscriptions
  if (urlStr.includes("/rest/v1/subscriptions")) {
    const url = new URL(urlStr);
    const inFilter = url.searchParams.get("user_id");
    if (inFilter && inFilter.startsWith("in.")) {
      lastRequestedInClauseIds = inFilter.replace("in.(", "").replace(")", "").split(",");
    }
    const mockSubs = [
      { user_id: ADMIN_USER_ID, status: "active", current_period_end: new Date(Date.now() + 1000000).toISOString() },
    ];
    return new Response(JSON.stringify(mockSubs), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // 6. PostgREST blocked_users
  if (urlStr.includes("/rest/v1/blocked_users")) {
    const mockBlocked = [
      { user_id: REGULAR_USER_ID, blocked_at: new Date().toISOString(), reason: "Spam behavior" },
    ];
    return new Response(JSON.stringify(mockBlocked), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // 7. PostgREST page_views
  if (urlStr.includes("/rest/v1/page_views")) {
    const mockViews = [
      { id: "pv-1", path: "/jobs", user_id: ADMIN_USER_ID, created_at: new Date().toISOString() },
      { id: "pv-2", path: "/dashboard", user_id: REGULAR_USER_ID, created_at: new Date().toISOString() },
    ];
    return new Response(JSON.stringify(mockViews), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // Deny unexpected external network traffic
  console.error(`[UNEXPECTED NETWORK TRAFFIC DENIED] ${urlStr}`);
  throw new Error(`Unexpected external network call denied in test environment: ${urlStr}`);
};

async function runHandlerTests() {
  console.log("================================================================================");
  console.log("TEST SUITE: REAL ADMIN ROUTE HANDLERS & BOUNDED READS VERIFICATION");
  console.log("================================================================================\n");

  let passes = 0;

  function recordPass(desc: string) {
    passes++;
    console.log(`✅ [PASS-LOCAL] ${desc}`);
  }

  // ---------------------------------------------------------------------------
  // 1. UNATTENDED / MISSING TOKEN CHECKS (Must return 403)
  // ---------------------------------------------------------------------------
  console.log("--- 1. MISSING AUTH TOKEN REJECTION (HTTP 403) ---");
  const endpoints = [
    { name: "/api/admin/stats", call: () => adminStatsGet(new Request("http://localhost:3000/api/admin/stats")) },
    { name: "/api/admin/users", call: () => adminUsersGet(new Request("http://localhost:3000/api/admin/users")) },
    { name: "/api/admin/users/activity", call: () => adminActivityGet(new Request("http://localhost:3000/api/admin/users/activity?userId=" + REGULAR_USER_ID)) },
    { name: "/api/admin/audit-log", call: () => adminAuditLogGet(new Request("http://localhost:3000/api/admin/audit-log")) },
    {
      name: "/api/admin/users/block",
      call: () => adminBlockPost(new Request("http://localhost:3000/api/admin/users/block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: REGULAR_USER_ID, action: "block" }),
      })),
    },
  ];

  for (const ep of endpoints) {
    const res = await ep.call();
    assert.equal(res.status, 403, `${ep.name} without token must return 403`);
    recordPass(`Missing token on ${ep.name} correctly returned HTTP 403`);
  }

  // ---------------------------------------------------------------------------
  // 2. NON-ADMIN TOKEN CHECKS (Must return 403)
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. NON-ADMIN TOKEN REJECTION (HTTP 403) ---");
  const nonAdminHeaders = { Authorization: "Bearer mock-non-admin-token" };
  const nonAdminEndpoints = [
    { name: "/api/admin/stats", call: () => adminStatsGet(new Request("http://localhost:3000/api/admin/stats", { headers: nonAdminHeaders })) },
    { name: "/api/admin/users", call: () => adminUsersGet(new Request("http://localhost:3000/api/admin/users", { headers: nonAdminHeaders })) },
    { name: "/api/admin/users/activity", call: () => adminActivityGet(new Request("http://localhost:3000/api/admin/users/activity?userId=" + REGULAR_USER_ID, { headers: nonAdminHeaders })) },
    { name: "/api/admin/audit-log", call: () => adminAuditLogGet(new Request("http://localhost:3000/api/admin/audit-log", { headers: nonAdminHeaders })) },
    {
      name: "/api/admin/users/block",
      call: () => adminBlockPost(new Request("http://localhost:3000/api/admin/users/block", {
        method: "POST",
        headers: { ...nonAdminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ userId: REGULAR_USER_ID, action: "block" }),
      })),
    },
  ];

  for (const ep of nonAdminEndpoints) {
    const res = await ep.call();
    assert.equal(res.status, 403, `${ep.name} with non-admin token must return 403`);
    recordPass(`Non-admin user on ${ep.name} correctly returned HTTP 403`);
  }

  // ---------------------------------------------------------------------------
  // 3. AUTHORIZED ADMIN ACCESS (Must return 200)
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. AUTHORIZED ADMIN ACCESS (HTTP 200) ---");
  const adminHeaders = { Authorization: "Bearer mock-admin-token" };

  const resUsers = await adminUsersGet(new Request("http://localhost:3000/api/admin/users", { headers: adminHeaders }));
  assert.equal(resUsers.status, 200, "Authorized admin /api/admin/users must return 200");
  const usersData = await resUsers.json();
  assert.equal(usersData.ok, true);
  assert.equal(Array.isArray(usersData.users), true);
  assert.equal(usersData.users.length, 25, "Default page size must be 25 users");
  assert.equal(usersData.pagination.page, 1);
  assert.equal(usersData.pagination.pageSize, 25);
  assert.equal(usersData.pagination.total, 120);
  assert.equal(usersData.pagination.totalPages, 5);
  recordPass("Authorized admin fetched users page 1 with accurate pagination metadata");

  const resAudit = await adminAuditLogGet(new Request("http://localhost:3000/api/admin/audit-log", { headers: adminHeaders }));
  assert.equal(resAudit.status, 200, "Authorized admin /api/admin/audit-log must return 200");
  const auditData = await resAudit.json();
  assert.equal(auditData.ok, true);
  assert.equal(Array.isArray(auditData.entries), true);
  recordPass("Authorized admin fetched audit log records");

  // ---------------------------------------------------------------------------
  // 4. MALFORMED PAGINATION PARAMETERS (Must return 400)
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. MALFORMED PAGINATION VALIDATION (HTTP 400) ---");
  const invalidUsersParams = [
    "page=-1",
    "page=abc",
    "page=0",
    "pageSize=0",
    "pageSize=-10",
    "pageSize=101",
    "pageSize=notanumber",
  ];

  for (const param of invalidUsersParams) {
    const res = await adminUsersGet(new Request(`http://localhost:3000/api/admin/users?${param}`, { headers: adminHeaders }));
    assert.equal(res.status, 400, `/api/admin/users?${param} must return 400`);
    const body = await res.json();
    assert.equal(body.ok, false);
    recordPass(`Invalid param ${param} on /api/admin/users rejected with HTTP 400`);
  }

  const invalidAuditParams = [
    "page=-5",
    "page=xyz",
    "pageSize=0",
    "pageSize=200",
  ];

  for (const param of invalidAuditParams) {
    const res = await adminAuditLogGet(new Request(`http://localhost:3000/api/admin/audit-log?${param}`, { headers: adminHeaders }));
    assert.equal(res.status, 400, `/api/admin/audit-log?${param} must return 400`);
    const body = await res.json();
    assert.equal(body.ok, false);
    recordPass(`Invalid param ${param} on /api/admin/audit-log rejected with HTTP 400`);
  }

  // ---------------------------------------------------------------------------
  // 5. BOUNDED SERVER READS VERIFICATION (Request and Query Bounds)
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. BOUNDED SERVER READS & IN-CLAUSE QUERY SCOPING ---");
  // Request page 2 with pageSize 10
  const resPage2 = await adminUsersGet(new Request("http://localhost:3000/api/admin/users?page=2&pageSize=10", { headers: adminHeaders }));
  assert.equal(resPage2.status, 200);
  const page2Data = await resPage2.json();
  assert.equal(page2Data.pagination.page, 2);
  assert.equal(page2Data.pagination.pageSize, 10);
  assert.equal(page2Data.users.length, 10);
  assert.equal(lastRequestedAuthParams.page, 2);
  assert.equal(lastRequestedAuthParams.perPage, 10);
  assert.equal(lastRequestedInClauseIds.length, 10, "Supplementary queries strictly bounded to page user IDs (10 IDs)");
  recordPass("Server reads verified as strictly bounded by requested page and pageSize");

  // ---------------------------------------------------------------------------
  // 6. MODERATION: SELF-BLOCK & ADMIN EMAIL BLOCK PREVENTION (HTTP 400)
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. MODERATION SAFETY LOCKS (SELF-BLOCK & ADMIN ACCOUNT BLOCK) ---");
  // A. Self-block by admin ID
  const resSelfBlock = await adminBlockPost(new Request("http://localhost:3000/api/admin/users/block", {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ userId: ADMIN_USER_ID, action: "block" }),
  }));
  assert.equal(resSelfBlock.status, 400);
  const selfBlockBody = await resSelfBlock.json();
  assert.equal(selfBlockBody.error, "Admin cannot block themselves.");
  recordPass("Admin self-block attempt rejected with HTTP 400 ('Admin cannot block themselves.')");

  // B. Admin email block prevention (attempting to block user who holds ADMIN_EMAIL)
  const resAdminEmailBlock = await adminBlockPost(new Request("http://localhost:3000/api/admin/users/block", {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ userId: ADMIN_TARGET_USER_ID, action: "block" }),
  }));
  assert.equal(resAdminEmailBlock.status, 400);
  const adminEmailBlockBody = await resAdminEmailBlock.json();
  assert.equal(adminEmailBlockBody.error, "Admin account cannot be blocked");
  recordPass("Attempt to block account with admin email rejected with HTTP 400 ('Admin account cannot be blocked')");

  // ---------------------------------------------------------------------------
  // 7. BACKEND FAILURE HANDLING (Must return generic 500 without secret leakage)
  // ---------------------------------------------------------------------------
  console.log("\n--- 7. BACKEND FAILURE HANDLING & NO SECRET LEAKAGE ---");
  // A. Supabase Auth failure in /api/admin/users
  simulateAuthFailure = true;
  const resUsersFail = await adminUsersGet(new Request("http://localhost:3000/api/admin/users", { headers: adminHeaders }));
  assert.equal(resUsersFail.status, 500, "Users route must return 500 on backend auth failure");
  const usersFailBody = await resUsersFail.json();
  assert.equal(usersFailBody.ok, false);
  assert.equal(usersFailBody.error, "Failed to retrieve users list");
  assert.equal(JSON.stringify(usersFailBody).includes("mock-service-role-key-secret-12345"), false, "No secrets leaked");
  simulateAuthFailure = false;
  recordPass("/api/admin/users returns generic 500 without secret leakage on backend failure");

  // B. Database failure in /api/admin/audit-log
  simulateAuditLogDbFailure = true;
  const resAuditFail = await adminAuditLogGet(new Request("http://localhost:3000/api/admin/audit-log", { headers: adminHeaders }));
  assert.equal(resAuditFail.status, 500, "Audit log route must return 500 on DB failure");
  const auditFailBody = await resAuditFail.json();
  assert.equal(auditFailBody.ok, false);
  assert.equal(auditFailBody.error, "Failed to retrieve audit logs from database");
  assert.equal(JSON.stringify(auditFailBody).includes("mock-service-role-key-secret-12345"), false, "No secrets leaked");
  simulateAuditLogDbFailure = false;
  recordPass("/api/admin/audit-log returns HTTP 500 instead of empty list on DB failure (Fix 3 verified)");

  // ---------------------------------------------------------------------------
  // 8. NEGATIVE CONTROL: Proving non-zero exit on invalid condition
  // ---------------------------------------------------------------------------
  console.log("\n--- 8. NEGATIVE CONTROL VERIFICATION ---");
  if (process.env.RUN_NEGATIVE_CONTROL === "true" || process.argv.includes("--negative-control")) {
    console.log("Executing intentional negative control assertion...");
    // Intentionally assert that missing auth returns 200 (which must fail)
    const fakeAuthCheck = await adminStatsGet(new Request("http://localhost:3000/api/admin/stats"));
    assert.equal(fakeAuthCheck.status, 200, "[NEGATIVE CONTROL INTENDED FAILURE] Missing auth should not return 200");
  } else {
    recordPass("Negative control harness present and callable with --negative-control or RUN_NEGATIVE_CONTROL=true");
  }

  console.log(`\n================================================================================`);
  console.log(`🎉 ALL ${passes} HANDLER VERIFICATION CHECKS PASSED (PASS-LOCAL)`);
  console.log(`================================================================================`);
}

runHandlerTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
