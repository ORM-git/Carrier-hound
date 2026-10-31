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
const NON_ADMIN_FIXTURE_ID = "00000000-0000-0000-0000-000000000005";
const HEAVY_USER_ID = "00000000-0000-0000-0000-000000000099";

// Instrumentation trackers
let privilegedCallsCount = 0;
let pageViewsRowsDownloaded = 0;
let lastAuditWritePayload: any = null;

// Flags for backend failure simulation
let simulateAuthFailure = false;
let simulateAuditLogDbFailure = false;
let simulateAuditWriteFailure = false;
let failingCountUserId: string | null = null;
let lastRequestedAuthParams: any = null;

// Intercept network boundary and deny unexpected external traffic
const originalFetch = global.fetch;
global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const urlStr = String(input);
  const method = (init?.method || "GET").toUpperCase();
  const headers = (init?.headers as any) || {};
  const authHeader = typeof headers.get === "function"
    ? headers.get("authorization") || headers.get("Authorization") || ""
    : (headers["Authorization"] || headers["authorization"] || "");

  // 1. Auth /user session verification (Public/client-facing endpoint)
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

  // --- PRIVILEGED ENDPOINTS BELOW ---
  privilegedCallsCount++;

  // 2. Auth admin getUserById (for block / unblock checks)
  if (urlStr.includes("/auth/v1/admin/users/")) {
    const userId = urlStr.split("/admin/users/")[1]?.split("?")[0];
    if (method === "PUT" || method === "PATCH") {
      return new Response(JSON.stringify({ id: userId, user_metadata: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

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
      const id = i === 98 ? HEAVY_USER_ID : `00000000-0000-0000-0000-${hex}`;
      return {
        id,
        email: i === 0 ? ADMIN_EMAIL : i === 98 ? "heavy.user@example.com" : `user${i + 1}@example.com`,
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
    if (method === "POST") {
      if (simulateAuditWriteFailure) {
        return new Response(JSON.stringify({ error: "Failed to write audit log" }), { status: 500 });
      }
      try {
        lastAuditWritePayload = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      } catch (_) {}
      return new Response(JSON.stringify({ success: true }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

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
    const mockSubs = [
      { user_id: ADMIN_USER_ID, status: "active", current_period_end: new Date(Date.now() + 1000000).toISOString() },
    ];
    return new Response(JSON.stringify(mockSubs), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // 6. PostgREST blocked_users
  if (urlStr.includes("/rest/v1/blocked_users")) {
    if (method === "POST") {
      return new Response(JSON.stringify({ success: true }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    if (method === "DELETE") {
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const mockBlocked = [
      { user_id: REGULAR_USER_ID, blocked_at: new Date().toISOString(), reason: "Spam behavior" },
    ];
    return new Response(JSON.stringify(mockBlocked), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // 7. PostgREST page_views
  if (urlStr.includes("/rest/v1/page_views")) {
    // Check if this is a count-only HEAD request
    if (method === "HEAD") {
      const url = new URL(urlStr);
      const userFilter = url.searchParams.get("user_id");

      // Check simulated count query failure for specific user
      if (failingCountUserId && userFilter && userFilter.includes(failingCountUserId)) {
        return new Response(JSON.stringify({ message: "PGRST_MOCK_TIMEOUT: DB count query timeout" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      let count = 4;
      if (userFilter && userFilter.includes(HEAVY_USER_ID)) {
        count = 5000; // Heavy user fixture
      }
      return new Response(null, {
        status: 200,
        headers: {
          "content-range": `0-0/${count}`,
          "Content-Type": "application/json",
        },
      });
    }

    // If rows are fetched via GET, track downloaded row count
    const mockViews = [
      { id: "pv-1", path: "/jobs", user_id: ADMIN_USER_ID, created_at: new Date().toISOString() },
      { id: "pv-2", path: "/dashboard", user_id: REGULAR_USER_ID, created_at: new Date().toISOString() },
    ];
    pageViewsRowsDownloaded += mockViews.length;
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
  // 1. UNATTENDED / MISSING TOKEN CHECKS (Must return 403 & make ZERO privileged calls)
  // ---------------------------------------------------------------------------
  console.log("--- 1. MISSING AUTH TOKEN REJECTION (HTTP 403 & ZERO PRIVILEGED CALLS) ---");
  privilegedCallsCount = 0;

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
  assert.equal(privilegedCallsCount, 0, "Missing token requests made 0 privileged database/admin calls");
  recordPass("Proved 0 privileged backend calls executed for missing token requests");

  // ---------------------------------------------------------------------------
  // 2. NON-ADMIN TOKEN CHECKS (Must return 403 & make ZERO privileged calls)
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. NON-ADMIN TOKEN REJECTION (HTTP 403 & ZERO PRIVILEGED CALLS) ---");
  privilegedCallsCount = 0;
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
  assert.equal(privilegedCallsCount, 0, "Non-admin token requests made 0 privileged database/admin calls");
  recordPass("Proved 0 privileged backend calls executed for non-admin requests");

  // ---------------------------------------------------------------------------
  // 3. AUTHORIZED ADMIN ACCESS & PAYLOAD INTEGRITY (Must return 200)
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. AUTHORIZED ADMIN ACCESS & COMPREHENSIVE PAYLOAD VERIFICATION ---");
  const adminHeaders = { Authorization: "Bearer mock-admin-token" };

  // A. Stats endpoint
  const resStats = await adminStatsGet(new Request("http://localhost:3000/api/admin/stats?range=7", { headers: adminHeaders }));
  assert.equal(resStats.status, 200, "Authorized admin /api/admin/stats must return 200");
  const statsData = await resStats.json();
  assert.equal(statsData.ok, true);
  assert.equal(typeof statsData.stats.totalViews, "number");
  assert.equal(typeof statsData.stats.totalUsers, "number");
  assert.equal(typeof statsData.stats.totalProUsers, "number");
  assert.equal(Array.isArray(statsData.stats.topPages), true);
  assert.equal(Array.isArray(statsData.stats.dailyViews), true);
  recordPass("Authorized admin fetched stats with complete aggregate structure");

  // B. Users listing endpoint
  pageViewsRowsDownloaded = 0;
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
  assert.equal(pageViewsRowsDownloaded, 0, "Zero page_views row records were downloaded during users listing");
  recordPass("Authorized admin fetched users page 1 with accurate pagination and 0 row data downloaded");

  // C. Activity endpoint
  const resActivity = await adminActivityGet(new Request(`http://localhost:3000/api/admin/users/activity?userId=${REGULAR_USER_ID}`, { headers: adminHeaders }));
  assert.equal(resActivity.status, 200, "Authorized admin /api/admin/users/activity must return 200");
  const actData = await resActivity.json();
  assert.equal(actData.ok, true);
  assert.equal(Array.isArray(actData.activity), true);
  assert.equal(typeof actData.summary.views24h, "number");
  assert.equal(typeof actData.summary.views7d, "number");
  assert.equal(typeof actData.summary.totalRecordedViews, "number");
  assert.equal(Boolean(actData.telemetryNotice.untrackedSearches), true);
  recordPass("Authorized admin fetched activity journey with 24h/7d metrics and telemetry boundaries");

  // D. Audit log listing endpoint
  const resAudit = await adminAuditLogGet(new Request("http://localhost:3000/api/admin/audit-log", { headers: adminHeaders }));
  assert.equal(resAudit.status, 200, "Authorized admin /api/admin/audit-log must return 200");
  const auditData = await resAudit.json();
  assert.equal(auditData.ok, true);
  assert.equal(Array.isArray(auditData.entries), true);
  recordPass("Authorized admin fetched audit log records");

  // ---------------------------------------------------------------------------
  // 4. BLOCK / UNBLOCK MUTATION & AUDIT PAYLOAD VERIFICATION
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. BLOCK/UNBLOCK MUTATION & EXACT AUDIT WRITE PAYLOAD VERIFICATION ---");
  // A. Block mutation on non-admin fixture user
  lastAuditWritePayload = null;
  const resBlock = await adminBlockPost(new Request("http://localhost:3000/api/admin/users/block", {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: NON_ADMIN_FIXTURE_ID,
      action: "block",
      reason: "Terms of service and scraping violation",
    }),
  }));
  assert.equal(resBlock.status, 200, "Blocking non-admin user must return 200");
  const blockResult = await resBlock.json();
  assert.equal(blockResult.ok, true);
  assert.equal(blockResult.isBlocked, true);
  // Verify exact audit log write payload
  assert.ok(lastAuditWritePayload, "Audit write payload was delivered to audit log service");
  assert.equal(lastAuditWritePayload.admin_user_id, ADMIN_USER_ID);
  assert.equal(lastAuditWritePayload.action, "user.block");
  assert.equal(lastAuditWritePayload.target_type, "user");
  assert.equal(lastAuditWritePayload.target_id, NON_ADMIN_FIXTURE_ID);
  assert.equal(lastAuditWritePayload.metadata?.reason, "Terms of service and scraping violation");
  recordPass("Block action succeeded and verified exact audit payload write (action, target, reason)");

  // B. Unblock mutation on non-admin fixture user
  lastAuditWritePayload = null;
  const resUnblock = await adminBlockPost(new Request("http://localhost:3000/api/admin/users/block", {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: NON_ADMIN_FIXTURE_ID,
      action: "unblock",
      reason: "Appeal reviewed and approved",
    }),
  }));
  assert.equal(resUnblock.status, 200, "Unblocking non-admin user must return 200");
  const unblockResult = await resUnblock.json();
  assert.equal(unblockResult.ok, true);
  assert.equal(unblockResult.isBlocked, false);
  // Verify exact audit log write payload for unblock
  assert.ok(lastAuditWritePayload, "Audit write payload was delivered for unblock");
  assert.equal(lastAuditWritePayload.action, "user.unblock");
  assert.equal(lastAuditWritePayload.target_id, NON_ADMIN_FIXTURE_ID);
  assert.equal(lastAuditWritePayload.metadata?.reason, "Appeal reviewed and approved");
  recordPass("Unblock action succeeded and verified exact audit payload write (action, target, reason)");

  // C. Audit log write failure resilience (Fail-safe logging)
  simulateAuditWriteFailure = true;
  const resBlockAuditFail = await adminBlockPost(new Request("http://localhost:3000/api/admin/users/block", {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: NON_ADMIN_FIXTURE_ID,
      action: "block",
      reason: "Secondary block test with simulated audit failure",
    }),
  }));
  assert.equal(resBlockAuditFail.status, 200, "Block action succeeds even when non-critical audit log write fails");
  const auditFailRes = await resBlockAuditFail.json();
  assert.equal(auditFailRes.ok, true);
  simulateAuditWriteFailure = false;
  recordPass("Mutation route contract resilient: non-critical audit write failure does not crash response");

  // ---------------------------------------------------------------------------
  // 5. MALFORMED PAGINATION PARAMETERS (Must return 400)
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. MALFORMED PAGINATION VALIDATION (HTTP 400) ---");
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
  // 6. HEAVY USER FIXTURE & BOUNDED COUNT QUERY VERIFICATION
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. HEAVY USER FIXTURE & ZERO ROW DOWNLOAD PROOF ---");
  pageViewsRowsDownloaded = 0;
  // Request page 4 (contains HEAVY_USER_ID)
  const resHeavyPage = await adminUsersGet(new Request("http://localhost:3000/api/admin/users?page=4&pageSize=25", { headers: adminHeaders }));
  assert.equal(resHeavyPage.status, 200);
  const heavyPageData = await resHeavyPage.json();
  const heavyUser = heavyPageData.users.find((u: any) => u.id === HEAVY_USER_ID);
  assert.ok(heavyUser, "Heavy user found on page 4");
  assert.equal(heavyUser.totalViews, 5000, "Heavy user totalViews reflects exact 5000 count from count-only query");
  assert.equal(pageViewsRowsDownloaded, 0, "Zero row records downloaded across network despite 5,000 views");
  recordPass("Proved 5,000 page views counted accurately via count-only query with 0 row data downloaded");

  // ---------------------------------------------------------------------------
  // 7. HONEST PAGE-LOCAL SEARCH INDICATION & NOTICE
  // ---------------------------------------------------------------------------
  console.log("\n--- 7. HONEST PAGE-LOCAL SEARCH NOTICES ---");
  const resSearch = await adminUsersGet(new Request("http://localhost:3000/api/admin/users?q=heavy", { headers: adminHeaders }));
  assert.equal(resSearch.status, 200);
  const searchData = await resSearch.json();
  assert.ok(searchData.searchNotice, "Search notice returned when search query is active");
  assert.equal(
    searchData.searchNotice,
    "Email search filters users on the current page. Global search across all accounts requires server-side index configuration."
  );
  assert.equal(searchData.searchNotice.includes("phase A1b"), false, "User-facing notice contains no implementation-phase jargon");
  recordPass("Search notice verified free of phase jargon and explicitly discloses page-local filtering");

  // ---------------------------------------------------------------------------
  // 8. MODERATION: SELF-BLOCK & ADMIN EMAIL BLOCK PREVENTION (HTTP 400)
  // ---------------------------------------------------------------------------
  console.log("\n--- 8. MODERATION SAFETY LOCKS (SELF-BLOCK & ADMIN ACCOUNT BLOCK) ---");
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
  // 9. BACKEND FAILURE HANDLING (Must return generic 500 without secret leakage)
  // ---------------------------------------------------------------------------
  console.log("\n--- 9. BACKEND FAILURE HANDLING & NO SECRET LEAKAGE ---");
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
  // 10. PARTIAL COUNT FAILURE RESILIENCE (FAILED COUNTS ARE EXPLICITLY NULL/UNAVAILABLE)
  // ---------------------------------------------------------------------------
  console.log("\n--- 10. PARTIAL COUNT FAILURE: EXPLICIT NULL/UNAVAILABLE STATE (FIX 1) ---");
  const failedTargetUserId = "00000000-0000-0000-0000-000000000003";
  failingCountUserId = failedTargetUserId;
  pageViewsRowsDownloaded = 0;

  const resPartialFail = await adminUsersGet(new Request("http://localhost:3000/api/admin/users?page=1&pageSize=25", { headers: adminHeaders }));
  assert.equal(resPartialFail.status, 200, "Users route must return 200 even if individual user count query fails");
  const partialFailData = await resPartialFail.json();
  assert.equal(partialFailData.ok, true);
  assert.equal(Array.isArray(partialFailData.users), true);

  const failedUserItem = partialFailData.users.find((u: any) => u.id === failedTargetUserId);
  assert.ok(failedUserItem, "Failed-count user is still retained in list and not omitted");
  assert.equal(failedUserItem.totalViews, null, "Failed-count user has totalViews explicitly set to null (never 0)");

  const successfulUserItem = partialFailData.users.find((u: any) => u.id !== failedTargetUserId);
  assert.ok(successfulUserItem, "Successful user found on same page");
  assert.equal(typeof successfulUserItem.totalViews, "number", "Successful user has numeric totalViews count");
  assert.equal(successfulUserItem.totalViews, 4, "Successful user has accurate count from head-only query");

  assert.equal(pageViewsRowsDownloaded, 0, "Zero row records downloaded across network during partial failure");
  assert.equal(
    JSON.stringify(partialFailData).includes("PGRST_MOCK_TIMEOUT"),
    false,
    "No raw backend error or internal database error message exposed in client response"
  );
  failingCountUserId = null;
  recordPass("Proved partial count failure sets explicit null without dropping user, exposing error, or downloading rows");

  // ---------------------------------------------------------------------------
  // 11. STATE DIFFERENTIATION: POPULATED, EMPTY, AND ERROR STATES (FIX 3)
  // ---------------------------------------------------------------------------
  console.log("\n--- 11. STATE DIFFERENTIATION: POPULATED, EMPTY, AND ERROR STATES (FIX 3) ---");
  // A. Populated State
  const resPopulated = await adminUsersGet(new Request("http://localhost:3000/api/admin/users?page=1&pageSize=10", { headers: adminHeaders }));
  assert.equal(resPopulated.status, 200);
  const popData = await resPopulated.json();
  assert.equal(popData.ok, true);
  assert.equal(popData.users.length, 10);
  assert.equal(popData.pagination.total, 120);
  recordPass("Populated state: Returns HTTP 200 with 10 users and accurate total metadata");

  // B. Genuine Empty Search State
  const resEmptySearch = await adminUsersGet(new Request("http://localhost:3000/api/admin/users?q=nonexistent_query_xyz_12345", { headers: adminHeaders }));
  assert.equal(resEmptySearch.status, 200);
  const emptySearchData = await resEmptySearch.json();
  assert.equal(emptySearchData.ok, true);
  assert.equal(emptySearchData.users.length, 0, "Empty search returns empty user list");
  assert.ok(emptySearchData.searchNotice, "Search notice present for empty search");
  recordPass("Empty search state: Returns HTTP 200 with empty list and search disclosure");

  // C. Hard Backend Error State
  simulateAuthFailure = true;
  const resHardError = await adminUsersGet(new Request("http://localhost:3000/api/admin/users", { headers: adminHeaders }));
  assert.equal(resHardError.status, 500);
  const hardErrorData = await resHardError.json();
  assert.equal(hardErrorData.ok, false);
  assert.equal(hardErrorData.error, "Failed to retrieve users list");
  simulateAuthFailure = false;
  recordPass("Hard error state: Returns HTTP 500 and distinct non-empty error payload");

  console.log(`\n================================================================================`);
  console.log(`🎉 ALL ${passes} HANDLER VERIFICATION CHECKS PASSED (PASS-LOCAL)`);
  console.log(`================================================================================`);
}

runHandlerTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
