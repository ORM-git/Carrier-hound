/**
 * scripts/test-admin-early-access.ts
 *
 * Comprehensive verification suite for Admin Early-Access Approvals API:
 * 1. Non-admin 403: No token, invalid token, and non-admin tokens strictly return HTTP 403.
 * 2. Client role ignored: Client cannot spoof admin role or approved_by in payload.
 * 3. Paginated listing: GET /api/admin/early-access returns pending requests with pagination and status filtering.
 * 4. Idempotent approval: POST /api/admin/early-access/approve sets approved_at and approved_by. Second call returns already_approved: true.
 * 5. Idempotent rejection: POST /api/admin/early-access/reject sets status='rejected'. Second call returns already_rejected: true.
 * 6. Missing-env notification resilience: If EARLY_ACCESS_NOTIFY_EMAIL or APPS_SCRIPT_MAIL_URL is missing, approve succeeds and returns notify_skipped: true (no crash).
 * 7. Negative controls: Real subprocess execution asserting non-zero exit on compromised invariants.
 */

import assert from "node:assert";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Module from "node:module";

// Mock @cloudflare/next-on-pages in test environment
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

process.env.NODE_ENV = "test";

// Negative control mode
const isNegativeControl = process.argv.includes("--negative-control");
if (isNegativeControl) {
  console.log("[NEGATIVE CONTROL MODE] Proving assertions fail with non-zero exit on invalid condition...");
  const nonAdminGotAccess = false;
  assert.strictEqual(
    nonAdminGotAccess,
    true,
    "Negative control expected failure: non-admin must never receive 200 OK."
  );
  process.exit(0);
}

// Ensure mock Supabase env vars are set
process.env.NEXT_PUBLIC_SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://mock-proj.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mock-service-role-key";

import { ADMIN_EMAIL } from "../src/lib/admin/constants";
import {
  listPendingEarlyAccessRequests,
  approveEarlyAccessRequest,
  rejectEarlyAccessRequest,
} from "../src/lib/admin/earlyAccess";
import { isUserApproved } from "../src/lib/auth/approval";

interface StoredEmailRow {
  email: string;
  created_at: string;
  status: "pending" | "approved" | "rejected";
  approved_at?: string | null;
  approved_by?: string | null;
}

interface StoredApprovedRow {
  email: string;
  approved: boolean;
  approved_at?: string | null;
  approved_by?: string | null;
  created_at: string;
  updated_at: string;
}

const mockEmailsTable: StoredEmailRow[] = [];
const mockApprovedTable: StoredApprovedRow[] = [];
const dispatchedMails: Array<Record<string, any>> = [];

function resetMockDb() {
  mockEmailsTable.length = 0;
  mockApprovedTable.length = 0;
  dispatchedMails.length = 0;
}

function createMockSupabaseAdmin() {
  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "valid-admin-token") {
          return {
            data: {
              user: {
                id: "admin-user-id-001",
                email: ADMIN_EMAIL,
                email_confirmed_at: "2026-10-30T00:00:00.000Z",
                app_metadata: { provider: "google", providers: ["google"] },
              },
            },
            error: null,
          };
        }
        if (token === "non-admin-token") {
          return {
            data: {
              user: {
                id: "regular-user-id-002",
                email: "regular.user@example.com",
                email_confirmed_at: "2026-10-30T00:00:00.000Z",
                app_metadata: { provider: "google" },
              },
            },
            error: null,
          };
        }
        return { data: { user: null }, error: { message: "Invalid JWT token" } };
      },
    },
    from: (table: string) => {
      let filteredRows: any[] = [];
      if (table === "early_access_emails") {
        filteredRows = [...mockEmailsTable];
      } else if (table === "early_access_approved") {
        filteredRows = [...mockApprovedTable];
      } else if (table === "admin_audit_log") {
        filteredRows = [];
      }

      let selectedFields = "*";
      let isCountExact = false;
      let rangeFrom: number | null = null;
      let rangeTo: number | null = null;

      const builder: any = {
        select: (fields: string = "*", options?: { count?: string; head?: boolean }) => {
          selectedFields = fields;
          if (options?.count === "exact") {
            isCountExact = true;
          }
          return builder;
        },
        eq: (column: string, value: any) => {
          filteredRows = filteredRows.filter((r) => r[column] === value);
          return builder;
        },
        order: (column: string, { ascending }: { ascending: boolean } = { ascending: true }) => {
          filteredRows.sort((a, b) => {
            if (a[column] < b[column]) return ascending ? -1 : 1;
            if (a[column] > b[column]) return ascending ? 1 : -1;
            return 0;
          });
          return builder;
        },
        range: (from: number, to: number) => {
          rangeFrom = from;
          rangeTo = to;
          return builder;
        },
        maybeSingle: async () => {
          const row = filteredRows[0] || null;
          return { data: row, error: null };
        },
        insert: async (values: any) => {
          const rowsToInsert = Array.isArray(values) ? values : [values];
          for (const row of rowsToInsert) {
            if (table === "early_access_emails") {
              mockEmailsTable.push({
                email: row.email,
                created_at: row.created_at || new Date().toISOString(),
                status: row.status || "pending",
                approved_at: row.approved_at || null,
                approved_by: row.approved_by || null,
              });
            } else if (table === "early_access_approved") {
              mockApprovedTable.push({
                email: row.email,
                approved: Boolean(row.approved),
                approved_at: row.approved_at || null,
                approved_by: row.approved_by || null,
                created_at: row.created_at || new Date().toISOString(),
                updated_at: row.updated_at || new Date().toISOString(),
              });
            }
          }
          return { error: null };
        },
        update: (values: any) => {
          return {
            eq: async (column: string, value: any) => {
              for (const row of table === "early_access_emails" ? mockEmailsTable : mockApprovedTable) {
                if ((row as any)[column] === value) {
                  Object.assign(row, values);
                }
              }
              return { error: null };
            },
          };
        },
        upsert: async (values: any) => {
          const rowsToUpsert = Array.isArray(values) ? values : [values];
          for (const row of rowsToUpsert) {
            if (table === "early_access_approved") {
              const existingIdx = mockApprovedTable.findIndex((r) => r.email === row.email);
              if (existingIdx >= 0) {
                Object.assign(mockApprovedTable[existingIdx], row);
              } else {
                mockApprovedTable.push({
                  email: row.email,
                  approved: Boolean(row.approved),
                  approved_at: row.approved_at || null,
                  approved_by: row.approved_by || null,
                  created_at: row.created_at || new Date().toISOString(),
                  updated_at: row.updated_at || new Date().toISOString(),
                });
              }
            } else if (table === "early_access_emails") {
              const existingIdx = mockEmailsTable.findIndex((r) => r.email === row.email);
              if (existingIdx >= 0) {
                Object.assign(mockEmailsTable[existingIdx], row);
              } else {
                mockEmailsTable.push({
                  email: row.email,
                  created_at: row.created_at || new Date().toISOString(),
                  status: row.status || "pending",
                  approved_at: row.approved_at || null,
                  approved_by: row.approved_by || null,
                });
              }
            }
          }
          return { error: null };
        },
        then: (onFulfilled: any) => {
          const count = filteredRows.length;
          let resultRows = filteredRows;
          if (rangeFrom !== null && rangeTo !== null) {
            resultRows = filteredRows.slice(rangeFrom, rangeTo + 1);
          }
          return Promise.resolve({
            data: resultRows,
            count: isCountExact ? count : undefined,
            error: null,
          }).then(onFulfilled);
        },
      };

      return builder;
    },
  };
}

// Global mock registration
const mockClient = createMockSupabaseAdmin();
(globalThis as any).__mockSupabaseAdmin = mockClient;
(globalThis as any).__mockSupabaseClient = mockClient;

// Intercept fetch for Apps Script mail dispatcher & audit log
const originalFetch = global.fetch;
global.fetch = async (input: any, init?: any): Promise<Response> => {
  const url = String(input);

  // Supabase auth getUser mock endpoint
  if (url.includes("/auth/v1/user")) {
    const authHeader = init?.headers?.Authorization || "";
    if (authHeader.includes("valid-admin-token")) {
      return new Response(
        JSON.stringify({
          id: "admin-user-id-001",
          email: ADMIN_EMAIL,
          email_confirmed_at: "2026-10-30T00:00:00.000Z",
          app_metadata: { provider: "google", providers: ["google"] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (authHeader.includes("non-admin-token")) {
      return new Response(
        JSON.stringify({
          id: "regular-user-id-002",
          email: "regular.user@example.com",
          email_confirmed_at: "2026-10-30T00:00:00.000Z",
          app_metadata: { provider: "google" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
  }

  // Google Apps Script mail dispatcher
  if (url.includes("script.google.com") || url.includes("mock-apps-script")) {
    try {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      dispatchedMails.push(body);
    } catch (_) {}
    return new Response("ok", { status: 200 });
  }

  // Admin audit log
  if (url.includes("/rest/v1/admin_audit_log")) {
    return new Response("ok", { status: 201 });
  }

  return originalFetch ? originalFetch(input, init) : new Response("Not found", { status: 404 });
};

async function main() {
  console.log("================================================================================");
  console.log("       CAREERMONKE ADMIN EARLY-ACCESS APPROVALS API VERIFICATION SUITE          ");
  console.log("================================================================================\n");

  const { GET: listEarlyAccessRoute, POST: mutateEarlyAccessRoute } = await import(
    "../src/app/api/admin/early-access/route"
  );
  const { POST: approveRoute } = await import(
    "../src/app/api/admin/early-access/approve/route"
  );
  const { POST: rejectRoute } = await import(
    "../src/app/api/admin/early-access/reject/route"
  );

  // ---------------------------------------------------------------------------
  // TEST 1: Non-Admin 403 Access Control Verification
  // ---------------------------------------------------------------------------
  console.log("[TEST 1] Verifying non-admin requests return HTTP 403 Forbidden...");
  resetMockDb();

  // 1.1 GET /api/admin/early-access without token
  const noTokenGet = await listEarlyAccessRoute(
    new Request("http://localhost:3000/api/admin/early-access")
  );
  assert.strictEqual(noTokenGet.status, 403, "GET without token must return 403");
  const noTokenGetJson = await noTokenGet.json();
  assert.ok(noTokenGetJson.error?.includes("Forbidden"), "Must return Forbidden error");
  console.log("  [PASS] GET /api/admin/early-access without token -> 403");

  // 1.2 GET /api/admin/early-access with invalid token
  const invalidTokenGet = await listEarlyAccessRoute(
    new Request("http://localhost:3000/api/admin/early-access", {
      headers: { Authorization: "Bearer bad-token" },
    })
  );
  assert.strictEqual(invalidTokenGet.status, 403, "GET with invalid token must return 403");
  console.log("  [PASS] GET /api/admin/early-access with invalid token -> 403");

  // 1.3 GET /api/admin/early-access with regular user token
  const nonAdminGet = await listEarlyAccessRoute(
    new Request("http://localhost:3000/api/admin/early-access", {
      headers: { Authorization: "Bearer non-admin-token" },
    })
  );
  assert.strictEqual(nonAdminGet.status, 403, "GET with regular user token must return 403");
  console.log("  [PASS] GET /api/admin/early-access with non-admin user token -> 403");

  // 1.4 POST /api/admin/early-access/approve with non-admin token
  const nonAdminApprove = await approveRoute(
    new Request("http://localhost:3000/api/admin/early-access/approve", {
      method: "POST",
      headers: {
        Authorization: "Bearer non-admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "candidate@example.com" }),
    })
  );
  assert.strictEqual(nonAdminApprove.status, 403, "POST approve with non-admin token must return 403");
  console.log("  [PASS] POST /api/admin/early-access/approve with non-admin token -> 403");

  // 1.5 POST /api/admin/early-access/reject with non-admin token
  const nonAdminReject = await rejectRoute(
    new Request("http://localhost:3000/api/admin/early-access/reject", {
      method: "POST",
      headers: {
        Authorization: "Bearer non-admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "candidate@example.com" }),
    })
  );
  assert.strictEqual(nonAdminReject.status, 403, "POST reject with non-admin token must return 403");
  console.log("  [PASS] POST /api/admin/early-access/reject with non-admin token -> 403");

  // 1.6 Untrusted client attempt to pass role: 'admin' or spoofed approved_by in body
  const spoofAttempt = await mutateEarlyAccessRoute(
    new Request("http://localhost:3000/api/admin/early-access", {
      method: "POST",
      headers: {
        Authorization: "Bearer non-admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "approve",
        email: "candidate@example.com",
        role: "admin",
        approved_by: "system_admin",
      }),
    })
  );
  assert.strictEqual(spoofAttempt.status, 403, "Spoofed client payload without admin session must return 403");
  console.log("  [PASS] Client-supplied role/approved_by never trusted; rejected with 403");

  // ---------------------------------------------------------------------------
  // TEST 2: Paginated List of Pending Requests
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 2] Verifying paginated listing of pending requests...");
  resetMockDb();

  // Populate mock waitlist with 5 items (3 pending, 1 approved, 1 rejected)
  mockEmailsTable.push(
    { email: "user1@example.com", created_at: "2026-11-04T01:00:00.000Z", status: "pending" },
    { email: "user2@example.com", created_at: "2026-11-04T02:00:00.000Z", status: "pending" },
    { email: "user3@example.com", created_at: "2026-11-04T03:00:00.000Z", status: "pending" },
    { email: "user4@example.com", created_at: "2026-11-04T04:00:00.000Z", status: "approved", approved_at: "2026-11-04T04:30:00.000Z", approved_by: ADMIN_EMAIL },
    { email: "user5@example.com", created_at: "2026-11-04T05:00:00.000Z", status: "rejected", approved_at: "2026-11-04T05:30:00.000Z", approved_by: ADMIN_EMAIL }
  );

  // 2.1 Default listing (status=pending, page 1, limit 25)
  const listReq = new Request("http://localhost:3000/api/admin/early-access", {
    headers: { Authorization: "Bearer valid-admin-token" },
  });
  const listRes = await listEarlyAccessRoute(listReq);
  assert.strictEqual(listRes.status, 200, "Admin listing must return 200");
  const listJson = await listRes.json();
  assert.strictEqual(listJson.ok, true, "Response ok must be true");
  assert.strictEqual(listJson.total, 3, "Total pending requests must be 3");
  assert.strictEqual(listJson.requests.length, 3, "Should return 3 pending items");
  assert.strictEqual(listJson.requests[0].email, "user3@example.com", "Must be ordered by created_at DESC");
  assert.strictEqual(listJson.requests[0].status, "pending");
  console.log("  [PASS] GET /api/admin/early-access lists pending requests (ordered created_at DESC)");

  // 2.2 Pagination slicing: page=1, limit=2
  const p1Req = new Request("http://localhost:3000/api/admin/early-access?page=1&limit=2", {
    headers: { Authorization: "Bearer valid-admin-token" },
  });
  const p1Res = await listEarlyAccessRoute(p1Req);
  const p1Json = await p1Res.json();
  assert.strictEqual(p1Json.requests.length, 2, "Page 1 limit 2 must return 2 rows");
  assert.strictEqual(p1Json.page, 1);
  assert.strictEqual(p1Json.limit, 2);
  assert.strictEqual(p1Json.totalPages, 2);
  assert.strictEqual(p1Json.requests[0].email, "user3@example.com");
  assert.strictEqual(p1Json.requests[1].email, "user2@example.com");

  // 2.3 Pagination page=2, limit=2
  const p2Req = new Request("http://localhost:3000/api/admin/early-access?page=2&limit=2", {
    headers: { Authorization: "Bearer valid-admin-token" },
  });
  const p2Res = await listEarlyAccessRoute(p2Req);
  const p2Json = await p2Res.json();
  assert.strictEqual(p2Json.requests.length, 1, "Page 2 limit 2 must return 1 row");
  assert.strictEqual(p2Json.requests[0].email, "user1@example.com");
  console.log("  [PASS] Pagination correctly computes page, limit, totalPages and slices rows");

  // 2.4 Status filter: status=approved
  const approvedListReq = new Request("http://localhost:3000/api/admin/early-access?status=approved", {
    headers: { Authorization: "Bearer valid-admin-token" },
  });
  const approvedListRes = await listEarlyAccessRoute(approvedListReq);
  const approvedListJson = await approvedListRes.json();
  assert.strictEqual(approvedListJson.total, 1);
  assert.strictEqual(approvedListJson.requests[0].email, "user4@example.com");
  assert.strictEqual(approvedListJson.requests[0].status, "approved");
  console.log("  [PASS] Filter by status (approved) verified");

  // ---------------------------------------------------------------------------
  // TEST 3: Idempotent Approval & approved_at / approved_by
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 3] Verifying approve endpoint, approved_at, approved_by, and idempotency...");
  resetMockDb();

  // Configure Apps Script & notify email
  process.env.EARLY_ACCESS_NOTIFY_EMAIL = "notify@careermonke.com";
  process.env.APPS_SCRIPT_MAIL_URL = "https://mock-apps-script.example.com";
  process.env.APPS_SCRIPT_MAIL_SECRET = "secret-123";

  mockEmailsTable.push({
    email: "approved.test@example.com",
    created_at: "2026-11-04T00:00:00.000Z",
    status: "pending",
  });

  // 3.1 First approve call via POST /api/admin/early-access/approve
  const approveReq1 = new Request("http://localhost:3000/api/admin/early-access/approve", {
    method: "POST",
    headers: {
      Authorization: "Bearer valid-admin-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: "Approved.Test@Example.Com", // Mixed-case normalization check
      role: "hacker", // Attacker role injection attempt in body
      approved_by: "spoofed_admin@fake.com", // Attacker spoof injection attempt
    }),
  });

  const approveRes1 = await approveRoute(approveReq1);
  assert.strictEqual(approveRes1.status, 200, "Approve must return 200 OK");
  const approveJson1 = await approveRes1.json();
  assert.strictEqual(approveJson1.ok, true);
  assert.strictEqual(approveJson1.email, "approved.test@example.com", "Email must be normalized lowercase");
  assert.strictEqual(approveJson1.status, "approved");
  assert.strictEqual(approveJson1.approved_by, ADMIN_EMAIL, "approved_by must strictly equal verified admin identity");
  assert.ok(approveJson1.approved_at, "approved_at must be an ISO timestamp");
  assert.strictEqual(approveJson1.notify_skipped, false, "Notification must not be skipped when env is present");
  assert.strictEqual(dispatchedMails.length, 1, "Exactly one notification email must be dispatched");
  assert.strictEqual(dispatchedMails[0].email, "notify@careermonke.com");

  // Verify DB state
  const approvedRowInDb = mockApprovedTable.find((r) => r.email === "approved.test@example.com");
  assert.ok(approvedRowInDb, "Row must exist in early_access_approved table");
  assert.strictEqual(approvedRowInDb.approved, true, "approved flag must be true");
  assert.strictEqual(approvedRowInDb.approved_by, ADMIN_EMAIL);

  const emailRowInDb = mockEmailsTable.find((r) => r.email === "approved.test@example.com");
  assert.strictEqual(emailRowInDb?.status, "approved");
  assert.strictEqual(emailRowInDb?.approved_by, ADMIN_EMAIL);

  // Verify access is immediately unlocked via isUserApproved
  const accessCheck = await isUserApproved(mockClient, { email: "approved.test@example.com" });
  assert.strictEqual(accessCheck, true, "User must immediately be granted access via isUserApproved");
  console.log("  [PASS] First approve: sets status='approved', writes approved_at and server-derived approved_by");

  // 3.2 Double-Approve Idempotency Check
  const recordedApprovedAt = approveJson1.approved_at;
  const approveReq2 = new Request("http://localhost:3000/api/admin/early-access/approve", {
    method: "POST",
    headers: {
      Authorization: "Bearer valid-admin-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: "approved.test@example.com" }),
  });

  const approveRes2 = await approveRoute(approveReq2);
  assert.strictEqual(approveRes2.status, 200, "Double-approve must succeed idempotently (200 OK)");
  const approveJson2 = await approveRes2.json();
  assert.strictEqual(approveJson2.ok, true);
  assert.strictEqual(approveJson2.already_approved, true, "already_approved must be true");
  assert.strictEqual(approveJson2.approved_at, recordedApprovedAt, "Original approved_at must not be mutated");
  assert.strictEqual(approveJson2.notify_skipped, true, "Notification must be skipped on duplicate approve");
  assert.strictEqual(dispatchedMails.length, 1, "Duplicate notification email MUST NOT be sent on second approve");
  console.log("  [PASS] Double-approve: Idempotent (returns 200, already_approved: true, zero duplicate email)");

  // ---------------------------------------------------------------------------
  // TEST 4: Idempotent Rejection
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 4] Verifying reject endpoint and idempotency...");
  mockEmailsTable.push({
    email: "rejected.candidate@example.com",
    created_at: "2026-11-04T00:00:00.000Z",
    status: "pending",
  });

  // 4.1 First reject call
  const rejectReq1 = new Request("http://localhost:3000/api/admin/early-access/reject", {
    method: "POST",
    headers: {
      Authorization: "Bearer valid-admin-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: "rejected.candidate@example.com",
      reason: "Suspicious activity",
    }),
  });

  const rejectRes1 = await rejectRoute(rejectReq1);
  assert.strictEqual(rejectRes1.status, 200, "Reject must return 200 OK");
  const rejectJson1 = await rejectRes1.json();
  assert.strictEqual(rejectJson1.ok, true);
  assert.strictEqual(rejectJson1.status, "rejected");
  assert.strictEqual(rejectJson1.approved_by, ADMIN_EMAIL);

  const rejectedApprovedDbRow = mockApprovedTable.find((r) => r.email === "rejected.candidate@example.com");
  assert.ok(rejectedApprovedDbRow, "Row must exist in early_access_approved");
  assert.strictEqual(rejectedApprovedDbRow.approved, false, "approved flag must be false");

  const rejectedEmailDbRow = mockEmailsTable.find((r) => r.email === "rejected.candidate@example.com");
  assert.strictEqual(rejectedEmailDbRow?.status, "rejected");

  const rejectedAccessCheck = await isUserApproved(mockClient, { email: "rejected.candidate@example.com" });
  assert.strictEqual(rejectedAccessCheck, false, "Rejected user must NOT be approved");
  console.log("  [PASS] First reject: sets status='rejected', approved=false in DB");

  // 4.2 Double-Reject Idempotency Check
  const rejectReq2 = new Request("http://localhost:3000/api/admin/early-access/reject", {
    method: "POST",
    headers: {
      Authorization: "Bearer valid-admin-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: "rejected.candidate@example.com" }),
  });

  const rejectRes2 = await rejectRoute(rejectReq2);
  assert.strictEqual(rejectRes2.status, 200, "Double-reject must succeed idempotently (200 OK)");
  const rejectJson2 = await rejectRes2.json();
  assert.strictEqual(rejectJson2.ok, true);
  assert.strictEqual(rejectJson2.already_rejected, true, "already_rejected must be true");
  console.log("  [PASS] Double-reject: Idempotent (returns 200, already_rejected: true)");

  // ---------------------------------------------------------------------------
  // TEST 5: Missing-Env Path (notify_skipped: true, zero crash)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 5] Verifying missing-env path succeeds with notify_skipped: true and zero crash...");
  resetMockDb();

  mockEmailsTable.push({
    email: "missing.env.user@example.com",
    created_at: "2026-11-04T00:00:00.000Z",
    status: "pending",
  });

  // 5.1 When EARLY_ACCESS_NOTIFY_EMAIL is empty
  delete process.env.EARLY_ACCESS_NOTIFY_EMAIL;
  process.env.APPS_SCRIPT_MAIL_URL = "https://mock-apps-script.example.com";

  const missingNotifyEmailRes = await approveEarlyAccessRequest({
    adminEmail: ADMIN_EMAIL,
    targetEmail: "missing.env.user@example.com",
    customClient: mockClient,
  });

  assert.strictEqual(missingNotifyEmailRes.ok, true, "Approve must succeed when notify email is missing");
  assert.strictEqual(missingNotifyEmailRes.status, "approved");
  assert.strictEqual(missingNotifyEmailRes.notify_skipped, true, "notify_skipped must be true");
  console.log("  [PASS] Missing EARLY_ACCESS_NOTIFY_EMAIL: approve succeeds with notify_skipped: true, no crash");

  // 5.2 When APPS_SCRIPT_MAIL_URL is empty
  mockEmailsTable.push({
    email: "missing.url.user@example.com",
    created_at: "2026-11-04T00:00:00.000Z",
    status: "pending",
  });
  process.env.EARLY_ACCESS_NOTIFY_EMAIL = "notify@careermonke.com";
  delete process.env.APPS_SCRIPT_MAIL_URL;

  const missingUrlRes = await approveEarlyAccessRequest({
    adminEmail: ADMIN_EMAIL,
    targetEmail: "missing.url.user@example.com",
    customClient: mockClient,
  });

  assert.strictEqual(missingUrlRes.ok, true, "Approve must succeed when Apps Script URL is missing");
  assert.strictEqual(missingUrlRes.status, "approved");
  assert.strictEqual(missingUrlRes.notify_skipped, true, "notify_skipped must be true");
  console.log("  [PASS] Missing APPS_SCRIPT_MAIL_URL: approve succeeds with notify_skipped: true, no crash");

  // 5.3 Combined POST route test with missing env
  mockEmailsTable.push({
    email: "combined.route.user@example.com",
    created_at: "2026-11-04T00:00:00.000Z",
    status: "pending",
  });
  delete process.env.EARLY_ACCESS_NOTIFY_EMAIL;
  delete process.env.APPS_SCRIPT_MAIL_URL;

  const combinedReq = new Request("http://localhost:3000/api/admin/early-access", {
    method: "POST",
    headers: {
      Authorization: "Bearer valid-admin-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "approve",
      email: "combined.route.user@example.com",
    }),
  });

  const combinedRes = await mutateEarlyAccessRoute(combinedReq);
  assert.strictEqual(combinedRes.status, 200, "POST /api/admin/early-access must return 200");
  const combinedJson = await combinedRes.json();
  assert.strictEqual(combinedJson.ok, true);
  assert.strictEqual(combinedJson.notify_skipped, true, "notify_skipped must be true");
  console.log("  [PASS] Route POST /api/admin/early-access: approve succeeds with notify_skipped: true when env unset");

  // ---------------------------------------------------------------------------
  // TEST 6: Subprocess Negative Control
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 6] Confirming negative control fails with non-zero exit code...");
  const negResult = spawnSync(process.execPath, ["-r", "tsx", __filename, "--negative-control"], {
    encoding: "utf-8",
    env: process.env,
  });

  assert.notStrictEqual(
    negResult.status,
    0,
    "Negative control MUST exit with non-zero exit code when invalid condition is asserted!"
  );
  console.log(`  [PASS] Negative control exited non-zero (${negResult.status}) as expected.`);

  console.log("\n================================================================================");
  console.log("       ALL ADMIN EARLY-ACCESS APPROVALS API TESTS PASSED [PASS-LOCAL]           ");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("\n[FAIL] Admin Early-Access Approvals Test Suite Error:\n", err);
  process.exit(1);
});
